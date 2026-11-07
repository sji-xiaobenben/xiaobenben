/**
 * 首启静默下载——模型获取基建（与推理运行时解耦，先落"下载"这一半）。
 *
 * 红线（全部固化，违反即返工）：
 * - 调用点永不 throw：任何失败降级为 { status:"failed" }，纯 FTS 照跑（双降级）
 * - sha256 流式校验通过才原子落盘，绝不留半截模型（staging 目录 + rename）
 * - .ok 标记 = manifest JSON 快照（全文件唯一约定，三处读写对齐）：
 *   ① TTL 内零请求  ② 文件 size 对账  ③ 过期后解析比对版本，没变 touch 续期
 * - 多源 fallback：manifest 与文件各支持多 URL，逐源尝试
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, renameSync, statSync, utimesSync } from "node:fs";
import { join, dirname } from "node:path";

export type ModelFileSpec = {
  /** 相对模型目录的文件名（如 model.int8.onnx） */
  name: string;
  /** 内容 sha256（64 位 hex，小写） */
  sha256: string;
  /** 预期字节数（缓存命中快速校验用） */
  size: number;
  /** 下载源列表，按优先级排列 */
  urls: string[];
};

export type ModelManifest = {
  name: string;
  version: string;
  files: ModelFileSpec[];
};

export type EnsureResult =
  | { status: "cached"; dir: string }
  | { status: "downloaded"; dir: string; bytes: number }
  | { status: "failed"; reason: string };

const HEX64 = /^[0-9a-f]{64}$/;
/** .ok 标记文件名（目录内），内容 = manifest JSON 快照 */
const OK_MARKER = ".ok";

type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** manifest 结构校验：不合法返回 null（不抛错） */
export function parseManifest(json: unknown): ModelManifest | null {
  if (typeof json !== "object" || json === null) return null;
  const m = json as Record<string, unknown>;
  if (typeof m.name !== "string" || m.name.length === 0) return null;
  if (typeof m.version !== "string" || m.version.length === 0) return null;
  if (!Array.isArray(m.files) || m.files.length === 0) return null;
  const files: ModelFileSpec[] = [];
  for (const f of m.files) {
    const s = f as Record<string, unknown>;
    if (typeof s.name !== "string" || s.name.length === 0) return null;
    if (typeof s.sha256 !== "string" || !HEX64.test(s.sha256)) return null;
    if (typeof s.size !== "number" || s.size < 0 || !Number.isFinite(s.size)) return null;
    if (!Array.isArray(s.urls) || s.urls.length === 0 || s.urls.some((u) => typeof u !== "string" || u.length === 0)) return null;
    files.push({ name: s.name, sha256: s.sha256, size: s.size, urls: s.urls as string[] });
  }
  return { name: m.name, version: m.version, files };
}

/** 文件 sha256（流式，不整读进内存） */
export async function sha256File(path: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** manifest 稳定哈希（JSON 序列化后 sha256，用于过期快照与新版比对） */
function manifestHash(m: ModelManifest): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(m)).digest("hex");
}

/**
 * 确保模型就位。input 可为 manifest 对象或 manifest URL（单个或多个，逐源尝试）。
 * 永不 throw；失败一律 { status:"failed", reason }。
 * ttlMs：.ok 新鲜度窗口（默认 24h），窗口内直接 cached 零请求。
 */
export async function ensureModel(
  input: string | string[] | ModelManifest,
  dir: string,
  opts: { ttlMs?: number; timeoutMs?: number; fetchImpl?: FetchFn } = {},
): Promise<EnsureResult> {
  const ttlMs = opts.ttlMs ?? 24 * 3600_000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const doFetch: FetchFn = opts.fetchImpl ?? ((u, init) => fetch(u, init));

  try {
    // ① TTL 内已有合格缓存 → 零请求直接返回
    if (cachedValid(dir, ttlMs)) return { status: "cached", dir };

    // ② 解析 manifest（URL 逐源尝试；对象直接用）
    const manifest = await resolveManifest(input, doFetch, timeoutMs);
    if (manifest === null) return { status: "failed", reason: "manifest 不可用（拉取失败或结构非法）" };

    // ③ .ok 存在但 TTL 过期 → 解析快照比对版本：没变就 touch 续期，省一次重下
    const okPath = join(dir, OK_MARKER);
    if (existsSync(okPath)) {
      try {
        const prev = parseManifest(JSON.parse(readFileSync(okPath, "utf8")));
        if (prev !== null && manifestHash(prev) === manifestHash(manifest) && filesIntact(dir, manifest)) {
          utimesSync(okPath, new Date(), new Date()); // touch：mtime 刷新续 TTL
          return { status: "cached", dir };
        }
      } catch {
        // .ok 损坏 → 视为不存在，走全量重下（自愈）
      }
    }

    // ④ 全新下载到 staging，全部校验通过再原子 rename
    const bytes = await downloadAll(manifest, dir, doFetch, timeoutMs);
    return { status: "downloaded", dir, bytes };
  } catch (e) {
    return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 缓存命中判定：.ok 存在 + mtime 在 TTL 内 + 快照可解析 + 全部文件 size 一致 */
function cachedValid(dir: string, ttlMs: number): boolean {
  const okPath = join(dir, OK_MARKER);
  if (!existsSync(okPath)) return false;
  try {
    const age = Date.now() - statSync(okPath).mtimeMs;
    if (age > ttlMs) return false;
    const manifest = parseManifest(JSON.parse(readFileSync(okPath, "utf8")));
    return manifest !== null && filesIntact(dir, manifest);
  } catch {
    return false;
  }
}

/** .ok 里存的 manifest 与磁盘文件对账（size 快校验） */
function filesIntact(dir: string, manifest: ModelManifest): boolean {
  try {
    return manifest.files.every((f) => {
      const p = join(dir, f.name);
      return existsSync(p) && statSync(p).size === f.size;
    });
  } catch {
    return false;
  }
}

async function resolveManifest(input: string | string[] | ModelManifest, doFetch: FetchFn, timeoutMs: number): Promise<ModelManifest | null> {
  if (typeof input === "object" && !Array.isArray(input)) return parseManifest(JSON.parse(JSON.stringify(input)));
  const sources = Array.isArray(input) ? input : [input];
  for (const url of sources) {
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      const parsed = parseManifest(await res.json());
      if (parsed) return parsed;
    } catch {
      // 换下一个源
    }
  }
  return null;
}

/** 下载全部文件到 staging → 校验 → rename。任一文件所有源都失败则整体 failed 并清理 staging。 */
async function downloadAll(manifest: ModelManifest, dir: string, doFetch: FetchFn, timeoutMs: number): Promise<number> {
  const staging = `${dir}.staging-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    mkdirSync(staging, { recursive: true });
    let bytes = 0;
    for (const f of manifest.files) {
      const ok = await downloadOne(f, join(staging, f.name), doFetch, timeoutMs);
      if (!ok) return fail(`文件 ${f.name} 所有源均失败（sha/size 不符或网络错误）`);
      bytes += f.size;
    }
    // 原子换装：旧目录先移除（Windows rename 不覆盖已存在目录）
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    renameSync(staging, dir);
    writeFileSync(join(dir, OK_MARKER), JSON.stringify(manifest)); // .ok = manifest 快照（唯一约定）
    return bytes;
  } finally {
    rmSync(staging, { recursive: true, force: true }); // 失败/异常路径清理半成品
  }

  function fail(reason: string): never {
    throw new Error(reason);
  }
}

/** 单文件：逐 URL 尝试，流式写盘并同步算 sha256，size/sha 双校验 */
async function downloadOne(f: ModelFileSpec, dest: string, doFetch: FetchFn, timeoutMs: number): Promise<boolean> {
  for (const url of f.urls) {
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok || !res.body) continue;
      const h = new Bun.CryptoHasher("sha256");
      let size = 0;
      const chunks: Buffer[] = [];
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        h.update(buf);
        chunks.push(buf);
        size += buf.length;
      }
      if (size !== f.size || h.digest("hex") !== f.sha256) continue; // 校验不过换下个源
      writeFileSync(dest, Buffer.concat(chunks));
      return true;
    } catch {
      // 换下一个源
    }
  }
  return false;
}
