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
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

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
          if (inside(pts, x, y)) hits++;
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

/** 射线法判定点是否在多边形内（顶点按给定顺序构成简单闭合多边形）。 */
function inside(pts: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i] as readonly [number, number];
    const [xj, yj] = pts[j] as readonly [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// ── PNG 编码（RGBA8、无滤波） ───────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // no interlace
  // 每行前置一个 filter 字节 0（None）
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

// ── ICO 编码 ────────────────────────────────────────────────────────────────

/** 32bpp BMP（含 AND 掩码）—— 小尺寸走这条，见文件头第 3 点。 */
function dibForIcon(size: number, rgba: Uint8Array): Buffer {
  const xorSize = size * size * 4;
  const maskRow = Math.ceil(size / 8 / 4) * 4;
  const maskSize = maskRow * size;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight = XOR + AND
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(xorSize + maskSize, 20); // biSizeImage
  const xor = Buffer.alloc(xorSize);
  const mask = Buffer.alloc(maskSize);
  for (let y = 0; y < size; y++) {
    const srcRow = size - 1 - y; // BMP 自下而上
    for (let x = 0; x < size; x++) {
      const s = (srcRow * size + x) * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2] as number; // B
      xor[d + 1] = rgba[s + 1] as number; // G
      xor[d + 2] = rgba[s] as number; // R
      xor[d + 3] = rgba[s + 3] as number; // A
      if ((rgba[s + 3] as number) === 0) {
        const bit = 7 - (x & 7);
        mask[y * maskRow + (x >> 3)] = (mask[y * maskRow + (x >> 3)] as number) | (1 << bit);
      }
    }
  }
  return Buffer.concat([header, xor, mask]);
}

function encodeIco(sizes: ReadonlyArray<number>): Buffer {
  const images: Buffer[] = [];
  for (const size of sizes) {
    const rgba = renderRgba(size);
    images.push(size >= 256 ? encodePng(size, rgba) : dibForIcon(size, rgba));
  }
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // type = icon
  dir.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries: Buffer[] = [];
  for (let i = 0; i < images.length; i++) {
    const size = sizes[i] as number;
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 256 记为 0
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // 调色板色数
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE((images[i] as Buffer).length, 8);
    e.writeUInt32LE(offset, 12);
    offset += (images[i] as Buffer).length;
    entries.push(e);
  }
  return Buffer.concat([dir, ...entries, ...images]);
}

// ── 输出 ────────────────────────────────────────────────────────────────────

const root = join(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), ".");
const pngPath = join(root, "assets", "tray.png");
const icoPath = join(root, "assets", "tray.ico");

const png = encodePng(PNG_SIZE, renderRgba(PNG_SIZE));
const ico = encodeIco(ICO_SIZES);
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
