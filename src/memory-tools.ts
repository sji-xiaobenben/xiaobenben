// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * MCP 工具层。
 * recall_topic / recall_timeline / recall_session / get_memory / get_related /
 * reveal_secret / recall_directives / recall_constraints / constraint_directory
 * 全部确定性 SQL，零模型。
 *
 * 移植适配：id number→string(UUIDv7)；recorded_at→created_at（对外 createdAt）；存活过滤双列。
 * directives 两函数为一等语义重建（源 SQL 结构已核对，行为对齐：窗口内 directive/ habit / constraint 目录）。
 */
import type { Database } from "bun:sqlite";
import { localNow, autoSessionId } from "./memory-write";
import { DEFAULT_DOMAIN } from "./seed";
import { maskSecrets, resolveChain } from "./memory-search";
import { onRecalled } from "./recall-feedback";
import { LINK_VISIBLE_MIN } from "./schema";
import { attachPayloads, loadPayloadsFor } from "./payloads";

const cut = (s: string, n = 30) => (s.length > n ? s.slice(0, n) + "…" : s);

function chainHead(db: Database, id: string, maxHops = 10): string {
  let head = id, hops = 0;
  while (hops++ < maxHops) {
    const r = db.prepare("SELECT id, superseded_by FROM memories WHERE id = ? AND deleted_at IS NULL").get(head) as { id: string; superseded_by: string | null } | undefined;
    if (!r || !r.superseded_by) break;
    head = r.superseded_by;
  }
  return head;
}

/** 话题簇召回：「我们上次聊的 X」——实体精确命中 + 按会话分组 + 链头保障在场 */
export function recallTopic(db: Database, entity: string, limit = 30) {
  const ent = db.prepare("SELECT id, name, aliases FROM entities WHERE name = ? OR aliases LIKE ?").get(entity, `%"${entity}"%`) as { id: number; name: string; aliases: string | null } | undefined;
  if (!ent) return { entity, aliases: [], total: 0, sessions: [] };
  let aliases: string[] = [];
  try { aliases = ent.aliases ? JSON.parse(ent.aliases) : []; } catch { /* 忽略 */ }

  const rows = db.prepare(`
    SELECT m.id, m.content, m.type, m.session_id, m.occurred_at, m.superseded_by
    FROM memory_entity me JOIN memories m ON m.id = me.memory_id
    WHERE me.entity_id = ? AND m.deleted_at IS NULL
    ORDER BY m.occurred_at DESC, m.created_at DESC LIMIT ?
  `).all(ent.id, Math.min(limit, 30)) as Array<{ id: string; content: string; type: string; session_id: string | null; occurred_at: string | null; superseded_by: string | null }>;

  const seenIds = new Set<string>(rows.map((r) => r.id));
  for (const r of [...rows]) {
    if (!r.superseded_by) continue;
    const head = chainHead(db, r.id);
    if (!seenIds.has(head)) {
      const hm = db.prepare("SELECT id, content, type, session_id, occurred_at, superseded_by FROM memories WHERE id = ? AND deleted_at IS NULL").get(head) as typeof rows[number] | undefined;
      if (hm) { rows.push(hm); seenIds.add(head); }
    }
  }

  onRecalled(db, rows.map((r) => r.id));
  const bySession = new Map<string, Array<{ id: string; content: string; type: string; occurred: string | null; supersededBy: string | null }>>();
  for (const r of rows) {
    const key = r.session_id ?? `#${r.id}`;
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key)!.push({ id: r.id, content: maskSecrets(r.content), type: r.type, occurred: r.occurred_at, supersededBy: r.superseded_by ?? null });
  }
  const sessions = [...bySession.entries()].map(([sessionId, memories]) => ({
    sessionId,
    occurred: memories[0]?.occurred ?? null,
    memories: memories.map(({ id, content, type, supersededBy }) => ({ id, content, type, supersededBy })),
  }));
  // 载荷提货单（只给引用与描述、**不给字节**；无载荷的记忆不出现 payloads 键）
  const flat: Array<{ id: string; payloads?: unknown }> = sessions.flatMap((s) => s.memories);
  attachPayloads(db, flat);
  return { entity: ent.name, aliases, total: rows.length, sessions };
}

/** 时间线回溯：「去年三月都聊了什么」（occurred_at 本地格式，字符串比较） */
export function recallTimeline(db: Database, from: string, to: string, entity?: string, limit = 20) {
  let rows: Array<{ id: string; content: string; type: string; occurred_at: string | null; session_id: string | null; superseded_by: string | null }>;
  if (entity) {
    const ent = db.prepare("SELECT id FROM entities WHERE name = ? OR aliases LIKE ?").get(entity, `%"${entity}"%`) as { id: number } | undefined;
    if (!ent) return { from, to, hits: [] };
    rows = db.prepare(`
      SELECT m.id, m.content, m.type, m.occurred_at, m.session_id, m.superseded_by
      FROM memory_entity me JOIN memories m ON m.id = me.memory_id
      WHERE me.entity_id = ? AND m.occurred_at >= ? AND m.occurred_at < ? || 'z' AND m.deleted_at IS NULL
      ORDER BY m.occurred_at DESC LIMIT ?
    `).all(ent.id, from, to, Math.min(limit, 30)) as typeof rows;
  } else {
    rows = db.prepare(`
      SELECT id, content, type, occurred_at, session_id, superseded_by FROM memories
      WHERE occurred_at >= ? AND occurred_at < ? || 'z' AND deleted_at IS NULL
      ORDER BY occurred_at DESC LIMIT ?
    `).all(from, to, Math.min(limit, 30)) as typeof rows;
  }
  onRecalled(db, rows.map((r) => r.id));
  const hits = rows.map((r) => ({ id: r.id, content: maskSecrets(r.content), type: r.type, occurredAt: r.occurred_at, sessionId: r.session_id, supersededBy: r.superseded_by ?? null }));
  attachPayloads(db, hits);
  return { from, to, hits };
}

/** 精确取单条（含双向链接全景 + 延续链） */
export function getMemory(db: Database, id: string) {
  const m = db.prepare(`
    SELECT m.id, m.content, m.type, m.tags, m.entities, m.occurred_at, m.created_at,
           m.session_id, m.source_ref, m.importance, m.superseded_by, d.name AS device_name
    FROM memories m LEFT JOIN devices d ON d.id = m.device_id
    WHERE m.id = ? AND m.deleted_at IS NULL
  `).get(id) as {
    id: string; content: string; type: string; tags: string | null; entities: string | null;
    occurred_at: string | null; created_at: string; session_id: string | null; source_ref: string | null;
    importance: number | null; superseded_by: string | null; device_name: string | null;
  } | undefined;
  if (!m) return null;
  const links = db.prepare(`
    SELECT l.from_id, l.to_id, l.relation, l.eff AS weight,
           CASE WHEN l.from_id = ? THEN l.to_id ELSE l.from_id END AS other_id, om.content
    FROM memory_links_eff l JOIN memories om ON om.id = CASE WHEN l.from_id = ? THEN l.to_id ELSE l.from_id END
    WHERE l.from_id = ? OR l.to_id = ?
    ORDER BY l.eff DESC
  `).all(id, id, id, id) as Array<{ other_id: string; relation: string; weight: number; content: string }>;
  const parse = (s: string | null): string[] => { try { return s ? JSON.parse(s) : []; } catch { return []; } };
  const out: Record<string, unknown> = {
    id: m.id, content: maskSecrets(m.content), type: m.type,
    tags: parse(m.tags), entities: parse(m.entities),
    occurredAt: m.occurred_at, createdAt: m.created_at,
    sessionId: m.session_id, sourceRef: m.source_ref,
    device: m.device_name ?? null, supersededBy: m.superseded_by ?? null,
    links: links.map((l) => ({ id: l.other_id, relation: l.relation, weight: Math.round(l.weight * 100) / 100, preview: maskSecrets(cut(l.content)) })),
    chain: resolveChain(db, id).filter((l) => l.id !== id).map((l) => ({ ...l, content: maskSecrets(l.content) })),
  };
  // 载荷提货单（提货单不含字节；取本体走 get_asset）。无载荷时**不写这个键**。
  const ps = loadPayloadsFor(db, [id]).get(id);
  if (ps?.length) out.payloads = ps;
  return out;
}

/**
 * 邻居探索：1-hop 关联记忆（嵌套探索入口）。
 *
 * 排序 = **有效权重 ÷ √(1+邻居度)**：
 *  - 有效权重含时间衰减（30 天半衰）⇒ 久不共现的边自然沉底，而不是永久占位；
 *  - 除以√度是抑制**枢纽霸榜**：一条连着几百条记忆的“人类常识”条目，对谁都很近，
 *    若不折算，它的每一条边都会盖过真正私密而紧密的关联（Adamic-Adar 的资源分配思路）。
 *    只除以当前节点自己的度是没用的——那是所有邻居共有的常数，改不了排序。
 */
export function getRelated(db: Database, id: string, limit = 10) {
  const rows = db.prepare(`
    SELECT l.relation, l.eff AS w,
           CASE WHEN l.from_id = ? THEN l.to_id ELSE l.from_id END AS other_id, om.content, om.type, om.occurred_at
    FROM memory_links_eff l JOIN memories om ON om.id = CASE WHEN l.from_id = ? THEN l.to_id ELSE l.from_id END
    WHERE (l.from_id = ? OR l.to_id = ?) AND l.eff > ${LINK_VISIBLE_MIN} AND om.deleted_at IS NULL
  `).all(id, id, id, id) as Array<{ other_id: string; relation: string; w: number; type: string; occurred_at: string | null; content: string }>;
  if (!rows.length) return [];

  const nbr = [...new Set(rows.map((r) => r.other_id))];
  const ph = nbr.map(() => "?").join(",");
  const deg = new Map<string, number>();
  for (const r of db.prepare(`
    SELECT nid AS id, COUNT(*) AS c FROM (
      SELECT from_id AS nid FROM memory_links WHERE from_id IN (${ph})
      UNION ALL
      SELECT to_id AS nid FROM memory_links WHERE to_id IN (${ph})
    ) GROUP BY nid
  `).all(...nbr, ...nbr) as Array<{ id: string; c: number }>) deg.set(r.id, r.c);

  const r2 = (n: number) => Math.round(n * 100) / 100;
  return rows
    .map((r) => ({ ...r, score: r.w / Math.sqrt(1 + (deg.get(r.other_id) ?? 0)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(limit, 20))
    .map((r) => ({
      id: r.other_id, relation: r.relation,
      weight: r2(r.w), score: r2(r.score),
      type: r.type, occurredAt: r.occurred_at, content: maskSecrets(cut(r.content, 60)),
    }));
}

/** 会话回放：按会话 id 拉取全部记忆（排除已延续旧环），时间正序还原 */
export function recallSession(db: Database, sessionId: string, limit = 100) {
  const total = (db.prepare(
    "SELECT COUNT(*) AS c FROM memories WHERE session_id = ? AND deleted_at IS NULL AND superseded_by IS NULL",
  ).get(sessionId) as { c: number }).c;
  const rows = db.prepare(`
    SELECT id, content, type, kind, occurred_at, created_at, tags
    FROM memories
    WHERE session_id = ? AND deleted_at IS NULL AND superseded_by IS NULL
    ORDER BY COALESCE(occurred_at, created_at) ASC, created_at ASC
    LIMIT ?
  `).all(sessionId, Math.min(limit, 500)) as Array<{ id: string; content: string; type: string; kind: string | null; occurred_at: string | null; created_at: string; tags: string | null }>;
  onRecalled(db, rows.map((r) => r.id));
  const items = rows.map((r) => ({
    id: r.id, content: maskSecrets(r.content), type: r.type, kind: r.kind ?? "memory",
    occurredAt: r.occurred_at, createdAt: r.created_at,
    tags: (() => { try { return r.tags ? JSON.parse(r.tags) : []; } catch { return []; } })(),
  }));
  attachPayloads(db, items);
  return { sessionId, total, items };
}

/** 取密：凭据明文唯一出口（显式动作，工具描述写死「先向用户说明用途」纪律） */
export function revealSecret(db: Database, id: number): { id: number; value: string; label: string | null; updatedAt: string | null } | null {
  const r = db.prepare("SELECT id, value, label, updated_at FROM secrets WHERE id = ?").get(id) as { id: number; value: string; label: string | null; updated_at: string | null } | undefined;
  if (!r) return null;
  return { id: r.id, value: r.value, label: r.label ?? null, updatedAt: r.updated_at ?? null };
}

// 赫布式强化已迁至 `recall-feedback.ts:reinforceCooccurrence()`（2026-10-18）。
// 旧实现 `reinforce()` 是**按节点**强化（`from_id = ? OR to_id = ?`），且全仓 0 调用点、
// 无衰减 ⇒ weight 恒等于默认 0.5，`ORDER BY weight` 是空排序。新实现按**共现对**强化、
// 与衰减同做，并由 `onRecalled()` 统一挂到四个召回入口上。此处刻意不留转发导出：
// 留着会诱使后来者「调一下这个就行」——那正是它变成死代码的那条路。

// ── 指令记忆子系统（directives.ts 语义重建）──

export interface DirectiveRow {
  id: string; content: string; kind: string; dscope: string | null; domain: string | null;
  expiresAt: string | null; similarSessions: number; createdAt: string;
}

const D_COLS = `id, content, kind, dscope, domain, expires_at, similar_sessions, created_at`;
const dOut = (r: any): DirectiveRow => ({
  id: r.id, content: maskSecrets(r.content), kind: r.kind, dscope: r.dscope ?? null,
  domain: r.domain ?? null, expiresAt: r.expires_at ?? null,
  similarSessions: r.similar_sessions ?? 0, createdAt: r.created_at,
});

/** 召回当前生效的指令面：有效窗口 directive + 全部 habit + constraint（AI 新会话首查入口） */
export function recallDirectives(db: Database, sessionId?: string | null, nowLocal?: string) {
  const now = nowLocal ?? localNow();

  // 长期习惯（启动全量 ≤100）
  const habits = (db.prepare(`
    SELECT ${D_COLS} FROM memories
    WHERE kind = 'habit' AND deleted_at IS NULL AND status = 'active' AND superseded_by IS NULL
    ORDER BY created_at DESC LIMIT 100
  `).all() as any[]).map(dOut);

  // 窗口内短期叮嘱（≤20 按到期升序——最快失效的最先提醒；会话级不拉：它本来就在当前对话上下文里）
  const directives = (db.prepare(`
    SELECT ${D_COLS} FROM memories
    WHERE kind = 'directive' AND deleted_at IS NULL AND status = 'active' AND superseded_by IS NULL
      AND dscope IN ('today', 'week')
      AND (starts_at IS NULL OR starts_at <= ?) AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY expires_at ASC, created_at DESC LIMIT 20
  `).all(now, now) as any[]).map(dOut);

  // 全局约束（用户立的"处处生效"约束，预计极少 ≤10）
  const globalConstraints = (db.prepare(`
    SELECT ${D_COLS} FROM memories
    WHERE kind = 'constraint' AND deleted_at IS NULL AND status = 'active' AND superseded_by IS NULL
      AND dscope = 'global'
    ORDER BY created_at DESC LIMIT 10
  `).all() as any[]).map(dOut);

  // 默认约束域（系统行为契约，随库分发，全量）
  const defaultConstraints = (db.prepare(`
    SELECT ${D_COLS} FROM memories
    WHERE kind = 'constraint' AND deleted_at IS NULL AND status = 'active' AND superseded_by IS NULL
      AND domain = ?
    ORDER BY created_at ASC
  `).all(DEFAULT_DOMAIN) as any[]).map(dOut);

  // 晋升就绪的叮嘱（跨 ≥7 个会话出现相似叮嘱 → AI 应询问用户是否蒸馏为习惯）
  const promotionReady = (db.prepare(`
    SELECT id, content, similar_sessions, created_at FROM memories
    WHERE kind = 'directive' AND deleted_at IS NULL AND status = 'active' AND superseded_by IS NULL
      AND similar_sessions >= 7
    ORDER BY similar_sessions DESC LIMIT 10
  `).all() as any[]).map((r) => ({ id: r.id, content: r.content, distinctSessions: r.similar_sessions, recordedAt: r.created_at }));

  return {
    now,
    // 回传进程级自动会话章：AI 由此得知当前会话标识（写入时可复用）
    sessionId: sessionId ?? autoSessionId(),
    habits,
    directives,
    globalConstraints,
    defaultConstraints,
    promotionReady,
    hint: "以上习惯/叮嘱/约束在本会话全程生效。sessionId 是引擎为本连接自动盖的会话章——若本次对话实际是在继续早前的同一对话（客户端重连/重开会换连接），检索命中此前记忆后以其 sessionId 为准，写入时显式传入。promotionReady 非空时，向用户转述并询问是否将相似叮嘱蒸馏为长期习惯（用户同意后调用 write_memory kind=habit 写入蒸馏结果，原叮嘱无需删除——引擎在写入时自动覆盖）。",
  };
}

// ── 域地图（约束域 dirctory + 域聚合召回）─────────────────────────────────────
// 指令/约束解析。此前这块曾整体缺失：
// constraintDirectory 沦为死代码、recallConstraints 退化成"扁平 hits + 重叠数排序"、
// 工具 schema 的 terms 又改成必填 ⇒ 接口层连目录模式都进不去。本轮恢复并小幅增强。
//
// 语义（**引擎不枚举域**）：`domain` 只服务 kind='constraint'；引擎只提供「域」这个**容器**，
// 具体有哪些域（UI 设计/代码风格/沟通语气…）由 **AI 写入时动态归并**——这是「机制不语义」在约束层的落点。
// 「地图」= ①域目录（写前归并）+ ②域聚合召回（域是检索单元），共同解决**域爆炸**——
// 没有地图，AI 会不断造近义域（"健体/健身/运动"三分），约束体系就散了。
// ⚠️ 防爆是**软约束**：既有测试就同时造了四个近义域并断言目录能列全 ⇒ 地图只负责"让 AI 看得见"，
//    不负责强制归并。要强约束得靠组织级（企业）那层，不在本机制内。
const DOMAIN_LIMITS = { domains: 200, sampleTerms: 12 };
const DIRECTORY_HINT =
  "写入新约束前先看本目录：已有相近域必须复用（如「健体」应归入「运动」），确属新维度才建新域。";
const UNMATCHED_HINT =
  "词群未命中任何约束域——可能确实没有相关约束，也可能是词群质量不足。直接继续任务即可；如属风格类产出，谨慎行事。";

/** 域目录 = 地图本体（写入归并前置）。只列**用户/AI 自建域**：
 *  `system = 0` 且 `domain <> 默认域` ⇒ 系统级契约**不进地图**（它走 recall_directives 的 defaultConstraints 段）。
 *  增强：目录项补 terms 摘要与最近更新时间——AI 判断"新约束该归哪个域"时比单看一条样例更准。 */
export function constraintDirectory(db: Database) {
  const now = localNow();
  const rows = db.prepare(`
    SELECT domain, COUNT(*) AS c, MAX(created_at) AS updated_at
    FROM memories
    WHERE kind = 'constraint' AND deleted_at IS NULL AND status = 'active' AND superseded_by IS NULL
      AND domain IS NOT NULL AND system = 0 AND domain <> ?
    GROUP BY domain ORDER BY c DESC, domain ASC LIMIT ?
  `).all(DEFAULT_DOMAIN, DOMAIN_LIMITS.domains) as Array<{ domain: string; c: number; updated_at: string | null }>;
  const sampleStmt = db.prepare(`
    SELECT content FROM memories
    WHERE kind = 'constraint' AND domain = ? AND deleted_at IS NULL AND status = 'active' AND superseded_by IS NULL
    ORDER BY created_at DESC LIMIT 1
  `);
  const termsStmt = db.prepare(`
    SELECT DISTINCT mt.term FROM memory_terms mt JOIN memories m ON m.id = mt.memory_id
    WHERE m.kind = 'constraint' AND m.domain = ? AND m.deleted_at IS NULL AND m.status = 'active' AND m.superseded_by IS NULL
    ORDER BY mt.term LIMIT ?
  `);
  return {
    mode: "directory" as const,
    now,
    total: rows.length,
    domains: rows.map((r) => {
      const s = sampleStmt.get(r.domain) as { content: string } | undefined;
      return {
        domain: r.domain,
        count: r.c,
        sample: s ? maskSecrets(s.content) : null,
        terms: (termsStmt.all(r.domain, DOMAIN_LIMITS.sampleTerms) as Array<{ term: string }>).map((t) => t.term),
        updatedAt: r.updated_at ?? null,
      };
    }),
    // hits 恒存在（两模式出参同形）——目录模式下为空数组，消费方无需判 undefined
    hits: [] as Array<{ id: string; content: string; kind: string; domain: string | null; expiresAt: string | null }>,
    hint: DIRECTORY_HINT,
  };
}

/** 约束召回：任务词群 → 命中域（**域 = 检索单元**：域分 = Σ 域内条分，条分 = Σ IDF(命中词)）。
 *  0 词群 = 目录模式（写前归并）；0 命中是正常结果（继续任务即可，不是错误）。
 *  `hits` 是 `matchedDomains` 的**扁平派生视图**（派生视图，保留以兼容既有消费方与 AI 扫读习惯）。 */
export function recallConstraints(db: Database, terms: string[], budget = 1500) {
  const ts = (terms ?? []).map((t) => t.trim()).filter(Boolean);
  if (!ts.length) return constraintDirectory(db);

  const now = localNow();
  const ph = ts.map(() => "?").join(",");

  // IDF 分母：全库在世记忆数（**不分 kind**，同一把尺子量"词有多罕见"）
  const total =
    (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE deleted_at IS NULL").get() as { c: number } | undefined)?.c || 1;
  const dfRows = db
    .prepare(`SELECT term, COUNT(*) AS c FROM memory_terms WHERE term IN (${ph}) GROUP BY term`)
    .all(...ts) as Array<{ term: string; c: number }>;
  const df = new Map(dfRows.map((r) => [r.term, r.c]));

  const rows = db.prepare(`
    SELECT m.id, m.content, m.kind, m.domain, m.expires_at, GROUP_CONCAT(DISTINCT mt.term) AS matched
    FROM memories m JOIN memory_terms mt ON mt.memory_id = m.id AND mt.term IN (${ph})
    WHERE m.kind IN ('constraint', 'habit')
      AND m.deleted_at IS NULL AND m.status = 'active' AND m.superseded_by IS NULL
    GROUP BY m.id
  `).all(...ts) as Array<{
    id: string; content: string; kind: string; domain: string | null; expires_at: string | null; matched: string;
  }>;

  type Scored = { id: string; content: string; matchedTerms: string[]; expiresAt: string | null; score: number };
  const domainMap = new Map<string, { score: number; items: Scored[] }>();
  const habitList: Scored[] = [];
  for (const r of rows) {
    const hit = (r.matched ?? "").split(",").filter(Boolean);
    let score = 0;
    for (const t of hit) score += Math.log(1 + total / Math.max(1, df.get(t) ?? 1));
    const item: Scored = {
      id: r.id, content: maskSecrets(r.content), matchedTerms: hit, expiresAt: r.expires_at ?? null, score,
    };
    // 习惯天生无域（domain 恒 NULL）⇒ 不进地图，单列返回——否则会污染"域"的语义
    if (r.kind === "habit") { habitList.push(item); continue; }
    const key = r.domain ?? "(未归类)";
    if (!domainMap.has(key)) domainMap.set(key, { score: 0, items: [] });
    const d = domainMap.get(key)!;
    d.score += score;
    d.items.push(item);
  }

  const est = (s: string) => Math.ceil(s.length * 0.8) + 16;
  let used = 0;
  const matchedDomains: Array<{
    domain: string; score: number;
    constraints: Array<{ id: string; content: string; matchedTerms: string[]; expiresAt: string | null }>;
  }> = [];
  const hits: Array<{ id: string; content: string; kind: string; domain: string | null; expiresAt: string | null }> = [];
  // 域按总分降序、域内条按分降序；token 预算**以域为粒度**（进不去就整域不进，不留半截域）
  for (const [domain, info] of [...domainMap.entries()].sort((a, b) => b[1].score - a[1].score)) {
    const items = [...info.items].sort((a, b) => b.score - a.score);
    const need = items.reduce((n, it) => n + est(it.content), 0);
    if (used + need > budget) break;
    used += need;
    matchedDomains.push({
      domain,
      score: Math.round(info.score * 100) / 100,
      constraints: items.map((it) => ({ id: it.id, content: it.content, matchedTerms: it.matchedTerms, expiresAt: it.expiresAt })),
    });
    for (const it of items) {
      hits.push({ id: it.id, content: it.content, kind: "constraint", domain: domain === "(未归类)" ? null : domain, expiresAt: it.expiresAt });
    }
  }
  // 习惯：排在域聚合之后吃剩余预算
  const habitSorted = [...habitList].sort((a, b) => b.score - a.score);
  for (const h of habitSorted) {
    const tk = est(h.content);
    if (used + tk > budget) break;
    used += tk;
    hits.push({ id: h.id, content: h.content, kind: "habit", domain: null, expiresAt: h.expiresAt });
  }

  return {
    mode: "matched" as const,
    now,
    matchedDomains,
    habits: habitSorted.map((h) => ({ id: h.id, content: h.content, matchedTerms: h.matchedTerms })),
    hits,
    tokensUsed: used,
    unmatchedHint: matchedDomains.length || habitSorted.length ? null : UNMATCHED_HINT,
  };
}
