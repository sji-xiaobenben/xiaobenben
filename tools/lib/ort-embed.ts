// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 构建期内嵌向量运行时的资源准备（`tools/build.ts` 调用）。
 *
 * 干三件事：
 *   ① 按目标平台挑出 onnxruntime 的 CPU 必需文件（剔除 GPU 后端 —— 代码里写死 cpu execution provider）
 *   ② 逐个 gzip，写到 `src/generated-ort/`，内容相同的只存一份（符号链接去重）
 *   ③ 覆写 `src/ort-assets.generated.ts` 成真实清单，让 `bun build --compile` 把它们内嵌进 exe
 *
 * 构建结束后必须调 `restoreGenerated()` 还原空壳 —— 工作区里的清单文件始终是提交进仓库的
 * 那一份，否则一次跨平台构建就会把「Windows 的内嵌清单」留在 Linux 开发者的工作区里。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

/** bun 的 target 段 → onnxruntime-node 的 `bin/napi-v6/<os>/<arch>` 命名 */
export function ortOsDir(plat: string): string {
  return plat === "windows" ? "win32" : plat;
}

/**
 * GPU 后端文件 —— 一次都不会被加载，纯占位。
 *
 * 依据：`src/embedder.ts` 建 session 时写死 `executionProviders: ["cpu"]`，
 * 且已在全新隔离环境实测（只放 CPU 四个文件，`[xbb] 向量就绪: bge-small-zh-v1.5/int8 (512d)`）。
 */
const GPU_ONLY = ["DirectML.dll", "dxcompiler.dll", "dxil.dll"];

const GEN_DIR = "generated-ort";
const GEN_TS = "ort-assets.generated.ts";

/** 空壳模板：与仓库里提交的那份保持一致（还原时逐字节写回） */
function emptyShell(): string {
  return `// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 内嵌向量运行时清单 —— **构建期生成物**，由 \`tools/build.ts\` 在编译前覆盖、编译后还原。
 *
 * 工作区里这个文件永远是空壳（\`EMBEDDED_ORT = null\`），这是刻意的：
 *   · 开发模式下 ORT 直接从 \`node_modules\` import，内嵌没有意义，白白让 typecheck 依赖
 *     一堆构建期才存在的 \`.gz\` 文件；
 *   · 空壳能让 \`tsc --noEmit\` 在没有 node_modules/onnxruntime-node 的机器上也过；
 *   · 发行产物里它会被替换成真实清单（若干 \`import … with { type: "file" }\`），
 *     那些 import 由 Bun 在 \`--compile\` 时内嵌进 exe，运行时由 \`ort-embedded.ts\` 解压。
 *
 * ⚠️ 不要手动编辑。构建脚本会把改动覆盖掉。
 */

export interface EmbeddedOrtBundle {
  /** 内嵌资源身份（平台 + 内容哈希），同时用作释放目录名 */
  key: string;
  /** pkg 内相对路径 → 已 gzip 的内嵌文件句柄（多个 path 可以指向同一个 gz，用于符号链接去重） */
  files: { path: string; gz: string }[];
}

export const EMBEDDED_ORT: EmbeddedOrtBundle | null = null;
`;
}

/** 收集某平台的 ORT 必需文件（相对 pkg 根的 POSIX 路径）。该平台无原生库 → null。 */
export function collectOrtFiles(pkg: string, plat: string, arch: string): string[] | null {
  const nat = `bin/napi-v6/${ortOsDir(plat)}/${arch}`;
  const natAbs = join(pkg, ...nat.split("/"));
  if (!existsSync(natAbs)) return null;

  const out: string[] = [];
  // bundle 的 JS 部分：ort-bundle.cjs 是 `bun run bundle:ort` 的产物（test/test:ci 也会生成）
  const bundle = join(pkg, "dist", "ort-bundle.cjs");
  if (!existsSync(bundle)) return null;
  out.push("package.json", "dist/ort-bundle.cjs");

  for (const name of readdirSync(natAbs)) {
    if (GPU_ONLY.includes(name)) continue;
    const p = join(natAbs, name);
    if (!statSync(p).isFile()) continue; // 目录/软链交给后面按名处理
    out.push(`${nat}/${name}`);
  }
  // 关键两个文件缺一个，加载必然失败 —— 早失败比编出一个没有向量的 exe 好
  if (!out.some((f) => f.endsWith("/onnxruntime_binding.node"))) return null;
  return out;
}

export interface EmbedResult {
  /** 内嵌了哪些文件（含去重后实际落盘的 gz 数量） */
  files: number;
  uniqueBlobs: number;
  rawBytes: number;
  gzBytes: number;
  key: string;
}

/**
 * 生成内嵌资源并覆写清单文件。调用方必须在 finally 里 `restoreGenerated()`。
 * 返回 `null` = 该平台没有可用的 ORT（darwin-x64），产物将不带向量通道。
 */
export function writeGenerated(
  root: string,
  opts: { pkg: string; plat: string; arch: string; version: string },
): EmbedResult | null {
  const list = collectOrtFiles(opts.pkg, opts.plat, opts.arch);
  if (!list) return null;

  const genAbs = join(root, "src", GEN_DIR);
  rmSync(genAbs, { recursive: true, force: true });
  mkdirSync(genAbs, { recursive: true });

  const byHash = new Map<string, string>(); // sha256 → gz 文件名
  const entries: { path: string; gzName: string }[] = [];
  let rawBytes = 0;
  let gzBytes = 0;

  for (const rel of list) {
    const src = join(opts.pkg, ...rel.split("/"));
    const raw = readFileSync(src);
    const gz = gzipSync(raw, { level: 9 });
    // 往返校验：gzip 出错（截断、字典问题）在运行时表现为「解压出来是废文件 → 静默降级」，
    // 而 macOS 产物是交叉编译的、CI 里根本跑不起来 —— 数据对不对只能在这里当场证明。
    const back = gunzipSync(gz);
    if (back.length !== raw.length || createHash("sha256").update(back).digest("hex") !== createHash("sha256").update(raw).digest("hex")) {
      throw new Error(`gzip 往返校验失败：${rel}（原始 ${raw.length} 字节，还原 ${back.length} 字节）`);
    }
    const h = createHash("sha256").update(gz).digest("hex").slice(0, 16);
    const gzName = `${h}.gz`;
    if (!byHash.has(h)) {
      writeFileSync(join(genAbs, gzName), gz);
      byHash.set(h, gzName);
      gzBytes += gz.length;
    }
    rawBytes += raw.length;
    entries.push({ path: rel, gzName });
  }

  // key 由「平台 + 全部内容哈希」决定：内容一变目录名就变，旧的释放目录自然作废
  const keyHash = createHash("sha256")
    .update(
      entries
        .map((e) => `${e.path}:${e.gzName}`)
        .sort()
        .join("\n"),
    )
    .digest("hex")
    .slice(0, 12);
  const key = `${ortOsDir(opts.plat)}-${opts.arch}-${opts.version}-${keyHash}`;

  const imports = [...new Set(entries.map((e) => e.gzName))]
    .map((n, i) => `import gz${i} from "./${GEN_DIR}/${n}" with { type: "file" };`)
    .join("\n");
  // gz 文件名 → import 变量名的映射（同一个 gz 被多个 path 引用时，变量也复用）
  const varOf = new Map<string, string>();
  [...new Set(entries.map((e) => e.gzName))].forEach((n, i) => varOf.set(n, `gz${i}`));

  const body = `// @ts-nocheck
// @generated by tools/build.ts — 构建期生成，勿手改（工作区版本是空壳）
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)
${imports}

export interface EmbeddedOrtBundle {
  key: string;
  files: { path: string; gz: string }[];
}

export const EMBEDDED_ORT: EmbeddedOrtBundle = {
  key: ${JSON.stringify(key)},
  files: [
${entries.map((e) => `    { path: ${JSON.stringify(e.path)}, gz: ${varOf.get(e.gzName)} as unknown as string },`).join("\n")}
  ],
};
`;
  writeFileSync(join(root, "src", GEN_TS), body, "utf8");

  return { files: entries.length, uniqueBlobs: byHash.size, rawBytes, gzBytes, key };
}

/** 还原空壳清单并删掉 gz 目录（构建结束必调，含异常路径） */
export function restoreGenerated(root: string): void {
  try {
    writeFileSync(join(root, "src", GEN_TS), emptyShell(), "utf8");
  } catch {
    /* 只读工作区：留着真清单不影响下一次构建（下次会再覆盖） */
  }
  try {
    rmSync(join(root, "src", GEN_DIR), { recursive: true, force: true });
  } catch {
    /* 同上 */
  }
}

/** 把空壳模板写进仓库（仅修复用：万一工作区被中断的构建留下了真清单） */
export function writeEmptyShell(root: string): void {
  writeFileSync(join(root, "src", GEN_TS), emptyShell(), "utf8");
}
