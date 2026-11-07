/**
 * 个人库存储实现：core 端口的 SQLite 注入端。
 * 纪律：一切变更走 events 哈希链（append-only）；memories 遗忘=墓碑不删除。
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { eventHash, payloadHash, uuidv7, type MemoryRecord, type MemoryWrite, type EventRecord, type EventInput } from "@xbb/core";
import { initSchemaV2, ORG_PERSONAL } from "./schema";
import { tokenize } from "./tokenize";
import { openGate, resolveDbPath, markInitialized } from "./home";

const GENESIS = "GENESIS";

/** IR 停用词（检索机制用，非业务语义）：时间指代/疑问代词/寒暄等无记忆价值的高频双字词 */
const WEAK_STOP = new Set([
  "今天", "明天", "后天", "昨天", "现在", "刚才", "最近", "马上", "待会", "回头",
  "怎么", "什么", "这么", "那么", "这个", "那个", "哪些", "哪个", "哪里", "多少",
  "可以", "应该", "需要", "能够", "可能", "我们", "你们", "他们", "自己", "大家",
  "还有", "但是", "所以", "如果", "就是", "还是", "只是", "一点", "一下", "有点",
  "时候", "样子", "感觉", "直接", "请问", "帮忙", "谢谢", "你好",
]);

interface MemoryRow {
  id: string;
  org_id: string;
  space_id: string;
  actor: string;
  content: string;
  tags: string;
  status: string;
  needs_ack: number;
  created_at: string;
  updated_at: string;
}

function toMemoryRecord(r: MemoryRow): MemoryRecord & { status: string; needsAck: boolean } {
  return {
    id: r.id as MemoryRecord["id"],
    orgId: r.org_id,
    spaceId: r.space_id,
    actor: r.actor,
    content: r.content,
    tags: JSON.parse(r.tags) as string[],
    embeddingModel: null,
    createdAt: r.created_at,
    status: r.status,
    needsAck: r.needs_ack === 1,
  };
}

/**
 * 收紧个人库的文件权限：目录 0700、库与 WAL/SHM 0600。
 *
 * 为什么必须做：库里存的是**这个人全部的记忆原文**，以及密钥保险箱的明文值
 * （`secrets.value` 是掩码展示、不是加密存储）。默认 umask 下它们是 0644 ——
 * 同机其他用户、备份工具、误开的共享目录都能直接读走。
 *
 * 只在 POSIX 上做：Windows 没有 chmod 语义，权限走继承 ACL（用户目录默认就是私有的），
 * 路径上加了盘符判断反而是假动作。失败只静默——收紧不了不该让开库失败，
 * 但也不假装成功（调用方要判权限，读 stat 即可）。
 */
function tightenPerms(file: string): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(dirname(file), 0o700);
    for (const p of [file, `${file}-wal`, `${file}-shm`]) {
      if (existsSync(p)) chmodSync(p, 0o600);
    }
  } catch {
    /* 只读挂载 / 非属主：收紧失败不影响使用 */
  }
}

export class PersonalStore {
  readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
  }

  /** 打开（必要时创建）个人库。默认 ~/.xiaobenben/memory.db（统一），测试传显式路径 */
  static open(path?: string, opts: { force?: boolean } = {}): PersonalStore {
    // 无显式路径 ⇒ 走判定闸：库不在配置指定的位置时**抛错，绝不静默新建**。
    // 显式路径（测试 / 导入导出）跳过闸门——那份文件是什么，由调用方负责。
    let file: string;
    let firstRun = false;
    if (path) {
      file = path;
    } else {
      const gate = openGate({ force: opts.force });
      file = gate.dbPath;
      firstRun = gate.firstRun;
    }
    mkdirSync(dirname(file), { recursive: true });
    const db = new Database(file, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    // 页缓存：SQLite 默认仅 2MB，1 万条库（约 49MB）读向量时页会被反复淘汰重读。
    // 64MB 是连接级上限、按需分配；不改数据格式也不参与 SQL 语义，删掉即回到默认。
    db.exec("PRAGMA cache_size = -65536");
    initSchemaV2(db);
    tightenPerms(file);
    // 「用过」的锚点：库被删之后，就靠它把"库丢了"和"全新安装"分开。
    if (firstRun) markInitialized();
    return new PersonalStore(db);
  }

  // ---------- 记忆（可变层） ----------

  async deliver(write: MemoryWrite, opts: { needsAck?: boolean } = {}): Promise<MemoryRecord & { status: string; needsAck: boolean }> {
    const now = new Date().toISOString();
    const id = uuidv7();
    const tags = JSON.stringify(write.tags ?? []);
    this.db
      .query(
        `INSERT INTO memories (id, org_id, space_id, actor, content, tags, needs_ack, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ORG_PERSONAL, write.spaceId, write.actor, write.content, tags, opts.needsAck ? 1 : 0, now, now);
    await this.appendEvent({
      orgId: ORG_PERSONAL,
      actor: write.actor,
      type: "memory.deliver",
      payloadHash: await payloadHash({ id, content: write.content, tags: write.tags ?? [], needsAck: opts.needsAck ?? false }),
    });
    return toMemoryRecord(this.db.query("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow);
  }

  get(id: string): (MemoryRecord & { status: string; needsAck: boolean }) | null {
    const r = this.db.query("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
    return r ? toMemoryRecord(r) : null;
  }

  listBySpace(spaceId: string, opts: { limit: number; cursor?: string }): MemoryRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM memories WHERE space_id = ? AND status = 'active' AND (? IS NULL OR created_at < ?)
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(spaceId, opts.cursor ?? null, opts.cursor ?? null, opts.limit) as MemoryRow[];
    return rows.map(toMemoryRecord);
  }

  /** 遗忘=墓碑事件（append-only：内容行保留 status='forgotten'，凭证链永远可审计）。
   * 双列同步：deleted_at 与 status 同写（检索 SQL 按 deleted_at 过滤，移植纪律） */
  async forget(id: string, actor: string): Promise<boolean> {
    const now = new Date().toISOString();
    const r = this.db
      .query("UPDATE memories SET status = 'forgotten', deleted_at = ?, updated_at = ? WHERE id = ? AND status = 'active'")
      .run(now, now, id);
    if (r.changes === 0) return false;
    await this.appendEvent({
      orgId: ORG_PERSONAL,
      actor,
      type: "memory.forget",
      payloadHash: await payloadHash({ id }),
    });
    return true;
  }

  // ---------- inbox / ack（AI 建议的入场券，凭证链） ----------

  inbox(opts: { limit?: number } = {}): (MemoryRecord & { status: string; needsAck: boolean })[] {
    const rows = this.db
      .query("SELECT * FROM memories WHERE needs_ack = 1 AND status = 'active' ORDER BY created_at DESC LIMIT ?")
      .all(opts.limit ?? 50) as MemoryRow[];
    return rows.map(toMemoryRecord);
  }

  async ack(id: string, actor: string): Promise<boolean> {
    const now = new Date().toISOString();
    const r = this.db
      .query("UPDATE memories SET needs_ack = 0, updated_at = ? WHERE id = ? AND needs_ack = 1")
      .run(now, id);
    if (r.changes === 0) return false;
    await this.appendEvent({
      orgId: ORG_PERSONAL,
      actor,
      type: "memory.ack",
      payloadHash: await payloadHash({ id }),
    });
    return true;
  }

  /**
   * 主动推送：把既有记忆标记回 inbox（needs_ack 0→1），事件类型 memory.push。
   * 推送的是引用不是副本——不新增 memories 行；已在 inbox 的返回 false（天然去重）。
   */
  async pushToInbox(id: string, actor = "hook"): Promise<boolean> {
    const now = new Date().toISOString();
    const r = this.db
      .query("UPDATE memories SET needs_ack = 1, updated_at = ? WHERE id = ? AND status = 'active' AND needs_ack = 0")
      .run(now, id);
    if (r.changes === 0) return false;
    await this.appendEvent({
      orgId: ORG_PERSONAL,
      actor,
      type: "memory.push",
      payloadHash: await payloadHash({ id, via: "hook" }),
    });
    return true;
  }

  // ---------- 检索（两段式的本地简化版） ----------
  //  三级漏斗（与 server org-store.search 同构，2026-09-28 recall-bench 定稿）：
  //  查询 token（CJK bigram + ASCII 词）AND（precision 优先）→ 落空降级 OR
  //  （多词接缝 bigram「末天/粮补」内容侧不存在，AND 会全灭）→ 整串 LIKE 兜底。
  //  实现说明：FTS5 trigram 的 MATCH 对 <3 字符 token 不产生匹配（实测），
  // 故 bigram 组合查询走 LIKE（个人库量级全表扫可接受；FTS5 保留给 push 的
  //  三元组 df 统计与 ≥3 字子串加速）。OR 版按命中 token 数 DESC → created_at DESC。

  search(text: string, opts: { limit?: number; spaceIds?: string[] } = {}): { memoryId: string; content: string; score: number; createdAt: string }[] {
    const limit = Math.min(opts.limit ?? 10, 100);
    const hasSpace = !!(opts.spaceIds && opts.spaceIds.length);
    const spaceFilter = hasSpace ? opts.spaceIds! : [];
    const ph = spaceFilter.map(() => "?").join(",");
    const spaceClause = hasSpace ? `m.space_id IN (${ph})` : "1=1";
    const params = [...spaceFilter];

    const toks = [...new Set(tokenize(text))];
    if (toks.length === 0) return []; // 纯标点/空查询：无可匹配 token（原整串 LIKE 兜底已证死代码，2026-09-28）
    {
      const likeClause = toks.map(() => `m.content LIKE '%' || ? || '%'`).join(" AND ");
      const orClause = toks.map(() => `m.content LIKE '%' || ? || '%'`).join(" OR ");
      const hitOrder = toks.map(() => `(CASE WHEN m.content LIKE '%' || ? || '%' THEN 1 ELSE 0 END)`).join(" + ");
      for (const stage of ["AND", "OR"] as const) {
        if (stage === "OR" && toks.length < 2) break;
        const rows = this.db
          .query(
            `SELECT m.id AS memoryId, m.content, m.created_at AS createdAt, -1.0 AS score
             FROM memories m WHERE m.status = 'active' AND ${spaceClause}
             AND (${stage === "AND" ? likeClause : orClause})
             ${stage === "OR" ? `ORDER BY (${hitOrder}) DESC, m.created_at DESC` : "ORDER BY m.created_at DESC"}
             LIMIT ?`,
          )
          .all(...params, ...toks, ...(stage === "OR" ? toks : []), limit) as { memoryId: string; content: string; score: number; createdAt: string }[];
        if (rows.length > 0) return rows;
      }
    }
    return [];
  }

  /**
   * 主动推送检索v3：双通道 + 触发门槛。
   * 强信号 = CJK 三元组 + ASCII 词（≥3），df ≤ max(2, 5%·N)；
   * 弱信号 = CJK 双字词（去停用词），df ≤ max(1, 1%·N)。
   * 触发门槛（hook-eval 实测定稿）：≥1 强信号 或 ≥2 弱信号——
   * 单弱信号全是"今天/天气/称呼"级别的语义噪声，宁缺勿滥。
   */
  searchProactive(text: string, opts: { limit?: number } = {}): { memoryId: string; content: string; score: number; createdAt: string }[] {
    const { strong, weak } = this.hookPhrases(text);
    const nDocs = (this.db.query("SELECT count(*) AS n FROM memories WHERE status='active'").get() as { n: number }).n;
    const maxDf3 = Math.max(2, Math.ceil(nDocs * 0.05));
    const maxDf2 = Math.max(1, Math.ceil(nDocs * 0.01));

    type Cand = { memoryId: string; content: string; createdAt: string; df: number; strong: number; weak: number };
    const best = new Map<string, Cand>();
    const accept = (
      rows: Array<{ id: string; content: string; created_at: string }>,
      phrase: string,
      df: number,
      kind: "strong" | "weak",
      ci: boolean,
    ) => {
      for (const r of rows) {
        const hit = ci
          ? r.content.toLowerCase().includes(phrase.toLowerCase())
          : r.content.includes(phrase);
        if (!hit) continue;
        const cur = best.get(r.id);
        if (!cur) best.set(r.id, { memoryId: r.id, content: r.content, createdAt: r.created_at, df, strong: kind === "strong" ? 1 : 0, weak: kind === "weak" ? 1 : 0 });
        else {
          cur.df = Math.min(cur.df, df);
          if (kind === "strong") cur.strong++;
          else cur.weak++;
        }
      }
    };

    if (strong.length > 0) {
      const rare: Array<[string, number]> = [];
      for (const p of strong) {
        const row = this.db
          .query("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?")
          .get(`"${p}"`) as { n: number };
        if (row.n > 0 && row.n <= maxDf3) rare.push([p, row.n]);
      }
      if (rare.length > 0) {
        const match = rare.map(([p]) => `"${p}"`).join(" OR ");
        const rows = this.db
          .query(
            `SELECT m.id, m.content, m.created_at FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
             WHERE memories_fts MATCH ? AND m.status = 'active' ORDER BY bm25(memories_fts) LIMIT 30`,
          )
          .all(match) as Array<{ id: string; content: string; created_at: string }>;
        for (const [p, df] of rare) accept(rows, p, df, "strong", true); // FTS trigram 大小写不敏感，复核须同步
      }
    }

    if (weak.length > 0) {
      const rare2: Array<[string, number]> = [];
      for (const p of weak) {
        const row = this.db
          .query("SELECT count(*) AS n FROM memories WHERE status = 'active' AND content LIKE '%' || ? || '%'")
          .get(p) as { n: number };
        if (row.n > 0 && row.n <= maxDf2) rare2.push([p, row.n]);
      }
      if (rare2.length > 0) {
        const where = rare2.map(() => "content LIKE '%' || ? || '%'").join(" OR ");
        const rows = this.db
          .query(`SELECT id, content, created_at FROM memories WHERE status = 'active' AND (${where}) LIMIT 50`)
          .all(...rare2.map(([p]) => p)) as Array<{ id: string; content: string; created_at: string }>;
        for (const [p, df] of rare2) accept(rows, p, df, "weak", false);
      }
    }

    return [...best.values()]
      .filter((c) => c.strong >= 1 || c.weak >= 2) // 门槛：≥1 强信号，或同一条记忆命中 ≥2 弱信号（单弱=今天/天气级噪声，宁缺勿滥）
      .sort((a, b) => a.df - b.df || b.createdAt.localeCompare(a.createdAt))
      .slice(0, opts.limit ?? 3)
      .map(({ memoryId, content, createdAt, df }) => ({ memoryId, content, score: -df, createdAt }));
  }

  /** 回合文本 → 检索短语：强=ASCII 词(≥3)+CJK 三元组；弱=CJK 双字词（去停用词） */
  private hookPhrases(text: string): { strong: string[]; weak: string[] } {
    const strong = new Set<string>();
    const weak = new Set<string>();
    for (const m of text.matchAll(/[A-Za-z0-9_+#.-]{3,}/g)) strong.add(m[0]);
    for (const run of text.matchAll(/[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]+/g)) {
      const s = run[0];
      for (let i = 0; i + 3 <= s.length; i++) strong.add(s.slice(i, i + 3));
      for (let i = 0; i + 2 <= s.length; i++) {
        const bi = s.slice(i, i + 2);
        if (!WEAK_STOP.has(bi)) weak.add(bi);
      }
    }
    return { strong: [...strong].slice(0, 40), weak: [...weak].slice(0, 40) };
  }

  // ---------- 凭证层（events 哈希链） ----------

  async appendEvent(input: EventInput): Promise<EventRecord> {
    const last = this.db
      .query("SELECT org_seq, hash FROM events WHERE org_id = ? ORDER BY org_seq DESC LIMIT 1")
      .get(input.orgId) as { org_seq: number; hash: string } | undefined;
    const seq = last ? last.org_seq + 1 : 1;
    const prevHash = last ? last.hash : GENESIS;
    const ph = input.payloadHash;
    const hash = await eventHash({ orgId: input.orgId, seq, prevHash, payloadHash: ph });
    const id = uuidv7();
    const at = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO events (id, org_id, org_seq, actor, type, payload_hash, prev_hash, hash, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.orgId, seq, input.actor, input.type, ph, prevHash, hash, at);
    return { ...input, payloadHash: ph, seq, prevHash, hash, at, };
  }

  async verifyChain(orgId: string): Promise<boolean> {
    const rows = this.db
      .query("SELECT * FROM events WHERE org_id = ? ORDER BY org_seq ASC")
      .all(orgId) as Array<{ org_seq: number; prev_hash: string; hash: string; payload_hash: string }>;
    let prev = GENESIS;
    for (const r of rows) {
      const expect = await eventHash({ orgId, seq: r.org_seq, prevHash: prev, payloadHash: r.payload_hash });
      if (r.prev_hash !== prev || r.hash !== expect) return false;
      prev = r.hash;
    }
    return true;
  }

  /**
   * 库存统计（全部从现表 count 聚合，不建新真源；同期补齐内容侧面板）。
   * 类型分布遵守「机制不语义」：只按 space/tags/actor/时间桶等机制维度聚合，
   * 不内置分类枚举；byTag 只取 top N，其余不穷举。
   */
  stats(): {
    memories: number;
    forgotten: number;
    pendingAck: number;
    events: number;
    oldest: string | null;
    newest: string | null;
    last7d: number;
    bySpace: { spaceId: string; count: number }[];
    byTag: { tag: string; count: number }[];
    links: {
      total: number;
      reinforced: number;
      byRelation: { relation: string; count: number }[];
      weight: { min: number | null; p50: number | null; p90: number | null; max: number | null };
      avgDegree: number;
    };
  } {
    const one = (sql: string) => (this.db.query(sql).get() as { n: number }).n;
    const memories = one(`SELECT count(*) AS n FROM memories WHERE status='active'`);
    const forgotten = one(`SELECT count(*) AS n FROM memories WHERE status='forgotten'`);
    const pendingAck = one(`SELECT count(*) AS n FROM memories WHERE needs_ack=1 AND status='active'`);
    const events = one(`SELECT count(*) AS n FROM events`);
    const oldest = (this.db.query(`SELECT min(created_at) AS v FROM memories WHERE status='active'`).get() as { v: string | null }).v;
    const newest = (this.db.query(`SELECT max(created_at) AS v FROM memories WHERE status='active'`).get() as { v: string | null }).v;
    const last7d = one(`SELECT count(*) AS n FROM memories WHERE status='active' AND created_at >= datetime('now', '-7 days')`);
    const bySpace = (
      this.db
        .query(`SELECT space_id AS spaceId, count(*) AS count FROM memories WHERE status='active' GROUP BY space_id ORDER BY count DESC`)
        .all() as { spaceId: string; count: number }[]
    );
    const tagCounter = new Map<string, number>();
    for (const r of this.db.query(`SELECT tags FROM memories WHERE status='active' AND tags != '[]'`).all() as { tags: string }[]) {
      try {
        for (const t of JSON.parse(r.tags) as unknown[]) {
          if (typeof t === "string" && t) tagCounter.set(t, (tagCounter.get(t) ?? 0) + 1);
        }
      } catch {
        // tags 列损坏行不阻断统计
      }
    }
    const byTag = [...tagCounter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([tag, count]) => ({ tag, count }));

    // ── 关联网络（赫布强度是否真的在动，只能靠分布证明）──
    // 只报 total 是不够的：total 恒等于写入时的建边数，谁都不知道权重有没有变化。
    // 所以报**有效权重的分位**（含时间衰减）+ **被强化过的边数** ——
    // 一个恒为 0 的 reinforced 或 p50 永远卡在 0.5，就是「写了但没接线」的自证。
    const linkTotal = one(`SELECT count(*) AS n FROM memory_links`);
    const reinforced = one(`SELECT count(*) AS n FROM memory_links WHERE hits > 0`);
    const byRelation = this.db
      .query(`SELECT relation, count(*) AS count FROM memory_links GROUP BY relation ORDER BY count DESC`)
      .all() as { relation: string; count: number }[];
    const effs = (this.db.query(`SELECT eff FROM memory_links_eff`).all() as { eff: number }[])
      .map((r) => r.eff).sort((a, b) => a - b);
    const at = (p: number): number | null =>
      effs.length ? Math.round(effs[Math.min(effs.length - 1, Math.floor(p * effs.length))]! * 1000) / 1000 : null;
    const ends = one(`SELECT count(*) AS n FROM (SELECT from_id AS id FROM memory_links UNION ALL SELECT to_id AS id FROM memory_links)`);
    const nodes = one(`SELECT count(DISTINCT id) AS n FROM (SELECT from_id AS id FROM memory_links UNION ALL SELECT to_id AS id FROM memory_links)`);
    const links = {
      total: linkTotal,
      reinforced,
      byRelation,
      weight: { min: at(0), p50: at(0.5), p90: at(0.9), max: effs.length ? Math.round(effs[effs.length - 1]! * 1000) / 1000 : null },
      avgDegree: nodes ? Math.round((ends / nodes) * 10) / 10 : 0,
    };

    return { memories, forgotten, pendingAck, events, oldest, newest, last7d, bySpace, byTag, links };
  }
}

/** 兼容别名 —— 真正实现在 home.ts（`resolveDbPath`）。
 *  留这一个名字而不是删掉重写调用方：**"库在哪"必须只有一条计算路径**，多一处拼就是多一处漂移。 */
export function defaultDbPath(): string {
  return resolveDbPath();
}
