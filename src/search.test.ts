// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 检索管线的回归钉子（2026-11-11 首建）。
 *
 * 为什么现在才有这个文件：`memory-search.ts` 之前**一条专属测试都没有**，而它是每次
 * 对话每一轮都要跑的那条路。没有测试的后果已经兑现过两次 ——
 *   - `linkedPreview` 因为一行与 WHERE 等价的判断，从上线起永远是空数组；
 *   - 传时间范围时 107 条无 occurred_at 的记忆被静默丢弃，五分之一的结果集凭空消失。
 * 两次都"看起来完全正常"，两次都没人发现。
 *
 * 所以这里每条断言都钉一个「读代码时觉得没问题、跑起来才知道是假的」的反面：
 *   1. 时间窗**回落 created_at**（不是「没有事件时间就丢」）
 *   2. 时间窗真的**会排除**范围外的记忆（回落不等于放行一切）
 *   3. 时间边界**包含整天**（日期上界不吃掉当天）
 *   4. 复合词三路全空时**拆 2-gram 兜底**能捞回来
 *   5. 兜底**自报家门**（lexNote + `~` 前缀），不冒充正常命中
 *   6. 正路命中时**不启用**兜底（不掺噪音）
 *   7. 纯 ASCII 长词**不拆**（拆出来全是噪音）
 *   8. **向量路**也过同一道时间闸（只对一半结果生效的过滤更欺骗）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { PersonalStore } from "./store";
import { invalidateVecCache, searchHybrid, searchMemory } from "./memory-search";

const dir = mkdtempSync(join(tmpdir(), "xbb-search-test-"));
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

/**
 * 建一条记忆。
 *
 * 倒排（memory_terms）是手工灌的，因为写入侧的真实形态正是这样：**只落 AI 显式传入的
 * terms/tags/entities，从不从 content 自动切词**（见 memory-write.ts 第 270 行一带）。
 * 这一点是 n-gram 回退成立的前提，也是下面那组测试能忠实复刻线上故障的原因。
 */
async function mem(
  content: string,
  opts: { terms?: string[]; occurredAt?: string } = {},
): Promise<string> {
  const rec = await store.deliver({ spaceId: "sp-1", actor: "ai-host", content });
  for (const t of opts.terms ?? []) {
    db.prepare("INSERT OR IGNORE INTO memory_terms (term, memory_id, source) VALUES (?,?,?)").run(t, rec.id, "expand");
  }
  if (opts.occurredAt) {
    db.prepare("UPDATE memories SET occurred_at = ? WHERE id = ?").run(opts.occurredAt, rec.id);
  }
  return rec.id;
}

const ids = (r: { hits: Array<{ id: string }> }) => r.hits.map((h) => h.id);
const Y = new Date().getFullYear();

// ─────────────────────────────────────────────────────────────────────────────
// 1. 时间窗过滤
//
// 线上形态：occurred_at 覆盖 469/576 = 81.4%，缺的 107 条以 fact / procedure /
// decision 为主。旧代码 `if (from && (!m.occurred_at || …)) continue` 把「没有事件
// 时间」当成「不在窗口里」，于是**传了时间范围反而比不传搜到的更少**。
// ─────────────────────────────────────────────────────────────────────────────
describe("时间窗：无 occurred_at 的记忆回落 created_at，不再整条丢弃", () => {
  test("窗口覆盖 created_at ⇒ 无事件时间的那条必须出现", async () => {
    const dated = await mem("相位校准的结果是 37.5 度", { terms: ["相位校准"], occurredAt: `${Y}-03-15 10:00:00` });
    const undated = await mem("相位校准还得再复测一轮才能定", { terms: ["相位校准"] });

    // 前提：不带窗口时两条都在（证明检索本身能命中，失败只可能来自时间闸）
    expect(ids(searchMemory(db, { terms: ["相位校准"], limit: 10 }))).toEqual(
      expect.arrayContaining([dated, undated]),
    );

    // created_at = 现在 ⇒ 窗口取今年，两条都该在。
    // 旧代码在这里必挂：undated 没有 occurred_at，被第一个条件直接 continue 掉。
    const r = searchMemory(db, { terms: ["相位校准"], occurredFrom: `${Y}-01-01`, occurredTo: `${Y}-12-31`, limit: 10 });
    expect(ids(r)).toContain(undated);
    expect(ids(r)).toContain(dated);
  });

  test("事件时间真的在窗口外 ⇒ 仍然被排除（回落不等于放行一切）", async () => {
    const old = await mem("古早的一次纬度标定", { terms: ["纬度标定"], occurredAt: "2019-05-04 08:00:00" });
    const recent = await mem("上周又做了一次纬度标定", { terms: ["纬度标定"], occurredAt: `${Y}-03-20 08:00:00` });

    const r = searchMemory(db, { terms: ["纬度标定"], occurredFrom: `${Y}-03-01`, occurredTo: `${Y}-03-31`, limit: 10 });
    expect(ids(r)).toContain(recent);
    expect(ids(r)).not.toContain(old);
  });

  test("日期上界包含当天整天（occurred_at 带时刻也不能被吃掉）", async () => {
    const late = await mem("截止日当天傍晚的一次性核对", { terms: ["截止日核对"], occurredAt: `${Y}-06-30 23:30:00` });
    const r = searchMemory(db, { terms: ["截止日核对"], occurredTo: `${Y}-06-30`, limit: 10 });
    expect(ids(r)).toContain(late);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 长词降级（中文 2-gram 回退）
//
// 线上形态：写入侧 terms 71% 是 2-4 字短词，查询侧给的是「发版流水线」这种复合词。
// 倒排是 `term = ?` 精确等值 ⇒ 一条都对不上；FTS trigram 要求连续三字滑窗全中 ⇒
// 同样落空 ⇒ 词法三路全空 ⇒ 向量路（无相似度下限）接管整份结果且不给任何信号。
// 576 条库 100% 复现，与库大小无关。
// ─────────────────────────────────────────────────────────────────────────────
describe("长词降级：复合词三路全空时拆 2-gram 兜底", () => {
  test("写入是短词、查询是复合词 ⇒ 能捞回来，且自报 lexNote", async () => {
    const target = await mem("发版走 cnb 流水线的自动触发", { terms: ["发版", "流水线", "自动化"] });
    const noise = await mem("字幕系统的限流阈值调到了 200", { terms: ["字幕", "限流", "阈值"] });

    // 复合词：正文里没有"发版流水线"这五个连续字，倒排里也没有这个整词 ⇒ 主路必然全空
    const r = searchMemory(db, { terms: ["发版流水线", "怎么配置"], limit: 5 });
    expect(ids(r)).toContain(target);      // 「发版」这个 gram 把它捞出来了
    expect(ids(r)).not.toContain(noise);   // 零共享二字片段的不能被带进来
    expect(r.lexNote).toBeTruthy();        // 兜底必须自报家门，不能冒充正常命中
    // matchedTerms 的 `~` 前缀让 AI 一眼看出这是拆词命中
    expect(r.hits.find((h) => h.id === target)!.matchedTerms.some((t) => t.startsWith("~"))).toBe(true);
  });

  test("正路命中时不启用兜底（不掺噪音、不出 lexNote）", async () => {
    const r = searchMemory(db, { terms: ["发版"], limit: 5 });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.lexNote).toBeUndefined();
    expect(r.hits.every((h) => h.matchedTerms.every((t) => !t.startsWith("~")))).toBe(true);
  });

  test("纯 ASCII 长词不拆 2-gram（拆出来只会是噪音）", async () => {
    // 库里只躺了 "do"/"oc" 这种英文碎片；若实现对 ASCII 也拆 gram，下面这条就会被捞出来
    await mem("一条与查询毫无关系的话", { terms: ["do", "oc"] });
    const r = searchMemory(db, { terms: ["dockerclusterxyz"], limit: 5 });
    expect(r.hits.length).toBe(0);
    expect(r.lexNote).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. IDF 归一化
//
// 旧实现 `2.0 * log(1 + total/df)` 没有上界，随库规模单调增长，而实体分写死 3.0。
// 于是「一个词 vs 一个实体」的兑换率会随库长大而漂移 —— 同一个查询，今天和半年后
// 排序不一样，且没有任何一处会报错。
//
// 这一组的做法：在**两个规模相差 100 倍的独立库**里，跑同一个查询，比较
// 「只靠词命中」与「只靠实体命中」两条记忆的分数**比值**。比值必须恒定。
// ─────────────────────────────────────────────────────────────────────────────
describe("IDF 归一化：分数不随库规模漂移", () => {
  /**
   * 在独立库里造一对记忆并返回两者的分数：
   *   byTerm —— 正文含查询词（走 FTS），但没有倒排词、没有实体
   *   byEnt  —— 正文不含任何查询词，只挂两个查询词同名实体
   * 两条互不干扰，分数分别代表「纯词信号」与「纯实体信号」。
   */
  async function measure(noise: number): Promise<{ term: number; ent: number }> {
    const d = mkdtempSync(join(tmpdir(), "xbb-idf-"));
    const s = PersonalStore.open(join(d, "t.db"));
    const ldb = s.db;
    try {
      for (let i = 0; i < noise; i++) {
        await s.deliver({ spaceId: "sp-1", actor: "x", content: `噪音记录 ${i}，与本次查询完全无关` });
      }
      const byTerm = await s.deliver({ spaceId: "sp-1", actor: "x", content: "长河渡口的船闸在检修" });
      const byEnt = await s.deliver({ spaceId: "sp-1", actor: "x", content: "那座水闸年久失修该换了" });
      // 实体名必须与 terms 精确相等才会命中（路径 C 是 `e.name IN (terms)`）
      ldb.prepare("INSERT OR IGNORE INTO entities (name) VALUES (?)").run("长河渡口");
      const e1 = (ldb.query("SELECT id FROM entities WHERE name = ?").get("长河渡口") as { id: number }).id;
      ldb.prepare("INSERT OR IGNORE INTO memory_entity (memory_id, entity_id) VALUES (?,?)").run(byEnt.id, e1);
      ldb.prepare("INSERT OR IGNORE INTO entities (name) VALUES (?)").run("青岚水闸");
      const e2 = (ldb.query("SELECT id FROM entities WHERE name = ?").get("青岚水闸") as { id: number }).id;
      ldb.prepare("INSERT OR IGNORE INTO memory_entity (memory_id, entity_id) VALUES (?,?)").run(byEnt.id, e2);

      const r = searchMemory(ldb, { terms: ["长河渡口", "青岚水闸"], limit: 10 });
      const t = r.hits.find((h) => h.id === byTerm.id)!.score;
      const e = r.hits.find((h) => h.id === byEnt.id)!.score;
      return { term: t, ent: e };
    } finally {
      ldb.close();
      try { rmSync(d, { recursive: true, force: true }); } catch { /* 临时目录残留 */ }
    }
  }

  test("库量级差 100 倍，词信号与实体信号的分数比值必须不变", async () => {
    const small = await measure(0);    // total = 2
    const large = await measure(200);  // total = 202

    // 分数本身确实是正常量级（不是归一化过头全变 0）
    expect(small.term).toBeGreaterThan(0.5);
    expect(large.term).toBeGreaterThan(0.5);

    // 核心断言：比值恒定。
    // 旧实现这里会塌：total=2 时 term≈2.20 / ent=3.0 = 0.73；
    // total=202 时 term≈10.63 / ent=3.0 = 3.54 —— 差 4.8 倍，排序直接翻转。
    expect((large.term / large.ent) / (small.term / small.ent)).toBeCloseTo(1, 2);
  });

  test("常见实体自动降权：挂 20 条的实体不能和孤例实体同分", async () => {
    const d = mkdtempSync(join(tmpdir(), "xbb-idf2-"));
    const s = PersonalStore.open(join(d, "t.db"));
    const ldb = s.db;
    try {
      const common: string[] = [];
      for (let i = 0; i < 20; i++) {
        common.push((await s.deliver({ spaceId: "sp-1", actor: "x", content: `周报第 ${i} 期` })).id);
      }
      const rare = await s.deliver({ spaceId: "sp-1", actor: "x", content: "关于丙烷脱氢的那次讨论" });
      const mk = (id: string, name: string) => {
        ldb.prepare("INSERT OR IGNORE INTO entities (name) VALUES (?)").run(name);
        const eid = (ldb.query("SELECT id FROM entities WHERE name = ?").get(name) as { id: number }).id;
        ldb.prepare("INSERT OR IGNORE INTO memory_entity (memory_id, entity_id) VALUES (?,?)").run(id, eid);
      };
      mk(rare.id, "孤例锚点");
      for (const id of common) mk(id, "周报");

      // limit 放到 25：要能同时拿到两类，否则截断本身就会伪装成「排序正确」
      const r = searchMemory(ldb, { terms: ["孤例锚点", "周报"], limit: 25 });
      const rareScore = r.hits.find((h) => h.id === rare.id)!.score;
      const commonScore = r.hits.find((h) => h.id === common[0]!)!.score;

      // 稀有实体（df=1）→ 2.0；常见实体（df=20）→ 2.0*log(1+21/20)/log(22) ≈ 0.46。
      // 旧实现两条都是死板的 `+= 3.0`，两者相等 ⇒ 这条断言必挂。
      // 之所以比「谁排第一」而不是「分数」：并列时的先后取决于 SQL 返回顺序，
      // 拿它当判据会变成一条偶尔碰巧通过的假测试。
      expect(rareScore).toBeGreaterThan(commonScore * 2);
    } finally {
      ldb.close();
      try { rmSync(d, { recursive: true, force: true }); } catch { /* 临时目录残留 */ }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. 混合检索的时间闸
//
// 词法路在组装 hits 时逐条判时间，向量路却把 top-100 无条件塞进 RRF —— 于是
// 「传了时间范围」在混合检索下形同虚设：范围外的语义邻居照样排进来，还可能因为
// 向量名次靠前把范围内的词法命中挤下去。只对一半结果生效的过滤比不过滤更欺骗。
// ─────────────────────────────────────────────────────────────────────────────
describe("混合检索：向量路走同一道时间闸", () => {
  const setEmbedding = (id: string, v: Float32Array) =>
    db.prepare("UPDATE memories SET embedding = ?, vec_model = ? WHERE id = ?")
      .run(Buffer.from(v.buffer.slice(0)), "bge-small-zh-v1.5/int8", id);

  test("语义命中的范围外记忆不得混进结果", async () => {
    const v = new Float32Array(512);
    v[0] = 1;
    const inWin = await mem("硼酸结晶温度定在 42 度", { terms: ["硼酸结晶"], occurredAt: `${Y}-03-10 09:00:00` });
    const outWin = await mem("硼酸结晶的老方案是 55 度", { terms: ["硼酸结晶"], occurredAt: `${Y - 2}-03-10 09:00:00` });
    setEmbedding(inWin, v);
    setEmbedding(outWin, v);
    invalidateVecCache(); // 本连接改已有行的向量不会动 data_version，必须显式失效

    const r = await searchHybrid(db, async () => v, {
      terms: ["硼酸结晶"], occurredFrom: `${Y}-03-01`, occurredTo: `${Y}-03-31`, limit: 10,
    });
    // 前提：向量通道确实跑了（否则测的是纯词法，测不出这个 bug）
    expect(r.vecHits).toBeGreaterThan(0);
    expect(ids(r)).toContain(inWin);
    expect(ids(r)).not.toContain(outWin); // 旧代码：向量路无闸，这条必挂
  });
});
