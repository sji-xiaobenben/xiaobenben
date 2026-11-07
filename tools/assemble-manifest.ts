// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 组装自更新清单 manifest.json——CI 的 publish job 与本地应急发版
 * （tools/publish-local.sh）共用同一份逻辑，杜绝「两条路各算各的 sha256」。
 *
 * 用法:
 *   bun run tools/assemble-manifest.ts <artifactsDir> <version> <baseUrl>
 * 例:
 *   bun run tools/assemble-manifest.ts ./artifacts 0.4.12 https://dl.xiaobenben.net/releases/v0.4.12
 *
 * stdout = 纯 JSON（清单本体，未签名）；人读摘要走 stderr，方便 `> manifest.json` 直接落盘。
 *
 * 两条硬约束：
 * 1) 平台必须齐全。清单少一个平台 = 那个平台的用户再也查不到自己的产物，自更新静默失效
 *    （updater 会返回 no_artifact_for_<key>，用户侧毫无提示）。宁可整条流水线失败。
 * 2) 清单只放**被签名覆盖**的内容。签名载荷 = version + files，所以这里不得顺手加
 *    generatedAt / channel / rollout 之类的"人读字段"——未签名字段一旦被将来的客户端
 *    采信就是提权口子。调试信息请走 OSS 对象 Last-Modified 与 GitHub Release 存档。
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ManifestFiles } from "../src/update-payload";

const [dir, version, base] = process.argv.slice(2);
if (!dir || !version || !base) {
  console.error("用法: bun run tools/assemble-manifest.ts <artifactsDir> <version> <baseUrl>");
  process.exit(1);
}

/**
 * 产物名（平台段）→ updater 的 platform key。
 * 必须与 updater.ts 的 `${process.platform}-${process.arch}` 严格对齐，否则用户查不到产物。
 */
const ART_TO_KEY: Record<string, string> = {
  "windows-x64": "win32-x64",
  "linux-x64": "linux-x64",
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
};

/**
 * 本次必须齐全的平台。这个列表就是"哪些平台在承诺之内"的登记簿。
 *
 * darwin-x64（Intel Mac）2026-10-08 补回。它**没有** ort 向量旁路包（上游 onnxruntime-node
 * 不发 darwin/x64 原生绑定），所以只登记主产物、不登记 `ort-darwin-x64`。但正因如此它更
 * 必须留在这个列表里：一旦哪天流水线漏构建了它，该平台用户会**静默**失去整条更新通道
 * （updater 只返回 no_artifact_for_darwin-x64，用户侧毫无提示）——与"少一个平台"完全同级。
 */
const REQUIRED = ["windows-x64", "linux-x64", "darwin-arm64", "darwin-x64"];

/** 流式算 sha256 并返回字节数（不把几十 MB 整个读进内存） */
async function sha256OfFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of Bun.file(path).stream()) {
    const buf = chunk as Uint8Array;
    hash.update(buf);
    bytes += buf.byteLength;
  }
  return { sha256: hash.digest("hex"), bytes };
}

const files: ManifestFiles = {};
const seenMain = new Set<string>();
const names = readdirSync(dir)
  .filter((n) => !n.startsWith("."))
  .sort();

for (const name of names) {
  const ortMatch = /^xbb-ort-(.+)\.zip$/.exec(name);
  const mainMatch = ortMatch ? null : (/^xbb-(.+)\.exe$/.exec(name) ?? /^xbb-([a-z0-9][a-z0-9-]*)$/.exec(name));
  if (!ortMatch && !mainMatch) {
    console.error(`✗ 产物目录里有未识别文件：${name}——拒绝继续（重命名会让某个平台悄悄从清单里消失）`);
    process.exit(1);
  }

  const art = (ortMatch ? ortMatch[1] : mainMatch![1])!;
  const key = ART_TO_KEY[art];
  if (!key) {
    console.error(`✗ 未知平台产物 ${name}（平台段=${art}）——请先在 ART_TO_KEY 登记，否则它不会被清单收录`);
    process.exit(1);
  }

  const path = join(dir, name);
  const { sha256, bytes } = await sha256OfFile(path);
  const stated = statSync(path).size;
  if (bytes !== stated) {
    console.error(`✗ ${name} 读取字节数(${bytes}) 与 stat 大小(${stated}) 不一致——产物可能被截断`);
    process.exit(1);
  }

  if (ortMatch) {
    // 向量旁路包（onnxruntime 原生库）也纳入签名覆盖：将来 updater 支持更新它时，
    // 历史清单的可信基础已经就位，不必回头重签。今天的 updater 只按平台 key 取 exe，忽略这些条目。
    files[`ort-${key}`] = { url: `${base}/${name}`, sha256, size: bytes };
  } else {
    files[key] = { url: `${base}/${name}`, sha256, size: bytes };
    seenMain.add(art);
  }
}

const missing = REQUIRED.filter((a) => !seenMain.has(a));
if (missing.length > 0) {
  console.error(`✗ 缺失平台产物: ${missing.join(", ")}——清单缺平台等于该平台自更新静默失效，拒绝出包`);
  process.exit(1);
}

// 键排序只为人工 diff 好看；签名载荷（buildUpdatePayload）内部另有排序，不依赖此处顺序
const ordered: ManifestFiles = {};
for (const k of Object.keys(files).sort()) ordered[k] = files[k]!;

console.error(
  `[manifest] version=${version} · 条目=${Object.keys(ordered).length}` +
    ` · 平台=${[...seenMain].sort().join("/")} · base=${base}`
);
console.log(JSON.stringify({ version, files: ordered }, null, 2));
