// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * npm 分发链路的一致性检查。
 *
 * 这几处「两份实现」是不得不为：npm 安装阶段只能跑纯 Node，不能 import TS，
 * 所以公钥、载荷魔数在 `scripts/lib/install.mjs` 里各有一份。好处是装包零依赖；
 * 代价是**漂移没有任何运行时反馈** —— 公钥对不上，表现只是「所有用户都装不下来」，
 * 而验签是 fail-closed，日志里甚至看不出异常来源。
 *
 * 所以把它变成一条会响的断言。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fail: string[] = [];

const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const grab = (src: string, re: RegExp) => re.exec(src)?.[1];

// ── 1. 公钥一致 ──
const pkSrc = grab(read("src/build-meta.ts"), /UPDATE_PUBKEY = "([^"]+)"/);
const pkPkg = grab(read("scripts/lib/install.mjs"), /UPDATE_PUBKEY = "([^"]+)"/);
if (!pkSrc) fail.push("src/build-meta.ts 里找不到 UPDATE_PUBKEY");
if (!pkPkg) fail.push("scripts/lib/install.mjs 里找不到 UPDATE_PUBKEY");
if (pkSrc && pkPkg && pkSrc !== pkPkg) {
  fail.push(`UPDATE_PUBKEY 不一致：src=${pkSrc} / scripts=${pkPkg}`);
}

// ── 2. 载荷魔数一致 ──
const mgSrc = grab(read("src/update-payload.ts"), /UPDATE_PAYLOAD_MAGIC = "([^"]+)"/);
const mgPkg = grab(read("scripts/lib/install.mjs"), /PAYLOAD_MAGIC = "([^"]+)"/);
if (!mgSrc) fail.push("src/update-payload.ts 里找不到 UPDATE_PAYLOAD_MAGIC");
if (!mgPkg) fail.push("scripts/lib/install.mjs 里找不到 PAYLOAD_MAGIC");
if (mgSrc && mgPkg && mgSrc !== mgPkg) {
  fail.push(`载荷魔数不一致：src=${mgSrc} / scripts=${mgPkg}`);
}

// ── 3. server.json 与 package.json 对齐（发版时最容易忘的就是它）──
const pkg = JSON.parse(read("package.json")) as {
  name: string;
  version: string;
  mcpName?: string;
  bin?: Record<string, string>;
  files?: string[];
};
interface ServerJson {
  name?: string;
  version?: string;
  packages?: Array<{ identifier?: string; version?: string }>;
}
let server: ServerJson = {};
try {
  server = JSON.parse(read("server.json")) as ServerJson;
} catch (e) {
  fail.push(`server.json 解析失败：${e instanceof Error ? e.message : e}`);
}
if (server.version !== pkg.version) {
  fail.push(`server.json 版本 ${server.version} ≠ package.json ${pkg.version}`);
}
if (server.packages?.[0]?.version !== pkg.version) {
  fail.push(`server.json packages[0].version ${server.packages?.[0]?.version} ≠ ${pkg.version}`);
}
if (server.packages?.[0]?.identifier !== pkg.name) {
  fail.push(`server.json packages[0].identifier ${server.packages?.[0]?.identifier} ≠ 包名 ${pkg.name}`);
}
if (pkg.mcpName !== server.name) {
  fail.push(`package.json mcpName ${pkg.mcpName} ≠ server.json name ${server.name}`);
}

// ── 4. files 清单里每个条目都真实存在 ──
for (const entry of pkg.files ?? []) {
  const isDir = entry.endsWith("/");
  const target = join(root, isDir ? entry.slice(0, -1) : entry);
  if (!existsSync(target)) fail.push(`package.json files 里列了不存在的${isDir ? "目录" : "文件"}：${entry}`);
}

// ── 5. bin 入口存在且带 shebang（缺 shebang 时装出来是「permission denied」）──
for (const [name, rel] of Object.entries(pkg.bin ?? {})) {
  if (!existsSync(join(root, rel))) {
    fail.push(`bin.${name} 指向不存在的文件：${rel}`);
    continue;
  }
  if (!read(rel).startsWith("#!")) fail.push(`bin.${name} 缺少 shebang：${rel}`);
}

// ── 6. 安装侧不允许往 stdout 写东西（stdout 是 MCP 的 JSON-RPC 通道）──
for (const rel of ["bin/xbb.mjs", "scripts/lib/install.mjs", "scripts/lib/binary.mjs"]) {
  const hits = read(rel).match(/console\.log\(/g);
  if (hits) fail.push(`${rel} 里出现 ${hits.length} 处 console.log —— stdout 是 MCP 协议通道`);
}

if (fail.length) {
  console.error("✗ npm 分发检查未通过：");
  for (const f of fail) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(
  `✓ npm 分发检查通过 · ${pkg.name}@${pkg.version} · bin ${Object.keys(pkg.bin ?? {}).length} 个 · files ${pkg.files?.length ?? 0} 项`,
);
