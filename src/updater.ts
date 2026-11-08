// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 自更新（rename-swap）。
 *
 * 安全模型：清单带 ed25519 签名，公钥内置在 build-meta（见 UPDATE_PUBKEY 注释）。
 *   验签**排在版本比较之前** —— 未通过验签的清单不构成可信输入，连"版本号"都不该采信。
 *   失败一律 fail-closed（拒绝更新），绝不 fail-open。
 *
 * 生效模型：swap 只换磁盘文件，内存中进程仍跑旧代码 → 需重启才生效。
 *   默认只提示不自动重启：xbb serve 被多个 AI 宿主以 MCP 连着，擅自重启会掐断用户正在进行的会话。
 *
 * 回滚：swap 时把旧 exe 保留到备份路径并写 pending.json，由 update-rollback.ts 在下次启动做健康确认；
 *   确认失败的版本进黑名单（blocklist.json），避免"回滚 → 又自动装回 → 再崩"的死循环。
 *
 * Windows 纪律：运行中的 exe 不能删但能改名——旧 exe rename 成备份，新 exe 原子就位。
 * 全程永不 throw：更新失败只影响更新本身，绝不影响本地服务。
 */
import { programDir } from "./home";
import { createHash, createPublicKey, verify } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { VERSION as BUILD_VERSION, UPDATE_PUBKEY, UPDATE_URL_DEFAULT, IS_OFFICIAL_BUILD } from "./build-meta";
import { buildUpdatePayload, type ManifestFiles } from "./update-payload";

export interface UpdateManifest {
  version: string;
  files: ManifestFiles; // key = `${platform}-${arch}`
  /** ed25519 签名（base64），覆盖 buildUpdatePayload(version, files) */
  sig?: string;
}

export type UpdateStatus =
  | { status: "disabled" }
  | { status: "up_to_date"; version: string }
  | { status: "downloaded"; version: string; stagedPath: string }
  | { status: "swapped"; version: string; note: string }
  | { status: "failed"; reason: string };

/**
 * 轻量探测结果：只回答「有没有新版本」，不下载、不换文件。
 * 给「新会话提示」用——那条路径每次会话都可能走，绝不能顺手把 exe 换了。
 * 与 checkAndApply 共用同一条安全线（验签先于版本比较），只是止步于比较。
 */
export type ProbeOutcome =
  | { status: "disabled" }
  | { status: "up_to_date"; version: string }
  | { status: "available"; version: string }
  | { status: "failed"; reason: string };

/**
 * 版本真源 = 编译期注入的 build-meta.VERSION（CI 每次发版 sed 写入）。
 * 此前兜底 "0.0.0-dev" 而 XBB_VERSION 全仓无设置点 → 恒为 0.0.0-dev，
 * 与任何 manifest 比较都判「有新版本」。env 仅作显式覆盖（企业包可钉版本）。
 */
export const CURRENT_VERSION = process.env.XBB_VERSION ?? BUILD_VERSION;

const PENDING_FILE = "pending.json";
const BLOCKLIST_FILE = "blocklist.json";

/** 自更新工作目录：staging / 旧版备份 / pending 标记 / 黑名单 */
export function updateRoot(): string {
  return join(programDir(), "update");
}

/**
 * 解析生效的清单地址：env 覆盖 > 编译期默认。
 * 未设 env → 用 UPDATE_URL_DEFAULT（官方包开箱自更新）；
 * 设空串   → 返回 ""，即关闭（企业分发/离线场景零网络动作）；
 * 设值     → 用该值（私有镜像）。
 */
export function resolveUpdateUrl(): string {
  return process.env.XBB_UPDATE_URL ?? UPDATE_URL_DEFAULT;
}

/**
 * 这个产物有没有资格用「编译期内置的」更新源。
 *
 * 官方发版由 release.yml 把 BUILD_TIME 注入成真实时刻，本地构建与第三方构建保持 "local"
 * —— 所以 IS_OFFICIAL_BUILD 就是「这是不是我们自己发的版」。
 *
 * 非官方构建默认**不**自更新。原因不是安全，是身份：[`UPDATE_PUBKEY`] 和
 * [`UPDATE_URL_DEFAULT`] 都是编译期常量，fork 出来的产物把**官方的**公钥和 CDN
 * 一起编了进去。官方一发版，它就会在用户面前弹「要不要更新到 0.4.48」，用户点了，
 * 验签会通过（那本来就是官方签的），然后 fork 者的定制代码被官方 exe 顶掉。
 * 他继承的是我们发布链路的身份，但不该继承它的更新去向。
 *
 * 显式设了 `XBB_UPDATE_URL`（含空串）即放行：那是用户在明说「我知道我在连哪里」。
 * 空串随后会在 `resolveUpdateUrl()` 那层变成「关闭」——两件事各管各的，不冲突。
 */
export function usesBuiltinUpdateSource(): boolean {
  return process.env.XBB_UPDATE_URL !== undefined || IS_OFFICIAL_BUILD;
}

/**
 * 实际取清单用的 URL。
 * 官方 CDN 入口追加 `?v=<当前版本>` 做缓存击穿：CDN 一旦把 stable.json 缓存住（默认规则、
 * 或有人误配了目录缓存），全量用户的自更新会**静默冻结**——服务端正常、CI 全绿、上传成功，
 * 只有客户端永远"已是最新"，几乎无从定位。带上版本参数后，每次版本跃迁必然换 key 取到新清单，
 * 把"永久冻结"降级成"至多滞后一个版本"。
 * 企业私有镜像**刻意不加**：它可能是预签名 URL，追加任何参数都会破坏签名。
 */
function manifestUrl(base: string): string {
  if (process.env.XBB_UPDATE_URL) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}v=${encodeURIComponent(CURRENT_VERSION)}`;
}

let cachedPubKey: ReturnType<typeof createPublicKey> | null = null;

function updatePublicKey(b64: string): ReturnType<typeof createPublicKey> {
  // 内置公钥走缓存；测试注入的临时公钥不缓存
  if (b64 === UPDATE_PUBKEY && cachedPubKey) return cachedPubKey;
  const key = createPublicKey({
    key: Buffer.from(b64, "base64"),
    format: "der",
    type: "spki",
  });
  if (b64 === UPDATE_PUBKEY) cachedPubKey = key;
  return key;
}

/**
 * 校验 manifest 的 ed25519 签名；任何异常一律判不通过（fail-closed）。
 * pubKeyB64 默认用内置公钥；冒烟测试可注入临时公钥，从而不必持有真实私钥。
 */
export function verifyManifestSignature(manifest: UpdateManifest, pubKeyB64 = UPDATE_PUBKEY): boolean {
  try {
    if (!manifest?.sig || typeof manifest.version !== "string" || typeof manifest.files !== "object") {
      return false;
    }
    const payload = Buffer.from(buildUpdatePayload(manifest.version, manifest.files), "utf8");
    return verify(null, payload, updatePublicKey(pubKeyB64), Buffer.from(manifest.sig, "base64"));
  } catch {
    return false;
  }
}

export interface BlocklistEntry {
  version: string;
  at: string;
  reason?: string;
}

/** 读取回滚黑名单（读不到就当空表——黑名单失效不该阻断更新通道） */
export function readBlocklist(): BlocklistEntry[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(updateRoot(), BLOCKLIST_FILE), "utf8"));
    return Array.isArray(raw) ? (raw as BlocklistEntry[]) : [];
  } catch {
    return [];
  }
}

/** 把某版本拉黑（由 update-rollback.ts 在判定启动失败后调用）。滚动保留最近 10 条。 */
export function addToBlocklist(version: string, reason: string): void {
  try {
    const root = updateRoot();
    mkdirSync(root, { recursive: true });
    const list = readBlocklist().filter((e) => e.version !== version);
    list.push({ version, at: new Date().toISOString(), reason });
    writeFileSync(join(root, BLOCKLIST_FILE), JSON.stringify(list.slice(-10), null, 2));
  } catch {
    /* 黑名单写不进不该影响主流程 */
  }
}

export function pendingPath(): string {
  return join(updateRoot(), PENDING_FILE);
}

/** 当前可执行文件路径（bun build --compile 后 process.execPath 即 exe 本体） */
function currentExe(): string {
  return process.execPath;
}

/**
 * 是否运行在编译后的单文件 exe 里。
 * **这道闸是保命的**：`bun run src/index.ts` 形态下 process.execPath 是 bun 运行时本体，
 * 一旦触发 swap，rename 的是用户的 bun —— 等于把开发环境搞坏。
 *
 * 编译形态下 import.meta.dir 落在 bun 的虚拟文件系统里，但两侧路径形态不同
 * （实测 Bun 1.4.2，见 dev-ops-conventions）：
 *   · POSIX（linux/macOS）：`/$bunfs/root`
 *   · Windows：`<盘符>:\~BUN\root`
 * 此前只判 `/$bunfs`，导致 **Windows 编译产物恒判为非编译形态** → 自更新在 Windows 上
 * 永远 `not_compiled_exe`；而 probeLatest 不查这道闸，于是「提示有新版本」照常弹、
 * 用户一点更新必然失败。dir 参数可注入，便于测试覆盖两条路径形态。
 */
export function isCompiledExe(dir: string = import.meta.dir): boolean {
  return dir.startsWith("/$bunfs") || /^[A-Za-z]:[\\/]~BUN([\\/]|$)/i.test(dir);
}

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

/** 宽松版本比较（semver 子集：x.y.z[-prereq]）；b > a 返回 true */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(/[-.]/).filter(Boolean);
  const pb = b.split(/[-.]/).filter(Boolean);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i]);
    const y = Number(pb[i]);
    if (!Number.isNaN(x) && !Number.isNaN(y)) {
      if (y !== x) return y > x;
    } else if (pb[i] !== pa[i]) {
      return (pb[i] ?? "") > (pa[i] ?? "");
    }
  }
  return false;
}

/**
 * 只探测、不落地：取清单 → 验签 → 比版本。全程不写文件、不换 exe。
 *
 * 与 checkAndApply 的关系：**共用同一条安全线**（验签必须先于版本比较，
 * 未验签的清单连版本号都不采信），区别只在止步点。刻意不复用 checkAndApply，
 * 因为后者的语义里含有"下载并替换 exe"——让一条每次会话都跑的路径持有那种能力，
 * 迟早会有人在它上面加个 `apply: true` 就出事。
 */
export async function probeLatest(timeoutMs = 8_000): Promise<ProbeOutcome> {
  const url = resolveUpdateUrl();
  if (!url) return { status: "disabled" };
  try {
    const manifest = (await fetchJson([manifestUrl(url)], timeoutMs)) as UpdateManifest | null;
    if (!manifest?.version || typeof manifest.files !== "object") {
      return { status: "failed", reason: "bad_manifest" };
    }
    if (!verifyManifestSignature(manifest)) {
      return { status: "failed", reason: "bad_signature" };
    }
    return isNewer(CURRENT_VERSION, manifest.version)
      ? { status: "available", version: manifest.version }
      : { status: "up_to_date", version: manifest.version };
  } catch (e) {
    return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchJson(urls: string[], timeoutMs = 15_000): Promise<unknown> {
  let lastErr: unknown = null;
  for (const u of urls) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("all sources failed");
}

async function downloadVerified(url: string, dest: string, sha256: string, size: number, timeoutMs = 600_000): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`);
  // mode 只作为初值（仍受 umask 影响），真正保证可执行位的是 swap 前那次 chmodSync：
  // 下载流不会保留源文件的权限，缺了执行位则新 exe 在 Linux/macOS 上起不来。
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest, { mode: 0o755 }));
  const st = statSync(dest);
  if (st.size !== size) throw new Error(`size mismatch: ${st.size} != ${size}`);
  const hash = createHash("sha256");
  hash.update(Buffer.from(await Bun.file(dest).arrayBuffer()));
  if (hash.digest("hex") !== sha256) throw new Error("sha256 mismatch");
}

/** 清理更早的旧版备份，只留本次那份（被运行中进程占用的删不掉，忽略） */
function prunePrevious(root: string, keep: string): void {
  try {
    for (const f of readdirSync(root)) {
      if (!f.startsWith("xbb-previous-")) continue;
      const p = join(root, f);
      if (p === keep) continue;
      try {
        unlinkSync(p);
      } catch {
        /* 仍被旧进程占用 —— 留待下次 */
      }
    }
  } catch {
    /* 清理失败不影响更新结果 */
  }
}

export class Updater {
  private checking = false;

  get enabled(): boolean {
    return !!resolveUpdateUrl() && usesBuiltinUpdateSource();
  }

  /**
   * 检查并更新（manual=托盘触发时给用户日志反馈；后台轮询静默）。
   * swapped 后需要用户重启（旧 exe 已备份，新 exe 已就位）——不自动重启：服务中断要用户知情。
   */
  async checkAndApply(manual = false): Promise<UpdateStatus> {
    const url = resolveUpdateUrl();
    if (!url) {
      if (manual) console.log("[update] 自更新已关闭（XBB_UPDATE_URL 为空）");
      return { status: "disabled" };
    }
    if (!usesBuiltinUpdateSource()) {
      // 刻意不是 "failed"：没有出任何错，是这个产物不该自动更新。
      // 提示要给出「想连官方源」的完整命令，否则用户只会看到一句「关了」而无从下手。
      if (manual) {
        console.log("[update] 本地构建：自更新默认关闭");
        console.log("         本产物内置的是官方更新源与签名公钥，自动更新会把你的构建换成官方 exe。");
        console.log(`         确实要连官方源：XBB_UPDATE_URL=${UPDATE_URL_DEFAULT}`);
      }
      return { status: "disabled" };
    }
    if (this.checking) return { status: "failed", reason: "already_checking" };
    this.checking = true;
    try {
      // 保命闸：非编译产物下 process.execPath 是 bun 本体，swap 会毁掉开发环境（见 isCompiledExe 注释）
      if (!isCompiledExe()) {
        if (manual) console.log("[update] 当前非编译产物（dev 运行），自更新不适用");
        return { status: "failed", reason: "not_compiled_exe" };
      }
      const manifest = (await fetchJson([manifestUrl(url)])) as UpdateManifest | null;
      if (!manifest?.version || typeof manifest.files !== "object") {
        return { status: "failed", reason: "bad_manifest" };
      }
      // 验签必须先于版本比较：未通过验签的清单连版本号都不该采信
      if (!verifyManifestSignature(manifest)) {
        console.warn("[update] 清单验签失败 —— 已拒绝更新（源可能被劫持，或签名密钥已轮换）");
        return { status: "failed", reason: "bad_signature" };
      }
      // 曾被回滚的版本不再**自动**装回，避免「回滚 → 又装 → 再崩」死循环。
      // 但手动检查更新（托盘）刻意放行：黑名单有可能来自一次误判（如确认点前被强杀），
      // 用户主动重试的意图应当被尊重——这是人类可介入的逃生口。
      if (!manual && readBlocklist().some((e) => e.version === manifest.version)) {
        return { status: "failed", reason: "version_blocklisted" };
      }
      if (!isNewer(CURRENT_VERSION, manifest.version)) {
        if (manual) console.log(`[update] 已是最新（${CURRENT_VERSION}）`);
        return { status: "up_to_date", version: manifest.version };
      }
      const spec = manifest.files[platformKey()];
      if (!spec) return { status: "failed", reason: `no_artifact_for_${platformKey()}` };

      const root = updateRoot();
      mkdirSync(root, { recursive: true });
      const ext = process.platform === "win32" ? ".exe" : "";
      const staged = join(root, `xbb-${manifest.version}${ext}`);
      if (!existsSync(staged)) {
        const urls = spec.urls?.length ? spec.urls : [spec.url];
        let ok = false;
        for (const u of urls) {
          try {
            await downloadVerified(u, staged, spec.sha256, spec.size);
            ok = true;
            break;
          } catch (e) {
            console.warn(`[update] 源失败 ${u}: ${e instanceof Error ? e.message : e}`);
          }
        }
        if (!ok) return { status: "failed", reason: "download_failed" };
      }

      // 可执行位：下载/落盘不保留源文件 mode（createWriteStream 默认 0644 且受 umask 影响）。
      // 不置位则 swap 后就位的 exe 在 Linux/macOS 上无法启动（Permission denied）——
      // Windows 无此概念，跳过。刻意放在 rename 之前：置位失败即抛错，被外层 catch 接住，
      // 此时旧 exe 还没动过，用户只是更新失败，而不是换上一个起不来的新 exe。
      if (process.platform !== "win32") chmodSync(staged, 0o755);

      // rename-swap：旧 exe 改名让位（同卷 rename = 原子）→ 新 exe 就位。
      // 旧 exe 不再删进临时目录，而是留在备份路径——update-rollback.ts 启动失败时要靠它回退。
      const exe = currentExe();
      const prevPath = join(root, `xbb-previous-${Date.now()}${ext}`);
      try {
        renameSync(exe, prevPath);
      } catch (e) {
        return { status: "failed", reason: `rename_running_exe: ${e instanceof Error ? e.message : e}` };
      }
      try {
        renameSync(staged, exe);
      } catch (e) {
        renameSync(prevPath, exe); // 回滚：旧 exe 归位，服务照旧
        return { status: "failed", reason: `swap: ${e instanceof Error ? e.message : e}` };
      }
      try {
        // attempts=0：新版还一次都没跑过。启动侧据此区分「新版自己的首次引导」
        // 与「新版启动失败后的下一次启动」——见 update-rollback.ts 的 decideBootAction。
        writeFileSync(
          pendingPath(),
          JSON.stringify({ version: manifest.version, prev: prevPath, at: new Date().toISOString(), attempts: 0 }, null, 2)
        );
      } catch {
        /* 标记写不进 = 丧失自动回滚能力，但不该阻断更新本身 */
      }
      prunePrevious(root, prevPath);

      const note = "新版本已就位，重启 xbb 生效";
      console.log(`[update] ${note}: ${CURRENT_VERSION} → ${manifest.version}`);
      return { status: "swapped", version: manifest.version, note };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn(`[update] 检查失败（不影响服务）: ${reason}`);
      return { status: "failed", reason };
    } finally {
      this.checking = false;
    }
  }
}
