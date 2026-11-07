// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/** UUIDv7（时间有序）——全线主键，禁自增。应用层生成。 */
export type UUIDv7 = string & { readonly __brand: "uuidv7" };

export function uuidv7(): UUIDv7 {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const ts = Date.now(); // 48-bit unix ms
  // 注意：JS 位运算只有 32 位——对 41 位时间戳做 >>>40/>>>32 会先截断成 uint32 再移位（恒为 0）。
  // 必须用除法取高位字节（CI Linux runner 实测翻过车）。
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as UUIDv7;
}

export function isUUIDv7(s: string): s is UUIDv7 {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s);
}
