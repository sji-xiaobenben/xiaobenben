/**
 * 本地向量推理（个人版直上，2026-10-04 定稿）。
 * 实现：bge-small-zh-v1.5 INT8 + 纯 JS WordPiece。
 *
 * 红线（与 server 同一纪律）：
 *  - 双降级：模型缺失/加载失败/推理异常 → embed() 返回 null → 明文照存/检索纯词法，永不因模型故障挂
 *  - 模型首启静默下载：cli models.ts 基建接线（sha256 双校验 + staging 原子落盘），失败静默重试
 *  - 加载：compile exe 走旁路 ort-bundle.cjs（PoC 定案：createRequire 绝对路径，
 *    bundle 内联全部 JS 依赖、binding.node 相对路径命中真实 DLL）；bun 开发模式直接 import
 *  - vec_model 列 = 坐标系账本（换模型=全库重算）
 */
import { modelsDir } from "./home";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { ensureModel, type ModelManifest } from "./models";

export const EMBED_DIM = 512;
export const VEC_MODEL = "bge-small-zh-v1.5/int8";

/** 模型清单（sha256 与 server 侧一致；多源：hf-mirror → huggingface） */
export const BGE_MANIFEST: ModelManifest = {
  name: "bge-small-zh-v1.5-int8",
  version: "1",
  files: [
    {
      name: "model_quantized.onnx",
      sha256: "15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc",
      size: 24_010_842,
      urls: [
        "https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx",
        "https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx",
      ],
    },
    {
      name: "tokenizer.json",
      sha256: "48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26",
      size: 439_125,
      urls: [
        "https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/tokenizer.json",
        "https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/tokenizer.json",
      ],
    },
  ],
};

export function defaultModelDir(): string {
  // 模型属**数据资产**（24MB、重下要等），跟数据目录走而不是程序目录
  return process.env.XBB_MODEL_DIR ?? join(modelsDir(), BGE_MANIFEST.name);
}

/** 持有 dlopen 句柄，防止 GC 触发 dlclose 把预加载的 DLL 卸掉（不 close 是刻意的：常驻正是本意） */
let pinnedOrtHandle: unknown = null;

/** 系统目录里是否有同名 ORT（Win11 24H2+ 的 Windows ML 会预装 1.17，API 17） */
function systemOrtPath(): string | null {
  // ⚠️ 用 `||` 不是 `??`：宿主净化 env 时 SystemRoot 可能是空串，空串 join 出来是相对路径，
  //    那会让这条判定静默失效，等于把整个修复关掉
  const p = join(process.env.SystemRoot || "C:\\Windows", "System32", "onnxruntime.dll");
  return existsSync(p) ? p : null;
}

/**
 * 在旁路包里定位 `bin/<napi>/win32/<arch>/onnxruntime.dll`，找不到返回 null。
 *
 * 两条防错：
 *  · `readdirSync` 不保证顺序 → 按 napi 版本号降序取，多目录时优先钉高版本
 *    （钉到低版本 DLL 的症状与本次的 bug 一模一样，而预检看不见——那是我们自己加载的）
 *  · 同目录必须还有 `onnxruntime_binding.node` 才算命中（只有 DLL 的残包不能用）
 */
export function findBundledOrtDir(pkg: string): string | null {
  const binRoot = join(pkg, "bin");
  if (!existsSync(binRoot)) return null;
  try {
    const cands = readdirSync(binRoot)
      .filter((d) => /^napi-v\d+$/.test(d))
      .sort((a, b) => Number(b.slice(6)) - Number(a.slice(6)));
    for (const napi of cands) {
      const dir = join(binRoot, napi, "win32", process.arch);
      if (existsSync(join(dir, "onnxruntime.dll")) && existsSync(join(dir, "onnxruntime_binding.node"))) {
        return dir;
      }
    }
  } catch {
    /* 目录不可读 → 当没有 */
  }
  return null;
}

/** 窄字符串 → Windows 的 LPCWSTR（UTF-16LE + NUL），交给 ffi 当 ptr 用 */
function wstr(s: string): Buffer {
  return Buffer.from(`${s}\0`, "utf16le");
}

export type PinResult = {
  /** 调用即回滚 DLL 搜索路径 */
  restore: () => void;
  /** false = 检测到「同名 DLL 已被别人抢先」→ 调用方必须放弃而不是硬 require（硬 require 会在原生层崩） */
  safe: boolean;
  /** 诊断信息，进 stderr */
  detail: string;
};

/**
 * Windows 专用：把旁路包自带的 ORT 原生库钉在 System32 之前。
 *
 * 背景（2026-10-23 真实用户反馈，v0.4.40 / Win11 Home China 26300）：
 * Win11 24H2+ 的 Windows ML 会在 `C:\Windows\System32` 预装 `onnxruntime.dll`（1.17，
 * `ORT_API_VERSION=17`），而捆绑的 onnxruntime-node 1.30 的 binding 要求 API 30。
 * DLL 搜索顺序一旦命中 System32 那份，ORT 在**原生层直接 abort**，进程当场死，
 * 外层 try/catch 根本执行不到 —— 原降级设计只挡住了「找不到」，挡不住「找错了」。
 *
 * 三道防线：
 *   ⓿ **预检（不可删）**：进程里已有同名模块但路径不是旁路包 → 立即判 unsafe，绝不 require。
 *      实测：Windows 对「同名不同绝对路径」会加载出**第二份映射**（符号地址不同），
 *      而 binding.node 按 base name 加载时只会复用第一份 —— 所以我们必须是第一个加载者；
 *      一旦别人抢先，② 也救不回来，只能放弃。
 *   ① `SetDllDirectoryW(旁路包目录)` —— 插入顺序在 System32 之前，连带覆盖同级的
 *      DirectML.dll / dxcompiler.dll / dxil.dll；复位时还原**原值**（SetDllDirectory 只有一个槽位，
 *      清成 null 会抹掉别人设的目录）。
 *   ② `dlopen(绝对路径, { OrtGetApiBase })` —— 预占模块名。OrtGetApiBase 是 ORT C API 的固定入口，
 *      能证明「这是真 ORT 而不是 stub」，但**不能**证明 API 版本是 30（1.17 也有该符号）。
 *
 * safe 的判定原则：**只要「系统里存在同名 ORT」且「我们没能把自己的那份钉进去」，就判 unsafe。**
 * 宁可退化成纯词法检索，也绝不让进程在原生层崩掉 —— 用户丢的是 mcp 入口，不是向量。
 */
export async function pinBundledOrt(pkg: string): Promise<PinResult> {
  const noop = () => {};
  if (process.platform !== "win32") return { restore: noop, safe: true, detail: "non-win32" };

  const ortDir = findBundledOrtDir(pkg);
  const sysOrt = systemOrtPath();

  // 没有自带 ORT：系统那份会坑我们 ⇒ 判 unsafe；系统也没有 ⇒ require 只会失败，不会崩
  if (!ortDir) {
    return sysOrt
      ? { restore: noop, safe: false, detail: `no-bundled-ort + system-ort(${sysOrt})` }
      : { restore: noop, safe: true, detail: "no-bundled-ort, no-system-ort" };
  }

  const target = join(ortDir, "onnxruntime.dll");
  const targetDir = dirname(target);
  let restore = noop;

  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const api = dlopen("kernel32.dll", {
      SetDllDirectoryW: { args: [FFIType.ptr], returns: FFIType.bool },
      GetDllDirectoryW: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
      GetModuleHandleW: { args: [FFIType.ptr], returns: FFIType.ptr },
      GetModuleFileNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
      GetLongPathNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    });
    const sym = api.symbols as Record<string, (...a: never[]) => unknown>;
    const setDir = sym.SetDllDirectoryW as unknown as (p: unknown) => boolean;
    const getDir = sym.GetDllDirectoryW as unknown as (n: number, buf: unknown) => number;
    const getHandle = sym.GetModuleHandleW as unknown as (p: unknown) => unknown;
    const getPath = sym.GetModuleFileNameW as unknown as (h: unknown, buf: unknown, n: number) => number;
    const getLong = sym.GetLongPathNameW as unknown as (src: unknown, buf: unknown, n: number) => number;

    /**
     * 长路径归一化。
     * ⚠️ 必须做：`GetModuleFileNameW` 返回的是**加载时传入的形态**，实测会给出 8.3 短路径
     * （`C:\Users\USERNA~1\...`）。拿它跟长路径 `startsWith` 比 ⇒ 误判「被抢占」⇒
     * 白白关掉向量通道。反过来若 exe 从短路径启动，process.execPath 也是短路径，同样要比。
     */
    const toLong = (p: string): string => {
      try {
        const CAP = 2048;
        const buf = Buffer.alloc(CAP * 2);
        const n = getLong(wstr(p), buf, CAP);
        if (n > 0 && n < CAP) return buf.toString("utf16le", 0, n * 2);
      } catch {
        /* 归一化失败就用原值 */
      }
      return p;
    };

    /** 进程内当前 onnxruntime.dll 的真实路径；未加载或路径被截断 → null（不拿半截路径做判断） */
    const loadedPath = (): string | null => {
      const h = getHandle(wstr("onnxruntime.dll"));
      if (!h) return null;
      const CAP = 1024;
      const buf = Buffer.alloc(CAP * 2);
      const n = getPath(h, buf, CAP);
      if (n <= 0 || n >= CAP) return null;
      return buf.toString("utf16le", 0, n * 2);
    };
    /** 严格判定：两边都归一化成**长路径**再比，且带分隔符（避免 `...\x64` 命中 `...\x64-old`） */
    const inOurs = (p: string): boolean =>
      toLong(p).toLowerCase().startsWith(`${toLong(targetDir).toLowerCase()}\\`);

    // ⓿ 预检
    const before = loadedPath();
    if (before && !inOurs(before)) {
      return { restore: noop, safe: false, detail: `preempted: ${before}` };
    }

    // ① 备份原值 → 设置 → 复位还原原值
    let prevDir = "";
    try {
      const pb = Buffer.alloc(2048);
      const pn = getDir(1024, pb);
      if (pn > 0) prevDir = pb.toString("utf16le", 0, pn * 2);
    } catch {
      /* 取不到原值就当空，复位时清空 */
    }
    setDir(wstr(ortDir));
    restore = () => {
      try {
        setDir(prevDir ? wstr(prevDir) : null);
      } catch {
        process.stderr.write(`[xbb] SetDllDirectory 复位失败，搜索路径残留 ${ortDir}\n`);
      }
    };

    // ② 预加载，占住模块名
    //    单独 catch：这一步失败意味着「我们自己的 DLL 都加载不了」，
    //    无论系统有没有同名 ORT 都必须判 unsafe —— 否则就是拿"注定失败"去赌一把
    try {
      pinnedOrtHandle = dlopen(target, {
        OrtGetApiBase: { args: [], returns: FFIType.ptr },
      });
    } catch (e) {
      return { restore, safe: false, detail: `bundled-ort-unloadable: ${String(e).slice(0, 100)}` };
    }

    const after = loadedPath();
    if (!after) {
      return {
        restore,
        safe: false,
        detail: `pin-unverifiable${sysOrt ? ` + system-ort(${sysOrt})` : ""}`,
      };
    }
    if (!inOurs(after)) {
      return { restore, safe: false, detail: `pin-failed: ${after}` };
    }
    return { restore, safe: true, detail: after };
  } catch (e) {
    // ffi 不可用 / kernel32 符号缺失 / 预加载被拒 = 三道防线全失效。
    // 此时系统若有一份同名 ORT，硬 require 就是用户报的那个崩溃 → 必须降级。
    return {
      restore,
      safe: !sysOrt,
      detail: `ffi-unavailable${sysOrt ? ` + system-ort(${sysOrt})` : ""}: ${String(e).slice(0, 100)}`,
    };
  }
}

/**
 * 从指定旁路包目录加载 ORT（可测、可复用；`loadOrt` 是它的 exe 路径版）。
 * 返回 null = 放弃向量通道（不 throw，绝不把进程带崩）。
 */
export async function loadOrtFromPkg(pkg: string): Promise<typeof import("onnxruntime-node") | null> {
  const bundle = join(pkg, "dist", "ort-bundle.cjs");
  if (!existsSync(bundle)) return null;
  // Windows：先钉住自带 ORT，再 require —— 顺序不能反
  const pin = await pinBundledOrt(pkg);
  if (process.env.XBB_DEBUG_ORT) {
    process.stderr.write(`[xbb] ort pin: safe=${pin.safe} ${pin.detail}\n`);
  }
  if (!pin.safe) {
    pin.restore(); // pin-failed 分支可能已改过搜索路径，退出前必须复位
    process.stderr.write(`[xbb] 向量通道跳过（ORT 原生库不可用/被占用）：${pin.detail}\n`);
    return null;
  }
  try {
    const req = createRequire(join(pkg, "package.json"));
    return req(bundle) as typeof import("onnxruntime-node");
  } catch {
    // 契约就是「不 throw，失败返回 null」——产品侧不接 unhandled rejection
    return null;
  } finally {
    pin.restore();
  }
}

/** compile exe 旁路加载（PoC ort-embed3.ts 定案路径）；开发模式 fallback import */
export async function loadOrt(): Promise<typeof import("onnxruntime-node") | null> {
  try {
    const pkg = join(dirname(process.execPath), "node_modules", "onnxruntime-node");
    if (existsSync(join(pkg, "dist", "ort-bundle.cjs"))) return await loadOrtFromPkg(pkg);
    return await import("onnxruntime-node");
  } catch {
    return null;
  }
}

// ── tokenizer（BertNormalizer + BertPreTokenizer + WordPiece，server 同款已验证实现）──

type Vocab = Record<string, number>;

function basicTokenize(text: string): string[] {
  const cleaned = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const spaced = cleaned.replace(/([\u4e00-\u9fff\u3400-\u4dbf])/g, " $1 ").replace(/[\u0000-\u001f]/g, " ");
  const out: string[] = [];
  for (const word of spaced.split(/\s+/).filter(Boolean)) {
    let buf = "";
    for (const ch of word) {
      if (/[\u2000-\u206f\u3000-\u303f!-/:-@\[-`{-~]/.test(ch)) {
        if (buf) { out.push(buf); buf = ""; }
        out.push(ch);
      } else buf += ch;
    }
    if (buf) out.push(buf);
  }
  return out;
}

function wordpiece(word: string, vocab: Vocab, unk: number): number[] {
  if (word.length > 100) return [unk];
  const ids: number[] = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let id: number | undefined;
    while (start < end) {
      id = vocab[(start === 0 ? "" : "##") + word.slice(start, end)];
      if (id !== undefined) break;
      end--;
    }
    if (id === undefined) return [unk];
    ids.push(id);
    start = end;
  }
  return ids;
}

// ── 单例 Embedder ──

type OrtModule = typeof import("onnxruntime-node");

class Embedder {
  private session: import("onnxruntime-node").InferenceSession | null = null;
  private ort: OrtModule | null = null;
  private vocab: Vocab | null = null;
  private cls = 0;
  private sep = 0;
  private unk = 0;
  status: "idle" | "loading" | "ready" | "failed" = "idle";
  private loading: Promise<boolean> | null = null;

  /** 加载（幂等；失败置 failed 并返回 false，绝不 throw） */
  load(dir: string = defaultModelDir()): Promise<boolean> {
    if (this.status === "ready") return Promise.resolve(true);
    if (this.status === "loading") return this.loading ?? Promise.resolve(false);
    this.status = "loading";
    this.loading = (async () => {
      try {
        const ok = await ensureModel(BGE_MANIFEST, dir);
        if (!ok) { this.status = "failed"; return false; }
        const ort = await loadOrt();
        if (!ort) { this.status = "failed"; return false; }
        this.ort = ort;
        this.session = await ort.InferenceSession.create(join(dir, "model_quantized.onnx"), {
          executionProviders: ["cpu"],
          graphOptimizationLevel: "all",
        });
        const tok = JSON.parse(await Bun.file(join(dir, "tokenizer.json")).text()) as { model: { vocab: Vocab } };
        this.vocab = tok.model.vocab;
        this.cls = this.vocab["[CLS]"]!;
        this.sep = this.vocab["[SEP]"]!;
        this.unk = this.vocab["[UNK]"]!;
        this.status = "ready";
        return true;
      } catch {
        this.status = "failed";
        return false;
      }
    })();
    return this.loading;
  }

  /** 单条 embed：失败返回 null（双降级） */
  async embed(text: string): Promise<Float32Array | null> {
    if (this.status !== "ready" || !this.session || !this.vocab || !this.ort) return null;
    try {
      const tokens = basicTokenize(text).flatMap((w) => wordpiece(w, this.vocab!, this.unk)).slice(0, 510);
      const ids = [this.cls, ...tokens, this.sep];
      const n = ids.length;
      const feeds: Record<string, import("onnxruntime-node").Tensor> = {
        input_ids: new this.ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, n]),
        attention_mask: new this.ort.Tensor("int64", BigInt64Array.from(Array.from({ length: n }, () => 1n)), [1, n]),
        token_type_ids: new this.ort.Tensor("int64", BigInt64Array.from(Array.from({ length: n }, () => 0n)), [1, n]),
      };
      const out = await this.session.run(feeds);
      const key = this.session.outputNames.includes("last_hidden_state") ? "last_hidden_state" : this.session.outputNames[0]!;
      const t = out[key]!;
      const dim = t.dims[2]!;
      const hidden = t.data as Float32Array;
      const vec = new Float32Array(EMBED_DIM);
      const use = Math.min(dim, EMBED_DIM);
      for (let i = 0; i < use; i++) vec[i] = hidden[i]!; // CLS pooling
      let norm = 0;
      for (const v of vec) norm += v * v;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm;
      return vec;
    } catch {
      return null;
    }
  }
}

export const embedder = new Embedder();

/** 惰性后台加载（serve/mcp 启动时 fire，不阻塞任何功能） */
export function warmupEmbedder(): void {
  void embedder.load().then((ok) => {
    if (ok) process.stderr.write(`[xbb] 向量就绪: ${VEC_MODEL} (${EMBED_DIM}d)\n`);
    else process.stderr.write(`[xbb] 向量不可用，纯词法检索（双降级）\n`);
  });
}

/** 余弦相似度（向量已 L2 归一，点积即 cos） */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}
