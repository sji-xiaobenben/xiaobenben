// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 中文 bigram 切分 —— episode_chunks 的检索索引层。
 *
 * 为什么不用 FTS5 自带的 trigram（2026-11-20 在 27,995 条真实原话上实测）：
 *
 *  1. **2 字词全废**。trigram 要求 ≥3 字符才建索引，中文核心词汇单元恰恰是 2 字。
 *     "记忆" 在库里有 3,399 条，`episode_chunks MATCH '"记忆"'` 返回 **0**；
 *     "向量" 879 条→0、"蒸馏" 128 条→0、"AI" 9,414 条→0、"DB" 1,748 条→0。
 *     查不到 → AI 换词重试 → 再查不到 …… 用户感知就是"搜原话好久好久"。
 *
 *  2. **长串假阳性**。trigram 不存位置信息，短语查询退化成纯 AND，且 `MATCH` 不带列限定
 *     时会跨列拼凑 trigram。查一个 12 位 hash：返回 6,379 条，真值 221 条 —— **假阳性 28.9 倍**，
 *     返回的头几条是"你好""我先把项目结构摸一遍"。根因是 episode_chunks 把 session_id /
 *     position 也建进了索引，而它们与正文的片段能拼满同一组 trigram。
 *
 * bigram 把任意相邻 2 字符都变成 token：
 *  - 2 字词天然可查（"记忆" 就是一个 token）；
 *  - 配 FTS5 短语查询（`"记忆 忆检 检索"`）等价于带顺序的子串匹配
 *    （实测 "记忆检索" 22 条 vs "检索记忆" 6 条，顺序保住了）；
 *  - 索引反而更小：44.9 MB vs trigram 的 78 MB（45,224 chunk 实测）。
 *
 * 覆盖范围：CJK 按 2 字滑窗；拉丁字母 / 数字同样按 2 字符滑窗，于是
 * "1562"（手机号后 4 位）、"8947"、"0.4" 这类任意短片段都能定位，
 * 不再需要为号码串另开一条 LIKE 通道。
 */

/** CJK 统一表意文字（含扩展 A 与兼容区） */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 分隔符：空白、标点、符号。它们不进索引，只用来断词 */
const SEP = /[\s\p{P}\p{S}]/u;

/**
 * 文本 → bigram token 序列（空格connection，可直接喂给 FTS5）。
 *
 * 边界规则：
 *  - 空白/标点/符号 ⇒ 断词（不产生跨标点的 bigram，"0.4.57" 会拆成 04x? 不，
 *    见测试：标点被丢弃、两侧各自切分，因此 "0.4.57" → "04 4" + "57"… 由调用方
 *    决定是否需要保留标点；检索场景下丢掉标点反而能匹配 "0.4.57" 与 "v0.4.57"）
 *  - CJK 与拉丁/数字相邻 ⇒ 断词（"AI记忆" 不产生 "I记" 这种无意义 token）
 *  - 单字符段 ⇒ 保留单 token（保证 1 字查询也有东西可匹配）
 */
export function bigramify(text: string): string {
  const out: string[] = [];
  let run: string[] = [];
  let runCJK: boolean | null = null;

  const flush = () => {
    if (run.length === 1) out.push(run[0]!);
    else for (let i = 0; i + 1 < run.length; i++) out.push(run[i]! + run[i + 1]!);
    run = [];
    runCJK = null;
  };

  for (const ch of text) {
    if (SEP.test(ch)) {
      flush();
      continue;
    }
    const isCJK = CJK.test(ch);
    if (runCJK !== null && runCJK !== isCJK) flush();
    run.push(ch);
    runCJK = isCJK;
  }
  flush();
  return out.join(" ");
}

/** 查询串 → bigram token 数组（与 bigramify 同一套边界规则） */
export function bigramTerms(query: string): string[] {
  const s = bigramify(query).trim();
  return s ? s.split(" ") : [];
}

/** 短语形态（FTS5 带顺序匹配；token 之间用空格，整体加引号） */
export function asPhrase(terms: string[]): string {
  return `"${terms.map((t) => t.replace(/"/g, '""')).join(" ")}"`;
}

/**
 * 何时把查询当"原文片段"（短语）而不是"自然语言提问"（OR）？
 *
 * 实测分界：
 *  - 3–100 字的原文片段 ⇒ 短语精确命中，100 字耗时 4.70 ms，无长度断点；
 *  - 自然语言长句（哪怕只有 8 字"向量检索怎么做的"）⇒ 短语必然 0 命中，
 *    因为原文不会连续出现这一整句，`LIKE '%整句%'` 同样是 0。
 *
 * 所以短语失败不是错误，是常态。调用方应先试短语（保精度），
 * 0 命中且长度够时再降级 OR（保召回）。
 */
export const PHRASE_MAX_TERMS = 6;

/**
 * 长查询的 OR 表达式：去掉重复 term，并把"每个字都出现"的碎片 term 压低权重
 * —— FTS5 不支持 per-term 权重，这里只做去重与截断，排序交给 bm25 的 IDF。
 */
export function asOr(terms: string[], cap = 32): string {
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const t of terms) {
    if (seen.has(t)) continue;
    seen.add(t);
    uniq.push(t);
    if (uniq.length >= cap) break;
  }
  return uniq.map((t) => t.replace(/"/g, '""')).join(" OR ");
}
