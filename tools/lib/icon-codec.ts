// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 图标编解码公共件 —— PNG（RGBA8 无滤波）与 ICO（多尺寸，≤64 走 32bpp BMP、256 走 PNG）。
 *
 * 从 `gen-tray-icon.ts` 抽出来的唯一原因：`gen-app-icon.ts`（exe 资源段图标）要用同一套
 * 编码器。两份拷贝一旦各自演化，同一个品牌图形会在托盘和资源管理器里呈现两种抗锯齿边缘，
 * 而且没人会去比对两个二进制文件。抽出来之后两边只共享**编码**，不共享**图形**：
 * 托盘是透明底上的裸书签，应用图标是红底白书签的方块，几何常量各在各的文件里。
 *
 * 编码逻辑一个字都没改 —— 抽取后用 `sha256sum` 对比过 `assets/tray.{png,ico}` 的前后字节，
 * 完全一致才算通过（`bun run gen:tray-icon` 的输出必须是同一份二进制）。
 */
import { deflateSync } from "node:zlib";

// ── PNG ─────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
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

/** 正方形 RGBA 位图 → PNG。每行前置 filter 字节 0（None），压缩级别固定 9。 */
export function encodePng(size: number, rgba: Uint8Array): Buffer {
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

// ── ICO ─────────────────────────────────────────────────────────────────────

/** 32bpp BMP（含 AND 掩码）—— 小尺寸走这条，老 Shell 组件最保险的路径。 */
export function dibForIcon(size: number, rgba: Uint8Array): Buffer {
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

/**
 * 多尺寸 ICO。`render` 由调用方提供（每个尺寸返回 size×size 的 RGBA），
 * 编码侧只决定「这个尺寸用 BMP 还是 PNG」——≤64 用 BMP、≥256 用 PNG。
 */
export function encodeIco(sizes: ReadonlyArray<number>, render: (size: number) => Uint8Array): Buffer {
  const images: Buffer[] = [];
  for (const size of sizes) {
    const rgba = render(size);
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

/**
 * 射线法判定点是否在多边形内（顶点按给定顺序构成简单闭合多边形）。
 * 8×8 超采样逐个样本点调用，所以这里只做纯算术，不做任何分配。
 */
export function insidePolygon(
  pts: ReadonlyArray<readonly [number, number]>,
  x: number,
  y: number,
): boolean {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i] as readonly [number, number];
    const [xj, yj] = pts[j] as readonly [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
