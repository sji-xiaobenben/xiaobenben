// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 域地图（constraint domain map）单测 —— 2026-10-07 恢复。
 * 覆盖：目录模式（写前归并）＋ 词群模式（IDF 加权 × 域聚合）＋ 系统级契约不进地图 ＋ 习惯单列。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PersonalStore } from "./store";
import { writeMemory } from "./memory-write";
import { recallConstraints, constraintDirectory } from "./memory-tools";
import { DEFAULT_DOMAIN } from "./seed";

const dir = mkdtempSync(join(tmpdir(), "xbb-constraints-test-"));
const store = PersonalStore.open(join(dir, "test.db"));
const db = store.db;

beforeAll(async () => {
  // 两个自建域 + 一个习惯 + 两条普通记忆（对照组 / 制造高频词）
  await writeMemory(store, {
    content: "讨厌大圆角，卡片一律小圆角",
    type: "preference", kind: "constraint", domain: "UI 设计",
    terms: ["圆角", "卡片", "界面", "样式", "设计"],
  });
  await writeMemory(store, {
    content: "配色只用低饱和",
    type: "preference", kind: "constraint", domain: "UI 设计",
    terms: ["配色", "低饱和", "色板", "饱和度", "颜色", "设计"],
  });
  await writeMemory(store, {
    content: "每周至少运动三次",
    type: "preference", kind: "constraint", domain: "运动",
    terms: ["运动", "健身", "跑步", "锻炼", "健康"],
  });
  await writeMemory(store, {
    content: "回复我时称呼我为老师",
    type: "preference", kind: "habit",
    terms: ["称呼", "老师", "礼貌", "沟通", "对话"],
  });
  await writeMemory(store, {
    content: "我住在广州",
    type: "fact",
    terms: ["广州", "居住", "城市", "地点", "地址"],
  });
  // 普通记忆带 "样式" ⇒ 把该词的 df 抬到 2（IDF 对比用：罕见词得分应更高）
  await writeMemory(store, {
    content: "样式库参考了 tailwind 的做法",
    type: "fact",
    terms: ["tailwind", "样式", "css", "参考", "库"],
  });
  // 模拟引擎播种的系统级契约（system=1，落在保留域）——**必须不出现在地图里**
  const sys = await writeMemory(store, {
    content: "你没有可靠的内部时钟，一切时间判断以工具响应的 now 为准",
    type: "procedure", kind: "constraint", domain: DEFAULT_DOMAIN,
    terms: ["时间", "现在", "几点", "时钟", "now", "当前时间"],
  });
  db.prepare("UPDATE memories SET system = 1 WHERE id = ?").run(sys.id);
});

afterAll(() => {
  db.close();
  // Windows 下 WAL/SHM 句柄释放有延迟，清理失败不该让测试报红（目录在系统 temp 下，残留无害）
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* 句柄未释放，留给系统清理 */
  }
});

describe("域地图：目录模式（terms 空 = 写前归并前置）", () => {
  test("空词群返回目录，而非空 hits（回归：此处曾退化成 {hits:[], note:'空词群'}）", () => {
    const r = recallConstraints(db, []) as any;
    expect(r.mode).toBe("directory");
    expect(Array.isArray(r.domains)).toBe(true);
    expect(r.domains.length).toBe(2);
    expect(r.hits).toEqual([]);
  });

  test("目录列出全部自建域，且带 条数 / 样例 / 词群摘要 / 更新时间", () => {
    const r = constraintDirectory(db) as any;
    const names = r.domains.map((d: any) => d.domain);
    expect(names).toContain("UI 设计");
    expect(names).toContain("运动");
    const ui = r.domains.find((d: any) => d.domain === "UI 设计");
    expect(ui.count).toBe(2);
    expect(typeof ui.sample).toBe("string");
    expect(ui.sample.length).toBeGreaterThan(0);
    // 增强项：词群摘要 —— 判断"新约束该归哪个域"的依据
    expect(ui.terms).toContain("圆角");
    expect(ui.terms).toContain("配色");
    expect(typeof ui.updatedAt).toBe("string");
  });

  test("系统级契约域不进地图（system=1 过滤）", () => {
    const r = constraintDirectory(db) as any;
    expect(r.domains.map((d: any) => d.domain)).not.toContain(DEFAULT_DOMAIN);
  });

  test("目录带归并提示（AI 靠它防域爆炸）", () => {
    const r = constraintDirectory(db) as any;
    expect(r.hint).toContain("复用");
  });
});

describe("域地图：词群模式（IDF 加权 × 域聚合）", () => {
  test("命中域而非散点：做卡片设计 → UI 设计域整域返回", () => {
    const r = recallConstraints(db, ["圆角", "卡片", "界面", "样式", "设计"]) as any;
    expect(r.mode).toBe("matched");
    const doms = r.matchedDomains.map((d: any) => d.domain);
    expect(doms).toContain("UI 设计");
    const ui = r.matchedDomains.find((d: any) => d.domain === "UI 设计");
    expect(ui.constraints.length).toBe(2);
    expect(ui.score).toBeGreaterThan(0);
    expect(ui.constraints[0].matchedTerms.length).toBeGreaterThan(0);
  });

  test("域按总分降序（域得分 = Σ 域内条分）", () => {
    const r = recallConstraints(db, ["设计", "运动", "界面"]) as any;
    const scores = r.matchedDomains.map((d: any) => d.score);
    expect(scores.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < scores.length; i++) expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
  });

  test("IDF 加权生效：罕见词比高频词得分高", () => {
    // "圆角" 只出现 1 次（df=1）；"样式" 出现 2 次（df=2，被普通记忆抬高）⇒ 前者 IDF 更高
    const rare = recallConstraints(db, ["圆角"]) as any;
    const common = recallConstraints(db, ["样式"]) as any;
    expect(rare.matchedDomains.length).toBe(1);
    expect(common.matchedDomains.length).toBe(1);
    expect(rare.matchedDomains[0].score).toBeGreaterThan(common.matchedDomains[0].score);
  });

  test("习惯单列（天生无域，不进域聚合）", () => {
    const r = recallConstraints(db, ["称呼", "老师", "沟通", "运动", "圆角"]) as any;
    expect(r.habits.map((h: any) => h.content).join()).toContain("称呼我为老师");
    for (const d of r.matchedDomains) {
      expect(d.constraints.some((c: any) => c.content.includes("称呼我为老师"))).toBe(false);
    }
  });

  test("hits 是 matchedDomains 的扁平派生视图（兼容既有消费方）", () => {
    const r = recallConstraints(db, ["圆角", "界面", "设计", "运动", "称呼", "老师"]) as any;
    const flat = [
      ...r.matchedDomains.flatMap((d: any) => d.constraints.map((c: any) => c.id)),
      ...r.habits.map((h: any) => h.id),
    ];
    expect(r.hits.map((h: any) => h.id).sort()).toEqual(flat.sort());
    expect(typeof r.tokensUsed).toBe("number");
  });

  test("0 命中是正常结果：给 unmatchedHint，不报错", () => {
    const r = recallConstraints(db, ["量子纠缠", "核聚变", "超导"]) as any;
    expect(r.matchedDomains).toEqual([]);
    expect(r.habits).toEqual([]);
    expect(typeof r.unmatchedHint).toBe("string");
    expect(r.unmatchedHint.length).toBeGreaterThan(0);
  });

  test("kind 过滤生效：普通记忆不误纳", () => {
    const r = recallConstraints(db, ["广州", "居住", "城市"]) as any;
    const ids = r.hits.map((h: any) => h.id);
    expect(ids.length).toBe(0);
  });

  test("预算封顶：极小 budget 下不整域塞入", () => {
    const r = recallConstraints(db, ["圆角", "卡片", "界面", "样式", "设计", "运动", "健身"], 1) as any;
    expect(r.tokensUsed).toBeLessThanOrEqual(1);
    expect(r.matchedDomains.length).toBe(0);
  });
});
