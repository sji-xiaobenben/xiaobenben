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
import { maskSecrets, resolveChain, walkToHead } from "./memory-search";
import { onRecalled } from "./recall-feedback";
import { LINK_VISIBLE_MIN } from "./schema";
import { attachPayloads, loadPayloadsFor } from "./payloads";

const cut = (s: string, n = 30) => (s.length > n ? s.slice(0, n) + "…" : s);

// 链头查找统一走 memory-search 的 walkToHead（无跳数上限、靠 seen 防环）。
// 这里原先有一份 `maxHops = 10` 的副本：链超过 10 层时它返回的是**中间节点**，
// 而 recallTopic 拿这个结果做「链头保障在场」——保障了一个假链头，还不报错。

/**
 * 话题簇召回：「我们上次聊的 X」——实体精确命中 + 按会话分组 + 链头保障在场。
 *
 * ⚠️ **两道召回，缺一不可**（2026-11-24 修）：
 * 原先只有「`memory_entity` 显式挂边」这一道。于是**正文里明明提到了 X、但写入时没建立
 * 实体关联**的记忆，`recall_topic` 永远看不到 —— 用户问「上次聊的 X 有哪些」，它只交出
 * 一半，而且看起来完全正常（有结果、有分组、不报错）。实测本机库有 212 条记忆没有任何实体（用户抽测的另一份库是 258 条），
 * 这些记忆对话题召回就是黑洞。
 *
 * 第二道用正文子串匹配补上。**但它是弱证据**：正文提到 X 不等于这条记忆在讲 X
 * （"顺便说一句，X 那个事我不同意"也算提到）。所以两道的返回**分开**——
 * `sessions` 是锚定过的（强），`mentions` 只是提到过（弱），让调用方自己判，
 * 而不是混在一起假装一样可靠。这正是本模块一贯的原则：宁可说"这批证据弱"，不假装都强。
 */
type TopicRow = {
  id: string; content: string; type: string; session_id: string | null;
  occurred_at: string | null; superseded_by: string | null;
};
type EntRow = { id: number; name: string; aliases: string | null };

/** LIKE 的通配符要转义，否则实体名里带 `_`（如 `user_name`）会变成"任意一个字符" */
function likeEsc(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const TOPIC_ROW_SQL = "SELECT id, content, type, session_id, occurred_at, superseded_by FROM memories";

/**
 * 弱证据那一路最多捞多少条候选。
 *
 * 不是展示上限（展示是 10 条），是**扫描阀**：2 字实体只能 LIKE，在十年期大库上
 * 没有这个阀就是「一个查询跑几秒」。取 200 —— 真实的"提到过"条目远比这多，
 * 我们只要最近的那十条，多扫的部分纯浪费。
 */
const MENTION_SCAN_CAP = 200;

export function recallTopic(db: Database, entity: string, limit = 30) {
  const cap = Math.min(limit, 30);
  const name = entity.trim();
  if (!name) return { entity, aliases: [], total: 0, sessions: [] };

  /**
   * 实体名匹配分三档，由严到宽：精确名 > 别名 > 名字包含。
   *
   * 只取**一个**实体（最精确、名字最短的那个）——`recall_topic` 的语义是"一个话题"，
   * 多实体合并会让 `total` 失去意义，也会把"青岚"和"青岚项目二期"糊成一个簇。
   * 加子串档是为了「用户说的是全名、库里存的是简称」这类日常偏差。
   */
  const ent: EntRow | undefined =
    (db.prepare("SELECT id, name, aliases FROM entities WHERE name = ? LIMIT 1").get(name) as EntRow | undefined) ??
    (db.prepare("SELECT id, name, aliases FROM entities WHERE aliases LIKE ? ESCAPE '\\' ORDER BY length(name) ASC LIMIT 1")
      .get(`%"${likeEsc(name)}"%`) as EntRow | undefined) ??
    (db.prepare("SELECT id, name, aliases FROM entities WHERE name LIKE ? ESCAPE '\\' ORDER BY length(name) ASC LIMIT 1")
      .get(`%${likeEsc(name)}%`) as EntRow | undefined);

  /**
   * 同一实体的**大小写变体**必须一起取。
   *
   * 真实库上实测：`小本本`(216 条) / `XiaoBenBen`(28) / `xiaobenben`(21) 是**三个独立实体**。
   * 写入侧的实体归一只做完全相等，于是同一件事被拆成三个簇 —— 只取最大的那个，
   * 剩下 49 条对 `recall_topic("小本本")` 就是黑洞。这正是「簇总量 20、提到 20 仍不出现」
   * 那类漏召回的另一个成因（根因是写入时没有归一，这里只能补救）。
   *
   * 判据刻意收得很窄：**忽略大小写后完全相同**才算同一个。不按前后缀、不按包含关系，
   * 因为「青岚」和「青岚项目二期」是真的两件事，合并会把话题搅浑。
   */
  const siblingIds: number[] = [];
  if (ent) {
    const sib = db.prepare("SELECT id FROM entities WHERE lower(name) = lower(?)").all(ent.name) as Array<{ id: number }>;
    for (const r of sib) if (r.id !== ent.id) siblingIds.push(r.id);
  }

  let aliases: string[] = [];
  if (ent) {
    try { aliases = ent.aliases ? JSON.parse(ent.aliases) : []; } catch { /* 忽略损坏的别名 JSON */ }
  }

  // ── 第一道：显式锚定 ──
  /**
   * **主实体先独占 `cap` 个名额，兄弟实体和链头只能在剩余额度里补。**
   *
   * 这条顺序是硬约束，不是洁癖：第一版把主实体和大小写兄弟塞进同一个
   * `WHERE entity_id IN (...)` 再 `LIMIT cap`，实测自指召回率从 100% 掉到 94.1%
   * —— 兄弟实体的记忆按时间排进来，把主实体自己的条目挤出了名单。
   * "为了让 A 能被搜到，把 B 挤掉"不是改进，是换了个地方漏。
   * 现在的形态保证：**旧实现能拿到的，一条都不会少**。
   */
  const hardCap = cap + Math.ceil(cap / 2);
  const qEnt = db.prepare(`
    SELECT m.id, m.content, m.type, m.session_id, m.occurred_at, m.superseded_by
    FROM memory_entity me JOIN memories m ON m.id = me.memory_id
    WHERE me.entity_id = ? AND m.deleted_at IS NULL
    ORDER BY m.occurred_at DESC, m.created_at DESC LIMIT ?
  `);

  /**
   * 主实体 + 大小写兄弟的**挂边总数**（不受 `cap` 影响）。
   * 只用来在返回里诚实报一句"库里一共有多少条、这次给了多少条" —— 大实体上
   * `total` 是 `limit` 的天花板，不说清就会被当成"这个话题就这么点内容"。
   */
  let entityTotal = 0;
  if (ent) {
    const ids = [ent.id, ...siblingIds];
    entityTotal = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM memory_entity me JOIN memories m ON m.id = me.memory_id
            WHERE me.entity_id IN (${ids.map(() => "?").join(", ")}) AND m.deleted_at IS NULL`,
        )
        .get(...ids) as { c: number }
    ).c;
  }

  const rows: TopicRow[] = ent ? (qEnt.all(ent.id, cap) as TopicRow[]) : [];

  const seenIds = new Set<string>(rows.map((r) => r.id));

  // 大小写兄弟实体：追加，不抢占主实体的名额
  for (const sid of siblingIds) {
    if (rows.length >= hardCap) break;
    for (const r of qEnt.all(sid, hardCap - rows.length) as TopicRow[]) {
      if (seenIds.has(r.id)) continue;
      seenIds.add(r.id);
      rows.push(r);
      if (rows.length >= hardCap) break;
    }
  }
  const qNext = db.prepare("SELECT superseded_by FROM memories WHERE id = ? AND deleted_at IS NULL");
  const qOne = db.prepare(`${TOPIC_ROW_SQL} WHERE id = ? AND deleted_at IS NULL`);

  /**
   * 被延续掉的条目换成它的**真链头**（现状）；链头已在结果里就跳过。
   *
   * ⚠️ 没有 `superseded_by` 的条目**必须也查一次 `seenIds`**：它在锚定名单里时
   * 返回自身，调用方 `rows.push(h)` 就等于把同一条推第二遍。这个洞漏了很久 ——
   * 实测 limit 5 的实体返回 `total: 8`，其中 3 条是重复的同一个 id（一直推到
   * `hardCap` 才停）。重复项不报错，只会让 `total` 虚高、让 AI 以为看到了更多东西。
   */
  const headOf = (r: TopicRow): TopicRow | undefined => {
    if (!r.superseded_by) return seenIds.has(r.id) ? undefined : r;
    const head = walkToHead(db, r.id, qNext);
    if (seenIds.has(head)) return undefined;
    const hm = qOne.get(head) as TopicRow | undefined;
    if (hm) seenIds.add(head);
    return hm;
  };

  /**
   * 链头补入也吃同一个 `hardCap`（cap 的 1.5 倍）。
   *
   * "链头保障在场"原先没有条数上限（旧实现也没有），于是一条挂了 216 条记忆的实体
   * 在 limit 30 下会返回 54 条，其中 24 条是补进来的链头。这些条目确实该在，
   * 但**一次工具调用的返回体积不能是调用方 limit 的两倍** —— 多出来的每一条都在挤
   * 上下文预算，而调用方以为自己只要了 30 条。
   *
   * 被挤掉的那些不是丢了：它们仍在链里，`get_memory` 能看到完整故事线。
   *
   * 注意这个上限只管 `sessions`（强证据）。弱证据走独立字段 `mentions`，额度是它自己的
   * `cap` —— 两者性质不同，调用方可以只读前者。混用一个预算会让"要么链头缺、要么弱证据缺"。
   */
  for (const r of [...rows]) {
    if (rows.length >= hardCap) break;
    const h = headOf(r);
    // headOf 已经保证「链头不在 seenIds 里」才返回它，这里不需要再比对引用
    if (h) rows.push(h);
  }

  // ── 第二道：正文提到（弱证据）──
  // 用实体名本身（不用别名：别名常是泛词，会带进一堆无关条目）。
  // 已经出现在锚定结果里的排除，避免同一条既算"聊过"又算"提到"。
  //
  // ⚠️ **性能：这里绝不能无条件 `content LIKE '%x%'`。**
  // 实测真实库（178MB / 605 条）上，一条 `LIKE ... ORDER BY occurred_at DESC, created_at DESC`
  // 要 225ms —— 双列排序用不上任何索引，等于全表扫 + 全表排序。相差两个数量级的是
  // **索引**，不是"多查了一路"：
  //   · ≥3 个字符 → 走 `memories_fts` 的 trigram 索引（MATCH 短语查询），毫秒级；
  //   · <3 个字符 → trigram 生不出 gram（它就是这么设计的），只能 LIKE，
  //     但改成**单列排序**，让 `idx_memories_occurred` 的反向扫描能吃上，凑够就停。
  // 2 字词那条在超大库上仍会慢，所以额外用 `MENTION_SCAN_CAP` 兜住最坏情况。
  /**
   * 弱证据一次列多少条：**跟随调用方的 limit**，不再钉死在 10。
   *
   * 10 是当初为了控返回体积拍的数，实测在大实体上把真实召回吃掉了：正文含「小本本」
   * 却没有实体挂边的有 38 条，只兜回 10 条 —— 剩下 28 条在话题召回里永远看不见，
   * 而它们在库里明明存在。调用方既然要了 `limit` 条，就按 `limit` 给。
   *
   * 体积仍然可控：`cap` 已经被限到 30，且弱证据是**独立字段** `mentions`，
   * 调用方可以只读 `sessions`。真被 `MENTION_SCAN_CAP` 截断时必须报出来
   * （`mentionsOmitted`）—— 悄悄吞掉正是这条链上最常见的那种病。
   */
  const want = cap;
  const mentionRows: TopicRow[] = [];
  /** 因为条数上限而没列出的弱证据（按链头去重；同一链条上的多个成员算一条） */
  const mentionOmitted = new Set<string>();
  /** 弱证据池是否被 MENTION_SCAN_CAP 截住 —— 截住了真实总数就只多不少 */
  let mentionPoolCapped = false;
  if (name) {
    const chars = Array.from(name).length;
    let pool: TopicRow[] = [];
    /**
     * **必须排掉已经有实体挂边的条目。**
     *
     * `mentions` 的语义是"只在正文里提到过、没有建立实体关联"，这句话要兑现。
     * 第一版直接拿 FTS 命中当池子，结果 171 条正文含「小本本」的记忆里有 133 条
     * 本来就挂在小本本实体上 —— 它们没进 `sessions` 只是因为 `limit` 卡在 30，
     * 跟"缺实体标注"毫无关系。混进来等于对 AI 说"这些记忆没建关联"，是硬性错误信息。
     *
     * 真正无挂边的只有 38 条；这个数才是值得提醒用户去补标注的量。
     */
    const NOT_ATTACHED = "NOT EXISTS (SELECT 1 FROM memory_entity me WHERE me.memory_id = m.id)";
    // LIKE 那一路用的是无别名的 TOPIC_ROW_SQL，列名只能裸写
    const NOT_ATTACHED_BARE = "NOT EXISTS (SELECT 1 FROM memory_entity me WHERE me.memory_id = id)";
    if (chars >= 3) {
      // FTS5 短语：整串当字面量，内部的双引号要成对转义
      const phrase = `"${name.replace(/"/g, '""')}"`;
      pool = db.prepare(`
        SELECT m.id, m.content, m.type, m.session_id, m.occurred_at, m.superseded_by
        FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
        WHERE memories_fts MATCH ? AND m.deleted_at IS NULL AND ${NOT_ATTACHED}
        ORDER BY m.occurred_at DESC LIMIT ?
      `).all(phrase, MENTION_SCAN_CAP) as TopicRow[];
    } else {
      pool = db.prepare(`
        ${TOPIC_ROW_SQL}
        WHERE deleted_at IS NULL AND content LIKE ? ESCAPE '\\' AND ${NOT_ATTACHED_BARE}
        ORDER BY occurred_at DESC LIMIT ?
      `).all(`%${likeEsc(name)}%`, MENTION_SCAN_CAP) as TopicRow[];
    }
    mentionPoolCapped = pool.length >= MENTION_SCAN_CAP;
    for (const r of pool) {
      if (seenIds.has(r.id)) continue;
      const h = headOf(r);
      if (!h) continue;
      if (mentionRows.length >= want) {
        mentionOmitted.add(h.id);
        continue;
      }
      mentionRows.push(h);
      seenIds.add(h.id);
    }
  }

  // 两批都为空才算真的没有；以前这里 `!ent` 就 return 空，
  // 于是"实体没建、但正文提过"和"库里真没有"在调用方眼里一模一样。
  if (!rows.length && !mentionRows.length) {
    return { entity: ent?.name ?? name, aliases, total: 0, sessions: [] };
  }

  // **只记锚定结果**：召回记账（命中计数 + 共现强化）的含义是"这条被用上了"。
  // 弱证据那批还没经过调用方确认，把它们记进去等于用"顺口提了一句"去强化边 ——
  // 既污染 hit_count，也会让共现强化把无关条目越推越近。而且它省掉一半写库开销。
  onRecalled(db, rows.map((r) => r.id));

  const group = (list: TopicRow[]) => {
    const bySession = new Map<string, Array<{ id: string; content: string; type: string; occurred: string | null; supersededBy: string | null }>>();
    for (const r of list) {
      const key = r.session_id ?? `#${r.id}`;
      if (!bySession.has(key)) bySession.set(key, []);
      bySession.get(key)!.push({ id: r.id, content: maskSecrets(r.content), type: r.type, occurred: r.occurred_at, supersededBy: r.superseded_by ?? null });
    }
    return [...bySession.entries()].map(([sessionId, memories]) => ({
      sessionId,
      occurred: memories[0]?.occurred ?? null,
      memories: memories.map(({ id, content, type, supersededBy }) => ({ id, content, type, supersededBy })),
    }));
  };

  const sessions = group(rows);
  const mentions = group(mentionRows);

  // 载荷提货单（只给引用与描述、**不给字节**；无载荷的记忆不出现 payloads 键）
  const flat: Array<{ id: string; payloads?: unknown }> = [...sessions, ...mentions].flatMap((s) => s.memories);
  attachPayloads(db, flat);

  const out: Record<string, unknown> = { entity: ent?.name ?? name, aliases, total: rows.length, sessions };
  if (siblingIds.length) {
    // 拆簇是写入侧的问题，但读的人有权知道"还有几个同名的簇被合并进来了"
    out.mergedEntities = siblingIds.length;
  }
  /**
   * 锚定侧被 `limit` 截掉多少条，必须报出来。
   *
   * 大实体上「这次只给了 45 条、库里其实有 216 条」是最关键的一句 —— 不说，
   * 调用方会把 `total: 45` 当成"这个话题只有 45 条"，然后据此下结论。
   * 不额外查一次表：主实体挂边总数在取锚定时就一并取了。
   */
  if (ent && entityTotal > rows.length) {
    out.entityTotal = entityTotal;
    out.entityOmitted = entityTotal - rows.length;
  }
  if (mentions.length) {
    /**
     * 这段说明必须给到 AI：`mentions` 里的条目**没有**实体关联，只是正文出现过这个词。
     * 不说清，它会把"顺口提了一句"当成"专门聊过"，然后用肯定语气讲述。
     * 顺带把数据卫生的问题点出来 —— 缺实体的记忆对话题召回是长期损失，值得提醒补。
     */
    out.mentions = mentions;
    // 截断必须报数：池子被 MENTION_SCAN_CAP 截住时，真实数量可能还更多，用 "+" 标出来
    const capped = mentionPoolCapped;
    if (mentionOmitted.size > 0) out.mentionsOmitted = mentionOmitted.size;
    out.mentionsNote =
      `另有 ${mentionRows.length} 条**只在正文里提到过「${ent?.name ?? name}」、并没有建立实体关联**（已与上面的结果去重）。` +
      `这批是弱证据：提到不等于在讲这件事，引用前先看内容对不对题。` +
      `若其中确有该挂到该实体下的条目，说明写入时漏了实体标注 —— 用 get_memory 看清内容后再决定要不要以它为准。` +
      (mentionOmitted.size > 0
        ? `\n还有 ${mentionOmitted.size}${capped ? "+" : ""} 条同类弱证据因返回体积没有列出，` +
          `需要时用 search_memory 按关键词单独查。`
        : "");
  }
  return out;
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
  };
  /**
   * 延续链：**整条都返回**（含旁支）。
   *
   * 原先 10 条封顶同时造成两个问题：主线被截断（实测库里有 15 层的链），
   * 以及 BFS 排在后面的旁支永远进不来 —— 一条 15 层的主线就把 9 个名额吃满，
   * 所以「9 个链头有 2–3 条直接前驱，却一条都没显示」。
   *
   * 只有异常长链才裁（>50），且必须**说出来**：不声明的截断比截断更糟，
   * 调用方会把"看到的最早那条"当成"这条记忆的起点"。
   */
  const chainRes = resolveChain(db, id);
  out.chain = chainRes.links.filter((l) => l.id !== id).map((l) => ({ ...l, content: maskSecrets(l.content) }));
  if (chainRes.truncated) {
    out.chainTotal = chainRes.total;
    out.chainNote = `这条延续链共 ${chainRes.total} 条（含链头），上面只列了最近 ${chainRes.links.length} 条`;
  }
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
