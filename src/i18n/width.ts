// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 终端文本的**显示宽度**，用于对齐。
 *
 * 为什么不能直接 `padEnd`：`库文件` 是 3 个字符，但在等宽终端里占 6 列；`记忆` 是 2 个字符
 * 占 4 列。按 `.length` 补空格，中文列永远差一半 —— 这也是为什么改造前 `stats` 的列宽
 * 是手敲的 8 列（6 列汉字 + 2 个空格），全靠人数格子数算出来的。
 *
 * 手敲的列宽在单语言下能凑合，换来英文就必错：`Database` / `Transcripts` 的字符宽度
 * 与列数一一对应，而中文的字符数是列数的一半，同一套硬编码空格不可能同时对齐两种语言。
 * 所以列宽改成**渲染时按当前语言的标签实测**，两种语言各自对齐，且以后加语言不用回来改空格。
 *
 * 只覆盖东亚宽字符（W/F）判定：终端对齐只关心这个。不追求完整 Unicode 的
 * EastAsianWidth 数据库 —— 一个只服务 5 个统计标签的函数，不值得拖一张表进来。
 */

/** 该码位在等宽终端里是否占两列 */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo 初声
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首 … 康熙部首
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名 / 注音 / CJK 兼容
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意文字
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul 音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe10 && cp <= 0xfe19) || // 竖排标点
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
    (cp >= 0x1f300 && cp <= 0x1f64f) || // 常用 emoji（`❌` 在 0x274c，不在此列，占 1 列）
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B 及以后
  );
}

/** 字符串在等宽终端里占多少列 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    // 用 for...of 而不是下标：代理对（emoji、扩展 B 汉字）要按码位算，按 UTF-16 单元算会拆成两半
    const cp = ch.codePointAt(0)!;
    // 组合附加符号不占列（极少出现在我们的文案里，但写错了会让法语/越南语用户的输出错位）
    if (cp >= 0x0300 && cp <= 0x036f) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

/** 补空格到指定**列宽**（不足补，超出原样返回 —— 宁可错位也不要截断一个词） */
export function padTo(s: string, width: number): string {
  const gap = width - displayWidth(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}

/** 一组标签的统一列宽（取最宽者） */
export function columnWidth(labels: readonly string[]): number {
  return labels.reduce((m, s) => Math.max(m, displayWidth(s)), 0);
}
