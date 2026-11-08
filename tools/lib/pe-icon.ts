// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 从 Windows PE 产物的资源段里，把**图标**原样取回来（重建成一个 .ico 字节串）。
 *
 * 为什么值得写一个 PE 解析器：`--windows-icon` 是编译期才生效的一步，参数拼错、路径错、
 * CI 里漏了这一步，构建都不会失败——只会让 90MB 的产物少掉两三千字节，然后资源管理器
 * 退回一个通用空白壳，且不报错。要区分「图标没进产物」和「图标长得不好看」，只能读资源段。
 *
 * 覆盖范围：只取 RT_GROUP_ICON(14) / RT_ICON(3)，只处理数字 id（图标资源不会用字符串名），
 * 语言层取第一个。够用即止，不做通用资源浏览器。
 */

/** 把 PE 里嵌的图标重新拼成 ICO 字节。失败时抛 Error（消息是给人看的中文解释）。 */
export interface EmbeddedIcon {
  /** 重建出的 ICO 字节（与源 .ico 逐字节一致时，说明产物用的就是这份图标）。 */
  ico: Buffer;
  /** 各档尺寸（如 [16, 32, 256]），用于日志与断言。 */
  sizes: number[];
}

const RT_ICON = 3;
const RT_GROUP_ICON = 14;

export function extractEmbeddedIcon(exe: Buffer): EmbeddedIcon {
  if (exe[0] !== 0x4d || exe[1] !== 0x5a) throw new Error("不是 PE 文件（缺 MZ 头）");
  const u16 = (o: number) => exe.readUInt16LE(o);
  const u32 = (o: number) => exe.readUInt32LE(o);

  const peOff = u32(0x3c);
  if (exe.toString("latin1", peOff, peOff + 4) !== "PE\0\0") throw new Error("不是 PE 文件（缺 PE 签名）");

  const coffOff = peOff + 4;
  const numSections = u16(coffOff + 2);
  const optSize = u16(coffOff + 16);
  const optOff = coffOff + 20;
  const magic = u16(optOff);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error(`未知的可选头 magic: 0x${magic.toString(16)}`);
  // 数据目录在可选头里的偏移：PE32 是 96、PE32+ 是 112；资源目录是第 3 项（index 2）。
  const ddOff = optOff + (magic === 0x20b ? 112 : 96);
  const resRva = u32(ddOff + 16);
  const resSize = u32(ddOff + 20);
  if (resRva === 0 || resSize === 0) {
    throw new Error(
      "产物的可选头里没有资源目录（DataDirectory[2] 为空）\n" +
        "  ⇒ 图标没进 exe。检查 `bun build --compile` 是否带了 `--windows-icon=assets/app.ico`。",
    );
  }

  const sections: Array<{ va: number; span: number; raw: number }> = [];
  const secOff = optOff + optSize;
  for (let i = 0; i < numSections; i++) {
    const o = secOff + i * 40;
    const vsize = u32(o + 8);
    const rsize = u32(o + 16);
    sections.push({ va: u32(o + 12), span: Math.max(vsize, rsize), raw: u32(o + 20) });
  }
  const rva2off = (rva: number): number => {
    for (const s of sections) if (rva >= s.va && rva < s.va + s.span) return rva - s.va + s.raw;
    throw new Error(`RVA 0x${rva.toString(16)} 不在任何 section 内 —— PE 头自相矛盾`);
  };

  const resBase = rva2off(resRva);

  /** 列出某个资源目录下的数字 id 项。 */
  const dirEntries = (dirOff: number) => {
    const named = u16(resBase + dirOff + 12);
    const ids = u16(resBase + dirOff + 14);
    const out: Array<{ id: number; off: number; isDir: boolean }> = [];
    for (let i = 0; i < named + ids; i++) {
      const p = resBase + dirOff + 16 + i * 8;
      const name = u32(p);
      if (name & 0x80000000) continue; // 字符串名字项：图标资源不用
      const off = u32(p + 4);
      out.push({ id: name, off: off & 0x7fffffff, isDir: (off & 0x80000000) !== 0 });
    }
    return out;
  };

  /** 资源数据项 → 字节（第三层语言取第一个）。 */
  const resourceBytes = (typeId: number, id: number): Buffer | null => {
    const type = dirEntries(0).find((e) => e.id === typeId && e.isDir);
    if (!type) return null;
    const name = dirEntries(type.off).find((e) => e.id === id);
    if (!name) return null;
    const dataOff = name.isDir
      ? (() => {
          const lang = dirEntries(name.off)[0];
          return lang ? resBase + lang.off : -1;
        })()
      : resBase + name.off;
    if (dataOff < 0) return null;
    const rva = u32(dataOff);
    const size = u32(dataOff + 4);
    const off = rva2off(rva);
    return exe.subarray(off, off + size);
  };

  const groupType = dirEntries(0).find((e) => e.id === RT_GROUP_ICON && e.isDir);
  const groupId = groupType ? dirEntries(groupType.off)[0]?.id : undefined;
  const group = groupId === undefined ? null : resourceBytes(RT_GROUP_ICON, groupId);
  if (!group) {
    throw new Error(
      "产物里没有 RT_GROUP_ICON（资源类型 14）\n" +
        "  ⇒ exe 图标没进产物：资源管理器会显示通用空白壳，且不会有任何报错。\n" +
        "  检查 `bun build --compile --windows-icon=assets/app.ico` 这一步是否真的执行了。",
    );
  }

  const gType = group.readUInt16LE(2);
  const count = group.readUInt16LE(4);
  if (gType !== 1) throw new Error(`RT_GROUP_ICON 的 type 字段应为 1（图标），实际 ${gType}`);

  // GRPICONDIRENTRY（14 字节）：宽 高 色数 保留 平面 bpp 字节数 id
  type Entry = { w: number; h: number; colors: number; planes: number; bpp: number; bytes: Buffer };
  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 14;
    const id = group.readUInt16LE(p + 12);
    const bytes = resourceBytes(RT_ICON, id);
    if (!bytes) throw new Error(`RT_GROUP_ICON 引用了 RT_ICON #${id}，但产物里找不到它 —— 图标资源是残缺的`);
    entries.push({
      w: group[p] as number,
      h: group[p + 1] as number,
      colors: group[p + 2] as number,
      planes: group.readUInt16LE(p + 4),
      bpp: group.readUInt16LE(p + 6),
      bytes,
    });
  }

  const dir = Buffer.alloc(6 + entries.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  entries.forEach((e, i) => {
    const p = 6 + i * 16;
    dir[p] = e.w;
    dir[p + 1] = e.h;
    dir[p + 2] = e.colors;
    dir[p + 3] = 0;
    dir.writeUInt16LE(e.planes, p + 4);
    dir.writeUInt16LE(e.bpp, p + 6);
    dir.writeUInt32LE(e.bytes.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += e.bytes.length;
  });

  return {
    ico: Buffer.concat([dir, ...entries.map((e) => e.bytes)]),
    sizes: entries.map((e) => (e.w === 0 ? 256 : e.w)),
  };
}
