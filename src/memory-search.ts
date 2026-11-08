// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 检索管线。
 * 三路确定性检索（FTS trigram ∥ 着陆垫倒排 ∥ 实体精确）+ IDF 加权融合
 * + 延续链重定向（现状优先，历史环随链附注）+ 预算封顶 + 1-hop 链接扩展 + related_tags 换词引导。
 * 全部本地 SQL，零模型。查询词群由客户端 AI 扩展后传入。
 *
 * 移植适配点：
 *  1. id: number → string（UUIDv7）
 *  2. recorded_at → created_at（对外字段名 createdAt）
 *  3. 存活过滤：deleted_at IS NULL + status != 'forgotten'（双列同步写，双保险）
 *  4. 向量通道将作为第四路并入 RRF——本文件保持三路纯度
 */
import type { Database } from "bun:sqlite";
import { cosine } from "./embedder";
import { onRecalled } from "./recall-feedback";
import { LINK_VISIBLE_MIN } from "./schema";

// 命中计数 / 共现强化已统一收进 recall-feedback.ts（一次召回的两种反馈，不该分家）。

// ── 召回侧密钥过扫（第二道闸，防御纵深；主闸=写入侧标记协议）──
const SECRET_FORMATS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /glpat-[A-Za-z0-9_-]{15,}/g,
  /AIza[A-Za-z0-9_-]{30,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /https?:\/\/[^\s/:@]+:[^\s/@]{6,}@[^\s]+/g,
];

/** 已知凭据形态 → 脱敏占位（召回载荷里永不出现明文） */
export function maskSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_FORMATS) out = out.replace(re, "[[secret:masked]]");
  return out;
}

// ── 延续链（记忆的故事线）──

export interface ChainLink {
  id: string;
  content: string;
  occurredAt: string | null;
  createdAt: string;
  /** true = 链头（现状）；false = 历史环（已延续） */
  current: boolean;
}

/** 展开某条记忆所在的延续链，返回按时间正序的链成员（链头带 current=true） */
export function resolveChain(db: Database, id: string, maxLen = 10): ChainLink[] {
  let head = id, hops = 0;
  while (hops++ < maxLen) {
    const r = db.prepare("SELECT superseded_by FROM memories WHERE id = ? AND deleted_at IS NULL").get(head) as { superseded_by: string | null } | undefined;
    if (!r || !r.superseded_by) break;
    head = r.superseded_by;
  }
  const members: { id: string; content: string; occurred_at: string | null; created_at: string; current: boolean }[] = [];
  const seen = new Set<string>([head]);
  const queue: string[] = [head];
  while (queue.length && members.length < maxLen - 1) {
    const cur = queue.shift()!;
    const rows = db.prepare(
      "SELECT id, content, occurred_at, created_at FROM memories WHERE superseded_by = ? AND deleted_at IS NULL ORDER BY created_at ASC",
    ).all(cur) as Array<{ id: string; content: string; occurred_at: string | null; created_at: string }>;
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      members.push({ id: r.id, content: r.content, occurred_at: r.occurred_at ?? null, created_at: r.created_at, current: false });
      queue.push(r.id);
    }
  }
  const headRow = db.prepare("SELECT id, content, occurred_at, created_at FROM memories WHERE id = ?").get(head) as { id: string; content: string; occurred_at: string | null; created_at: string } | undefined;
  if (headRow) members.push({ id: headRow.id, content: headRow.content, occurred_at: headRow.occurred_at ?? null, created_at: headRow.created_at, current: true });
  const key = (m: { occurred_at: string | null; created_at: string }) => normTime(m.occurred_at ?? m.created_at);
  members.sort((a, b) => (key(a) < key(b) ? -1 : 1));
  return members.slice(-maxLen).map((m) => ({
    id: m.id, content: m.content, occurredAt: m.occurred_at, createdAt: m.created_at, current: m.current,
  }));
}

export interface SearchParams {
  /** AI 扩展后的词群（同义词/上位词/场景词/实体名），>=3 字走 FTS，1-2 字走倒排 */
  terms: string[];
  occurredFrom?: string;
  occurredTo?: string;
  limit?: number;
  budget?: number;
}

export interface SearchHit {
  id: string;
  content: string;
  type: string;
  occurredAt: string | null;
  deviceId: string | null;
  sessionId: string | null;
  sourceRef: string | null;
  score: number;
  matchedTerms: string[];
  onThisDevice: boolean;
  chain?: { id: string; content: string; occurredAt: string | null; createdAt: string; superseded: boolean }[];
}

export interface SearchResult {
  hits: SearchHit[];
  linkedPreview: { id: string; relation: string; preview: string }[];
  relatedTags: string[];
  tokensUsed: number;
}

/** 估算一条记忆的 token 占用（中文 ~1 字 ≈ 1 token，保守 + 头部开销） */
function estTokens(s: string): number {
  return Math.ceil(s.length * 0.8) + 24;
}

/**
 * 时间归一化（移植适配）：occurred_at=本地格式 "YYYY-MM-DD HH:MM:SS"，
 * created_at=ISO UTC——两种格式直接字符串比较会错序（同格式无此问题）。
 * 排序 key 一律经此归一为本地 "YYYY-MM-DD HH:MM:SS" 再比较。
 */
function normTime(t: string): string {
  if (!t.includes("T")) return t;
  const d = new Date(t);
  if (isNaN(d.getTime())) return t;
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 给一批记忆算 1-hop 邻居预览（不含正文，只有 id + 关系 + 30 字）。
 *
 * 抽成函数是因为它有**两个调用方**：词法管线的命中，以及混合检索里纯向量命中的
 * 那部分。两份实现一定会漂移——而这一处漂移过一次（见下面那条注释），代价是
 * 「功能永远返回空数组，且没人发现」。
 *
 * `exclude` 放已在结果里的 id：邻居本身已经给过正文，就不该再花 25 token 给一份
 * 摘要，那纯属同一信息付两次钱。
 *
 * 排序读的是**有效权重**（含时间衰减）：久不共现的边会自然沉下去，而不是永久占位。
 */
export function linkedPreviewFor(
  db: Database,
  ids: string[],
  exclude: Set<string>,
  limit = 10,
): SearchResult["linkedPreview"] {
  if (!ids.length || limit <= 0) return [];
  const ph = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT l.from_id, l.to_id, l.relation, m.content
    FROM memory_links_eff l JOIN memories m ON m.id = CASE WHEN l.from_id IN (${ph}) THEN l.to_id ELSE l.from_id END
    WHERE (l.from_id IN (${ph}) OR l.to_id IN (${ph})) AND l.eff > ${LINK_VISIBLE_MIN}
    ORDER BY l.eff DESC
    LIMIT ${limit}
  `).all(...ids, ...ids, ...ids) as Array<{ from_id: string; to_id: string; relation: string; content: string }>;

  const idSet = new Set(ids);
  const out: SearchResult["linkedPreview"] = [];
  for (const r of rows) {
    // 对面那条：边至少有一端在 ids 里（见上面 WHERE），取另一端。
    // ⚠️ 2026-11-08 修：这里原来写的是
    //     if (hits.some((h) => h.id === r.from_id || h.id === r.to_id)) continue;
    //   而这个条件与 WHERE 的 `from_id IN (…) OR to_id IN (…)` 完全等价 ⇒ 恒为真，
    //   每一行都被跳过，linkedPreview **永远是空数组**。功能从上线起就没生效过，
    //   而 search_memory 的工具描述还一直对 AI 承诺 "linkedPreview neighbors" ——
    //   AI 读到空数组会认定「没有关联」，于是不再往下去找，比缺功能更糟。
    //   没有任何测试断言过 linkedPreview，所以它安静地空了很久。现在的判据是
    //   「**另一端**是否已在结果里」：在，就不必再占一份预览 token；不在，才推。
    const other = idSet.has(r.from_id) ? r.to_id : r.from_id;
    if (exclude.has(other)) continue;
    exclude.add(other); // 同一邻居被多条命中共享时只推一次
    out.push({
      id: other,
      relation: r.relation,
      preview: maskSecrets(r.content.length > 30 ? r.content.slice(0, 30) + "…" : r.content),
    });
  }
  return out;
}

export function searchMemory(db: Database, params: SearchParams): SearchResult {
  const limit = Math.min(params.limit ?? 5, 10);
  const budget = params.budget ?? 2000;
  const terms = params.terms.map((t) => t.trim()).filter(Boolean);

  // ── 路径 A：FTS trigram（>=3 字的词）──
  const ftsScores = new Map<string, { terms: Set<string> }>();
  for (const t of terms) {
    if ([...t].length < 3) continue;
    try {
      const rows = db.prepare(
        `SELECT rowid AS rid FROM memories_fts WHERE memories_fts MATCH ? LIMIT 200`,
      ).all(`"${t.replace(/"/g, '""')}"`) as Array<{ rid: number }>;
      for (const row of rows) {
        // rowid → UUID 主键映射（FTS content_rowid=rowid，与 TEXT 主键是两套）
        const m = db.prepare("SELECT id FROM memories WHERE rowid = ?").get(row.rid) as { id: string } | undefined;
        if (!m) continue;
        if (!ftsScores.has(m.id)) ftsScores.set(m.id, { terms: new Set() });
        ftsScores.get(m.id)!.terms.add(t);
      }
    } catch { /* 非法 MATCH 表达式跳过 */ }
  }

  // ── 路径 B：memory_terms 倒排（全部词，含 1-2 字短词；高频词截断）──
  const termScores = new Map<string, { terms: Set<string> }>();
  for (const t of terms) {
    const rows = db.prepare(
      "SELECT memory_id AS id FROM memory_terms WHERE term = ? LIMIT 500",
    ).all(t) as Array<{ id: string }>;
    for (const row of rows) {
      if (!termScores.has(row.id)) termScores.set(row.id, { terms: new Set() });
      termScores.get(row.id)!.terms.add(t);
    }
  }

  // ── 路径 C：实体精确命中（别名 LIKE 反向扫，语料小可接受）──
  const placeholders = terms.map(() => "?").join(",");
  const entityScores = new Map<string, Set<string>>();
  if (terms.length) {
    const rows = db.prepare(`
      SELECT me.memory_id AS id, e.name AS name
      FROM entities e
      LEFT JOIN memory_entity me ON me.entity_id = e.id
      WHERE e.name IN (${placeholders}) OR (e.aliases IS NOT NULL AND ${terms.map(() => "e.aliases LIKE ?").join(" OR ")})
    `).all(...terms, ...terms.map((t) => `%${t}%`)) as Array<{ id: string | null; name: string }>;
    for (const row of rows) {
      if (row.id == null) continue;
      if (!entityScores.has(row.id)) entityScores.set(row.id, new Set());
      entityScores.get(row.id)!.add(row.name);
    }
  }

  // ── IDF 加权融合 ──
  const total = (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE deleted_at IS NULL AND status != 'forgotten'").get() as { c: number }).c || 1;
  const dfRows = terms.length
    ? db.prepare("SELECT term, COUNT(*) AS c FROM memory_terms WHERE term IN (" + placeholders + ") GROUP BY term").all(...terms) as Array<{ term: string; c: number }>
    : [];
  const df = new Map<string, number>();
  for (const r of dfRows) df.set(r.term, r.c);

  const candidates = new Set<string>([...ftsScores.keys(), ...termScores.keys(), ...entityScores.keys()]);
  const scored: { id: string; score: number; matched: Set<string> }[] = [];
  for (const id of candidates) {
    let score = 0;
    const matched = new Set<string>();
    const fts = ftsScores.get(id);
    if (fts) for (const t of fts.terms) {
      score += 2.0 * Math.log(1 + total / Math.max(1, df.get(t) ?? 1));
      matched.add(t);
    }
    const ts = termScores.get(id);
    if (ts) for (const t of ts.terms) {
      if (!matched.has(t)) {
        score += 1.0 * Math.log(1 + total / Math.max(1, df.get(t) ?? 1));
        matched.add(t);
      }
    }
    const es = entityScores.get(id);
    if (es) { score += 3.0; for (const t of es) matched.add(t); }
    if (score > 0) scored.push({ id, score, matched });
  }
  scored.sort((a, b) => b.score - a.score);

  // ── 时间过滤 + 延续链重定向 + 预算封顶 + 组装 ──
  const hits: SearchHit[] = [];
  const hitIds = new Set<string>();
  let tokensUsed = 0;
  const loadMem = db.prepare(`
    SELECT m.id, m.content, m.type, m.occurred_at, m.session_id, m.device_id, m.source_ref, m.superseded_by, d.name AS device_name
    FROM memories m LEFT JOIN devices d ON d.id = m.device_id
    WHERE m.id = ? AND m.deleted_at IS NULL
  `);
  for (const s of scored) {
    if (hits.length >= limit) break;
    let m = loadMem.get(s.id) as {
      id: string; content: string; type: string; occurred_at: string | null; session_id: string | null;
      device_id: string | null; source_ref: string | null; superseded_by: string | null; device_name: string | null;
    } | undefined;
    if (!m) continue;
    if (m.superseded_by) {
      let head = m.superseded_by, hops = 0;
      while (hops++ < 10) {
        const r2 = db.prepare("SELECT id, superseded_by FROM memories WHERE id = ? AND deleted_at IS NULL").get(head) as { id: string; superseded_by: string | null } | undefined;
        if (!r2 || !r2.superseded_by) break;
        head = r2.superseded_by;
      }
      if (hitIds.has(head)) continue;
      const hm = loadMem.get(head) as typeof m | undefined;
      if (!hm) continue;
      m = hm;
    }
    if (params.occurredFrom && (!m.occurred_at || m.occurred_at < params.occurredFrom)) continue;
    if (params.occurredTo && (!m.occurred_at || m.occurred_at > params.occurredTo + "z")) continue;
    if (hitIds.has(m.id)) continue;
    const tk = estTokens(m.content);
    if (tokensUsed + tk > budget && hits.length > 0) break;
    tokensUsed += tk;
    hitIds.add(m.id);
    hits.push({
      id: m.id, content: maskSecrets(m.content), type: m.type,
      occurredAt: m.occurred_at, deviceId: m.device_name ?? m.device_id,
      sessionId: m.session_id ?? null,
      sourceRef: m.source_ref,
      score: Math.round(s.score * 100) / 100,
      matchedTerms: [...s.matched],
      onThisDevice: true,
    });
  }

  // ── 链共现：为每条命中挂延续链（轻量附注，跨命中去重，token 计入预算）──
  const chainShown = new Set<string>(hitIds);
  for (const h of hits) {
    const links = resolveChain(db, h.id);
    const others = links.filter((l) => !chainShown.has(l.id));
    for (const l of others) chainShown.add(l.id);
    if (others.length) {
      h.chain = others.map((l) => ({ id: l.id, content: maskSecrets(l.content), occurredAt: l.occurredAt, createdAt: l.createdAt, superseded: !l.current }));
      tokensUsed += others.reduce((t, l) => t + estTokens(l.content), 0);
    }
  }

  // ── 1-hop 链接扩展（折叠为单行预览，~25 token）──
  const linkedPreview = hits.length
    ? linkedPreviewFor(db, hits.map((h) => h.id), new Set(hits.map((h) => h.id)))
    : [];
  tokensUsed += linkedPreview.length * 25;

  // ── related_tags：命中项的标签/实体，引导 AI 下一轮换词 ──
  const tagSet = new Set<string>();
  for (const h of hits) {
    const row = db.prepare("SELECT tags, entities FROM memories WHERE id = ?").get(h.id) as { tags: string | null; entities: string | null } | undefined;
    for (const k of ["tags", "entities"] as const) {
      if (row?.[k]) {
        try { for (const t of JSON.parse(row[k]) as string[]) if (!terms.includes(t)) tagSet.add(t); } catch { /* 损坏行跳过 */ }
      }
    }
  }

  // ── 反馈记账（放最后）──
  // 本次检索读到的强度必须是「上一次为止」的积累，不能自己给自己打分：
  // 若先强化再取预览，同一批刚共现的边会立刻插到预览头部，排序就变成了自证。
  onRecalled(db, hits.map((h) => h.id));

  return {
    hits,
    linkedPreview,
    relatedTags: [...tagSet].slice(0, 10),
    tokensUsed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 混合检索（四通道：FTS ∥ 着陆垫 ∥ 实体 ∥ 向量，RRF k=60 合并）
// 2026-10-04 定稿：个人版直上向量。向量失败自动降级纯词法（双降级红线）。
// ─────────────────────────────────────────────────────────────────────────────

/** 暴力向量扫描（个人库量级全扫；512 维 f32，1 万条 ~20MB 内存，<10ms） */
function vecTopK(
  db: Database,
  queryVec: Float32Array,
  k = 100,
): Array<{ id: string; score: number }> {
  const rows = db.prepare(
    "SELECT id, embedding FROM memories WHERE status = 'active' AND deleted_at IS NULL AND embedding IS NOT NULL AND vec_model = ?",
  ).all(VEC_MODEL_REF) as Array<{ id: string; embedding: Buffer }>;
  const scored: Array<{ id: string; score: number }> = [];
  for (const r of rows) {
    const v = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
    scored.push({ id: r.id, score: cosine(queryVec, v) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// 避免循环 import：VEC_MODEL 从 embedder 动态取
const VEC_MODEL_REF = "bge-small-zh-v1.5/int8";

/**
 * 混合检索入口（MCP search_memory 本地路径）：
 * 词法三路（searchMemory）∪ 向量路 → RRF 合并 → 链重定向/预算封顶（词法管线内已完成的部分保留）。
 * query embed 失败/模型未就绪 = 直接返回词法结果（自动降级）。
 */
export async function searchHybrid(
  db: Database,
  embedQuery: () => Promise<Float32Array | null>,
  params: SearchParams,
): Promise<SearchResult & { vecHits?: number }> {
  const lexical = searchMemory(db, params);
  try {
    const qv = await embedQuery();
    if (!qv) return lexical;
    const vecHits = vecTopK(db, qv, 100);
    if (vecHits.length === 0) return lexical;

    // RRF k=60：词法榜与向量榜各按名次贡献 1/(60+rank)
    const K = 60;
    const rrf = new Map<string, number>();
    lexical.hits.forEach((h, i) => rrf.set(h.id, (rrf.get(h.id) ?? 0) + 1 / (K + i + 1)));
    vecHits.forEach((v, i) => rrf.set(v.id, (rrf.get(v.id) ?? 0) + 1 / (K + i + 1)));

    // 词法命中的元数据保留；纯向量命中的补取内容（过链重定向+预算闸）
    const byId = new Map(lexical.hits.map((h) => [h.id, h]));
    const merged: SearchHit[] = [];
    const usedTokens = lexical.tokensUsed;
    let tokens = usedTokens;
    for (const id of [...rrf.keys()].sort((a, b) => (rrf.get(b) ?? 0) - (rrf.get(a) ?? 0))) {
      const exist = byId.get(id);
      if (exist) { merged.push(exist); continue; }
      if (merged.length >= (params.limit ?? 5)) break;
      const m = db.prepare(
        "SELECT id, content, type, occurred_at, session_id, device_id, source_ref FROM memories WHERE id = ? AND deleted_at IS NULL AND status = 'active'",
      ).get(id) as { id: string; content: string; type: string; occurred_at: string | null; session_id: string | null; device_id: string | null; source_ref: string | null } | undefined;
      if (!m) continue;
      const tk = estTokens(m.content);
      if (tokens + tk > (params.budget ?? 2000)) break;
      tokens += tk;
      merged.push({
        id: m.id, content: maskSecrets(m.content), type: m.type,
        occurredAt: m.occurred_at, deviceId: m.device_id, sessionId: m.session_id,
        sourceRef: m.source_ref, score: Math.round((rrf.get(id) ?? 0) * 1000) / 1000,
        matchedTerms: ["vector"], onThisDevice: true,
      });
    }
    // 纯向量命中的条目不在 lexical.hits 里，它们的出边不会被词法管线算到——
    // 而「说法完全不同、语义相近」正是向量通道存在的理由（9 月说"吃饭的锅"、
    // 7 月记的是"电饭煲"）。漏在这里，等于多跳链在最需要它的那条路径上断掉。
    const lexIds = new Set(lexical.hits.map((h) => h.id));
    let linkedPreview = lexical.linkedPreview;
    const extraIds = merged.filter((h) => !lexIds.has(h.id)).map((h) => h.id);
    if (extraIds.length) {
      const seen = new Set(merged.map((h) => h.id));
      for (const p of linkedPreview) seen.add(p.id);
      const extra = linkedPreviewFor(db, extraIds, seen, Math.max(0, 10 - linkedPreview.length));
      linkedPreview = linkedPreview.concat(extra);
      tokens += extra.length * 25;
    }
    return { hits: merged, linkedPreview, relatedTags: lexical.relatedTags, tokensUsed: tokens, vecHits: vecHits.length };
  } catch {
    return lexical; // 永不因向量故障挂
  }
}
