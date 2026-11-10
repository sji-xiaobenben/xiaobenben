// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 产物侧断言：exe **真的带了应用图标**，且与 `assets/app.ico` 逐字节一致。
 *
 * 用法：`bun run tools/check-exe-icon.ts <windows 产物路径> [--dump <输出.ico>]`
 *
 * 图标缺失的失败模式是静的：资源管理器退回一个通用空白壳（不是报错），用户只觉得「有点糙」，
 * 而 `xbb version`、托盘、自更新全都正常。`--windows-icon` 又是编译期才生效的一步，
 * 参数错、路径错、CI 漏跑都不会让构建失败——所以必须在产物侧验一次。
 *
 * 解析逻辑在 `tools/lib/pe-icon.ts`：`tools/build.ts` 构建完 Windows 产物时也会调它，
 * 同一条断言两处复用，不留第二份 PE 解析。纯字节解析、不执行产物 ⇒ 交叉编译的产物同样能查。
 */
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractEmbeddedIcon } from "./lib/pe-icon";

const root = join(fileURLToPath(new URL("..", import.meta.url)), ".");
const artifact = process.argv[2];

if (!artifact) {
  console.error("用法: bun run tools/check-exe-icon.ts <windows 产物路径> [--dump <输出.ico>]");
  process.exit(2);
}

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const exe = readFileSync(artifact);
console.log(`产物   : ${artifact}（${exe.length} 字节）`);

let icon;
try {
  icon = extractEmbeddedIcon(exe);
} catch (err) {
  die((err as Error).message);
}
console.log(`嵌入尺寸: ${icon.sizes.map((s) => `${s}×${s}`).join(" ")}`);

// 排查时把重建出来的 ICO 落盘；正常发版不写任何文件。
const dumpIdx = process.argv.indexOf("--dump");
if (dumpIdx > 0) {
  const out = process.argv[dumpIdx + 1];
  if (!out) die("--dump 后面要跟一个输出路径");
  writeFileSync(out, icon.ico);
  console.log(`（已把重建的 ICO 写到 ${out}，共 ${icon.ico.length} 字节）`);
}

const srcPath = join(root, "assets", "app.ico");
if (!existsSync(srcPath)) die(`缺少源图标 ${srcPath}（先跑 bun run gen:app-icon）`);
const src = readFileSync(srcPath);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

if (icon.ico.length !== src.length) {
  die(
    `产物里的图标与 assets/app.ico 不一致：${icon.ico.length} 字节 vs ${src.length} 字节\n` +
      "  ⇒ 产物不是用当前这份 app.ico 编出来的（改完图标忘了重新构建？）。",
  );
}
if (sha(icon.ico) !== sha(src)) {
  die("产物里的图标字节与 assets/app.ico 不同（长度相同、内容不同）—— 同上，重编一次。");
}
console.log(`✓ 图标与 assets/app.ico 逐字节一致（${src.length} 字节，sha256 ${sha(src).slice(0, 16)}…）`);

console.log("check-exe-icon: PASS");
