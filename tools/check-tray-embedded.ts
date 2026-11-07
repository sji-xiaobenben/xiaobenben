// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 产物侧断言：托盘资产**真的嵌进了 exe**（`bun build --compile` 只打包 JS，按路径读的文件一律不进）。
 *
 * 用法：`bun run tools/check-tray-embedded.ts <产物路径> [平台]`（平台缺省 = 当前平台）
 *
 * 为什么单独做成一个工具、而不是塞进托盘冒烟：
 *  - 它需要**已编译的产物**，只该在 release 流水线的 build job 里跑；
 *  - 它纯字节比对、不需要执行产物 ⇒ **能覆盖交叉编译出的 darwin 产物**（那台 runner 跑不了它）；
 *  - 它正是 2026-10-07 查出"托盘在所有正式版里从未起过"的那条检查，把它固化下来。
 *
 * 反过来，dev 侧（资产可读、菜单形状、释放语义）由 `tools/tray-smoke.ts` 覆盖。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { trayBinName, trayIconAssetName } from "../src/tray-assets";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const cliRoot = join(root, ".");

const artifact = process.argv[2];
const platform = (process.argv[3] ?? process.platform) as NodeJS.Platform;

if (!artifact) {
  console.error("用法: bun run tools/check-tray-embedded.ts <产物路径> [平台]");
  process.exit(2);
}

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const exe = readFileSync(artifact);
console.log(`产物   : ${artifact}（${exe.length} 字节）`);
console.log(`平台   : ${platform}`);

const binName = trayBinName(platform);
if (!binName) die(`未知平台的托盘二进制名: ${platform}`);
const binSrc = readFileSync(join(cliRoot, "node_modules", "systray2", "traybin", binName));

// 图标按平台分叉（win=ico / 其余=png）。**交叉编译产物必须用目标平台的名字来核对**，
// 不能用当前 runner 的平台 —— release 流水线就在 ubuntu 上检查 Windows 产物。
const iconName = trayIconAssetName(platform);
const iconSrc = readFileSync(join(cliRoot, "assets", iconName));

// Go 二进制 3.6MB：几乎是全产物里最独特的字节串，缺失即"托盘起不来"的充要条件。
if (!exe.includes(binSrc)) {
  die(
    `托盘 Go 二进制（${binName}，${binSrc.length} 字节）未嵌入产物。\n` +
      "  ⇒ 正式版里托盘会 ENOENT 后静默降级（管理窗口/通知不受影响，但右下角图标永远不会出现）。\n" +
      "  修法参考 src/tray-assets.ts：用 `with { type: \"file\" }` 让 Bun 把字节嵌进产物。",
  );
}
console.log(`✓ 托盘 Go 二进制已嵌入（${binName}，${binSrc.length} 字节）`);

// 2026-10-07：Windows 端把 icon 字节落临时文件后走 LoadImage，喂 PNG 会被 Go 端拒绝
// （真机 stderr: `Unable to set icon`）⇒ 托盘区只剩空白占位。此处先卡格式，再卡嵌入。
if (platform === "win32") {
  // eslint-disable-next-line no-bitwise
  if (!(iconSrc[0] === 0x00 && iconSrc[1] === 0x00 && iconSrc[2] === 0x01 && iconSrc[3] === 0x00)) {
    die(
      `assets/${iconName} 不是 ICO 格式（ICONDIR 魔数应为 00 00 01 00，实际 ${iconSrc.subarray(0, 4).toString("hex")}）。\n` +
        "  ⇒ Windows 的 Go 端 SetIcon 会失败，托盘图标显示为空白占位（且不报错、不影响 serve）。",
    );
  }
  console.log(`✓ Windows 图标格式正确（ICO，${iconSrc.length} 字节）`);
}

if (!exe.includes(iconSrc)) {
  die(`托盘图标（assets/${iconName}，${iconSrc.length} 字节）未嵌入产物 ⇒ 即使二进制在，菜单也没有图标。`);
}
console.log(`✓ 托盘图标已嵌入（assets/${iconName}，${iconSrc.length} 字节）`);

console.log("check-tray-embedded: PASS");
