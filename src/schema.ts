// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 个人库 SQLite schema（客户端形态：内含个人库，零登录开箱即用）。
 * 与 server 的 PG schema 同构（memories/terms/events 三件套）——"个人还是组织"不是代码分支。
 * 迁移：PRAGMA user_version 递增，additive-only（与 server 迁移检查器同一纪律）。
 */
import type { Database } from "bun:sqlite";

/** 个人租户固定 ID（kind=personal，树根） */
export const ORG_PERSONAL = "00000000-0000-7000-8000-000000000001";
/** 默认个人空间 */
export const SPACE_PERSONAL = "00000000-0000-7000-8000-000000000002";

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  org_seq INTEGER NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS events_org_seq_uq ON events(org_id, org_seq);
CREATE INDEX IF NOT EXISTS events_org_at_idx ON events(org_id, at);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  needs_ack INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_space_created_idx ON memories(space_id, created_at);

CREATE TABLE IF NOT EXISTS terms (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  term TEXT NOT NULL,
  definition TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisional',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS terms_org_term_uq ON terms(org_id, term);
`;

/** FTS5 trigram：CJK 友好的子串检索（Bun 内置 SQLite 3.4x 含 trigram） */
const SCHEMA_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='rowid',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE OF content, status ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

export function initSchema(db: Database): void {
  db.exec(SCHEMA_V1);
  db.exec(SCHEMA_FTS);
  const v = db.query("PRAGMA user_version").get() as { user_version: number };
  if (v.user_version < 1) db.exec("PRAGMA user_version = 1");
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema v2（2026-10-04 代际合并）：既有全部能力融入，additive-only。
//  - memories 补全列（时间双字段/type/kind/约束窗口/importance/superseded_by/…）
//  - 新表：devices / entities / memory_entity / memory_links / memory_terms /
//          episodes / episode_chunks / secrets / asset_refs（主键适配 UUIDv7）
// - 向量：embedding BLOB(512×f32) + vec_model（个人版直上，vec_model=坐标系账本）
//  - status 枚举扩展：active | forgotten(墓碑) | archived(到期归档)
//  边界：
//  - memory_terms（每条记忆的检索着陆垫，倒排）与 terms（全局词群等价对）
//    是两个互补机制，共存。
//  - links.weight = 赫布权重，属机制数据不落 events 链（检索路径写库，落链会爆炸）；
//    links 的建立/删除与 supersede 动作落链。
//  - episodes/episode_chunks 仅本地、永不上云（CloudBackend 不实现）、不进 events。
// - 新表为本地特有（单租户物理隔离），云端 PG 同构表后续跟进。
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA_V2_TABLES = `
CREATE TABLE IF NOT EXISTS devices (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT UNIQUE NOT NULL,
  aliases TEXT
);
CREATE TABLE IF NOT EXISTS memory_entity (
  memory_id TEXT NOT NULL,
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  PRIMARY KEY (memory_id, entity_id)
);

CREATE TABLE IF NOT EXISTS memory_links (
  from_id   TEXT NOT NULL,
  to_id     TEXT NOT NULL,
  relation  TEXT NOT NULL,
  weight    REAL DEFAULT 0.5,
  hits      INTEGER NOT NULL DEFAULT 0,
  last_at   TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_links_to ON memory_links(to_id);
CREATE INDEX IF NOT EXISTS idx_links_from ON memory_links(from_id);

CREATE TABLE IF NOT EXISTS memory_terms (
  term      TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  source    TEXT NOT NULL,
  PRIMARY KEY (term, memory_id)
);
CREATE INDEX IF NOT EXISTS idx_mterms_term ON memory_terms(term);
CREATE INDEX IF NOT EXISTS idx_mterms_mem ON memory_terms(memory_id);

CREATE TABLE IF NOT EXISTS episodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  role        TEXT,
  content     TEXT,
  recorded_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS episode_chunks USING fts5(
  session_id, chunk_text, position, tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS secrets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  value      TEXT NOT NULL,
  value_hash TEXT UNIQUE NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_refs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  ref_type  TEXT NOT NULL,
  ref       TEXT NOT NULL,
  mime      TEXT,
  created_at TEXT NOT NULL
);
`;

/** memories v2 补列（幂等 ALTER）：列名保持一致，类型适配 TEXT 主键 */
const MEMORY_V2_COLUMNS: [string, string][] = [
  ["content_hash", "TEXT"],
  ["type", "TEXT DEFAULT 'fact'"],
  ["entities", "TEXT"],
  ["occurred_at", "TEXT"],
  ["occurred_precision", "TEXT"],
  ["session_id", "TEXT"],
  ["source_chunk", "INTEGER"],
  ["source", "TEXT"],
  ["source_ref", "TEXT"],
  ["device_id", "TEXT"],
  ["importance", "REAL DEFAULT 0.5"],
  ["superseded_by", "TEXT"],
  ["deleted_at", "TEXT"],
  ["kind", "TEXT DEFAULT 'memory'"],
  ["dscope", "TEXT"],
  ["domain", "TEXT"],
  ["starts_at", "TEXT"],
  ["expires_at", "TEXT"],
  ["system", "INTEGER DEFAULT 0"],
  ["similar_sessions", "INTEGER DEFAULT 0"],
  ["hit_count", "INTEGER DEFAULT 0"],
  ["embedding", "BLOB"],
  ["vec_model", "TEXT"],
];

/** v2 迁移（幂等）：新库与 v1 存量库统一走这里 */
export function migrateV2(db: Database): void {
  const existing = new Set(
    (db.query("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((r) => r.name),
  );
  for (const [col, def] of MEMORY_V2_COLUMNS) {
    if (!existing.has(col)) db.exec(`ALTER TABLE memories ADD COLUMN ${col} ${def}`);
  }
  db.exec(SCHEMA_V2_TABLES);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash) WHERE content_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_occurred ON memories(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_memories_device ON memories(device_id);
    CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind, status);
    CREATE INDEX IF NOT EXISTS idx_memories_domain ON memories(domain);
    CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at);
    CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by);
  `);
  const v = db.query("PRAGMA user_version").get() as { user_version: number };
  if (v.user_version < 2) db.exec("PRAGMA user_version = 2");

  // v3：episode_chunks 补 trigram 分词器（初版漏配，unicode61 对中文整段成 token，MATCH 必空）。
  // FTS 表是索引可重建；episodes 原文在，存量重灌在首版发布前无数据，直接重建空表。
  if (v.user_version < 3) {
    const cur = db.query("SELECT sql FROM sqlite_master WHERE name = 'episode_chunks'").get() as { sql: string } | undefined;
    if (cur && !cur.sql.includes("trigram")) {
      db.exec("DROP TABLE IF EXISTS episode_chunks");
      db.exec(`CREATE VIRTUAL TABLE episode_chunks USING fts5(session_id, chunk_text, position, tokenize='trigram')`);
    }
    db.exec("PRAGMA user_version = 3");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema v4（2026-10-15 载荷登记）：**只登记引用，不搬字节**。
//  - `payloads` / `memory_payloads` 两表；**刻意不建 `payload_index`** —— 它服务「多模型 / 可重算 /
// 服务端兜底」三个**服务端概念**，本地一个都不需要（一个 `description` 列足矣）。理由见下文。
// - 与旧表 `asset_refs`（per-memory、无 sha256/bytes）**不复用**：其形状本身阻止去重。
//  - 去重键 `UNIQUE(org_id, sha256)` 是**内容寻址**：同一份字节全库只登记一次，可被多条记忆引用。
// - `storage_kind` 现仅 `local_path`（云端的 `oss` 等留给 V2，走 Deployment Profile）。
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA_V4_TABLES = `
CREATE TABLE IF NOT EXISTS payloads (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  mime         TEXT,
  storage_kind TEXT NOT NULL DEFAULT 'local_path',
  storage_ref  TEXT NOT NULL,
  description  TEXT,
  tags         TEXT,
  uploaded_by  TEXT,
  created_at   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ready',
  UNIQUE (org_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_payloads_ref ON payloads(storage_ref);

CREATE TABLE IF NOT EXISTS memory_payloads (
  memory_id  TEXT NOT NULL,
  payload_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, payload_id)
);
CREATE INDEX IF NOT EXISTS idx_mp_payload ON memory_payloads(payload_id);
`;

/** v4 迁移（幂等、additive-only）：只加表与索引，不动既有数据。 */
export function migrateV4(db: Database): void {
  db.exec(SCHEMA_V4_TABLES);
  const v = db.query("PRAGMA user_version").get() as { user_version: number };
  if (v.user_version < 4) db.exec("PRAGMA user_version = 4");
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema v5（2026-10-15 字段改名）：`payloads.digest` → `payloads.description`。
//  两个理由，第二个更硬：
//   ① 「摘要」隐含压缩，与实际用途**相反** —— 这列要的是**细述**（宿主把文件内容展开写，
//      作为检索着陆垫），写得越详尽召回越准。工具描述里若写 "a short description"，
//      宿主就只写「一张猫的图」。
//   ② **`digest` 与 sha256 撞词**：`payloads.ts` 同一个文件里 `hasher.digest("hex")` 是 hash、
//      而 `payloads.digest` 是文字 —— sha256 在密码学里的本名就是 message digest，
//      读 `p.digest` 必须靠上下文猜是哪种。列名与它旁边的 `sha256` 列不应同义。
//  纯改名，无数据变化（RENAME COLUMN 保留列值）。
// ─────────────────────────────────────────────────────────────────────────────

/** v5 迁移（幂等）：列改名 `digest` → `description`。新库建表即新名，此处自动跳过。 */
export function migrateV5(db: Database): void {
  const v = db.query("PRAGMA user_version").get() as { user_version: number };
  const cols = db.query("PRAGMA table_info(payloads)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  // 双条件：老库有 digest、新库有 description —— 任一已到位都不重复动
  if (names.has("digest") && !names.has("description")) {
    db.exec("ALTER TABLE payloads RENAME COLUMN digest TO description");
  }
  if (v.user_version < 5) db.exec("PRAGMA user_version = 5");
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema v6（2026-10-18 赫布链接线）：memory_links 从「装饰列」变成「真的会动的权重」。
//
// 背景（改之前的实况）：`reinforce()` 写好了但**全仓 0 调用点**，也没有任何衰减
// ⇒ `weight` 恒为建边时的默认 0.5 ⇒ `ORDER BY weight DESC` 是空排序、
// `weight > 0.3 / > 0.2` 这类门槛永远放行。接线必须**同时**做衰减，否则每次召回
// 全体 +0.1，几天后全表漂到 1.0 —— 那只是把常量从 0.5 换成 1.0，信息量没增加。
//
// 三个新增：
//  - `weight`   当前强度（**未含时间衰减**，衰减在读取时惰性计算，见 `memory_links_eff`）
//  - `last_at`  最近一次强化的时刻；**NULL = 从未被共现强化过**
//  - `hits`     被共现强化的次数（观测用：证明这个字段真的在动，而不是又一个恒值列）
//
// 为什么衰减放读路径（视图）而不是跑定时任务：
//  本地版没有常驻调度器，物化衰减必然滞后 —— 用户三个月后打开，读到的还是三个月前的强度。
//  视图每次查询现算，无论多久没打开都正确。代价是「读的时候多一次 pow()」，
//  本地边量级（万级）下可忽略；而且这个视图只被 get_related / 链接预览 / 控制台三处读。
// ─────────────────────────────────────────────────────────────────────────────

/** 关联强度半衰期（天）：30 天没有一次共现 ⇒ 强度减半。改这里 = 改全表衰减速度。 */
export const LINK_HALF_LIFE_DAYS = 30;
/** 每次「同一次召回里一起出现」的强化增量。用可加不用可乘：乘性在低频时几乎不动。 */
export const LINK_REINFORCE_STEP = 0.05;
/** 关联强度上限（有效权重不会超过它） */
export const LINK_MAX_WEIGHT = 1.0;
/** 低于这个有效权重就不再当作「有关联」展示（get_related / linkedPreview 的门槛） */
export const LINK_VISIBLE_MIN = 0.2;

/**
 * 有效权重衰减因子（SQL 片段）：`0.5 ^ (Δt天 / 半衰期)`。
 *
 * - `MAX(0.0, …)`：防时钟回拨 —— `last_at` 落在未来时因子取 1，权重**不会被放大**。
 *   没有这一层，用户改系统时间或跨时区同步就会把关联强度刷到 1.0，而且不可逆。
 * - `COALESCE(last_at, created_at)`：从未强化过的边，从**建立时刻**起算。
 *
 * ⚠️ **公式唯一真源**：视图、`reinforceCooccurrence` 的 UPDATE、`stats` 全部拼这一句，
 * 任何地方手抄第二份都会漂移成「两个地方算出来的强度不一样」。
 */
export function linkDecayFactor(col = "COALESCE(last_at, created_at)"): string {
  return `pow(0.5, MAX(0.0, julianday('now') - julianday(${col})) / ${LINK_HALF_LIFE_DAYS}.0)`;
}

/** 有效权重视图：所有「按强度排序/过滤」的读点都走它，不许直接读 `weight` */
const VIEW_LINKS_EFF = `
CREATE VIEW memory_links_eff AS
SELECT from_id, to_id, relation, weight, hits, created_at, last_at,
       weight * ${linkDecayFactor("COALESCE(last_at, created_at)")} AS eff
FROM memory_links;
`;

export function migrateV6(db: Database): void {
  const cols = new Set(
    (db.query("PRAGMA table_info(memory_links)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  const fresh = !cols.has("last_at");
  if (fresh) db.exec("ALTER TABLE memory_links ADD COLUMN last_at TEXT");
  if (!cols.has("hits")) db.exec("ALTER TABLE memory_links ADD COLUMN hits INTEGER NOT NULL DEFAULT 0");
  db.exec("CREATE INDEX IF NOT EXISTS idx_links_from ON memory_links(from_id)");

  // 存量边：从**升级时刻**起算衰减，而不是从各自的 created_at 起算。
  // 理由：老库里的边全都带着「从未被强化」的 0.5 默认值，若按 created_at 起算，
  // 一条半年前建的边一升级就是 0.5 × 0.5^(180/30) ≈ 0.008，直接跌破可见门槛 ——
  // 等于一次迁移把历史关联全废了。新机制应当**从今天开始计时**。
  if (fresh) {
    db.exec(`UPDATE memory_links SET last_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE last_at IS NULL`);
  }

  // 视图带 now()，定义会随半衰期常量变化 ⇒ 每次启动重建。并发初始化时另一进程
  // 可能刚好建好，忽略「已存在」：两边拼的是同一个常量，定义必然一致。
  db.exec("DROP VIEW IF EXISTS memory_links_eff");
  try {
    db.exec(VIEW_LINKS_EFF);
  } catch {
    /* 并发初始化窗口：视图已由另一连接按同一常量建好 */
  }

  const v = db.query("PRAGMA user_version").get() as { user_version: number };
  if (v.user_version < 6) db.exec("PRAGMA user_version = 6");
}

/**
 * V7（2026-10-24）：情景层从「碎片捞」升级为「可翻页追溯」。
 *
 * 背景：episodes 原本只有表结构没有索引，且 log 侧只能靠 AI 自觉条件式调用，
 * 实测 358 条蒸馏记忆只对应 42 句原话（且集中在 2 场会话、全是事后批量补录）。
 * 要让「每轮都记 + 按会话/按天/按话题翻页回放」成立，需要三件基础设施：
 *
 *  1. topic 列 —— 话题是跨会话追溯的唯一稳定锚点，没有它就只能靠 sessionId 串。
 *  2. (session_id, id) 复合索引 —— 翻页永远是「某会话内 id > cursor」，无索引即全表扫。
 *  3. recorded_at 索引 —— 「某一天」的范围查询同理。
 *
 * 全部 additive-only，不改既有列语义。episode_chunks 是 FTS5 虚表，自带倒排，不另建索引。
 */
export function migrateV7(db: Database): void {
  const cols = new Set(
    (db.query("PRAGMA table_info(episodes)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has("topic")) db.exec("ALTER TABLE episodes ADD COLUMN topic TEXT");

  // 翻页主索引：会话内按 id 游标切片（cursor 分页依赖 id 单调递增，append-only 保证）
  db.exec("CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id, id)");
  // 按天回放：recorded_at 是 'YYYY-MM-DD HH:MM:SS' 定长文本，字典序即时间序
  db.exec("CREATE INDEX IF NOT EXISTS idx_episodes_at ON episodes(recorded_at, id)");
  // 按话题追溯：跨会话聚合
  db.exec("CREATE INDEX IF NOT EXISTS idx_episodes_topic ON episodes(topic, id)");

  const v = db.query("PRAGMA user_version").get() as { user_version: number };
  if (v.user_version < 7) db.exec("PRAGMA user_version = 7");
}

/**
 * V8（2026-10-24）：episodes 从「AI 自觉上报」扩成「引擎主动采集客户端会话」。
 *
 * 动机：MCP 是请求-响应协议，server 永远看不到对话流，靠 AI 每轮调 log_episodes 上报
 * 实测不可靠（358 条摘要只对应 42 句原话，且全是事后补录）。而客户端本来就把完整会话
 * 落在本机盘上（opencode 的 SQLite、Cursor 的 KV、各家 CLI 的 JSONL）——引擎自己去读，
 * 不依赖任何客户端配合，也不需要为每个 agent 写插件。
 *
 * 三列 + 三张表，全部 additive：
 *   source        哪来的（mcp / opencode / cursor / workbuddy / claude / generic）
 *   external_id   客户端原生 id（part id / bubbleId / message id）—— 跨扫描稳定，去重主依据
 *   dedupe_key    sha256(source|session|external_id)；**唯一索引**兜底，重扫零重复
 *   ingest_sources  每源最近一次采集结果（可用性 / 新增 / 耗时）
 *   ingest_files    按文件采集的字节游标（JSONL 追加写，靠 offset 续读）
 *
 * 为什么用唯一索引而不是「先 SELECT 再 INSERT」：采集是幂等的批量写，
 * 先查后插在并发（serve 定时 + 手动 xbb ingest 同时跑）下会双写；唯一约束是唯一可靠的闸。
 */
export function migrateV8(db: Database): void {
  const cols = new Set(
    (db.query("PRAGMA table_info(episodes)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has("source")) db.exec("ALTER TABLE episodes ADD COLUMN source TEXT");
  if (!cols.has("external_id")) db.exec("ALTER TABLE episodes ADD COLUMN external_id TEXT");
  if (!cols.has("dedupe_key")) db.exec("ALTER TABLE episodes ADD COLUMN dedupe_key TEXT");

  // 存量行都是 AI 通过 log_episodes 写的 —— 只在首次升到 V8 时回填一次。
  // 不能无条件执行：之后新插入的行 source 一定非空，这条 UPDATE 只会误标。
  const ver = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (ver < 8) db.exec("UPDATE episodes SET source = 'mcp' WHERE source IS NULL");

  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_episodes_dedupe ON episodes(dedupe_key) WHERE dedupe_key IS NOT NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_episodes_source ON episodes(source, id)");

  db.exec(`CREATE TABLE IF NOT EXISTS ingest_sources (
    source      TEXT PRIMARY KEY,
    available   INTEGER NOT NULL DEFAULT 0,
    last_run_at TEXT,
    last_new    INTEGER NOT NULL DEFAULT 0,
    cursor      TEXT,
    note        TEXT
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS ingest_files (
    source    TEXT NOT NULL,
    path      TEXT NOT NULL,
    offset    INTEGER NOT NULL DEFAULT 0,
    turns     INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT,
    PRIMARY KEY (source, path)
  )`);

  if (ver < 8) db.exec("PRAGMA user_version = 8");
}

/**
 * V9（2026-10-24）：采集层从「认客户端」转向「认结构」。
 *
 * 动机：V8 里每个源一份手写 extract，等于把各客户端的私有字段名焊死在代码里。
 * 上游一改版（content→body、role 挪进 message 壳）整源静默失效 —— 游标照常前进，
 * 那一段永久丢失，界面上只显示"新增 0"，几个月后才发现记忆断了。
 *
 * 三列 + 一张表，全部 additive：
 *   fingerprint  命中消息的键集合指纹；变了就是上游改版，--status 直接告警
 *   unparsed     上次采集里「读到了但解析不出」的行数；与 fingerprint 一起看才准
 *   total_lines  上次采集读过的总行数，unparsed/total_lines = 解析率
 *   ingest_formats  格式声明（descriptor）库：把适配写成数据，新增客户端不必改代码
 *
 * 为什么 fingerprint 不掺内容：掺了内容，同一格式只要对话变了指纹就变，天天假告警。
 */
export function migrateV9(db: Database): void {
  const cols = new Set(
    (db.query("PRAGMA table_info(ingest_sources)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has("fingerprint")) db.exec("ALTER TABLE ingest_sources ADD COLUMN fingerprint TEXT");
  if (!cols.has("unparsed")) db.exec("ALTER TABLE ingest_sources ADD COLUMN unparsed INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("total_lines")) db.exec("ALTER TABLE ingest_sources ADD COLUMN total_lines INTEGER NOT NULL DEFAULT 0");

  // 文件头部指纹：检测「原地重写」。纯字节偏移只在 append-only 下成立，
  // 而 Claude Code 的 /compact 会把会话文件整个重写一遍 —— 那时 size 可能还变大了，
  // 只比 size < offset 会漏读。头部变了就把游标作废（宁可重读，不可漏采）。
  const fcols = new Set(
    (db.query("PRAGMA table_info(ingest_files)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!fcols.has("head_hash")) db.exec("ALTER TABLE ingest_files ADD COLUMN head_hash TEXT");

  db.exec(`CREATE TABLE IF NOT EXISTS ingest_formats (
    id         TEXT PRIMARY KEY,
    source     TEXT,
    descriptor TEXT NOT NULL,
    origin     TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT
  )`);

  const v = db.query("PRAGMA user_version").get() as { user_version: number };
  if (v.user_version < 9) db.exec("PRAGMA user_version = 9");
}

/**
 * V10：存活过滤的部分索引。
 *
 * `deleted_at IS NULL AND status != 'forgotten'` 是每次检索的必经条件 ——
 * searchMemory 要用存活总数当 IDF 的分母（见 memory-search.ts）。而它原先没有任何
 * 索引吃得下：EXPLAIN 是 `SCAN memories`，1 万条 **3.4ms**，且随库线性增长；
 * 更要命的是 memories 行里躺着向量 BLOB，全表扫等于把 20MB 白读一遍。
 *
 * 部分索引只收存活行（规模通常接近全表，但条目是「status」这么窄的列），
 * status 随索引走 ⇒ 计数变成纯索引扫描，正文页一次都不碰。
 * 写入侧代价：只有 deleted_at IS NULL 的行进入该索引，且列极窄，可忽略。
 */
export function migrateV10(db: Database): void {
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_live ON memories(status) WHERE deleted_at IS NULL");
  // 待确认队列（inbox）：`needs_ack = 1 AND status = 'active' ORDER BY created_at DESC`。
  // 原计划是 `SCAN memories` + `USE TEMP B-TREE FOR ORDER BY` —— 全表扫完再排序，
  // 1 万条 2.7ms 且随库线性增长。部分索引只收待确认行、按 created_at 有序，
  // 取前 N 条变成索引倒序扫描，暂存 B-tree 也一并消失。
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_memories_pending_ack ON memories(created_at) WHERE needs_ack = 1",
  );
  const v = db.query("PRAGMA user_version").get() as { user_version: number };
  if (v.user_version < 10) db.exec("PRAGMA user_version = 10");
}

/** 目标结构版本：所有 migrateV* 收敛到的终点。healthz 靠它判断「服务活着但库还是旧的」。 */
export const SCHEMA_TARGET_VERSION = 10;

/** 拿不到写锁时的总尝试次数。每次尝试内部还会各自等 `busy_timeout`（默认 3s）。 */
const BUSY_ATTEMPTS = Math.max(1, Number(process.env.XBB_SCHEMA_RETRIES ?? 3));

/**
 * 结构升级拿不到写锁 —— 必须给人话，不能把 `SQLiteError: database is locked` 甩给用户。
 *
 * 2026-11-11 用户反馈（官网 /feedback，Win11 + serve + 两个 MCP 同时开着）：
 * 0.4.49 升 0.4.51 后首次 `xbb ingest` 只吐了一句 Bun 堆栈，没有任何「接下来怎么办」，
 * 用户只能自己猜出「先全停再重跑」。
 */
export class SchemaBusyError extends Error {
  constructor(detail: string) {
    super(
      "另一个小本本进程正在写库，结构升级没能拿到写锁。\n" +
        `  底层原因：${detail}\n` +
        "  怎么处理：先执行 `xbb stop` 把所有 xbb 进程停下（含 AI 客户端里的 mcp），再重跑刚才的命令；\n" +
        "            升级完成后再启动 AI 客户端即可。库里的数据不会丢，升级是幂等的。",
    );
    this.name = "SchemaBusyError";
  }
}

export function schemaVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

const isBusy = (e: unknown): boolean =>
  /SQLITE_BUSY|database is locked/i.test(e instanceof Error ? e.message : String(e));

/** 同步退避睡眠：迁移路径是同步的，只能用同步等待；Atomics.wait 不烧 CPU。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 建库/升级入口。**全部 DDL 必须在一个事务里**。
 *
 * 为什么包事务：下面每一步都是几十条 `db.exec`，不包事务时每条 DDL 都是一个独立隐式事务、
 * 各自 fsync。实测新建库要 310 ms，其中九成耗在提交次数上；包成一个事务后只剩一次提交。
 *
 * ⚠️ 为什么必须是 `BEGIN IMMEDIATE`，**不能**是 `BEGIN`（2026-11-11 实测修正）：
 *
 * 这里原来写的是 deferred，理由是「IMMEDIATE 会在 open 瞬间抢写锁，让并发启动互相等待」。
 * 这个取舍写反了 —— 等待恰恰是我们要的，立刻失败才是灾难：
 *
 *   deferred 事务在第一条 DDL 前已经执行了一堆读（`PRAGMA table_info`、查 FTS 表…），
 *   手里握着一个**读快照**。此时如果 serve / 采集子进程 / 另一个 MCP 提交了一笔写，
 *   快照即过期；再去 `ALTER TABLE` 需要把读事务升级成写事务，SQLite 判定快照已不可用，
 *   **直接返回 SQLITE_BUSY，根本不调用 busy 处理器** —— `PRAGMA busy_timeout = 3000` 完全失效。
 *
 * 三组对照实测（同库同条件）：
 *   · `BEGIN`            + 别人先提交     → 0ms 失败 database is locked（3000ms 超时形同虚设）
 *   · `BEGIN IMMEDIATE`  + 同条件         → 4ms 成功
 *   · `BEGIN IMMEDIATE`  + 对方持锁 1.2s  → 861ms 等到锁后成功
 *
 * 代价实测：118MB 真库完整跑一遍是 58ms。也就是说「并发启动多等 58ms」换掉「升级时随机失败」，
 * 这个方向不存在争议。再不济还有下面这层重试兜底。
 *
 * 回滚失败不再抛：SQLite 在部分错误下会自动回滚，此时 ROLLBACK 会报「no transaction is active」，
 * 盖掉真正的错误原因。原错误必须原样抛出（由外层判断是否属于可重试的忙）。
 */
export function initSchemaV2(db: Database): void {
  const before = schemaVersion(db);
  for (let attempt = 1; ; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        initSchema(db);
        migrateV2(db);
        migrateV4(db);
        migrateV5(db);
        migrateV6(db);
        migrateV7(db);
        migrateV8(db);
        migrateV9(db);
        migrateV10(db);
        db.exec("COMMIT");
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* 已自动回滚 */
        }
        throw e;
      }
      break; // 成功
    } catch (e) {
      if (!isBusy(e)) throw e;
      // 写锁被占满整个 busy_timeout：退避后再来。整段迁移是幂等的，重跑安全。
      if (attempt >= BUSY_ATTEMPTS) {
        throw new SchemaBusyError(e instanceof Error ? e.message : String(e));
      }
      sleepSync(200 * attempt);
    }
  }

  // 结构真的变了才说话 —— 而且走 stderr：MCP 模式下 stdout 是 JSON-RPC 帧流，
  // 往里写一个字符就能让宿主解析失败。这条日志每个进程开库时都可能打印。
  const after = schemaVersion(db);
  if (after > before) console.error(`[xbb] 库结构已升级 v${before} → v${after}`);
}
