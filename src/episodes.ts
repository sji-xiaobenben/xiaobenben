// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 情景层 episodes（此前仅有表结构，本文件按规范实现）。
 *
 * 双层记忆：episodes=原话冷存档（append-only 永不修改，"当时具体说了什么"）
 *          memories=蒸馏原子事实（"我们定了什么"），source_chunk 指回出处块。
 *
 * 红线（2026-10-04 定稿）：
 *  - 仅存本地、永不上云（CloudBackend 不实现此能力）、不进 events 哈希链
 * （append-only episodes 表自身即本地凭证；「原文永不落盘」红线是钩子/服务端场景，
 *     本地用户显式存档不违反——数据主权：存什么用户说了算）
 *  - 冷路径纪律：单次调用 ≤2k token，必须带 session_id/时间锚，永不返回整段会话
 *
 * 2026-10-24 升级（V7）：从「关键词碎片捞」扩成「可翻页追溯」。
 *   原来只有 findEpisodes（FTS 命中块 ± 邻块），AI 无法顺着时间线读一场会话，
 *   也无法回答「那天我们聊了什么」「这个话题从头到尾怎么走的」。
 *   新增 recallTranscript：按 会话/天/话题 三轴定位，先给目录（outline）再给正文（turns），
 *   正文一律游标分页 + 双预算（条数 + 字符）硬闸——绝不一次性把整段上下文灌进会话窗口。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

/** 分块粒度（300-500 token；中文字符≈token，取 400 字符软上限，段落边界优先切断） */
const CHUNK_SIZE = 400;

/** 翻页默认与硬顶：条数管"读几轮"，字符管"读多少字"，两道闸都要，只把一道调大不会失控 */
const TURNS_DEFAULT = 40;
const TURNS_MAX = 100;
const CHARS_DEFAULT = 6000;
const CHARS_MAX = 12000;

/** 一条待入档的原话。source/externalId/dedupeKey 是 V8 采集层新增，MCP 上报路径留空 */
export interface EpisodeInput {
  sessionId: string;
  role: string;
  content: string;
  topic?: string | null;
  source?: string | null;
  externalId?: string | null;
  /** 客户端原始时间（'YYYY-MM-DD HH:MM:SS'）；缺省用当前本地时间 */
  recordedAt?: string;
  /** 去重键；非空则受 ux_episodes_dedupe 唯一索引保护，重复插入静默跳过 */
  dedupeKey?: string | null;
}

/** 采集侧去重键：**只认来源 + 会话 + 客户端原生 id**，不掺内容。
 *  掺内容会让"同一句话被客户端改写一个字"变成两条，反而破坏幂等。 */
export function ingestDedupeKey(source: string, sessionId: string, externalId: string): string {
  return createHash("sha256").update(`${source}\u0000${sessionId}\u0000${externalId}`).digest("hex");
}

/** 分块 + 灌 FTS（只对真正插入的行调用，重复行不该再产生一份倒排） */
function indexChunks(db: Database, sessionId: string, content: string): { first: number | null; count: number } {
  const ins = db.prepare("INSERT INTO episode_chunks (session_id, chunk_text, position) VALUES (?, ?, ?)");
  let first: number | null = null;
  let count = 0;
  let pos = 0;
  let rest = content;
  while (rest.length > 0) {
    let size = Math.min(CHUNK_SIZE, rest.length);
    if (rest.length > CHUNK_SIZE) {
      const win = rest.slice(0, CHUNK_SIZE);
      const cutAt = Math.max(win.lastIndexOf("\n"), win.lastIndexOf("。"), win.lastIndexOf("．"), win.lastIndexOf(". "));
      if (cutAt > CHUNK_SIZE / 2) size = cutAt + 1;
    }
    const cr = ins.run(sessionId, rest.slice(0, size), pos);
    if (first === null) first = Number(cr.lastInsertRowid);
    count++;
    pos += size;
    rest = rest.slice(size);
  }
  return { first, count };
}

/** 单条入档：唯一键冲突 ⇒ 视为已存在，不写也不索引。返回是否真正新增 */
export function appendEpisode(db: Database, e: EpisodeInput): { id: number | null; inserted: boolean; firstChunk: number | null; chunks: number } {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO episodes (session_id, role, content, topic, recorded_at, source, external_id, dedupe_key)
       VALUES (?, ?, ?, ?, COALESCE(?, datetime('now','localtime')), ?, ?, ?)`,
    )
    .run(
      e.sessionId,
      e.role,
      e.content,
      e.topic?.trim() || null,
      e.recordedAt ?? null,
      e.source ?? null,
      e.externalId ?? null,
      e.dedupeKey ?? null,
    );
  if (res.changes === 0) return { id: null, inserted: false, firstChunk: null, chunks: 0 };
  const id = Number(res.lastInsertRowid);
  const ch = indexChunks(db, e.sessionId, e.content);
  return { id, inserted: true, firstChunk: ch.first, chunks: ch.count };
}

/** 批量入档（单事务）。采集一次可能是上万条，逐条自动提交会慢一个数量级 */
export function appendEpisodes(db: Database, rows: EpisodeInput[]): { inserted: number; skipped: number; ids: number[] } {
  const ids: number[] = [];
  let skipped = 0;
  const tx = db.transaction((items: EpisodeInput[]) => {
    for (const r of items) {
      const r1 = appendEpisode(db, r);
      if (r1.inserted && r1.id !== null) ids.push(r1.id);
      else skipped++;
    }
  });
  if (rows.length) tx(rows);
  return { inserted: ids.length, skipped, ids };
}

/** 原话入档：append-only 行 + FTS 分块索引。返回 { ids, firstChunk } 供 write_memory 的 sourceChunk 指回 */
export function logEpisodes(
  db: Database,
  sessionId: string,
  entries: Array<{ role: "user" | "assistant" | "system"; content: string }>,
  topic?: string,
): {
  ids: number[];
  firstChunk: number | null;
  chunks: number;
  /** 本会话累计句数（含本次）——AI 靠它确认自己记到哪了，避免重复记或漏记 */
  sessionTurns: number;
  /** 本会话最后一句的开头（截断 60 字）——给 AI 一个可核对的"记到这儿了"水位线 */
  lastLine: string;
  /** 本库里近期出现过的话题（供 AI 复用，避免"附件描述/文件记忆描述/description"各写一套） */
  knownTopics: string[];
} {
  const ids: number[] = [];
  let firstChunk: number | null = null;
  let chunks = 0;
  const tp = topic?.trim() || null;
  const tx = db.transaction(() => {
    for (const e of entries) {
      // MCP 上报路径**不做内容去重**：用户可能真的连说两句"好"，一内容一哈希会误删。
      // 客户端采集走 external_id 去重（见 ingestDedupeKey），两条路径的语义因此不冲突。
      const r = appendEpisode(db, { sessionId, role: e.role, content: e.content, topic: tp, source: "mcp" });
      if (r.inserted && r.id !== null) ids.push(r.id);
      if (r.inserted && r.firstChunk !== null && firstChunk === null) firstChunk = r.firstChunk;
      if (r.inserted) chunks += r.chunks;
    }
  });
  tx();

  const sessionTurns = (db.prepare("SELECT count(*) c FROM episodes WHERE session_id = ?").get(sessionId) as { c: number }).c;
  const last = db.prepare("SELECT role, substr(content,1,60) s FROM episodes WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(sessionId) as
    | { role: string; s: string }
    | null;
  const knownTopics = (
    db.prepare("SELECT topic, count(*) c FROM episodes WHERE topic IS NOT NULL AND recorded_at >= datetime('now','-30 days') GROUP BY topic ORDER BY c DESC LIMIT 15").all() as Array<{ topic: string }>
  ).map((x) => x.topic);

  return {
    ids,
    firstChunk,
    chunks,
    sessionTurns,
    lastLine: last ? `[${last.role}] ${last.s}` : "",
    knownTopics,
  };
}

export interface EpisodeHit {
  rowid: number;
  sessionId: string;
  /** 命中块全文 */
  chunk: string;
  /** 上下文窗口：命中块 ± ctx 邻块（回跳"当时原话"的最小切片） */
  context: Array<{ position: number; text: string }>;
}

/** 冷路径精确检索：FTS 定位原话块 → 取回上下文窗口（≤2k token 纪律靠 ctx+limit 控制） */
export function findEpisodes(
  db: Database,
  query: string,
  opts: { sessionId?: string; ctx?: number; limit?: number } = {},
): { hits: EpisodeHit[]; note?: string } {
  const ctx = Math.min(opts.ctx ?? 1, 3);
  const limit = Math.min(opts.limit ?? 5, 20);
  let rows: Array<{ rowid: number; session_id: string; chunk_text: string; position: number }>;
  try {
    const sql = opts.sessionId
      ? `SELECT rowid, session_id, chunk_text, position FROM episode_chunks WHERE episode_chunks MATCH ? AND session_id = ? ORDER BY rank LIMIT ?`
      : `SELECT rowid, session_id, chunk_text, position FROM episode_chunks WHERE episode_chunks MATCH ? ORDER BY rank LIMIT ?`;
    rows = (opts.sessionId ? db.prepare(sql).all(`"${query.replace(/"/g, '""')}"`, opts.sessionId, limit) : db.prepare(sql).all(`"${query.replace(/"/g, '""')}"`, limit)) as typeof rows;
  } catch {
    return { hits: [], note: "非法查询表达式" };
  }
  const hits: EpisodeHit[] = rows.map((h) => {
    const neighbors = db.prepare(
      `SELECT rowid, position, chunk_text FROM episode_chunks WHERE session_id = ? AND rowid BETWEEN ? AND ? ORDER BY position ASC`,
    ).all(h.session_id, h.rowid - ctx, h.rowid + ctx) as Array<{ rowid: number; position: number; chunk_text: string }>;
    return {
      rowid: h.rowid,
      sessionId: h.session_id,
      chunk: h.chunk_text,
      // FTS rowid 与 episodes.id 是两套体系——context 给 position+text（文本连续性足够还原原话语境）
      context: neighbors.map((n) => ({ position: n.position, text: n.chunk_text })),
    };
  });
  return { hits };
}

// ── 翻页回放（V7）────────────────────────────────────────────────────────────

export type TranscriptScope = "session" | "day" | "topic";
export type TranscriptDirection = "forward" | "backward";

export interface TranscriptTurn {
  id: number;
  role: string;
  content: string;
  at: string;
  topic: string | null;
}

/** 目录条目：先看有哪些段落，再决定翻哪一页——这是"不一次性灌爆上下文"的第一道闸 */
export interface TranscriptOutlineItem {
  key: string;
  sessionId: string;
  turns: number;
  from: string;
  to: string;
  chars: number;
  /** 首句用户原话（截断 80 字）——比时间戳更能让人认出"这是哪段" */
  opening: string;
  topics: string[];
}

export interface TranscriptPage {
  scope: TranscriptScope;
  mode: "outline" | "turns";
  anchor: Record<string, string | null>;
  outline?: TranscriptOutlineItem[];
  turns?: TranscriptTurn[];
  page?: { count: number; chars: number; truncated: boolean };
  /** 继续同方向翻 */
  next?: { cursor: number; direction: TranscriptDirection } | null;
  /** 往回翻（反方向） */
  prev?: { cursor: number; direction: TranscriptDirection } | null;
  hasMore: { older: boolean; newer: boolean };
  /** 该定位条件下的总句数——让 AI 知道"还剩多少"，不至于盲翻 */
  totalTurns: number;
  note?: string;
}

/** 'YYYY-MM-DD' → 次日同格式（翻"某一天"的右开区间用；不引 dayjs，纯字符串加法） */
function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + 1));
  return dt.toISOString().slice(0, 10);
}

/**
 * 原话回放（冷路径阅读路径）。三轴定位 × 两种模式：
 *
 *   scope='session'  一场对话          （必须给 sessionId）
 *   scope='day'      某一天的所有对话  （必须给 date: YYYY-MM-DD）
 *   scope='topic'    某个话题的来龙去脉（必须给 topic）
 *
 *   mode='outline'   只给目录：几段对话 / 各自多少句、时间跨度、首句、涉及话题
 *   mode='turns'     给正文：游标分页，双预算硬闸
 *
 * 翻页语义（cursor 永远是 episodes.id，append-only 保证单调、不重不漏）：
 *   direction='forward'  + cursor → id > cursor，时间正序（顺着时间往下读）
 *   direction='backward' + cursor → id < cursor，取更早的（往上翻）
 *   不传 cursor：forward 从最早开始；backward 从最新开始
 */
export function recallTranscript(
  db: Database,
  opts: {
    scope: TranscriptScope;
    sessionId?: string;
    date?: string;
    topic?: string;
    mode?: "outline" | "turns";
    cursor?: number;
    direction?: TranscriptDirection;
    limit?: number;
    maxChars?: number;
  },
): TranscriptPage {
  const scope = opts.scope;
  const mode = opts.mode ?? "turns";

  // ── 定位条件（outline 与 turns 共用同一套 WHERE，保证两者口径一致）──
  let where = "";
  const params: Array<string | number> = [];
  const anchor: Record<string, string | null> = {};
  if (scope === "session") {
    if (!opts.sessionId) return { scope, mode, anchor, hasMore: { older: false, newer: false }, totalTurns: 0, note: "scope=session 必须给 sessionId" };
    where = "session_id = ?";
    params.push(opts.sessionId);
    anchor.sessionId = opts.sessionId;
  } else if (scope === "day") {
    if (!opts.date || !/^\d{4}-\d{2}-\d{2}$/.test(opts.date))
      return { scope, mode, anchor, hasMore: { older: false, newer: false }, totalTurns: 0, note: "scope=day 必须给 date，格式 YYYY-MM-DD" };
    // recorded_at 是 'YYYY-MM-DD HH:MM:SS' 定长文本 ⇒ 半开区间比 date() 包裹更省（能吃 recorded_at 索引）
    where = "recorded_at >= ? AND recorded_at < ?";
    params.push(opts.date, nextDay(opts.date));
    anchor.date = opts.date;
  } else {
    if (!opts.topic) return { scope, mode, anchor, hasMore: { older: false, newer: false }, totalTurns: 0, note: "scope=topic 必须给 topic" };
    where = "topic = ?";
    params.push(opts.topic);
    anchor.topic = opts.topic;
  }

  const totalTurns = (db.prepare(`SELECT count(*) c FROM episodes WHERE ${where}`).get(...params) as { c: number }).c;

  // ── 目录模式 ──
  if (mode === "outline") {
    if (!totalTurns) return { scope, mode, anchor, outline: [], hasMore: { older: false, newer: false }, totalTurns: 0, note: "该范围内没有原话存档" };
    const segs = db
      .prepare(
        `SELECT session_id, count(*) turns, min(recorded_at) f, max(recorded_at) t, sum(length(content)) chars
           FROM episodes WHERE ${where} GROUP BY session_id ORDER BY min(id) ASC`,
      )
      .all(...params) as Array<{ session_id: string; turns: number; f: string; t: string; chars: number }>;

    const outline: TranscriptOutlineItem[] = segs.map((s) => {
      const opening =
        (db.prepare("SELECT substr(content,1,80) s FROM episodes WHERE session_id = ? AND role = 'user' ORDER BY id LIMIT 1").get(s.session_id) as { s: string } | null)?.s ??
        (db.prepare("SELECT substr(content,1,80) s FROM episodes WHERE session_id = ? ORDER BY id LIMIT 1").get(s.session_id) as { s: string } | null)?.s ??
        "";
      const topics = (
        db.prepare("SELECT DISTINCT topic FROM episodes WHERE session_id = ? AND topic IS NOT NULL ORDER BY topic").all(s.session_id) as Array<{ topic: string }>
      ).map((x) => x.topic);
      return { key: s.session_id, sessionId: s.session_id, turns: s.turns, from: s.f, to: s.t, chars: s.chars, opening, topics };
    });
    return { scope, mode, anchor, outline, hasMore: { older: false, newer: false }, totalTurns };
  }

  // ── 正文模式 ──
  const direction: TranscriptDirection = opts.direction ?? "forward";
  const limit = Math.min(Math.max(opts.limit ?? TURNS_DEFAULT, 1), TURNS_MAX);
  const maxChars = Math.min(Math.max(opts.maxChars ?? CHARS_DEFAULT, 500), CHARS_MAX);

  let sql = `SELECT id, role, content, recorded_at, topic FROM episodes WHERE ${where}`;
  const qp: Array<string | number> = [...params];
  if (opts.cursor !== undefined && opts.cursor !== null) {
    sql += direction === "forward" ? " AND id > ?" : " AND id < ?";
    qp.push(opts.cursor);
  }
  // 多取一条仅用于判定"还有没有"，不返回
  sql += direction === "forward" ? " ORDER BY id ASC LIMIT ?" : " ORDER BY id DESC LIMIT ?";
  qp.push(limit + 1);

  const raw = db.prepare(sql).all(...qp) as Array<{ id: number; role: string; content: string; recorded_at: string; topic: string | null }>;

  const overflow = raw.length > limit;
  const windowRows = overflow ? raw.slice(0, limit) : raw;

  // 双预算：条数已被 limit 切过，这里再按字符收口。
  // 第一条无条件收下（哪怕单条就超预算）——否则「第一条永远塞不进」会让 AI 反复用同一个
  // cursor 重试、永远读不出内容。单条超长时宁可这一页只有一条，也不要半条 + 死循环。
  const kept: typeof windowRows = [];
  let chars = 0;
  let charTruncated = false;
  for (const r of windowRows) {
    if (kept.length === 0) {
      kept.push(r);
      chars += r.content.length;
      if (r.content.length > maxChars) charTruncated = true;
      continue;
    }
    if (chars + r.content.length > maxChars) {
      charTruncated = true;
      break;
    }
    kept.push(r);
    chars += r.content.length;
  }

  // 正向读：时间顺序；反向翻：结果仍是时间顺序（人脑和 AI 都按时间线读，只是切片起点不同）
  const ordered = direction === "backward" ? [...kept].reverse() : kept;
  const turns: TranscriptTurn[] = ordered.map((r) => ({ id: r.id, role: r.role, content: r.content, at: r.recorded_at, topic: r.topic }));

  const firstId = kept[0]?.id;
  const lastId = kept[kept.length - 1]?.id;
  const drained = kept.length === 0;
  const opposite: TranscriptDirection = direction === "forward" ? "backward" : "forward";

  // hasMore 与方向无关，只问「边界之外还有没有」——比按方向推状态机可靠得多。
  const olderExists =
    firstId === undefined
      ? false
      : db.prepare(`SELECT 1 FROM episodes WHERE ${where} AND id < ? LIMIT 1`).get(...params, firstId) !== null;
  const newerExists =
    lastId === undefined
      ? false
      : db.prepare(`SELECT 1 FROM episodes WHERE ${where} AND id > ? LIMIT 1`).get(...params, lastId) !== null;
  const hasMore = { older: olderExists, newer: newerExists };

  // 游标只在**那一侧确实还有内容**时才给：否则 AI 为了确认"到头了"会多打一次空请求，
  // 一个话题十几页翻下来就是十几次白往返。到头就该是 null —— hasMore 已经把话说清楚了。
  const nextHasMore = direction === "forward" ? newerExists : olderExists;
  const prevHasMore = direction === "forward" ? olderExists : newerExists;

  const next = drained || lastId === undefined || !nextHasMore ? null : { cursor: lastId, direction };
  const prev = drained
    ? opts.cursor !== undefined && opts.cursor !== null
      ? { cursor: opts.cursor, direction: opposite }
      : null
    : firstId === undefined || !prevHasMore
      ? null
      : { cursor: firstId, direction: opposite };

  const note = drained
    ? "该方向已没有更多原话；若要回退请用 prev"
    : charTruncated
      ? `字符预算 ${maxChars} 已满，本页只到第 ${kept.length} 句；继续翻页会从下一句起，不会重复`
      : undefined;

  return {
    scope,
    mode,
    anchor,
    turns,
    page: { count: turns.length, chars, truncated: charTruncated },
    next,
    prev,
    hasMore,
    totalTurns,
    ...(note ? { note } : {}),
  };
}

/** 整会话原话回放（冷存档阅读路径；调用方自负预算——永不自动整段注入） */
export function sessionTranscript(db: Database, sessionId: string, limit = 200): Array<{ id: number; role: string; content: string; recordedAt: string }> {
  return db.prepare(
    "SELECT id, role, content, recorded_at FROM episodes WHERE session_id = ? ORDER BY id ASC LIMIT ?",
  ).all(sessionId, Math.min(limit, 500)) as Array<{ id: number; role: string; content: string; recordedAt: string }>;
}
