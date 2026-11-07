// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 召回段分词（纯函数零 IO）。与服务端同一份实现，同构。
 *
 * 用法差异：server 侧走 PG simple parser；cli 侧 token 串进 FTS5 trigram MATCH
 * （trigram tokenizer 对 ≥1 字符 query 均为子串匹配语义，bigram token 即 2 字子串条件）。
 * 与 cli 端 SQLite FTS5 trigram 同构（"个人还是组织"不是代码分支）。
 *
 * 已知边界：单字 CJK 查询（"飞"）命中不了 bigram（飞机）——词典法天花板，
 * 由词群展开（B5）与向量通道（B7）兜底。
 */

/** CJK 统一表意文字 + 扩展 A（MVP 覆盖简繁常用区；生僻扩展区进 Phase 2） */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const ASCII_WORD_RE = /^[a-z0-9_+#.-]+$/i;

/**
 * 切分：ASCII 词序列原样保留（小写化），CJK 连续段切成 bigram（单字段落单字）。
 * 其余字符（空格/标点/emoji）是天然分界，跳过。
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let ascii = "";
  let cjk = "";

  const flushAscii = () => {
    if (ascii) {
      out.push(ascii.toLowerCase());
      ascii = "";
    }
  };
  const flushCjk = () => {
    if (cjk.length === 1) {
      out.push(cjk); // 单字段：该字本身（查询侧保底；写入侧单字噪声可接受——GIN 索引体积小）
    } else {
      for (let i = 0; i < cjk.length - 1; i++) out.push(cjk.slice(i, i + 2)); // bigram
    }
    cjk = "";
  };

  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      flushAscii();
      cjk += ch;
    } else if (/\w/.test(ch) && !/\s/.test(ch)) {
      flushCjk();
      ascii += ch;
    } else {
      flushAscii();
      flushCjk();
    }
  }
  flushAscii();
  flushCjk();
  return out;
}

/** 生成 search_doc：token 流用空格连接，交给 PG simple parser 存 tsvector（写入侧） */
export function toSearchDoc(text: string): string {
  return tokenize(text).join(" ");
}

/**
 * 构造 tsquery 文本（语义定稿）：
 *  查询自身 token 之间 AND（websearch 语义，precision 优先——"游标o855m4" 不许召回所有含"游标"的行）；
 *  词群展开的每个 definition 各自成 AND 组，组间 OR（alias 命中任一展开式即入候选）。
 *  即：('游标' & 'o855m4') | ('费用' & '报销')。
 * tokenize 只产 [\w CJK]，无 tsquery 保留字符（&|!():*'），免转义。
 * 单 token 查询退化成该 token 自身（AND/OR 均等价）。
 */
export function buildTsQuery(query: string, defs: readonly string[] = []): string {
  const groups: string[] = [];
  const base = [...new Set(tokenize(query))];
  if (base.length > 0) groups.push(base.join(" & "));
  for (const d of defs) {
    const toks = [...new Set(tokenize(d))];
    if (toks.length > 0) groups.push(toks.join(" & "));
  }
  return groups.join(" | ");
}

/**
 * 宽松版 tsquery（降级链第二级，2026-09-28 recall-bench 实测新增）：
 * 查询 token 间 OR。仅在 AND 版落空后使用——多词自然查询的跨词接缝 bigram
 * （如「周末天气预报」的「末天」「狗粮补货」的「粮补」）在内容侧 bigram 流中
 * 不存在 → AND 组全灭，召回为零。宽松召回后精度交由 ts_rank（多 token 命中
 * 得分更高）+ 六维重排（W1）兜底；「游标o855m4」类精确查询 AND 命中即短路，
 * 永不进入降级。definition 组语义不变：各自 AND、组间 OR（def 是内容连续子串）。
 * 单 token 查询与 AND 版等价（调用方按字符串相等跳过重试）。
 */
export function buildTsQueryLoose(query: string, defs: readonly string[] = []): string {
  const groups: string[] = [];
  const base = [...new Set(tokenize(query))];
  if (base.length > 1) groups.push(base.join(" | "));
  for (const d of defs) {
    const toks = [...new Set(tokenize(d))];
    if (toks.length > 0) groups.push(toks.join(" & "));
  }
  return groups.join(" | ");
}
