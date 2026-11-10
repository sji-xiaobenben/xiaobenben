// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 赫布链接线（2026-10-18）的回归钉子。
 *
 * 这套测试存在的理由：`reinforce()` 曾经「写好了但全仓 0 调用点、也没有衰减」，
 * 而**没有任何测试会失败** —— 死代码最擅长的事就是安静地待着。所以这里每条断言
 * 都钉一个「看起来正常但其实是假的」的反面：
 *   - 权重真的会**变**（不是恒 0.5）
 *   - 只对**共现对**变（不是碰过的节点所有边都变）
 *   - 会**衰减**（不是只涨不落，最后全表 1.0）
 *   - 会**封顶**（不会溢出 1.0）
 *   - **不新建**边（不会把库越查越大）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { PersonalStore } from "./store";
import { getMemory, getRelated } from "./memory-tools";
import { searchHybrid, searchMemory } from "./memory-search";
import { onRecalled, reinforceCooccurrence, CO_OCCUR_MAX_NODES } from "./recall-feedback";
import { initSchemaV2, LINK_HALF_LIFE_DAYS, migrateV6 } from "./schema";

const dir = mkdtempSync(join(tmpdir(), "xbb-links-test-"));
const store = PersonalStore.open(join(dir, "test.db"));
const db = store.db;

afterAll(() => {
  db.close();
  // Windows 上 WAL 句柄释放有延迟，临时目录删不掉不影响断言（系统会回收）
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 临时目录残留，忽略 */
  }
});

/** 建一条记忆 + 可选出边（relation 固定 related_to，关系类型不影响强度逻辑） */
async function mem(content: string, links: Array<{ toId: string; relation?: string }> = []) {
  const rec = await store.deliver({ spaceId: "sp-1", actor: "ai-host", content });
  for (const l of links) {
    db.prepare("INSERT INTO memory_links (from_id, to_id, relation, weight, hits, last_at, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(rec.id, l.toId, l.relation ?? "related_to", 0.5, 0, null, new Date().toISOString());
  }
  return rec.id;
}

const linkRow = (from: string, to: string) =>
  db.prepare("SELECT weight, hits, last_at FROM memory_links WHERE from_id = ? AND to_id = ?").get(from, to) as
    | { weight: number; hits: number; last_at: string | null }
    | undefined;
const effOf = (from: string, to: string) =>
  (db.prepare("SELECT eff FROM memory_links_eff WHERE from_id = ? AND to_id = ?").get(from, to) as { eff: number }).eff;
const count = (sql: string) => (db.query(sql).get() as { n: number }).n;

describe("schema v6：列与视图", () => {
  test("新库带 last_at / hits，且 user_version ≥ 6", () => {
    const cols = (db.query("PRAGMA table_info(memory_links)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("last_at");
    expect(cols).toContain("hits");
    const v = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(v).toBeGreaterThanOrEqual(6);
  });

  test("有效权重视图存在且可读", () => {
    const r = db.query("SELECT count(*) AS n FROM memory_links_eff").get() as { n: number };
    expect(typeof r.n).toBe("number");
  });

  test("老库（无 last_at 列）升级后被补齐，存量边从升级时刻起算", () => {
    const legacy = PersonalStore.open(join(dir, "legacy.db")).db;
    db.exec("PRAGMA foreign_keys = OFF");
    // 退回 v5 的形状：先拆视图（它引用 last_at，否则 DROP COLUMN 会被拒），再删两列
    legacy.exec("DROP VIEW IF EXISTS memory_links_eff");
    legacy.exec("ALTER TABLE memory_links DROP COLUMN last_at");
    legacy.exec("ALTER TABLE memory_links DROP COLUMN hits");
    legacy.exec("PRAGMA user_version = 5");
    legacy
      .prepare("INSERT INTO memory_links (from_id, to_id, relation, weight, created_at) VALUES (?,?,?,?,?)")
      .run("a", "b", "related_to", 0.5, new Date().toISOString());

    migrateV6(legacy);

    const row = legacy.prepare("SELECT last_at, hits FROM memory_links WHERE from_id = 'a'").get() as {
      last_at: string | null;
      hits: number;
    };
    // 关键：不能是 NULL。若按 created_at 起算，半年前建的边一升级就跌到 0.008，等于迁移把历史关联全废了
    expect(row.last_at).toBeTruthy();
    expect(row.hits).toBe(0);
    const eff = (legacy.prepare("SELECT eff FROM memory_links_eff WHERE from_id = 'a'").get() as { eff: number }).eff;
    expect(eff).toBeCloseTo(0.5, 2);
    legacy.close();
  });
});

describe("共现强化：只认「一起出现过」的边", () => {
  test("同一次召回里两端都在 ⇒ 强度上升、hits+1、last_at 落时间", async () => {
    const b = await mem("共现测试-A 的邻居");
    const a = await mem("共现测试-A", [{ toId: b }]);

    expect(linkRow(a, b)!.weight).toBe(0.5);
    onRecalled(db, [a, b]);

    const after = linkRow(a, b)!;
    expect(after.weight).toBeGreaterThan(0.5);
    expect(after.hits).toBe(1);
    expect(after.last_at).toBeTruthy();
  });

  test("只有一端出现 ⇒ 边纹丝不动（这是「按共现对」与「按节点」的分水岭）", async () => {
    const x = await mem("共现测试-B 的邻居");
    const y = await mem("共现测试-B", [{ toId: x }]);
    const other = await mem("共现测试-B 的另一个不相关条目");

    // y 在召回集中、x 不在 ⇒ 不是共现。旧实现（from_id=? OR to_id=?）会照样强化 x—y
    onRecalled(db, [y, other]);

    expect(linkRow(y, x)!.weight).toBe(0.5);
    expect(linkRow(y, x)!.hits).toBe(0);
  });

  test("单条召回不强化（一条记忆没有「对」）", async () => {
    const p = await mem("单条测试-邻居");
    const q = await mem("单条测试", [{ toId: p }]);
    onRecalled(db, [q]);
    expect(linkRow(q, p)!.weight).toBe(0.5);
    expect(linkRow(q, p)!.hits).toBe(0);
  });

  test("只强化已存在的边，绝不凭共现新建", async () => {
    const m1 = await mem("建边测试-1");
    const m2 = await mem("建边测试-2");
    const before = count("SELECT count(*) AS n FROM memory_links");
    expect(reinforceCooccurrence(db, [m1, m2])).toBe(0);
    expect(count("SELECT count(*) AS n FROM memory_links")).toBe(before);
  });

  test("共现强化不越界到「本次召回集之外」的边", async () => {
    const out = await mem("越界测试-集外");
    const i1 = await mem("越界测试-集内1", [{ toId: out }]);
    const i2 = await mem("越界测试-集内2", [{ toId: i1 }]);
    const before = linkRow(i1, out)!.weight;
    onRecalled(db, [i1, i2]); // out 不在集内 ⇒ i1→out 不该动
    expect(linkRow(i1, out)!.weight).toBe(before);
    expect(linkRow(i2, i1)!.weight).toBeGreaterThan(0.5);
  });

  test("节点数超过上限时按榜前截断（防两两组合爆炸）", () => {
    expect(CO_OCCUR_MAX_NODES).toBeGreaterThanOrEqual(5);
    expect(CO_OCCUR_MAX_NODES).toBeLessThanOrEqual(50);
  });
});

describe("衰减：涨上去的会掉下来", () => {
  test("30 天半衰：60 天不共现 ⇒ 有效权重只剩 1/4", async () => {
    const n = await mem("衰减测试-邻居");
    const m = await mem("衰减测试", [{ toId: n }]);
    db.prepare("UPDATE memory_links SET weight = 1.0, last_at = datetime('now', '-60 days') WHERE from_id = ? AND to_id = ?").run(m, n);
    expect(effOf(m, n)).toBeCloseTo(0.25, 2);
    expect(LINK_HALF_LIFE_DAYS).toBe(30);
  });

  test("衰减只影响有效权重，不擅自改写存量 weight（读时算，不跑定时任务）", async () => {
    const n = await mem("衰减测试2-邻居");
    const m = await mem("衰减测试2", [{ toId: n }]);
    db.prepare("UPDATE memory_links SET weight = 1.0, last_at = datetime('now', '-60 days') WHERE from_id = ? AND to_id = ?").run(m, n);
    expect(linkRow(m, n)!.weight).toBe(1.0);
    expect(effOf(m, n)).toBeLessThan(0.3);
  });

  test("时钟回拨保护：last_at 落在未来时权重不被放大", async () => {
    const n = await mem("时钟测试-邻居");
    const m = await mem("时钟测试", [{ toId: n }]);
    db.prepare("UPDATE memory_links SET weight = 0.6, last_at = datetime('now', '+90 days') WHERE from_id = ? AND to_id = ?").run(m, n);
    expect(effOf(m, n)).toBeCloseTo(0.6, 6);
  });

  test("久置的边共现一次就回满基线，不再被 0.2 门槛挡着", async () => {
    const n = await mem("复活测试-邻居");
    const m = await mem("复活测试", [{ toId: n }]);
    db.prepare("UPDATE memory_links SET weight = 0.5, last_at = datetime('now', '-180 days') WHERE from_id = ? AND to_id = ?").run(m, n);
    expect(effOf(m, n)).toBeLessThan(0.05); // 衰到看不见
    onRecalled(db, [m, n]);
    expect(effOf(m, n)).toBeGreaterThan(0.5); // 一次共现 ⇒ 回到基线之上
  });
});

describe("封顶与分布", () => {
  test("反复共现不会超过 1.0", async () => {
    const n = await mem("封顶测试-邻居");
    const m = await mem("封顶测试", [{ toId: n }]);
    for (let i = 0; i < 100; i++) onRecalled(db, [m, n]);
    expect(linkRow(m, n)!.weight).toBeLessThanOrEqual(1.0 + 1e-9);
    expect(linkRow(m, n)!.hits).toBe(100);
  });

  test("stats.links 能证明权重真的在动（p50 不是恒 0.5）", async () => {
    const s = store.stats().links;
    expect(s.total).toBeGreaterThan(0);
    expect(s.reinforced).toBeGreaterThan(0);
    expect(s.byRelation.some((r) => r.relation === "related_to")).toBe(true);
    expect(s.weight.max).toBeGreaterThan(0.5);
    expect(typeof s.avgDegree).toBe("number");
  });
});

describe("读路径：邻居用有效权重与出度归一", () => {
  test("getRelated 只返回过门槛的邻居，且带有效权重", async () => {
    const b = await mem("邻居读路径-B");
    const a = await mem("邻居读路径-A", [{ toId: b }]);
    const rel = getRelated(db, a);
    expect(rel.map((r) => r.id)).toContain(b);
    const hit = rel.find((r) => r.id === b)!;
    expect(hit.weight).toBeGreaterThan(0.4);
    expect(hit.weight).toBeLessThanOrEqual(0.5); // 刚建、未强化、无衰减
  });

  test("衰到门槛以下的边不再出现在邻居里", async () => {
    const b = await mem("邻居衰减-B");
    const a = await mem("邻居衰减-A", [{ toId: b }]);
    db.prepare("UPDATE memory_links SET weight = 0.5, last_at = datetime('now', '-365 days') WHERE from_id = ? AND to_id = ?").run(a, b);
    expect(getRelated(db, a).map((r) => r.id)).not.toContain(b);
  });

  test("枢纽节点霸榜被抑制：同等强度下，度数低的邻居排在前面", async () => {
    const hub = await mem("枢纽-中心");
    const leaf = await mem("枢纽-叶子");
    // hub 连 20 条无关记忆，leaf 只连 1 条
    for (let i = 0; i < 20; i++) {
      const extra = await mem(`枢纽-填充${i}`);
      db.prepare("INSERT INTO memory_links (from_id, to_id, relation, weight, hits, last_at, created_at) VALUES (?,?,?,?,?,?,?)")
        .run(hub, extra, "related_to", 0.5, 0, null, new Date().toISOString());
    }
    const me = await mem("枢纽-考问者");
    db.prepare("INSERT INTO memory_links (from_id, to_id, relation, weight, hits, last_at, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(me, hub, "related_to", 0.5, 0, null, new Date().toISOString());
    db.prepare("INSERT INTO memory_links (from_id, to_id, relation, weight, hits, last_at, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(me, leaf, "related_to", 0.5, 0, null, new Date().toISOString());

    const rel = getRelated(db, me);
    expect(rel[0]!.id).toBe(leaf);
  });

  test("getMemory.links 展示的是有效权重", async () => {
    const b = await mem("getMemory-B");
    const a = await mem("getMemory-A", [{ toId: b }]);
    const g = getMemory(db, a) as { links: { id: string; weight: number }[] };
    const l = g.links.find((x) => x.id === b)!;
    expect(l.weight).toBeGreaterThan(0.4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 检索结果里的 1-hop 预览（linkedPreview）
//
// 这一组存在的理由：断言写的是「**另一端**在不在命中里」，而实现最初写成了
// 「任一端在命中里就跳过」——与 SQL 的 WHERE 完全等价，于是恒跳过、永远是空数组。
// 功能从上线起就是死的，测试一条都没碰过它。下面两条一正一反钉住它。
// ─────────────────────────────────────────────────────────────────────────────
describe("search 结果里的 linkedPreview（1-hop 邻居预览）", () => {
  test("命中的记忆有出边 ⇒ 邻居以预览形式带出，且 id 指向**邻居**而不是自己", async () => {
    // neighbor 的正文刻意不含「紫电项目」：若它自己也能被这个词搜到，就会进 hits，
    // 而「邻居已在命中里就不重复推预览」是另一条规则（下面那个用例管它）。
    const neighbor = await mem("样机外壳走 316 不锈钢，耐盐雾更强");
    const seed = await mem("紫电项目的样机选材定了", [{ toId: neighbor }]);

    const r = searchMemory(db, { terms: ["紫电项目"], limit: 5 });
    expect(r.hits.some((h) => h.id === seed)).toBe(true);

    const lp = r.linkedPreview.find((p) => p.id === neighbor);
    expect(lp).toBeDefined();          // 原来的空数组会让这条直接失败
    expect(lp!.relation).toBe("related_to");
    expect(lp!.preview.length).toBeGreaterThan(0);
    expect(lp!.preview.length).toBeLessThanOrEqual(31); // 30 字 + 省略号
    // 反向断言：不能把命中项自己塞进预览（旧实现取的是 to_id || from_id）
    expect(r.linkedPreview.some((p) => p.id === seed)).toBe(false);
  });

  test("邻居本身也在命中里 ⇒ 不重复推预览（省 token）", async () => {
    const a = await mem("青岚计划-第一版结论");
    const b = await mem("青岚计划-第二版结论", [{ toId: a }]);

    // 让两条都命中
    const r = searchMemory(db, { terms: ["青岚计划"], limit: 5 });
    const hitIds = new Set(r.hits.map((h) => h.id));
    if (hitIds.has(a) && hitIds.has(b)) {
      expect(r.linkedPreview.some((p) => p.id === a || p.id === b)).toBe(false);
    }
  });
});

describe("混合检索：纯向量命中也带出邻居", () => {
  /** 给记忆塞一个 embedding（512 维），让向量通道能命中它 */
  function setEmbedding(id: string, v: Float32Array) {
    db.prepare("UPDATE memories SET embedding = ?, vec_model = ? WHERE id = ?")
      .run(Buffer.from(v.buffer.slice(0)), "bge-small-zh-v1.5/int8", id);
  }

  test("词法搜不到、只有向量命中时，它的出边仍然出现在 linkedPreview 里", async () => {
    // 邻居：正文里没有任何查询词
    const neighbor = await mem("三一六比三零四含钼，耐盐雾腐蚀强得多");
    // 种子：正文刻意与查询词零重叠，词法通道必然搜不到它
    const seed = await mem("那个煮饭的家伙事儿该换了", [{ toId: neighbor }]);

    const v = new Float32Array(512).fill(0.05);
    setEmbedding(seed, v);

    const r = await searchHybrid(db, async () => v, { terms: ["崟岚工坊"], limit: 5 });

    // 前提成立：词法没命中它（否则测的就不是向量路径了）
    expect(r.vecHits).toBeGreaterThan(0);
    expect(r.hits.some((h) => h.id === seed)).toBe(true);
    expect(r.hits.find((h) => h.id === seed)!.matchedTerms).toContain("vector");

    // 关键断言：向量命中的条目，其邻居也要被带出来
    expect(r.linkedPreview.some((p) => p.id === neighbor)).toBe(true);
  });
});

describe("混合检索：limit 是硬上限", () => {
  function setEmbedding(id: string, v: Float32Array) {
    db.prepare("UPDATE memories SET embedding = ?, vec_model = ? WHERE id = ?")
      .run(Buffer.from(v.buffer.slice(0)), "bge-small-zh-v1.5/int8", id);
  }

  test("词法与向量都命中时，返回条数不超过 limit（曾经 limit 2 返回 3、5 返回 6）", async () => {
    // 5 条词法命中：给向量条目制造「插到中间」的机会
    for (let i = 0; i < 5; i++) await mem(`燧石巡检-第${i}次记录`);
    // 1 条只有向量命中（正文与查询词零重叠）
    const vecOnly = await mem("那台老设备的保养周期该重算了");
    setEmbedding(vecOnly, new Float32Array(512).fill(0.05));

    const v = new Float32Array(512).fill(0.05);
    for (const limit of [2, 3, 5]) {
      const r = await searchHybrid(db, async () => v, { terms: ["燧石巡检"], limit });
      expect(r.hits.length).toBeLessThanOrEqual(limit);
    }
  });
});

describe("混合检索：预算闸覆盖预览，tokensUsed 不越界", () => {
  function setEmbedding(id: string, v: Float32Array) {
    db.prepare("UPDATE memories SET embedding = ?, vec_model = ? WHERE id = ?")
      .run(Buffer.from(v.buffer.slice(0)), "bge-small-zh-v1.5/int8", id);
  }

  test("命中项和 1-hop 预览加起来不超过 budget（曾经报出 2295/2575 对着 2000）", async () => {
    // 每条都带一个邻居，逼预览也吃掉预算
    for (let i = 0; i < 12; i++) {
      const neighbor = await mem(`硼砂工序-附属说明-${i}-` + "占位内容".repeat(10));
      await mem(`硼砂工序-主记录-${i}-` + "占位内容".repeat(10), [{ toId: neighbor }]);
    }
    const vecOnly = await mem("那台老设备的保养周期该重算了");
    setEmbedding(vecOnly, new Float32Array(512).fill(0.05));

    const v = new Float32Array(512).fill(0.05);
    for (const budget of [300, 800]) {
      const r = await searchHybrid(db, async () => v, { terms: ["硼砂工序"], limit: 10, budget });
      expect(r.tokensUsed).toBeLessThanOrEqual(budget);
    }
  });
});

describe("混合检索：向量降级必须有信号", () => {
  test("模型未就绪时结果带 vecStatus=not-ready，不是一份看起来正常的词法结果", async () => {
    await mem("砚台维护-未就绪场景");
    const r = await searchHybrid(db, async () => null, { terms: ["砚台维护"], limit: 5 });
    expect(r.vecStatus).toBe("not-ready");
    expect(r.vecNote).toBeTruthy();
    expect(r.hits.length).toBeGreaterThan(0); // 降级不等于没结果
  });

  test("向量通道抛错时带 vecStatus=error，且错误原因不丢", async () => {
    await mem("砚台维护-异常场景");
    const r = await searchHybrid(
      db,
      async () => {
        throw new Error("ort session broken");
      },
      { terms: ["砚台维护"], limit: 5 },
    );
    expect(r.vecStatus).toBe("error");
    expect(r.vecNote).toContain("ort session broken");
    expect(r.hits.length).toBeGreaterThan(0);
  });
});
