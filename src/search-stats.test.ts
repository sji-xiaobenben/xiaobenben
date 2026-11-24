// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 检索观测（`search_stats`）的回归钉子。
 *
 * 这套表存在的理由不是「做个报表」，是**归因**：这个检索模块曾经两次静默失效
 * （`linkedPreview` 永远空、107 条被时间闸吞掉），两次都不报错，事后无从复盘。
 *
 * 所以这里每条断言都钉一个「看起来正常但其实是假的」的反面：
 *   - 四路命中数**分开**记（不是总分一个数 —— 总分正常而某一路恒 0 是最典型的故障）
 *   - n-gram 回退**不**混进倒排的计数（这两路正是「正常命中」与「硬凑」的分界）
 *   - 降级状态真的落库（不是一律记 ok）
 *   - 表**会封顶**（不是无界增长到比记忆还大）
 *   - 观测**失败不影响检索**（观测把检索搞挂比没有观测更糟）
 *   - 时间窗比较不能在同一天内把边界外的算进来（`'T'` > 空格，这个坑原话层踩过）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { PersonalStore } from "./store";
import { invalidateVecCache, searchHybrid, searchMemory, type SearchStats } from "./memory-search";
import { readSearchHealth, recordSearchStats } from "./search-stats";
import { SCHEMA_TARGET_VERSION } from "./schema";

const dir = mkdtempSync(join(tmpdir(), "xbb-search-stats-"));
const store = PersonalStore.open(join(dir, "test.db"));
const db = store.db;

afterAll(() => {
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上 WAL 句柄释放有延迟，临时目录残留不影响断言 */
  }
});

const count = (sql = "SELECT count(*) AS n FROM search_stats") => (db.query(sql).get() as { n: number }).n;

/** 构造一份统计，缺省字段由调用方覆盖 */
function st(over: Partial<SearchStats>): SearchStats {
  return {
    termsN: 1,
    ftsN: 0,
    invN: 0,
    entN: 0,
    ngN: 0,
    candN: 0,
    hitN: 0,
    tokens: 100,
    msLex: 1,
    msAll: 1,
    srcTop: "",
    hasWindow: false,
    budget: 2000,
    ...over,
  };
}

describe("schema v12：表结构", () => {
  test("search_stats 存在，且库版本已到目标值", () => {
    const cols = (db.query("PRAGMA table_info(search_stats)").all() as { name: string }[]).map((c) => c.name);
    for (const c of ["at", "fts_n", "inv_n", "ent_n", "ng_n", "vec_status", "vec_n", "ms_all", "src_top"]) {
      expect(cols).toContain(c);
    }
    const v = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    // 硬编码 12 而不是比常量：常量本身写错时，跟着它的断言会一起错，等于没测
    expect(v).toBe(12);
    expect(SCHEMA_TARGET_VERSION).toBeGreaterThanOrEqual(12);
  });

  test("**不**写进 events 哈希链 —— 检索是读操作，不该产生凭证", () => {
    const before = count("SELECT count(*) AS n FROM events");
    recordSearchStats(db, st({ hitN: 3 }));
    const after = count("SELECT count(*) AS n FROM events");
    expect(after).toBe(before);
    expect(count()).toBe(1);
  });
});

describe("四路命中数分开记", () => {
  const m1 = "硼酸结晶的工艺参数是 3 小时";
  const m2 = "硼酸的采购渠道在华南";
  let id1 = "";
  let id3 = "";

  // 建数据放在第一个用到它的 describe 里，避免和上面的空表断言抢顺序
  /**
   * `memory_terms` 是**着陆垫**（AI 写入时给的扩展词），不是内容分词 ——
   * 所以「倒排能命中」这句话只在写入方登记过该词时成立。这里手工登记，
   * 精确控制每一条落在哪个通道上；真实写入路径由 memory-write 负责填这张表。
   */
  const land = (term: string, id: string) =>
    db.prepare("INSERT OR IGNORE INTO memory_terms (term, memory_id, source) VALUES (?,?,?)").run(term, id, "expand");

  test("准备语料", async () => {
    id1 = (await store.deliver({ spaceId: "sp-1", actor: "ai-host", content: m1 })).id;
    const id2 = (await store.deliver({ spaceId: "sp-1", actor: "ai-host", content: m2 })).id;
    // 长词与短词都登记，两条记忆都登记短词
    land("硼酸结晶", id1);
    land("硼酸", id1);
    land("硼酸", id2);
    // 第三条：内容里**不含**实体名，只靠 memory_entity 挂上 —— 用来隔离实体通道
    id3 = (await store.deliver({ spaceId: "sp-1", actor: "ai-host", content: "一份与词面无关的记录" })).id;
    // entities 只有 (id, name, aliases)；entity_id 是 INTEGER，不能塞字符串 id
    const ins = db.prepare("INSERT OR IGNORE INTO entities (name, aliases) VALUES (?,?)").run("青岚", null);
    const eid = Number(ins.lastInsertRowid);
    db.prepare("INSERT OR IGNORE INTO memory_entity (memory_id, entity_id) VALUES (?,?)").run(id3, eid);
  });

  test("长词：FTS 与倒排各自记账", () => {
    const r = searchMemory(db, { terms: ["硼酸结晶"], limit: 5 });
    const s = r.stats!;
    expect(s.ftsN).toBe(1); // 「硼酸结晶」→ trigram 命中 m1
    expect(s.invN).toBe(1); // 整词在倒排里也是精确等值 → 同一批
    expect(s.entN).toBe(0);
    expect(s.ngN).toBe(0); // 有命中就不该走拆词兜底
    expect(s.hitN).toBe(r.hits.length);
  });

  test("短词：FTS 跳过，只剩倒排", () => {
    const s = searchMemory(db, { terms: ["硼酸"], limit: 5 }).stats!;
    expect(s.ftsN).toBe(0); // 2 字不足 trigram 下限
    expect(s.invN).toBe(2); // 着陆垫登记了两条
    expect(s.entN).toBe(0);
  });

  test("实体：词面完全不匹配也能命中，且只记在实体通道", () => {
    const s = searchMemory(db, { terms: ["青岚"], limit: 5 }).stats!;
    expect(s.ftsN).toBe(0);
    expect(s.invN).toBe(0);
    expect(s.entN).toBe(1);
    expect(s.hitN).toBe(1);
  });

  test("拆词回退单独记账，不冒充倒排命中", () => {
    // 这个短语在库里的任何一条记忆里都不原样存在 ⇒ A/B/C 全空 ⇒ 走 2-gram 回退
    const s = searchMemory(db, { terms: ["硼酸结晶工艺"], limit: 5 }).stats!;
    expect(s.ftsN).toBe(0);
    expect(s.invN).toBe(0); // 关键：回退的命中**不算**进倒排
    expect(s.ngN).toBe(2); // 拆出「硼酸」后命中那两条
  });
});

describe("混合检索：向量侧的状态与来源", () => {
  test("向量未就绪 → not-ready 落库，不是 ok", async () => {
    const r = await searchHybrid(db, async () => null, { terms: ["硼酸"], limit: 3 });
    expect(r.vecStatus).toBe("not-ready");
    // 检索本身不写库（它是纯读函数），落库由调用方做 —— 生产里是 mcp.ts
    recordSearchStats(db, r.stats!);
    const row = db.query("SELECT vec_status, vec_n FROM search_stats ORDER BY id DESC LIMIT 1").get() as {
      vec_status: string | null; vec_n: number | null;
    };
    expect(row.vec_status).toBe("not-ready");
    expect(row.vec_n).toBeNull();
  });

  test("stats 带出来了但没被记进 events，且词法耗时不为负数", async () => {
    const r = await searchHybrid(db, async () => null, { terms: ["硼酸"], limit: 3 });
    const s = r.stats!;
    expect(s.msAll).toBeGreaterThanOrEqual(0);
    expect(s.msLex).toBeGreaterThanOrEqual(0);
    expect(s.srcTop).toBe("L".repeat(r.hits.length));
  });

  test("纯向量命中在 srcTop 里记成 V", async () => {
    /**
     * 手工造一条只在向量空间相近的记忆：词面完全不同、但向量相同。
     * 走真实 `searchHybrid`，让 RRF 与来源标注按生产路径跑。
     */
    const v = new Float32Array(8);
    v[0] = 1;
    const id = (await store.deliver({ spaceId: "sp-1", actor: "ai-host", content: "完全无关的另一句话" })).id;
    // vec_model 必须对上，否则 vecTopK 的 WHERE 会把它过滤掉
    db.prepare("UPDATE memories SET embedding = ?, vec_model = ? WHERE id = ?").run(
      new Uint8Array(v.buffer), "bge-small-zh-v1.5/int8", id,
    );
    // 本连接自己 UPDATE 不改 data_version、也不改 MAX(rowid) ⇒ 缓存不会自己失效。
    // 生产里由 memory-write 写完向量后显式调；测试同样得调，否则读到的还是空缓存。
    invalidateVecCache();
    // 词群故意选一个它不含的词：词法捞不到它，只能靠向量进来
    const r = await searchHybrid(db, async () => v, { terms: ["硼酸"], limit: 10 });
    recordSearchStats(db, r.stats!);
    expect(r.vecStatus).toBe("ok");
    expect(r.stats!.vecN).toBeGreaterThan(0);
    expect(r.stats!.srcTop).toContain("V");
  });
});

describe("封顶：表会长，但不会无界地长", () => {
  test("超过上限后裁掉最旧的一批，最近的留着", () => {
    // 直接灌 5100 条：MAX_ROWS=5000 / KEEP_ROWS=4000 / TRIM_EVERY=64
    for (let i = 0; i < 5100; i++) recordSearchStats(db, st({ hitN: i % 3 }));
    const n = count();
    expect(n).toBeLessThanOrEqual(5100);
    expect(n).toBeGreaterThanOrEqual(4000);
    // 最早那批必须被删掉了 —— 否则「封顶」是假的
    const minId = (db.query("SELECT min(id) AS v FROM search_stats").get() as { v: number }).v;
    expect(minId).toBeGreaterThan(1000);
  });
});

describe("观测失败不能影响检索", () => {
  test("表不存在时 recordSearchStats 静默不抛", () => {
    db.exec("DROP TABLE search_stats");
    expect(() => recordSearchStats(db, st({ hitN: 1 }))).not.toThrow();
    // 读也跟着返回 null，而不是把 stats 命令整段搞崩
    expect(readSearchHealth(db)).toBeNull();
  });
});

describe("摘要口径", () => {
  test("分位、通道率、向量占比、降级计数", () => {
    db.exec("DROP TABLE IF EXISTS search_stats");
    db.exec(`CREATE TABLE search_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, terms_n INTEGER NOT NULL,
      fts_n INTEGER NOT NULL, inv_n INTEGER NOT NULL, ent_n INTEGER NOT NULL, ng_n INTEGER NOT NULL,
      cand_n INTEGER NOT NULL, hit_n INTEGER NOT NULL, vec_status TEXT, vec_n INTEGER,
      tokens INTEGER NOT NULL, ms_lex REAL NOT NULL, ms_all REAL NOT NULL, src_top TEXT NOT NULL,
      has_win INTEGER NOT NULL, budget INTEGER NOT NULL)`);

    recordSearchStats(db, st({ ftsN: 1, hitN: 2, msAll: 10, vecStatus: "ok", vecN: 2, srcTop: "LV" }));
    recordSearchStats(db, st({ invN: 3, hitN: 1, msAll: 20, vecStatus: "ok", vecN: 1, srcTop: "L" }));
    recordSearchStats(db, st({ entN: 2, hitN: 0, msAll: 30, vecStatus: "empty-index", vecN: 0, srcTop: "" }));
    recordSearchStats(db, st({ ftsN: 1, invN: 1, ngN: 1, hitN: 3, msAll: 40, vecStatus: "not-ready", srcTop: "" }));

    const h = readSearchHealth(db, 7)!;
    expect(h.n).toBe(4);
    expect(h.p50ms).toBe(30); // [10,20,30,40] 的第 floor(0.5*4)=2 位
    expect(h.p90ms).toBe(40);
    expect(h.chanRate).toEqual({ fts: 0.5, inv: 0.5, ent: 0.25, ng: 0.25 });
    expect(h.degraded).toBe(1); // 只有 not-ready 算故障
    expect(h.noVec).toBe(1); // empty-index 是"没索引"，不是"故障"
    expect(h.vecShare).toBeCloseTo(1 / 3, 5); // (LV + L) → 3 个字符里只有 1 个 V
    expect(h.emptyRate).toBe(0.25);
  });

  test("窗口外的不算进来", () => {
    const old = new Date(Date.now() - 30 * 86400_000).toISOString();
    db.query("INSERT INTO search_stats (at,terms_n,fts_n,inv_n,ent_n,ng_n,cand_n,hit_n,vec_status,vec_n,tokens,ms_lex,ms_all,src_top,has_win,budget) VALUES (?,0,0,0,0,0,0,0,NULL,NULL,0,0,0,'',0,2000)").run(old);
    const h = readSearchHealth(db, 7)!;
    expect(h.n).toBe(4); // 仍然只有刚才那 4 条
  });
});
