#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

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

const SPDX_HEADER = [
  "// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial",
  "// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)",
].join("\n");

/**
 * 上游 core 仓不带许可头，而内置副本要随本仓以 AGPL 发布——每个文件都得自证许可，
 * 否则 OEM 客户做开源合规审查时只能靠目录推断。所以头由**本仓注入**，上游保持原样。
 * 幂等：已含 SPDX 的文件原样返回（顺便护住手工改过的文件）。
 */
function withSpdx(text: string): string {
  if (text.includes("SPDX-License-Identifier")) return text;
  const shebang = text.match(/^#![^\n]*\n/);
  if (shebang) return shebang[0] + SPDX_HEADER + "\n\n" + text.slice(shebang[0].length);
  return SPDX_HEADER + "\n\n" + text;
}

function injectSpdx(dir: string): void {
  for (const rel of walk(dir)) {
    if (!rel.endsWith(".ts")) continue;
    const p = join(dir, rel);
    const before = readFileSync(p, "utf8");
    const after = withSpdx(before);
    if (after !== before) writeFileSync(p, after, "utf8");
  }
}

/** 内置副本的 license 必须是单一 AGPL-3.0-only，不带上游仓的双许可表达式 */
function normalizeLicense(): void {
  const p = join(DST, "package.json");
  const text = readFileSync(p, "utf8");
  const next = text.replace(/"license":\s*"[^"]*"/, LICENSE_LINE);
  if (next !== text) writeFileSync(p, next, "utf8");
}

const mode = process.argv[2] === "check" ? "check" : "sync";

if (!existsSync(SRC)) {
  if (mode === "check") {
    // 「无法检查」不等于「检查失败」。fork 出来的仓里根本没有上游目录，这是设计如此，
    // 用非零退出码会让 `bun run core:check` 看起来像环境坏了——而它一次都没跑起来过。
    console.log(`[core:check] 找不到上游目录 ${SRC}`);
    console.log("             本命令只在上游（含私有仓）的开发环境里可用；贡献者无需运行。");
    console.log("[core:check] 已跳过（没有上游可比对）——这不代表内置副本有问题");
    process.exit(0);
  }
  // sync 是写操作，没写成就是失败：不能让人以为"同步过了"
  console.error(`[core:sync] 找不到上游目录 ${SRC}`);
  console.error("           本命令只在上游（含私有仓）的开发环境里可用；贡献者无需运行。");
  process.exit(2);
}

if (mode === "sync") {
  rmSync(DST, { recursive: true, force: true });
  cpSync(SRC, DST, { recursive: true });
  injectSpdx(DST);
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
// 比对前先给上游内容补上同样的许可头——否则「本仓已注入、上游没有」会被误报成漂移
// package.json 同理：副本的 license 被 normalizeLicense 规范化过，得按同一规则比。
const sameContent = (f: string): boolean => {
  let s = readFileSync(join(SRC, f), "utf8");
  if (f.endsWith(".ts")) s = withSpdx(s);
  if (f === "package.json") s = s.replace(/"license":\s*"[^"]*"/, LICENSE_LINE);
  const d = readFileSync(join(DST, f), "utf8");
  return Buffer.from(s).equals(Buffer.from(d));
};
const changed = srcFiles.filter((f) => dstFiles.includes(f) && !sameContent(f));
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
