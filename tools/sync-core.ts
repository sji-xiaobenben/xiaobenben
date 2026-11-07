#!/usr/bin/env bun
/**
 * 同步内置依赖：`../core/packages/core` → `core/packages/core`
 *
 *   bun run core:sync    覆盖本仓副本，并更新 core/VENDORED.md 的上游提交号
 *   bun run core:check   只比对，不一致时退出码 1（pre-commit / 本地 CI 用）
 *
 * 设计取舍：公开仓必须能独立构建，而 `@xbb/core` 的真源在私有仓。
 * 因此采用「内置副本 + 漂移检查」而不是 submodule —— 前者对贡献者零门槛，
 * 后者要求 --recursive 且容易在 detached HEAD 上改错地方。
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = "../core/packages/core";
const DST = "core/packages/core";
const VENDORED = "core/VENDORED.md";
const LICENSE_LINE = '"license": "AGPL-3.0-only"';

function walk(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out.sort();
}

function upstreamCommit(): string {
  try {
    return Bun.spawnSync(["git", "-C", "../core", "rev-parse", "--short", "HEAD"]).stdout.toString().trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function writeVendored(commit: string): void {
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    VENDORED,
    `# 上游来源\n\n| 项 | 值 |\n|---|---|\n| 仓库 | \`xbb/core\`（私有） |\n| 路径 | \`packages/core/\` |\n| 提交 | \`${commit}\` |\n| 同步时间 | ${today} |\n\n若要追溯某一行的来历，请以上述提交为基准。\n`,
    "utf8",
  );
}

/** 内置副本的 license 必须是单一 AGPL-3.0-only，不带上游仓的双许可表达式 */
function normalizeLicense(): void {
  const p = join(DST, "package.json");
  const text = readFileSync(p, "utf8");
  const next = text.replace(/"license":\s*"[^"]*"/, LICENSE_LINE);
  if (next !== text) writeFileSync(p, next, "utf8");
}

if (!existsSync(SRC)) {
  console.error(`[core:sync] 找不到上游目录 ${SRC}`);
  console.error("           本命令只在上游（含私有仓）的开发环境里可用；贡献者无需运行。");
  process.exit(2);
}

const mode = process.argv[2] === "check" ? "check" : "sync";

if (mode === "sync") {
  rmSync(DST, { recursive: true, force: true });
  cpSync(SRC, DST, { recursive: true });
  normalizeLicense();
  writeVendored(upstreamCommit());
  console.log(`[core:sync] 已同步 ${walk(DST).length} 个文件，上游 ${upstreamCommit()}`);
  process.exit(0);
}

// check：逐个比对，报告差异
const srcFiles = walk(SRC);
const dstFiles = existsSync(DST) ? walk(DST) : [];
const onlySrc = srcFiles.filter((f) => !dstFiles.includes(f));
const onlyDst = dstFiles.filter((f) => !srcFiles.includes(f));
const changed = srcFiles.filter(
  (f) => dstFiles.includes(f) && !readFileSync(join(SRC, f)).equals(readFileSync(join(DST, f))),
);
const drift = onlySrc.length + onlyDst.length + changed.length;

if (drift === 0) {
  console.log("[core:check] 内置副本与上游一致");
  process.exit(0);
}

console.error("[core:check] 内置副本已漂移：");
for (const f of onlySrc) console.error(`  仅上游有   ${f}`);
for (const f of onlyDst) console.error(`  仅本仓有   ${f}`);
for (const f of changed) console.error(`  内容不同   ${f}`);
console.error("\n执行 `bun run core:sync` 重新同步。");
process.exit(1);
