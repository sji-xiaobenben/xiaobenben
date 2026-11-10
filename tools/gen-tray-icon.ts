// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 生成托盘图标：`assets/tray.png`（macOS/Linux）与 `assets/tray.ico`（Windows）。
 *
 * ## 为什么用代码生成，而不是直接放一张设计稿
 *
 * 图标要的形状只有一条路径（品牌红书签），但托盘需要**多个像素尺寸**：Windows 通知区域
 * 在 100% 缩放下是 16×16，150% 是 24×24，Alt+Tab / 任务管理器等场景还会要 32/48/256。
 * 手工导出七张图再拼 ICO，一旦品牌色或形状微调就得重来一遍，而且没人能 review 二进制。
 * 这里把「形状 + 调色 + 各尺寸留白」写成可读的常量，`bun run gen:tray-icon` 一键重出。
 *
 * ## 形状与配色是官网 favicon 的同源副本
 *
 * `web/apps/{site,account,console}/public/favicon.svg` 里的
 * `<path d="M2 0h14v22l-7-5-7 5z" fill="#F22"/>` —— 本文件把这条 path 的顶点直接抄成常量，
 * 换品牌图形时两边要一起改（favicon 是 18×22 的 viewBox，路径实际占 14×22）。
 *
 * ## 托盘为什么不套底板（而 exe 图标套了）
 *
 * 菜单栏 / 通知区域是**贴着别人的底色**渲染的，套一个红底板会在浅色任务栏上变成一个
 * 突兀的红方块；托盘要的正是「透明底 + 裸图形」。exe 图标相反——它在资源管理器里与一排
 * 图标并列，没有底板的裸图形会显得又小又空，所以 `gen-app-icon.ts` 用同一份图形套了底板。
 * 同一个品牌、两种落位，不是两套设计。
 *
 * ## 三个像素级决定
 *
 * 1. **8×8 超采样抗锯齿**：小尺寸下书签底部的 V 形缺口全靠 alpha 过渡才不糊成方块。
 * 2. **留白按比例而不是固定值**：16px 下留 1px、256px 下留 20px，视觉大小才对得上旁边那些
 *    系统图标；固定 2px 的话 16px 会显得瘦小、256px 又会顶满。
 * 3. **ICO 里 ≤64 用 BMP、256 用 PNG**：Vista 起两种都支持，但小尺寸走 BMP 是老 Shell
 *    组件（任务栏、Alt+Tab、部分第三方外壳）最保险的路径，PNG 只用在需要 256 的那一处。
 *
 * 用法：`bun run tools/gen-tray-icon.ts [--preview]`
 *   --preview 额外打印 16×16 / 32×32 的 ASCII 预览，用来肉眼核对形状（CI 不跑）。
 */
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeIco, encodePng, insidePolygon } from "./lib/icon-codec";

/** 品牌红书签的顶点（来源见文件头注释；坐标即 favicon.svg 的原坐标）。 */
const PATH: ReadonlyArray<readonly [number, number]> = [
  [2, 0],
  [16, 0],
  [16, 22],
  [9, 17],
  [2, 22],
];
/** 上面那条路径所在的坐标系（favicon 的 viewBox 是 18×22，路径实际只占 14×22）。 */
const VIEW_W = 18;
const VIEW_H = 22;
/** 品牌红 #F22 —— 与三个 favicon 完全一致，不做任何调整。 */
const FILL = { r: 0xff, g: 0x22, b: 0x22 } as const;
/** 路径自身在 viewBox 里的左边距（`M2 0…`），换算时要减掉才能视觉居中。 */
const PATH_LEFT = 2;

/** ICO 内要打包的尺寸。16/20/24/32/48 覆盖 Windows 各档 DPI，256 供大图标视图。 */
const ICO_SIZES = [16, 20, 24, 32, 48, 64, 256] as const;
/** macOS 菜单栏 22pt、2x 屏取 44px；Linux 托盘一般 24px。64 足够且有富余。 */
const PNG_SIZE = 64;

/** 超采样倍数：每个像素取 8×8 个样本点，覆盖率即 alpha。 */
const SS = 8;

/**
 * 画出某个尺寸下的 RGBA 位图（透明底 + 品牌红）。
 *
 * 留白规则：四周各留 `round(size * 0.08)`（至少 1px），图形按 viewBox 的宽高比缩放居中。
 * 这样 16px 得到 14px 高、约 9px 宽的书签——比顶满略小，但不会比旁边的系统图标显大。
 */
function renderRgba(size: number): Uint8Array {
  const margin = Math.max(1, Math.round(size * 0.08));
  const boxH = size - margin * 2;
  // 宽度取整、并让左右缝隙同奇偶 ⇒ 左右上下四条边都落在像素边界上。
  // 否则 16px 下会得到 8.9px 宽的形状，左右各有一条半透明列，小图标整体发虚。
  // 代价是横纵缩放比差 ~1%，肉眼不可见，换来的清晰度在小尺寸上是赚的。
  let boxW = Math.round((boxH * (VIEW_W - PATH_LEFT * 2)) / VIEW_H); // 路径宽 14 / 高 22
  if ((size - boxW) % 2 !== 0) boxW += 1;
  const offX = (size - boxW) / 2;
  const offY = margin;
  const scaleX = boxW / (VIEW_W - PATH_LEFT * 2);
  const scaleY = boxH / VIEW_H;

  // 把顶点换算成设备坐标（横向减掉路径自身的左边距，让图形在框内居中）
  const pts = PATH.map(
    ([x, y]) => [offX + (x - PATH_LEFT) * scaleX, offY + y * scaleY] as const,
  );

  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx2 = 0; sx2 < SS; sx2++) {
          const x = px + (sx2 + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          if (insidePolygon(pts, x, y)) hits++;
        }
      }
      if (hits === 0) continue;
      const a = Math.round((hits / (SS * SS)) * 255);
      const o = (py * size + px) * 4;
      out[o] = FILL.r;
      out[o + 1] = FILL.g;
      out[o + 2] = FILL.b;
      out[o + 3] = a;
    }
  }
  return out;
}

// ── 输出 ────────────────────────────────────────────────────────────────────

const root = join(fileURLToPath(new URL("..", import.meta.url)), ".");
const pngPath = join(root, "assets", "tray.png");
const icoPath = join(root, "assets", "tray.ico");

const png = encodePng(PNG_SIZE, renderRgba(PNG_SIZE));
const ico = encodeIco(ICO_SIZES, renderRgba);
writeFileSync(pngPath, png);
writeFileSync(icoPath, ico);

console.log(`✓ assets/tray.png  ${png.length} 字节（${PNG_SIZE}×${PNG_SIZE}）`);
console.log(`✓ assets/tray.ico  ${ico.length} 字节（${ICO_SIZES.join("/")}）`);

if (process.argv.includes("--preview")) {
  for (const size of [16, 32]) {
    const rgba = renderRgba(size);
    console.log(`\n${size}×${size} 预览（# 实心 / + 半透明 / · 透明）：`);
    for (let y = 0; y < size; y++) {
      let line = "";
      for (let x = 0; x < size; x++) {
        const a = rgba[(y * size + x) * 4 + 3] as number;
        line += a === 0 ? "·" : a > 200 ? "#" : "+";
      }
      console.log(line);
    }
  }
}
