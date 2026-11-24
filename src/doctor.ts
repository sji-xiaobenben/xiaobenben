// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 数据卫生体检（`xbb doctor`）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么需要它：脏数据不报错，只是让你搜不到
 * ─────────────────────────────────────────────────────────────────────────
 * 一条记忆在库里活得好不好，和"人能不能读懂"是两件事。检索吃的是**零件**：
 * 正文喂全文、词项喂倒排、实体喂实体通道、向量喂语义通道。任何一个零件缺了，
 * 对应的通道就对这条记忆**彻底失明** —— 而 SQLite 不会抛任何错，用户只会觉得
 * "它记了，但我找不到"。
 *
 * 这些零件是写入时由 AI 顺带给的（`write_memory` 的 terms/entities/type），
 * 少给一个也不违约束。历史上还有几条写入路径漏同步过词项。所以**必须有人事后去数**。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 三条自我约束
 * ─────────────────────────────────────────────────────────────────────────
 * 1. **报告与修复分离**。`runDoctor` 是纯 SELECT，只读连接就能跑；
 *    只有显式 `--fix` 才写库。体检本身永远不改变任何东西。
 * 2. **只修"有源可循"的**。词项能从 tags / 实体表**原样搬过来**，这是重建索引；
 *    类型和实体名**不能在正文里猜** —— 猜错比空着更糟：空着只是筛不到，
 *    猜错会让用户按类型查到错的东西。所以 `fixable` 与 `missing` 是两段，不混。
 * 3. **分母必须是检索看得见的那批**。`ALIVE` 与 `memory-search.ts` 的存活过滤
 *    逐字一致（`deleted_at IS NULL AND status != 'forgotten'`）。分母要是宽了，
 *    覆盖率就是自欺欺人 —— 那些检索根本不会返回的墓碑会一直挂在"缺"里。
 *
 * 修复一律幂等（`INSERT OR IGNORE` / `NOT EXISTS` 删除），重跑不会叠加，
 * 也不会碰正文、类型、实体名这些**语义内容**。
 */
import type { Database } from "bun:sqlite";

/**
 * 存活口径 —— 与 `memory-search.ts` 的 IDF 分母逐字一致。
 * 改这里必须同步改那里，否则覆盖率与检索实际可见范围会分叉。
 */
const ALIVE = "m.deleted_at IS NULL AND m.status != 'forgotten'";

/** 一条记忆在检索眼里的"零件"齐全程度 */
export interface Coverage {
  /** 拥有该零件的条数 */
  have: number;
  /** 分母（存活条数） */
  total: number;
}

export interface DoctorReport {
  /** 存活条数（检索看得见的） */
  alive: number;
  /** 表内总条数（含墓碑） */
  all: number;
  /**
   * 三条覆盖率。**全文不在这里** —— 理由见 `integrity.ftsSynced`：
   * FTS 由触发器自动维护，要么全在要么不一致，不存在"少了 3 条"这种可数的中间态。
   */
  channels: {
    /** 倒排（memory_terms 着陆垫） */
    inv: Coverage;
    /** 实体（memory_entity） */
    ent: Coverage;
    /** 语义（embedding） */
    vec: Coverage;
  };
  integrity: {
    /** 是否真的校验过全文索引（只读连接上跑不了 `integrity-check`） */
    ftsChecked: boolean;
    /** 全文索引与内容表一致 */
    ftsSynced: boolean;
    /** 词项指向已不存在的记忆 */
    orphanTerms: number;
    /** 实体挂边指向已不存在的记忆 */
    orphanEntities: number;
    /** 链接任一端已不存在 */
    orphanLinks: number;
    /** superseded_by 指向不存在的 id */
    danglingHead: number;
    /** superseded_by 成环的环数 */
    cycles: number;
    /** 存活条里内容哈希重复的组数 */
    dupHash: number;
  };
  /** 有源可循、`--fix` 能补齐的（纯索引重建，不动语义） */
  fixable: {
    /**
     * tags 里有这个词、倒排里却没有。
     *
     * ⚠️ **不能按 `source='tag'` 判**。`memory_terms` 的主键是 `(term, memory_id)`，
     * `source` 只是"这个词当初从哪来"的标注。同一条记忆的同一个词只会有一行 ——
     * 先由 expand 写进去，后来 tags 里也有它，那行就永远标着 `expand`。
     * 按 source 判会把这批全部报成"缺失"（实测 38 条），而它们**在倒排里好好的**，
     * 于是 `--fix` 一条也插不进去（主键冲突，`INSERT OR IGNORE` 静默跳过）——
     * 报告与修复对不上，用户看到的是一句假警报。
     * 所以口径是：**这个 term 在这条记忆的词项集合里到底有没有**。
     */
    tagTerms: number;
    /** 同上，来源换成实体名 */
    entityTerms: number;
    /** entities 列写了名字但 memory_entity 没有行 */
    entityRows: number;
    /** 词项是空白串（污染倒排） */
    blankTerms: number;
  };
  /** 无法从现有数据推出来、只能报告（绝不猜） */
  missing: {
    /** type 为空或不在已知枚举 */
    type: number;
    /** 实体列空且无挂边 —— 实体通道对它失明 */
    entities: number;
    /** occurred_at 为空（时间闸会回落到 created_at） */
    occurredAt: number;
  };
  /** 实体名忽略大小写后重复的组数（同名被拆成多个实体，召回被切两半） */
  caseDupEntities: number;
}

export interface RepairPlan {
  tagTerms: number;
  entityTerms: number;
  entityRows: number;
  blankTerms: number;
  orphans: number;
  /** 是否重建了 FTS 索引 */
  ftsRebuilt: boolean;
}

/** 记忆 type 的合法取值 —— 与 `MemoryItem.type` 的联合类型同源 */
const TYPES = ["fact", "preference", "decision", "event", "procedure"];

function hasTable(db: Database, name: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
}

function count(db: Database, sql: string, ...params: unknown[]): number {
  const r = db.query(sql).get(...(params as never[])) as { c: number } | null;
  return r?.c ?? 0;
}

/** 数（id, 下一跳）成环的环数。迭代 + 三色标记：每条边最多走两次，不递归不爆栈。 */
function countChainCycles(db: Database): number {
  const rows = db.query(
    "SELECT id, superseded_by FROM memories WHERE superseded_by IS NOT NULL AND deleted_at IS NULL",
  ).all() as Array<{ id: string; superseded_by: string }>;
  const next = new Map<string, string>();
  for (const r of rows) next.set(r.id, r.superseded_by);

  const done = new Set<string>();
  let cycles = 0;
  for (const start of next.keys()) {
    if (done.has(start)) continue;
    // onPath 只属于本次遍历：出环就清，避免把"上次走过的路"误判成环
    const onPath = new Set<string>();
    let cur: string | undefined = start;
    while (cur !== undefined && !done.has(cur)) {
      if (onPath.has(cur)) {
        cycles++;
        break;
      }
      onPath.add(cur);
      cur = next.get(cur);
    }
    for (const id of onPath) done.add(id);
  }
  return cycles;
}

/**
 * 全文索引一致性 —— **不能用 `COUNT(*) FROM memories_fts` 判**。
 *
 * `memories_fts` 是 external content 表（`content='memories'`）。它的 SELECT 从**内容表**
 * 取列值，所以 `COUNT(*)` 与 `WHERE rowid=?` 都永远等于 `memories` 的行数 ——
 * 哪怕索引项已经被删得干干净净（实测：删掉索引行后 `COUNT(*)` 不变，而 `MATCH` 查不到）。
 * 拿它当判据就是一个永远返回"正常"的检查。`fts5vocab` 也不行：`DISTINCT doc` 的
 * 优化器行为不可靠（实测缺行）。
 *
 * 唯一可信的是 FTS5 官方的一致性命令：`integrity-check` 带参数 1 时，会逐行比对
 * 索引与内容表。**注意它失败时抛的是 `database disk image is malformed`** ——
 * 这句误导性的话会撞上开库判定闸的损坏正则（`malformed`），让用户以为整库要抢救。
 * 所以必须在这里就地接住、单独归类，绝不让它冒到那套"别删库"的话术里。
 *
 * 代价：全表比对，605 条约 36ms；十万条量级是秒级。这是用户手动跑的体检，值得。
 * 只读连接上跑不了（`INSERT` 会被拒），此时返回 `checked:false` —— **不谎报"一致"**。
 */
function checkFts(db: Database): { checked: boolean; synced: boolean } {
  if (!hasTable(db, "memories_fts")) return { checked: false, synced: true };
  try {
    db.exec("INSERT INTO memories_fts(memories_fts, rank) VALUES('integrity-check', 1)");
    return { checked: true, synced: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 写不进去 = 这次没验成，而不是"验出问题"
    if (/read\s*only|readonly/i.test(msg)) return { checked: false, synced: true };
    return { checked: true, synced: false };
  }
}

/**
 * 体检。**除了 FTS 一致性校验之外全是 SELECT**：传只读连接进来也能跑
 * （`stats` 就是这么用的，此时 `ftsChecked` 为 false）。
 * 老库缺表时对应项按 0 处理 —— 缺表是版本问题，不是数据卫生问题。
 */
export function runDoctor(db: Database): DoctorReport {
  const alive = count(db, `SELECT COUNT(*) AS c FROM memories m WHERE ${ALIVE}`);
  const all = count(db, "SELECT COUNT(*) AS c FROM memories");

  const hasTerms = hasTable(db, "memory_terms");
  const hasEnt = hasTable(db, "memory_entity");
  const hasLinks = hasTable(db, "memory_links");

  // 通道覆盖：逐条 EXISTS。走的是各自的索引（`idx_mterms_mem` / 主键），
  // 几万条也是几十毫秒；这里是一次性体检，不是热路径，宁可精确不要估。
  const noTerms = hasTerms
    ? count(db, `SELECT COUNT(*) AS c FROM memories m WHERE ${ALIVE} AND NOT EXISTS (SELECT 1 FROM memory_terms t WHERE t.memory_id = m.id)`)
    : alive;
  const noEnt = hasEnt
    ? count(db, `SELECT COUNT(*) AS c FROM memories m WHERE ${ALIVE} AND NOT EXISTS (SELECT 1 FROM memory_entity e WHERE e.memory_id = m.id)`)
    : alive;
  const noVec = count(db, `SELECT COUNT(*) AS c FROM memories m WHERE ${ALIVE} AND m.embedding IS NULL`);

  const fts = checkFts(db);

  const orphanTerms = hasTerms
    ? count(db, "SELECT COUNT(*) AS c FROM memory_terms t WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = t.memory_id)")
    : 0;
  const orphanEntities = hasEnt
    ? count(db, "SELECT COUNT(*) AS c FROM memory_entity e WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = e.memory_id)")
    : 0;
  const orphanLinks = hasLinks
    ? count(
        db,
        `SELECT COUNT(*) AS c FROM memory_links l
          WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = l.from_id)
             OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = l.to_id)`,
      )
    : 0;

  const danglingHead = count(
    db,
    `SELECT COUNT(*) AS c FROM memories m
      WHERE m.superseded_by IS NOT NULL
        AND m.superseded_by != ''
        AND NOT EXISTS (SELECT 1 FROM memories x WHERE x.id = m.superseded_by)`,
  );

  const dupHash = count(
    db,
    `SELECT COUNT(*) AS c FROM (
        SELECT m.content_hash AS h FROM memories m
         WHERE ${ALIVE} AND m.content_hash IS NOT NULL AND m.content_hash != ''
         GROUP BY m.content_hash HAVING COUNT(*) > 1
      )`,
  );

  // 「来源里有、倒排里没有」的词 —— 统计与修复共用同一个扫描（见 scanSourceGaps 的注释）
  const gaps = scanSourceGaps(db);
  const entityRows = gaps.missingEdge.length;
  const blankTerms = hasTerms ? count(db, "SELECT COUNT(*) AS c FROM memory_terms WHERE trim(term) = ''") : 0;

  const missingType = count(
    db,
    `SELECT COUNT(*) AS c FROM memories m
      WHERE ${ALIVE} AND (m.type IS NULL OR m.type = '' OR m.type NOT IN (${TYPES.map(() => "?").join(",")}))`,
    ...TYPES,
  );
  const missingEntities = noEnt; // 实体通道失明 = 挂边表里没有它
  const missingOccurred = count(
    db,
    `SELECT COUNT(*) AS c FROM memories m WHERE ${ALIVE} AND (m.occurred_at IS NULL OR m.occurred_at = '')`,
  );

  const caseDupEntities = count(
    db,
    "SELECT COUNT(*) AS c FROM (SELECT lower(trim(name)) AS n FROM entities GROUP BY n HAVING COUNT(*) > 1)",
  );

  return {
    alive,
    all,
    channels: {
      inv: { have: alive - noTerms, total: alive },
      ent: { have: alive - noEnt, total: alive },
      vec: { have: alive - noVec, total: alive },
    },
    integrity: {
      ftsChecked: fts.checked,
      ftsSynced: fts.synced,
      orphanTerms,
      orphanEntities,
      orphanLinks,
      danglingHead,
      cycles: countChainCycles(db),
      dupHash,
    },
    fixable: { tagTerms: gaps.tagPairs.length, entityTerms: gaps.entityPairs.length, entityRows, blankTerms },
    missing: { type: missingType, entities: missingEntities, occurredAt: missingOccurred },
    caseDupEntities,
  };
}

/** 结构性问题（不是"缺零件"，是"索引和主表对不上"）—— 非 0 就该修 */
export function integrityProblems(r: DoctorReport): number {
  const i = r.integrity;
  return (
    i.orphanTerms +
    i.orphanEntities +
    i.orphanLinks +
    (i.ftsChecked && !i.ftsSynced ? 1 : 0) +
    i.danglingHead +
    i.cycles +
    i.dupHash
  );
}

/** `--fix` 有没有活可干 */
export function hasFixableWork(r: DoctorReport): boolean {
  const f = r.fixable;
  return f.tagTerms + f.entityTerms + f.entityRows + f.blankTerms > 0 || integrityProblems(r) > 0;
}

/**
 * 找出「来源里有、倒排里没有」的词。
 *
 * ── 为什么必须和 `repairDb` 共用这一个函数 ──
 * 第一版把统计写成 `NOT EXISTS (... t.source = 'tag')`，报出 38 条"标签词项缺失"，
 * 而 `--fix` 一条都插不进去（主键 `(term, memory_id)` 冲突被 `INSERT OR IGNORE` 静默吞掉）。
 * 那些词其实早就在倒排里了，只是 `source` 标着 `expand` —— 报告是假警报，修复是空转。
 * 两套判定只要有一点不一致，用户看到的就是「工具说有问题，修了还是有问题」。
 * 所以：**同一份 pairs，统计数长度，修复拿它插。**
 *
 * 判据本身也简单：这个词在这条记忆的词项集合里到底有没有。不看 source。
 */
interface SourceGaps {
  tagPairs: Array<{ term: string; id: string }>;
  entityPairs: Array<{ term: string; id: string }>;
  /**
   * `entities` 列能解析出名字、但挂边表里一条都没有的记忆。
   * 用 JS 解析而不是 SQL 判 `entities NOT IN ('[]','')`：坏 JSON（`{不是数组`）
   * 在 SQL 里看着"有值"，实际一个名字都解析不出来 —— 那样报告会说"能补"，
   * 修复却什么也没做。
   */
  missingEdge: Array<{ id: string; names: string[] }>;
}

function scanSourceGaps(db: Database): SourceGaps {
  const gaps: SourceGaps = { tagPairs: [], entityPairs: [], missingEdge: [] };
  if (!hasTable(db, "memory_terms")) return gaps;

  const termsOf = db.prepare("SELECT term FROM memory_terms WHERE memory_id = ?");
  const cache = new Map<string, Set<string>>();
  const termsIn = (id: string) => {
    let s = cache.get(id);
    if (!s) {
      s = new Set((termsOf.all(id) as Array<{ term: string }>).map((x) => x.term));
      cache.set(id, s);
    }
    return s;
  };

  const tagRows = db.query(
    `SELECT m.id AS id, m.tags AS tags FROM memories m
      WHERE ${ALIVE} AND m.tags IS NOT NULL AND m.tags NOT IN ('[]', '')`,
  ).all() as Array<{ id: string; tags: string }>;
  for (const r of tagRows) {
    const names = parseNameList(r.tags);
    if (!names.length) continue;
    const have = termsIn(r.id);
    for (const term of names) if (!have.has(term)) gaps.tagPairs.push({ term, id: r.id });
  }

  // 实体名只算真正挂上边的那些：`entities` 表里的孤立名字跟任何一条记忆都没关系
  if (hasTable(db, "memory_entity") && hasTable(db, "entities")) {
    const entRows = db.query(
      `SELECT m.id AS id, e.name AS name FROM memories m
        JOIN memory_entity me ON me.memory_id = m.id
        JOIN entities e ON e.id = me.entity_id
        WHERE ${ALIVE}`,
    ).all() as Array<{ id: string; name: string }>;
    for (const r of entRows) {
      const term = r.name.trim();
      if (!term) continue;
      if (!termsIn(r.id).has(term)) gaps.entityPairs.push({ term, id: r.id });
    }

    // 有名字却没挂边：写入时漏建（或历史数据只有 JSON 列）
    const edgeRows = db.query(
      `SELECT m.id AS id, m.entities AS entities FROM memories m
        WHERE ${ALIVE} AND m.entities IS NOT NULL AND m.entities NOT IN ('[]', '')
          AND NOT EXISTS (SELECT 1 FROM memory_entity e WHERE e.memory_id = m.id)`,
    ).all() as Array<{ id: string; entities: string }>;
    for (const r of edgeRows) {
      const names = parseNameList(r.entities);
      if (names.length) gaps.missingEdge.push({ id: r.id, names });
    }
  }

  return gaps;
}

function parseNameList(raw: string | null): string[] {  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    // 只认字符串数组。写成 `{"0":…}` 的对象、数字、null 一律当空 ——
    // 修复工具**绝不能**因为读不懂一个字段就编出实体来。
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
  } catch {
    return [];
  }
}

/**
 * 修复。**只做索引重建与孤儿清理，绝不改正文/类型/实体名。**
 *
 * 不进 events 哈希链：链是"谁在什么时候写了什么"的凭证层，而这里补的是
 * 从既有字段**原样搬过来的索引行**（tags → 词项、entities → 挂边），语义没有增减。
 * 把维护动作混进链里会让 `verifyChain` 的语义变浑，也会让"我写过什么"的审计变吵。
 *
 * 全程一个事务：中途失败不留半套索引（半套比不修更难查 —— 覆盖率会变得忽高忽低）。
 */
export function repairDb(db: Database, report: DoctorReport): RepairPlan {
  const plan: RepairPlan = {
    tagTerms: 0,
    entityTerms: 0,
    entityRows: 0,
    blankTerms: 0,
    orphans: 0,
    ftsRebuilt: false,
  };

  const tx = db.transaction(() => {
    // 1. 空白词项：它们会进倒排表但永远匹配不上任何输入，纯污染
    plan.blankTerms = db.prepare("DELETE FROM memory_terms WHERE trim(term) = ''").run().changes;

    // 2. 孤儿索引行：指向已不存在的记忆。零信息，删掉不损失任何东西。
    plan.orphans =
      db.prepare("DELETE FROM memory_terms WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_terms.memory_id)").run()
        .changes +
      db.prepare(
        "DELETE FROM memory_entity WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_entity.memory_id)",
      ).run().changes +
      db.prepare(
        `DELETE FROM memory_links
          WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_links.from_id)
             OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_links.to_id)`,
      ).run().changes;

    // 3. entities 列 → 挂边表（实体名以写入时记下的原文为准，不做大小写归一 —— 归一要合并实体，
    //    那是语义决策，不是重建）。**必须先做这一步**：下一段扫"实体名有没有进倒排"要靠它。
    const insTerm = db.prepare("INSERT OR IGNORE INTO memory_terms (term, memory_id, source) VALUES (?, ?, ?)");
    const insEntity = db.prepare("INSERT OR IGNORE INTO entities (name) VALUES (?)");
    const getEntity = db.prepare("SELECT id FROM entities WHERE name = ?");
    const insME = db.prepare("INSERT OR IGNORE INTO memory_entity (memory_id, entity_id) VALUES (?, ?)");
    for (const r of scanSourceGaps(db).missingEdge) {
      plan.entityRows++;
      for (const name of r.names) {
        insEntity.run(name);
        const eid = (getEntity.get(name) as { id: number } | null)?.id;
        if (eid != null) insME.run(r.id, eid);
      }
    }

    // 4. 来源 → 倒排。**用与 runDoctor 完全相同的扫描**，所以计划里的数字与报告里的数字必然对得上。
    //    只插真正缺的 term（主键是 `(term, memory_id)`，`INSERT OR IGNORE` 会静默吞掉重复，
    //    那样 `changes` 恒为 0，看起来像"什么都没干"）。
    const gaps = scanSourceGaps(db);
    for (const p of gaps.tagPairs) plan.tagTerms += insTerm.run(p.term, p.id, "tag").changes;
    for (const p of gaps.entityPairs) plan.entityTerms += insTerm.run(p.term, p.id, "entity").changes;

    // 5. FTS 索引重建：external content 表的官方重建入口，完全确定性。
    //    只有**验出不一致**才做 —— 重建整表在十万条库上是秒级，不该白跑；
    //    `ftsChecked=false`（只读连接没验成）也不做：没有证据就不动手。
    if (report.integrity.ftsChecked && !report.integrity.ftsSynced) {
      db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
      plan.ftsRebuilt = true;
    }
  });

  tx();
  return plan;
}
