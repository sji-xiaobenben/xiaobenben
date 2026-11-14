// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 下载并安装对应平台的单文件二进制 —— postinstall 与 bin 启动器共用。
 *
 * 安全模型（与 exe 自更新完全一致，不是另起一套）：
 *   1. 拉 `channels/stable.json`，用**内置 ed25519 公钥**验签，验不过一律拒绝（fail-closed）。
 *      签名覆盖 `version + files`，而 `files` 里带每个产物的 sha256 与 url —— 所以
 *      「CDN 被投毒但私钥没泄露」这条攻击路径在这里被切断：改过的清单验不过签，改过的
 *      二进制对不上签名清单里的 sha256。
 *   2. 按清单里的 url 下载，边下边算 sha256，**校验通过才落盘**（先写 .part 再 rename）。
 *   3. 任何异常都不落盘，也不覆盖已装好的旧文件。
 *
 * 这里刻意不引第三方依赖：npm install 阶段能用的只有 Node 原生模块，而且用户装的是
 * 一个 100MB 的下载器，多一个依赖就多一份攻击面。
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { binaryPathFor, binaryName, platformKey, pointerPath, readPointer, SUPPORTED } from "./binary.mjs";

/**
 * 清单真源。**这是唯一的签名真源**——`releases/v<版本>/manifest.json` 实际是 404，
 * 不要照 updater.ts 文件头里那句「另存一份」去猜路径（2026-11-14 实测确认）。
 */
export const MANIFEST_URL = process.env.XBB_MANIFEST_URL || "https://dl.xiaobenben.net/channels/stable.json";

/**
 * **必须与 src/build-meta.ts 的 UPDATE_PUBKEY 逐字一致。**
 * 两处漂移的后果不是报错而是全部安装失败：验签 fail-closed，用户只会看到「装不下来」。
 * `tools/npm-pkg-check.ts` 会对比这两个常量，改动任何一边都会被测试拦住。
 */
export const UPDATE_PUBKEY = "MCowBQYDK2VwAyEAc1RR4vsllVQ1BDf4pxauUOI1djJu+L9rS91V581n2wI=";

/** 与 src/update-payload.ts 的 UPDATE_PAYLOAD_MAGIC 一致 */
export const PAYLOAD_MAGIC = "xbb-update-v1";

/** 签名载荷规范化：与 src/update-payload.ts 的 buildUpdatePayload 逐字对齐（键名升序） */
export function buildPayload(version, files) {
  const lines = Object.keys(files)
    .sort()
    .map((k) => `${k}:${files[k].sha256}:${files[k].size}`);
  return [PAYLOAD_MAGIC, version, ...lines].join("\n");
}

/** 验签；任何异常一律判不通过 */
export function verifyManifest(manifest, pubKeyB64 = UPDATE_PUBKEY) {
  try {
    if (!manifest || !manifest.sig || typeof manifest.version !== "string") return false;
    if (!manifest.files || typeof manifest.files !== "object") return false;
    const key = createPublicKey({
      key: Buffer.from(pubKeyB64, "base64"),
      format: "der",
      type: "spki",
    });
    const payload = Buffer.from(buildPayload(manifest.version, manifest.files), "utf8");
    return verify(null, payload, key, Buffer.from(manifest.sig, "base64"));
  } catch {
    return false;
  }
}

/** 镜像改写：只换 origin，路径不动（自建镜像/内网缓存的常见做法） */
function rewrite(url) {
  const mirror = process.env.XBB_MIRROR;
  if (!mirror) return url;
  try {
    const u = new URL(url);
    const m = new URL(mirror);
    u.protocol = m.protocol;
    u.host = m.host;
    return u.toString();
  } catch {
    return url;
  }
}

function mb(n) {
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 带重试的 fetch：一次网络抖动不该让用户重装整个包 */
async function fetchWithRetry(url, { attempts = 3, timeoutMs = 60_000 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  throw lastErr;
}

export class UnsupportedPlatform extends Error {
  constructor(key) {
    super(`当前平台 ${key} 还没有官方构建（已支持：${SUPPORTED.join(" / ")}）`);
    this.name = "UnsupportedPlatform";
    this.platformKey = key;
  }
}

/** 拉清单并验签；返回 { version, files } */
export async function loadManifest({ log = () => {} } = {}) {
  const res = await fetchWithRetry(MANIFEST_URL, { timeoutMs: 30_000 });
  const manifest = await res.json();
  if (!verifyManifest(manifest)) {
    // 不打印清单内容：验不过的内容不值得信任，也不该被日志固化下来
    throw new Error(`清单签名校验失败（${MANIFEST_URL}）——已拒绝安装`);
  }
  log(`清单校验通过 · 最新版本 ${manifest.version}`);
  return manifest;
}

/**
 * 下载单个产物并校验。返回落盘路径。
 * 先写 `<目标>.part-<pid>`，校验通过才 rename —— 中途失败不会留下半截文件，
 * 也不会把已经在用的旧二进制换成坏的。
 */
async function downloadVerified(spec, dest, { onProgress = () => {} } = {}) {
  const url = rewrite(spec.url);
  const tmp = `${dest}.part-${process.pid}`;
  await mkdir(dirname(dest), { recursive: true });

  const res = await fetchWithRetry(url, { attempts: 3, timeoutMs: 600_000 });
  const total = Number(res.headers.get("content-length")) || spec.size || 0;

  const hash = createHash("sha256");
  let got = 0;
  let lastTick = 0;
  const fh = await open(tmp, "w");
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      hash.update(buf);
      await fh.write(buf);
      got += buf.length;
      const now = Date.now();
      if (now - lastTick > 400) {
        lastTick = now;
        onProgress({ got, total });
      }
    }
  } catch (e) {
    await fh.close();
    await rm(tmp, { force: true });
    throw e;
  }
  await fh.close();
  onProgress({ got, total });

  if (spec.size && got !== spec.size) {
    await rm(tmp, { force: true });
    throw new Error(`产物大小不符：收到 ${got} 字节，清单写 ${spec.size} 字节`);
  }
  const actual = hash.digest("hex");
  if (actual !== spec.sha256) {
    await rm(tmp, { force: true });
    throw new Error(`产物 sha256 不符：${actual} ≠ ${spec.sha256}`);
  }

  // Windows 上 rename 到已存在的文件会失败，先删旧文件（此时新文件已校验合格）
  await rm(dest, { force: true }).catch(() => {});
  await rename(tmp, dest);
  if (process.platform !== "win32") await chmod(dest, 0o755);
  return dest;
}

/**
 * 确保当前平台的可执行文件已就绪；已存在则直接返回，不发任何请求。
 * 返回 { path, version, downloaded }
 */
export async function ensureBinary({ pkgVersion, log = () => {}, onProgress = () => {}, force = false } = {}) {
  const key = platformKey();
  if (!SUPPORTED.includes(key)) throw new UnsupportedPlatform(key);

  if (!force) {
    // 先看安装记录：npm 包装器补丁版本（比如 0.4.54 的包装器）与线上二进制版本
    // （可能仍是 0.4.53）不必一致，认记录能避免为一个字节没变的二进制重下 100MB。
    const p = readPointer();
    if (p) return { path: p.path, version: p.version, downloaded: false };
  }

  const cached = binaryPathFor(pkgVersion || "0.0.0");
  if (!force && pkgVersion) {
    try {
      const st = await stat(cached);
      if (st.size > 0) return { path: cached, version: pkgVersion, downloaded: false };
    } catch {
      /* 未安装 */
    }
  }

  const manifest = await loadManifest({ log });
  // 只取单文件二进制。清单里那几个 `ort-*` 包**不下载**：主产物已把 onnxruntime
  // 内嵌进 exe（见 tools/lib/ort-embed.ts），单独发 ort 包是给 darwin-x64 那种
  // `--external onnxruntime-node` 构建做补救的，与 npm 渠道无关。
  const spec = manifest.files[key];
  if (!spec) throw new UnsupportedPlatform(key);

  const dest = binaryPathFor(manifest.version);
  log(`下载 ${binaryName()} · ${manifest.version} · ${mb(spec.size)}`);
  await downloadVerified(spec, dest, { onProgress });

  await writeFile(
    pointerPath(),
    JSON.stringify(
      {
        version: manifest.version,
        path: dest,
        platform: key,
        sha256: spec.sha256,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );

  return { path: dest, version: manifest.version, downloaded: true };
}

/** 供启动器/脚本复用：把异常翻译成一句人能看懂的话 */
export function explainError(e) {
  if (e instanceof UnsupportedPlatform) {
    return (
      `${e.message}。\n` +
      `  · 可以改用官方安装包：https://xiaobenben.net/download\n` +
      `  · 或自行构建：https://github.com/sji-xiaobenben/xiaobenben`
    );
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|HTTP 5\d\d/i.test(msg)) {
    return `${msg}\n  · 网络不通，可设置 XBB_MIRROR=<镜像地址> 后重试`;
  }
  return msg;
}
