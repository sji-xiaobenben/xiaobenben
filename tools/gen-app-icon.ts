// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 生成应用图标：`assets/app.ico`（exe 资源段）与 `assets/brand/logo.svg`（README 抬头）。
 *
 * ## 图形是什么
 *
 * 品牌红方块 + 白色书签。书签的顶点是 `assets/../public/favicon.svg` 那条 path 的原坐标
 * （`M2 0h14v22l-7-5-7 5z`，见 `gen-tray-icon.ts` 文件头），这里只做「换成白描边、缩小居中」
 * 两件事——**不改形状、不改品牌红**。两个文件（ICO / SVG）由同一份几何常量算出，
 * 所以资源管理器里的 exe 图标和 README 抬头的 logo 不可能长得不一样。
 *
 * ## 为什么套底板
 *
 * 托盘是透明底的裸书签（见 `gen-tray-icon.ts` 里「托盘为什么不套底板」）。exe 图标不行：
 * 资源管理器把图标排在一格里，没有底板的裸图形会显得又小又空，而且浅色/深色壁纸下
 * 反差方向相反、时隐时现。红方块给了一个恒定的对比背景，16px 下也认得出是什么。
 *
 * ## 为什么圆角 22.37%
 *
 * 与 iOS/macOS 应用图标的圆角占位一致（Apple 的 squircle 取 22.37%），在 Windows 上略圆但
 * 不显得像胶囊；比 25% 稳，比 15% 更像「应用」而不是「方块」。
 *
 * ## 为什么用代码生成
 *
 * 与托盘同理：七档尺寸 + 品牌色 + 圆角，任何一项微调都得重出七张图并重新拼 ICO，
 * 而二进制没人能 review。这里全是可读常量，`bun run gen:app-icon` 一键重出。
 * 生成的 ICO 直接进 PE 资源段（`bun build --compile --windows-icon=assets/app.ico`）。
 *
 * 用法：`bun run tools/gen-app-icon.ts [--preview]`
 *   --preview 额外打印 16×16 / 32×32 的 ASCII 预览（# 红底 / O 白书签 / · 透明）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodeIco, insidePolygon } from "./lib/icon-codec";

/** 书签顶点（favicon 原坐标，占 viewBox 的 x∈[2,16]、y∈[0,22]）。 */
const PATH: ReadonlyArray<readonly [number, number]> = [
  [2, 0],
  [16, 0],
  [16, 22],
  [9, 17],
  [2, 22],
];
const VIEW_W = 18;
const VIEW_H = 22;
const PATH_LEFT = 2;

/** 品牌红 #F22（与 favicon / 托盘一致）与底板上的白。 */
const TILE = { r: 0xff, g: 0x22, b: 0x22 } as const;
const GLYPH = { r: 0xff, g: 0xff, b: 0xff } as const;

/** 圆角半径 / 边长（见文件头「为什么圆角 22.37%」）。 */
const RADIUS_RATIO = 0.2237;
/** 书签高度 / 边长。0.54 是「四周留白够、16px 下书签仍有 8px 高」的折中。 */
const GLYPH_H_RATIO = 0.54;
/** 超采样倍数：每像素 8×8 样本点，覆盖率即 alpha（16px 下缺口全靠它才不糊）。 */
const SS = 8;

/** ICO 内打包的尺寸：16/20/24/32/40/48 覆盖各档 DPI 与小图标视图，64/128/256 供大图标。 */
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256] as const;
/** logo.svg 的画布边长（只影响 viewBox 精度，不改变比例）。 */
const SVG_SIZE = 512;

/** 书签在多边形坐标系 → 目标边长下的设备坐标。 */
function glyphPoints(size: number): Array<readonly [number, number]> {
  const h = size * GLYPH_H_RATIO;
  const w = (h * (VIEW_W - PATH_LEFT * 2)) / VIEW_H; // 路径宽 14 / 高 22
  const offX = (size - w) / 2;
  const offY = (size - h) / 2;
  const sx = w / (VIEW_W - PATH_LEFT * 2);
  const sy = h / VIEW_H;
  return PATH.map(([x, y]) => [offX + (x - PATH_LEFT) * sx, offY + y * sy] as const);
}

/** 点到圆角矩形内部（圆角用四个 1/4 圆判定，其余区域是直边）。 */
function insideTile(size: number, x: number, y: number): boolean {
  const r = size * RADIUS_RATIO;
  if (x < 0 || y < 0 || x > size || y > size) return false;
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 画某个尺寸的 RGBA 位图：圆角红底 + 白色书签，底板外透明。 */
function renderRgba(size: number): Uint8Array {
  const pts = glyphPoints(size);
  const out = new Uint8Array(size * size * 4);
  const n = SS * SS;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tileHits = 0;
      let glyphHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          if (!insideTile(size, x, y)) continue;
          tileHits++;
          if (insidePolygon(pts, x, y)) glyphHits++;
        }
      }
      if (tileHits === 0) continue;
      // 书签白与底板红按样本覆盖率混合，再乘底板整体覆盖率得 alpha。
      // 不这样做，书签边缘会在 16px 下出现一圈红白相间的毛刺。
      const g = glyphHits / n; // 书签占满整个像素的比例（底板外的样本天然不计入）
      const t = tileHits / n;
      const o = (py * size + px) * 4;
      const mix = (a: number, b: number) => Math.round(a + (b - a) * (g / (t || 1)));
      out[o] = mix(TILE.r, GLYPH.r);
      out[o + 1] = mix(TILE.g, GLYPH.g);
      out[o + 2] = mix(TILE.b, GLYPH.b);
      out[o + 3] = Math.round(t * 255);
    }
  }
  return out;
}

/** 同一份几何常量 → SVG（README 用；无字体依赖、无外部引用）。 */
function renderSvg(): string {
  const r = SVG_SIZE * RADIUS_RATIO;
  const pts = glyphPoints(SVG_SIZE).map(([x, y]) => `${+x.toFixed(2)} ${+y.toFixed(2)}`);
  const d = `M${pts[0]}L${pts[1]}L${pts[2]}L${pts[3]}L${pts[4]}Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_SIZE} ${SVG_SIZE}" width="${SVG_SIZE}" height="${SVG_SIZE}" role="img" aria-label="XiaoBenBen">
  <title>XiaoBenBen</title>
  <desc>XiaoBenBen logo: a white bookmark on a brand red rounded square.</desc>
  <rect width="${SVG_SIZE}" height="${SVG_SIZE}" rx="${+r.toFixed(2)}" fill="#F22222"/>
  <path d="${d}" fill="#FFFFFF"/>
</svg>
`;
}

// ── 输出 ────────────────────────────────────────────────────────────────────

const root = join(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), ".");
const icoPath = join(root, "assets", "app.ico");
const svgPath = join(root, "assets", "brand", "logo.svg");

const ico = encodeIco(ICO_SIZES, renderRgba);
const svg = renderSvg();
mkdirSync(dirname(svgPath), { recursive: true });
writeFileSync(icoPath, ico);
writeFileSync(svgPath, svg);

console.log(`✓ assets/app.ico          ${ico.length} 字节（${ICO_SIZES.join("/")}）`);
console.log(`✓ assets/brand/logo.svg   ${svg.length} 字节（${SVG_SIZE}×${SVG_SIZE}）`);

if (process.argv.includes("--preview")) {
  for (const size of [16, 32]) {
    const rgba = renderRgba(size);
    console.log(`\n${size}×${size} 预览（# 红底 / O 白书签 / · 透明）：`);
    for (let y = 0; y < size; y++) {
      let line = "";
      for (let x = 0; x < size; x++) {
        const o = (y * size + x) * 4;
        const a = rgba[o + 3] as number;
        if (a === 0) line += "·";
        else line += (rgba[o] as number) > 200 && (rgba[o + 1] as number) > 200 ? "O" : "#";
      }
      console.log(line);
    }
  }
}
