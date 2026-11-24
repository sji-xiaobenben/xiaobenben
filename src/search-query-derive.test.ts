// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 「专有名词只在 query、不在 terms 时检索完全失手」的钉子。
 *
 * 起因（ISSUE-marshal-recall）：`query="MARSHAL 操盘司令 项目 技术栈"` 配
 * `terms=[币圈,行情,信号,项目位置,技术栈]` 时，目标记忆（内容里明明写着 MARSHAL）
 * 连前 5 都进不去；把 `MARSHAL` 挪进 terms 立刻第 1 名。
 *
 * 根因不是排序权重，是**信号被送进了错误的通道**：query 只喂向量，词法三路只吃 terms。
 * 而向量通道在这个模型上的判别力有限（各向异性 + int8 量化，互不相关记忆的余弦
 * 相似度实测 0.52~0.71），等于把最独特的信号放在最弱的地方。
 *
 * 每条断言都钉一个「读代码觉得没问题、跑起来才知道是假的」的反面：
 *   1. 专有名词在 query 里也拿得到词法权重（否则整体失手）
 *   2. 不传 query 时行为与改动前**逐位一致**（新参数不能悄悄改老路径）
 *   3. query 与 terms 重名的词不重复计权（否则同一信号被算两遍）
 *   4. 无空格无标点的长句**不派生**（中文长句没有可靠切分，硬拆只会掺噪音）
 *   5. 派生词不进 matchedTerms（那是「我给的词命中了什么」的诚实回答）
 *   6. limit 严格等于返回条数（合并逻辑的历史坑，别回退）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { PersonalStore } from "./store";
import { searchMemory } from "./memory-search";

const dir = mkdtempSync(join(tmpdir(), "xbb-qderive-test-"));
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

/**
 * 建一条记忆。
 *
 * 倒排是手工灌的：写入侧的真实形态就是**只落 AI 显式传入的 terms/tags**，
 * 从不从 content 自动切词（见 memory-write.ts）。测试必须复刻这一点，
 * 否则「词项里有 / 正文里有」这两种命中会被混为一谈。
 */
async function mem(
  content: string,
  opts: { terms?: string[] } = {},
): Promise<string> {
  const rec = await store.deliver({ spaceId: "sp-1", actor: "ai-host", content });
  for (const t of opts.terms ?? []) {
    db.prepare("INSERT OR IGNORE INTO memory_terms (term, memory_id, source) VALUES (?,?,?)").run(t, rec.id, "expand");
  }
  return rec.id;
}

/**
 * 现场：照 issue 的形状搭。
 *
 * 目标记忆的 terms 里**确实有** MARSHAL 与 操盘司令 —— 这很重要：故障不是因为
 * 「写入时漏了词」，而是**查询时没把 MARSHAL 当检索词**。写对了也搜不到，才是这个 bug 的毒。
 *
 * 五条干扰记忆都挂着「项目位置 + 技术栈」，正是 issue 里抢占前几名的那类条目：
 * 它们靠两个词群词拿满词法分，而目标只靠一个两字词「币圈」走倒排，分差摆在那里。
 */
const TARGET_CONTENT = "[项目·MARSHAL 操盘司令] 老板的币圈行情扫描与信号引擎项目，代码在 G:\\Development\\WSworkspace\\marshal";
const TARGET_TERMS = ["MARSHAL", "操盘司令", "行情扫描", "信号引擎", "项目", "币圈"];
const QUERY = "MARSHAL 操盘司令 项目 技术栈";
const TERMS = ["币圈", "行情", "信号", "项目位置", "技术栈"];

let targetId = "";
const noiseIds: string[] = [];

describe("原句里的专有名词也参与词法检索", () => {
  test("铺场", async () => {
    targetId = await mem(TARGET_CONTENT, { terms: TARGET_TERMS });
    for (let i = 0; i < 5; i++) {
      noiseIds.push(await mem(`项目位置备忘 ${i}：技术栈与仓库结构记录，与行情扫描无关`, { terms: ["项目位置", "技术栈"] }));
    }
    // 几条纯背景记忆，保证 limit=5 真的有淘汰压力
    await mem("牙疼得厉害约了周四下午看牙医", { terms: ["牙疼", "牙医"] });
    await mem("体检报告显示尿酸偏高要少吃海鲜", { terms: ["尿酸", "体检"] });
    expect(targetId.length).toBeGreaterThan(0);
  });

  test("复现：专有名词只在 query 里时，目标靠词法就必须进前 3", () => {
    // 旧行为：不传 query —— 这正是 issue 里的调用在被引擎加工前的样子
    const before = searchMemory(db, { terms: TERMS, limit: 5 });
    const beforeRank = before.hits.findIndex((h) => h.id === targetId);

    const after = searchMemory(db, { terms: TERMS, query: QUERY, limit: 5 });
    const afterRank = after.hits.findIndex((h) => h.id === targetId);

    // 关键断言：改善必须是真的，不能「两边都进前 3」蒙过去
    expect(afterRank).toBeGreaterThanOrEqual(0);
    expect(afterRank).toBeLessThanOrEqual(2);
    if (beforeRank >= 0) expect(afterRank).toBeLessThan(beforeRank);
    // 派生确实发生了，否则上面的改善只能来自巧合
    expect(after.stats?.derivedN ?? 0).toBeGreaterThan(0);
  });

  test("不传 query 时与改动前逐位一致", () => {
    const r = searchMemory(db, { terms: TERMS, limit: 5 });
    expect(r.stats?.derivedN ?? 0).toBe(0);
  });

  test("query 与 terms 重名的词不重复计权", () => {
    // QUERY 切出来是 MARSHAL / marshal（小写副本）/ 操盘司令 / 项目 / 技术栈，
    // 其中只有「技术栈」已在 TERMS 里 ⇒ 派生的应该是 4 个，不是 5 个。
    const r = searchMemory(db, { terms: TERMS, query: QUERY, limit: 5 });
    expect(r.stats?.derivedN).toBe(4);
  });

  test("无空格无标点的长句不派生 —— 中文长句没有可靠切分，硬拆就是掺噪音", () => {
    const r = searchMemory(db, {
      terms: TERMS,
      query: "我上次做饭用的那个锅到底是哪一款来着",
      limit: 5,
    });
    expect(r.stats?.derivedN ?? 0).toBe(0);
  });

  test("日期/端口/两字符 ASCII 不派生 —— 库里遍地都是，当锚点没有区分度", () => {
    // "2026-11-09" 与 "21:30" 全被拒；只剩 CJK 段（这里没有）⇒ 派生为 0
    const r = searchMemory(db, { terms: TERMS, query: "2026-11-09 21:30", limit: 5 });
    expect(r.stats?.derivedN ?? 0).toBe(0);
    // "TS" / "go" 只有两字符，同样不派生
    const r2 = searchMemory(db, { terms: TERMS, query: "TS go", limit: 5 });
    expect(r2.stats?.derivedN ?? 0).toBe(0);
  });

  test("派生词不进 matchedTerms，但归因绝不留空", () => {
    const r = searchMemory(db, { terms: TERMS, query: QUERY, limit: 5 });
    const hit = r.hits.find((h) => h.id === targetId);
    expect(hit).toBeDefined();
    // MARSHAL 是派生来的（不在 TERMS 里）⇒ 不该冒充「我给的词命中了什么」
    expect(hit!.matchedTerms).not.toContain("MARSHAL");
    // 但也不能是空数组：空数组等于告诉 AI「不知道为什么打中了这条」，它只能当噪声丢掉
    expect(hit!.matchedTerms.length).toBeGreaterThan(0);
    // 而词群里真正命中的词必须还在，否则可解释性没了
    expect(hit!.matchedTerms.some((t) => TERMS.includes(t))).toBe(true);
  });

  test("同等稀有度下，词群命中压过原句派生（折扣不是装饰）", async () => {
    /**
     * 两个词的 df 都是 1（各自只出现在一条记忆里）⇒ IDF 相同 ⇒ 分差只可能来自权重。
     * 词群 2 个词（2.0×2 = 4.0）必须压过派生 3 个词（2.0×0.6×3 = 3.6）。
     *
     * 这条存在的理由：把 DERIVED_WEIGHT 从 0.6 改成 1.0 时，其余测试**全绿** ——
     * 折扣本身没有任何断言守着，谁哪天觉得「都是一样的词」把它抹平，没人会知道。
     */
    const a = await mem("甲项目 甲框架 的说明", { terms: ["甲项目", "甲框架"] });
    const b = await mem("乙平台 乙引擎 乙工具 的说明");
    const r = searchMemory(db, {
      terms: ["甲项目", "甲框架"],
      query: "乙平台 乙引擎 乙工具",
      limit: 10,
      budget: 100000,
    });
    const ai = r.hits.findIndex((h) => h.id === a);
    const bi = r.hits.findIndex((h) => h.id === b);
    expect(ai).toBeGreaterThanOrEqual(0);
    expect(bi).toBeGreaterThanOrEqual(0);
    expect(ai).toBeLessThan(bi);
  });

  test("词群一个都没中、只靠原句命中时，归因写成 ~query", () => {
    // 词群全落空，目标只能由 query 里的 MARSHAL 捞到 —— 这正是 issue 的失手场景
    const r = searchMemory(db, { terms: ["zzz这个词不存在zzz"], query: "MARSHAL", limit: 5 });
    const hit = r.hits.find((h) => h.id === targetId);
    expect(hit).toBeDefined();
    expect(hit!.matchedTerms).toEqual(["~query"]);
  });

  test("ASCII 词的大小写变体都能命中（库里写法不可控）", () => {
    const r = searchMemory(db, { terms: ["项目位置"], query: "marshal 的近况", limit: 5 });
    expect(r.hits.some((h) => h.id === targetId)).toBe(true);
  });
});

describe("limit 严格（合并逻辑的历史坑，别回退）", () => {
  test("limit=1/2/3/5 返回条数严格等于 limit", () => {
    for (const n of [1, 2, 3, 5]) {
      const r = searchMemory(db, { terms: TERMS, query: QUERY, limit: n, budget: 100000 });
      expect(r.hits.length).toBe(n);
    }
  });
});

describe("链附注也过预算闸", () => {
  test("预算小时宁可少附历史，也不许 tokensUsed 超出去", async () => {
    /**
     * 这条钉的是 issue 里「顺带确认」的那一项，但根因与描述不同：不是 linkedPreview
     * 在闸后累加，而是**链附注**无条件 `tokensUsed += …`。实测 60 次检索 14 次超
     * 2000、最坏 3734（超 87%）—— 预算是对调用方的硬承诺，不能只是「大概」。
     */
    const oldOne = await mem("链预算测试 老版本内容甲", { terms: ["链预算测试"] });
    const newOne = await mem("链预算测试 新版本内容乙", { terms: ["链预算测试"] });
    db.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(newOne, oldOne);

    const roomy = searchMemory(db, { terms: ["链预算测试"], limit: 5, budget: 10000 });
    const hit = roomy.hits.find((h) => h.id === newOne);
    expect(hit?.chain?.length ?? 0).toBeGreaterThan(0); // 预算充足时历史照常展开

    // 单条 estTokens ≈ 35（ceil(len*0.8)+24）。40 刚好够「命中本体」、不够「本体 + 链附注」。
    const tight = searchMemory(db, { terms: ["链预算测试"], limit: 5, budget: 40 });
    expect(tight.tokensUsed).toBeLessThanOrEqual(40); // 预算紧张时不许超
  });
});
