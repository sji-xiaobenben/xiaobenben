/**
 * 写入管线。
 * 去重(内容哈希) → 密钥标记解析 → 设备盖章 → FTS(触发器自动) → 扩展词 → 实体 → 链接 → 延续链 → 指令窗口/晋升
 *
 * 移植适配点（全部记录在案）：
 *  1. id：INTEGER 自增 → UUIDv7 应用层生成（links/superseded_by 同步 TEXT）
 *  2. 必填列补齐：org_id/space_id/actor/created_at（ISO UTC；recorded_at 语义并入 created_at）
 *  3. FTS：触发器自动同步 → 删除手动 ftsInsert（防双写）；时间戳 localNow 仅用于
 *     occurred_at/dscope 窗口（用户语义时间，字符串比较），created_at 保持 ISO
 *  4. status：NOT NULL，统一 'active' 起步；forget 时同步写 status='forgotten' + deleted_at
 *  5. 哈希链：写入落 memory.deliver 事件；supersede 动作落 memory.supersede 事件（链纪律）
 *  6. 零模型纪律不变：全部确定性计算
 */
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ORG_PERSONAL, SPACE_PERSONAL } from "./schema";
import { uuidv7 } from "@xbb/core";
import type { PersonalStore } from "./store";
import { admitAttachments, type AttachmentInput } from "./payloads";

// ── 类型（MemoryItem，id 引用改 string）──

export interface MemoryItem {
  content: string;
  type: "fact" | "preference" | "decision" | "event" | "procedure";
  tags?: string[];
  entities?: string[];
  /** 双端扩展着陆垫：同义词/上位词/场景词（AI 蒸馏时生成，5-15 个） */
  terms?: string[];
  occurredAt?: string;
  occurredPrecision?: "day" | "month" | "year";
  sessionId?: string;
  sourceRef?: string;
  links?: { toId: string; relation: "related_to" | "elaborates" | "caused_by" | "contradicts" }[];
  kind?: "memory" | "directive" | "habit" | "constraint";
  dscope?: "session" | "today" | "week" | "global";
  domain?: string;
  supersedeIds?: string[];
  raw?: boolean;
  /** 扩展字段：needsAck（AI 建议待确认，进 inbox） */
  needsAck?: boolean;
  /** 情景层出处块（episode_chunks rowid，冷路径回跳锚点） */
  sourceChunk?: number;
  /**
   * 载荷（文件记忆）：**本机绝对路径** + 可选描述。
   * 本地版**只登记引用、不搬字节** —— 字节始终待在用户原位置，我们只记 sha256 / bytes / 路径。
   * 进不去的附件**不会让本条写入失败**（降级铁律），失败项在回执的 `droppedAttachments` 里。
   */
  attachments?: AttachmentInput[];
}

export interface WriteResult {
  id: string;
  deduped: boolean;
  now: string;
  superseded?: string[];
  supersedeRejected?: { id: string; reason: string; currentHead?: string }[];
  /**
   * 候选链头（B 方案 2026-10-06）：本条未带 supersedeIds 时，同空间内词群高度重叠的旧状态记忆。
   * **只递材料、绝不自动挂**——AI 拿到候选后自行判断是否调 `supersede` 补链（"忘了挂"的补救入口）。
   */
  supersedeCandidates?: { id: string; content: string; overlap: number; createdAt: string; occurredAt: string | null }[];
  promotion?: { ready: boolean; distinctSessions: number; similarIds: string[] };
  vaulted?: number[];
  /**
   * 本次登记（或复用）的载荷。`reused:true` = 内容寻址命中，**零新增**；
   * `payloadId` 是持久引用 —— 取本体走 `get_asset`（提货单不含字节）。
   */
  attachments?: { payloadId: string; ref: string; bytes: number; mime: string | null; reused: boolean }[];
  /**
   * 进不去的附件（**不静默**）。宿主应转告用户「这个文件没存进去」。
   * ⚠️ 刻意**不落库**：events 是凭证层且只存 hash，dropped 无字节无 hash 不构成凭证；
   * 真正的处置是**让宿主把它描述进 `content`** —— 那本来就是记忆的形态。
   */
  droppedAttachments?: { ref: string; reason: string }[];
  /** 引擎本机时钟可读格式（随响应回传对时） */
  nowLocal: string;
}

/** 本地时间 "YYYY-MM-DD HH:MM:SS"（字符串比较即时间比较，含时区语义=用户本机） */
export function localNow(d = new Date()): string {
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── 自动会话盖章（进程级，确定性的事交给引擎）──
let AUTO_SESSION_ID: string | null = null;
export function autoSessionId(): string {
  if (!AUTO_SESSION_ID) {
    AUTO_SESSION_ID = "s-" + localNow().replace(/[- :]/g, "").slice(0, 14) + "-" +
      Math.random().toString(36).slice(2, 6);
  }
  return AUTO_SESSION_ID;
}

/** scope 语义 → 绝对窗口（引擎唯一有权做时间换算的地方） */
export function resolveWindow(dscope: MemoryItem["dscope"], now = new Date()): { startsAt: string | null; expiresAt: string | null } {
  const start = localNow(now);
  switch (dscope) {
    case "session":
      return { startsAt: start, expiresAt: null };
    case "today": {
      const end = new Date(now); end.setHours(23, 59, 59, 0);
      return { startsAt: start, expiresAt: localNow(end) };
    }
    case "week": {
      const end = new Date(now.getTime() + 7 * 86400_000);
      return { startsAt: start, expiresAt: localNow(end) };
    }
    default:
      return { startsAt: null, expiresAt: null };
  }
}

export function validateExplicitWindow(expiresAt: string, now = new Date()): string | null {
  const t = expiresAt.trim();
  if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(t)) return `expiresAt 格式非法: ${t}`;
  const norm = t.replace("T", " ") + (t.length <= 10 ? " 23:59:59" : t.length === 16 ? ":00" : "");
  const exp = new Date(norm.replace(" ", "T"));
  if (isNaN(exp.getTime())) return `expiresAt 无法解析: ${t}`;
  if (exp.getTime() < now.getTime() - 60_000) return `expiresAt 已是过去时（引擎当前时间 ${localNow(now)}）`;
  if (exp.getTime() - now.getTime() > 365 * 86400_000) return `expiresAt 超过 1 年上限——长期约束请用 kind=constraint`;
  return null;
}

/** 相似判定（确定性、零模型）：terms/tags 重叠数 ≥4 且 ≥ 较小方词数的 60% */
export function isSimilar(aTerms: Set<string>, bTerms: Set<string>): boolean {
  let shared = 0;
  for (const t of aTerms) if (bTerms.has(t)) shared++;
  const minLen = Math.min(aTerms.size, bTerms.size);
  return minLen > 0 && shared >= 4 && shared / minLen >= 0.6;
}

function itemTerms(db: Database, id: string): Set<string> {
  const rows = db.prepare("SELECT term FROM memory_terms WHERE memory_id = ?").all(id) as Array<{ term: string }>;
  return new Set(rows.map((r) => r.term));
}

/** 设备盖章：惰性生成持久 UUID（单机，一台设备一行） */
export function ensureDevice(db: Database): { id: string; name: string } {
  const row = db.query("SELECT id, name FROM devices LIMIT 1").get() as { id: string; name: string } | undefined;
  if (row) return row;
  const id = randomUUID();
  const name = hostname();
  db.prepare("INSERT INTO devices (id, name, created_at) VALUES (?, ?, ?)").run(id, name, new Date().toISOString());
  return { id, name };
}

// ── 密钥保险箱（标记协议）──

const SECRET_VALUE_RE = /\[\[xbb_secret_value:([\s\S]*?)\]\]/g;
const SECRET_ID_RE = /\[\[xbb_secret_id:(\d+)\]\]/g;

export function processSecretMarkers(db: Database, text: string): { text: string; vaulted: number[] } {
  const vaulted: number[] = [];
  const byValue = new Map<string, number>();
  const out = text.replace(SECRET_VALUE_RE, (_m, value: string) => {
    const v = value.trim();
    const vhash = createHash("sha256").update(v).digest("hex");
    let sid = byValue.get(vhash);
    if (sid === undefined) {
      const existing = db.prepare("SELECT id FROM secrets WHERE value_hash = ?").get(vhash) as { id: number } | undefined;
      if (existing) {
        sid = Number(existing.id);
      } else {
        const r = db.prepare("INSERT INTO secrets (value, value_hash, created_at, updated_at) VALUES (?, ?, ?, ?)").run(v, vhash, localNow(), localNow());
        sid = Number(r.lastInsertRowid);
        vaulted.push(sid);
      }
      byValue.set(vhash, sid);
    }
    return `[[xbb_secret_id:${sid}]]`;
  });
  return { text: out, vaulted };
}

// ── 主管线 ──

export async function writeMemory(
  store: PersonalStore,
  item: MemoryItem,
  opts: { spaceId?: string; actor?: string } = {},
): Promise<WriteResult> {
  const db = store.db;
  ensureDevice(db);
  const nowDate = new Date();
  const nowLocal = localNow(nowDate);
  const nowIso = nowDate.toISOString();
  const now = nowIso;
  const kind = item.kind ?? "memory";
  const sessionId = item.sessionId?.trim() || autoSessionId();

  // 0. 密钥标记解析
  const secContent = item.raw ? { text: item.content, vaulted: [] as number[] } : processSecretMarkers(db, item.content);
  const vaulted = [...secContent.vaulted];
  const mark = (s: string) => {
    if (item.raw) return s;
    const r = processSecretMarkers(db, s);
    vaulted.push(...r.vaulted.filter((v) => !vaulted.includes(v)));
    return r.text;
  };
  const secTerms = (item.terms ?? []).map(mark);
  const secTags = (item.tags ?? []).map(mark);
  const secEntities = (item.entities ?? []).map(mark);
  const content = secContent.text;
  const bare = content.replace(SECRET_ID_RE, "").replace(SECRET_VALUE_RE, "").trim();
  if (bare.length < 4) {
    throw new Error("整条记忆只有凭据值，没有记忆价值——请写清用途上下文（如\"服务器 SSH 密码\"）后再写入");
  }

  // 1. 确定性去重
  const hash = createHash("sha256").update(content).digest("hex");
  const existing = db.prepare(
    "SELECT id FROM memories WHERE content_hash = ? AND deleted_at IS NULL AND status != 'forgotten'",
  ).get(hash) as { id: string } | undefined;
  if (existing) {
    // 去重命中 ≠ 附件无事可做：用户可能第一次没带图、第二次带了。载荷挂载本身就是幂等的
    // （`memory_payloads` 复合主键 + sha256 去重），所以这里照样走一遍登记，多退少补。
    const admitted = await admitAttachments(db, existing.id, item.attachments, { actor: opts.actor });
    const dup: WriteResult = { id: existing.id, deduped: true, now, nowLocal };
    if (admitted.stored.length) dup.attachments = admitted.stored.map(toAck);
    if (admitted.dropped.length) dup.droppedAttachments = admitted.dropped;
    return dup;
  }

  // 2. 指令窗口换算
  let startsAt: string | null = null;
  let expiresAt: string | null = null;
  if (kind === "directive") {
    if (item.dscope === undefined || !["session", "today", "week"].includes(item.dscope)) {
      throw new Error("directive 必须带 dscope（session/today/week）——引擎用本机时钟换算窗口，AI 禁止自行传日期");
    }
    const w = resolveWindow(item.dscope, nowDate);
    startsAt = w.startsAt; expiresAt = w.expiresAt;
  }

  // 3. 插入（UUIDv7 应用层生成；org/space/actor/created_at 必填；FTS 由触发器自动同步）
  const id = uuidv7();
  db.prepare(`
    INSERT INTO memories (id, org_id, space_id, actor, content, content_hash, type, tags, entities,
                          occurred_at, occurred_precision, session_id, source_ref, source_chunk, device_id,
                          kind, dscope, domain, starts_at, expires_at, status, needs_ack,
                          created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(
    id, ORG_PERSONAL, opts.spaceId ?? SPACE_PERSONAL, opts.actor ?? "user",
    content, hash, item.type,
    JSON.stringify(secTags),
    secEntities.length ? JSON.stringify(secEntities) : null,
    item.occurredAt ?? null, item.occurredPrecision ?? null,
    sessionId, item.sourceRef ?? null, item.sourceChunk ?? null,
    (db.query("SELECT id FROM devices LIMIT 1").get() as { id: string }).id,
    kind, item.dscope ?? null,
    kind === "constraint" ? (item.domain?.trim() || null) : null,
    startsAt, expiresAt,
    item.needsAck ? 1 : 0,
    now, now,
  );

  // 3b. 载荷登记。**只登记引用，不搬字节**；sha256 内容寻址 ⇒ 同字节全库一份。
  // 永不抛：附件进不去，记忆照进（降级铁律）；失败项进 dropped 由回执告知宿主。
  const admitted = await admitAttachments(db, id, item.attachments, { actor: opts.actor });

  // 4. 扩展词入倒排索引（FTS 已由触发器处理，此处只做着陆垫）
  const insTerm = db.prepare("INSERT OR IGNORE INTO memory_terms (term, memory_id, source) VALUES (?, ?, ?)");
  for (const t of secTerms) insTerm.run(t.trim(), id, "expand");
  for (const t of secTags) insTerm.run(t.trim(), id, "tag");
  for (const t of secEntities) insTerm.run(t.trim(), id, "entity");

  // 5. 实体锚点
  const insEntity = db.prepare("INSERT OR IGNORE INTO entities (name) VALUES (?)");
  const getEntity = db.prepare("SELECT id FROM entities WHERE name = ?");
  const insME = db.prepare("INSERT OR IGNORE INTO memory_entity (memory_id, entity_id) VALUES (?, ?)");
  for (const name of secEntities) {
    insEntity.run(name);
    const eid = (getEntity.get(name) as { id: number }).id;
    insME.run(id, eid);
  }

  // 6. 记忆网络链接
  const insLink = db.prepare("INSERT OR IGNORE INTO memory_links (from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?)");
  for (const l of item.links ?? []) insLink.run(id, l.toId, l.relation, nowIso);

  // 7. 哈希链：写入落事件（payload 零明文凭据——只有 id/元数据计数）
  //    载荷只记**成功项**的 sha256/bytes：那是凭证（证明写入时确实带了这份字节）。
  // dropped 项**不进事件** —— 无字节无 hash，不构成可验真的凭证；其处置见下文（交给宿主描述进 content）。
  await store.appendEvent({
    orgId: ORG_PERSONAL,
    actor: opts.actor ?? "user",
    type: "memory.deliver",
    payloadHash: await (await import("@xbb/core")).payloadHash({
      id, kind, type: item.type, hasTerms: secTerms.length, links: item.links?.length ?? 0,
      vaultedCount: vaulted.length, needsAck: item.needsAck === true,
      attachments: admitted.stored.map((a) => ({ sha256: a.sha256, bytes: a.bytes })),
    }),
  });

  // 8. 显式延续（supersede）：链形铁律"收拢合法、分叉封死"
  const result: WriteResult = { id, deduped: false, now, nowLocal };
  const superseded: string[] = [];
  const supersedeRejected: NonNullable<WriteResult["supersedeRejected"]> = [];
  for (const sid of item.supersedeIds ?? []) {
    if (sid === id) { supersedeRejected.push({ id: sid, reason: "不能延续自己" }); continue; }
    const row = db.prepare(
      "SELECT id, superseded_by, system FROM memories WHERE id = ? AND deleted_at IS NULL",
    ).get(sid) as { id: string; superseded_by: string | null; system: number } | undefined;
    if (!row) { supersedeRejected.push({ id: sid, reason: "目标记忆不存在或已删除" }); continue; }
    if (row.system === 1) { supersedeRejected.push({ id: sid, reason: "系统默认约束不可被延续" }); continue; }
    if (row.superseded_by) {
      let head = row.superseded_by, hops = 0;
      while (hops++ < 10) {
        const r2 = db.prepare("SELECT id, superseded_by FROM memories WHERE id = ?").get(head) as { id: string; superseded_by: string | null } | undefined;
        if (!r2?.superseded_by) break;
        head = r2.superseded_by;
      }
      supersedeRejected.push({ id: sid, reason: `该记忆已被 ${head} 延续（新状态只能挂链头，保证现状唯一）`, currentHead: head });
      continue;
    }
    db.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(id, sid);
    superseded.push(sid);
  }
  if (superseded.length) {
    result.superseded = superseded;
    await store.appendEvent({
      orgId: ORG_PERSONAL,
      actor: opts.actor ?? "user",
      type: "memory.supersede",
      payloadHash: await (await import("@xbb/core")).payloadHash({ id, superseded }),
    });
  }
  if (supersedeRejected.length) result.supersedeRejected = supersedeRejected;
  if (vaulted.length) result.vaulted = vaulted;
  if (admitted.stored.length) result.attachments = admitted.stored.map(toAck);
  if (admitted.dropped.length) result.droppedAttachments = admitted.dropped;
  // ⚠️ supersede **不自动继承**旧条目的附件：附件的"当前性"属于语义，
  //    机械继承会在「旧版附件已过时」时静默给错字节。要带附件就在本次 attachments 里显式给。

  // 8b. 候选链头（B 方案）：未带 supersedeIds 时，回传同空间内词群高度重叠的旧状态记忆，
  //     让 AI 自己判断要不要补链（`supersede`）。**只递材料、绝不自动挂**（机制不语义）。
  //     阈值偏高（共享 ≥3 词、只荐链头、近 180 天）+ 只认 terms（与云端同口径），宁少勿滥。
  if (!item.supersedeIds?.length && secTerms.length >= 3) {
    const uniqTerms = [...new Set(secTerms.map((t) => t.trim()).filter(Boolean))];
    if (uniqTerms.length >= 3) {
      const cutoff = new Date(nowDate.getTime() - 180 * 86400_000).toISOString();
      const ph = uniqTerms.map(() => "?").join(",");
      const candRows = db.prepare(`
        SELECT m.id, m.content, m.created_at, m.occurred_at, count(*) AS overlap
          FROM memory_terms mt
          JOIN memories m ON m.id = mt.memory_id
         WHERE mt.term IN (${ph})
           AND m.id <> ? AND m.space_id = ?
           AND m.status = 'active' AND m.deleted_at IS NULL
           AND m.system = 0 AND m.superseded_by IS NULL
           AND m.created_at > ?
         GROUP BY m.id
        HAVING count(*) >= 3
         ORDER BY overlap DESC, m.created_at DESC
         LIMIT 5
      `).all(...uniqTerms, id, opts.spaceId ?? SPACE_PERSONAL, cutoff) as Array<{
        id: string; content: string; created_at: string; occurred_at: string | null; overlap: number;
      }>;
      if (candRows.length) {
        result.supersedeCandidates = candRows.map((r) => ({
          id: r.id,
          content: r.content.length > 60 ? r.content.slice(0, 60) + "…" : r.content,
          overlap: Number(r.overlap),
          createdAt: r.created_at,
          occurredAt: r.occurred_at ?? null,
        }));
      }
    }
  }

  // 9. 指令类后处理：相似叮嘱跨会话计数（≥7 触发晋升询问）
  if (kind === "directive" && item.dscope !== "session" && (secTerms.length || secTags.length || secEntities.length)) {
    const myTerms = new Set<string>([...secTerms, ...secTags, ...secEntities].map((t) => t.trim()));
    const ph = [...myTerms].map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT m.id, m.session_id FROM memories m
      WHERE m.kind = 'directive' AND m.deleted_at IS NULL AND m.status = 'active'
        AND EXISTS (SELECT 1 FROM memory_terms mt WHERE mt.memory_id = m.id AND mt.term IN (${ph}))
    `).all(...[...myTerms]) as Array<{ id: string; session_id: string | null }>;
    const similarIds: string[] = [];
    const sessions = new Set<string>([sessionId]);
    for (const row of rows) {
      if (isSimilar(myTerms, itemTerms(db, row.id))) {
        similarIds.push(row.id);
        if (row.session_id) sessions.add(row.session_id);
      }
    }
    const distinctSessions = sessions.size;
    db.prepare("UPDATE memories SET similar_sessions = ? WHERE id = ?").run(distinctSessions, id);
    for (const sid of similarIds) {
      db.prepare("UPDATE memories SET similar_sessions = MAX(similar_sessions, ?) WHERE id = ?").run(distinctSessions, sid);
    }
    if (distinctSessions >= 7) {
      result.promotion = { ready: true, distinctSessions, similarIds };
    }
  }

  // 10. 向量回填（fire-and-forget，双降级：embed 失败=列 NULL 明文照存；不阻塞写入返回）
  void (async () => {
    try {
      const { embedder, VEC_MODEL } = await import("./embedder");
      if ((await embedder.load()) !== true) return;
      const vec = await embedder.embed(content);
      if (!vec) return;
      db.prepare("UPDATE memories SET embedding = ?, vec_model = ? WHERE id = ?")
        .run(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), VEC_MODEL, id);
    } catch { /* 双降级红线：永不因模型故障影响写入 */ }
  })();

  return result;
}

/** 载荷回执项的公共形状（写入与去重两条路径共用） */
const toAck = (a: { payloadId: string; ref: string; bytes: number; mime: string | null; reused: boolean }) => ({
  payloadId: a.payloadId, ref: a.ref, bytes: a.bytes, mime: a.mime, reused: a.reused,
});

/** 补链结果（与云端 /v1/supersede 出参同形） */
export interface SupersedeOutcome {
  headId: string;
  superseded: string[];
  rejected: { id: string; reason: string; currentHead?: string }[];
}

/**
 * 事后补链（C 方案 2026-10-06）——本地版。链形铁律与 writeMemory 第 8 步完全同源：
 * ① headId 必须是真链头（已被延续则报出真正的链头）② 目标必须是当前链头（分叉封死）
 * ③ 同空间、非 system、不可自延续 ④ 幂等（已挂本头 = 已完成）。拒绝项不静默吞。
 *
 * 存在意义：链只能"往前挂"（写入时带 supersedeIds），此前**没有任何事后补救入口**——
 * 忘了挂就只能再写一条新记忆。这个函数把"已存在的两条"结成链，不动内容、不增条目。
 */
export async function supersedeMemories(
  store: PersonalStore,
  opts: { headId: string; supersededIds: string[]; actor?: string },
): Promise<SupersedeOutcome> {
  const db = store.db;
  const actor = opts.actor ?? "user";
  const targets = [...new Set((opts.supersededIds ?? []).map((s) => s.trim()).filter(Boolean))];
  type MemRow = { id: string; space_id: string; superseded_by: string | null; system: number; status: string; deleted_at: string | null };
  const load = db.prepare(
    "SELECT id, space_id, superseded_by, system, status, deleted_at FROM memories WHERE id = ?",
  );

  const headRow = load.get(opts.headId) as MemRow | undefined;
  if (!headRow || headRow.deleted_at || headRow.status === "forgotten") {
    throw new Error(`链头记忆 ${opts.headId} 不存在或已遗忘——补链只能挂到活着的记忆上`);
  }
  if (headRow.system === 1) throw new Error("系统默认记忆不能作为链头");
  if (headRow.superseded_by) {
    throw new Error(
      `该记忆已被 ${headRow.superseded_by} 延续——真正的链头是 ${headRow.superseded_by}，请改挂它（现状唯一）`,
    );
  }

  const superseded: string[] = [];
  const rejected: SupersedeOutcome["rejected"] = [];
  for (const sid of targets) {
    if (sid === headRow.id) { rejected.push({ id: sid, reason: "不能延续自己" }); continue; }
    const t = load.get(sid) as MemRow | undefined;
    if (!t || t.deleted_at || t.status === "forgotten") { rejected.push({ id: sid, reason: "目标记忆不存在或已删除" }); continue; }
    if (t.system === 1) { rejected.push({ id: sid, reason: "系统默认约束不可被延续" }); continue; }
    if (t.space_id !== headRow.space_id) { rejected.push({ id: sid, reason: "跨空间不可延续" }); continue; }
    if (t.superseded_by === headRow.id) continue; // 幂等：已挂本头
    if (t.superseded_by) {
      let head = t.superseded_by, hops = 0;
      while (hops++ < 10) {
        const r2 = db.prepare("SELECT id, superseded_by FROM memories WHERE id = ?").get(head) as { id: string; superseded_by: string | null } | undefined;
        if (!r2?.superseded_by) break;
        head = r2.superseded_by;
      }
      rejected.push({ id: sid, reason: `该记忆已被 ${head} 延续（新状态只能挂链头，保证现状唯一）`, currentHead: head });
      continue;
    }
    db.prepare("UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ?")
      .run(headRow.id, new Date().toISOString(), sid);
    superseded.push(sid);
  }
  if (superseded.length) {
    await store.appendEvent({
      orgId: ORG_PERSONAL,
      actor,
      type: "memory.supersede",
      payloadHash: await (await import("@xbb/core")).payloadHash({ id: headRow.id, superseded }),
    });
  }
  return { headId: headRow.id, superseded, rejected };
}
