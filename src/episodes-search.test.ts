// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 原话层检索的回归钉子（2026-11-20 首建）。
 *
 * 为什么现在才有：`findEpisodes` 一直用 `episode_chunks MATCH '"整句"'`，
 * 在 27,995 条真实原话上实测出的两个缺陷，全都是"看起来能跑、跑起来全是错的"：
 *
 *   1. **2 字中文词命中恒为 0** —— trigram 要求 ≥3 字符才建索引。"记忆" 3,399 条 → 0，
 *      "向量" 879 → 0，"AI" 9,414 → 0。AI 搜一次空一次，换词再搜还是空 —— 用户体感
 *      "搜原话要好久好久"，其实一次都没搜对。
 *   2. **长串假阳性 28.9 倍** —— trigram 不存位置信息，裸 MATCH 会跨列拼凑。
 *      查 12 位 hash 返回 6,379 条、真值 221 条，头几条是"你好""我先把项目结构摸一遍"。
 *
 * 每条断言都钉一个反例；把 bigram 换回 trigram 必须全红（变异验证见提交说明）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { PersonalStore } from "./store";
import { appendEpisode, findEpisodes, ingestDedupeKey } from "./episodes";
import { bigramify, bigramTerms } from "./bigram";

const dir = mkdtempSync(join(tmpdir(), "xbb-epsearch-"));
const store = PersonalStore.open(join(dir, "test.db"));
const db = store.db;

const HASH = "1185df8eee52";

/** 写入若干条独立会话，返回 sessionId → 首块 rowid */
function seed(): void {
  const rows: Array<[string, string]> = [
    ["s-a", "我们讨论小本本的向量检索方案，重点是延迟预算要压在 50 毫秒以内。"],
    ["s-b", "记忆检索和检索记忆是两件不同的事，前者查知识点，后者查出处。"],
    ["s-c", `这次发布卡在 ${HASH} 这个提交上，二进制校验没过。`],
    ["s-d", "蒸馏管线要按 token 预算切块，一次大概三万五千 token 最稳。"],
    // 陷阱行：**正文与 hash 毫无关系**，只在 session_id 里带完整 hash。
    // 线上 session_id 常是「前缀 + 哈希」的形态（UUID / 带哈希后缀），这就是跨列误报的现场：
    // episode_chunks 把 session_id 建成了索引列，于是裸 MATCH 会把它当命中，把这一行捞进来。
    // episode_bigrams 把 session_id 设成 UNINDEXED（不参与匹配），所以不会被带进来。
    [`s-${HASH}-trap`, "占位。"],
  ];
  let n = 0;
  for (const [sid, content] of rows) {
    appendEpisode(db, {
      sessionId: sid,
      role: "user",
      content,
      source: "test",
      externalId: `e${n++}`,
      dedupeKey: ingestDedupeKey("test", sid, `e${n}`),
    });
  }
}
seed();

afterAll(() => {
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows WAL 句柄延迟，忽略 */
  }
});

describe("bigram 切分边界", () => {
  test("中文按相邻 2 字滑窗", () => {
    expect(bigramify("记忆检索")).toBe("记忆 忆检 检索");
  });

  test("CJK 与拉丁数字不跨边界（不产生 I记 这种垃圾 token）", () => {
    expect(bigramify("AI记忆")).toBe("AI 记忆");
  });

  test("标点断词但两侧 token 序列与查询侧一致，版本号仍可命中", () => {
    expect(bigramify("0.4.57")).toBe("0 4 57");
    expect(bigramTerms("4.57")).toEqual(["4", "57"]);
  });

  test("单字符段保留，不做空转", () => {
    expect(bigramify("a")).toBe("a");
    expect(bigramTerms("")).toEqual([]);
  });
});

describe("原话检索：2 字词必须能命中（trigram 下恒为 0）", () => {
  test("「检索」命中向量检索那条", () => {
    const { hits } = findEpisodes(db, "检索");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.chunk.includes("向量检索方案"))).toBe(true);
  });

  test("「蒸馏」命中蒸馏管线那条", () => {
    const { hits } = findEpisodes(db, "蒸馏");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.chunk.includes("蒸馏管线"))).toBe(true);
  });

  test("「预算」命中延迟预算那条", () => {
    const { hits } = findEpisodes(db, "预算");
    expect(hits.some((h) => h.chunk.includes("延迟预算"))).toBe(true);
  });
});

describe("原话检索：短语保顺序", () => {
  test("「记忆检索」只命中 s-b，不命中「检索记忆」之外的顺序", () => {
    const { hits } = findEpisodes(db, "记忆检索");
    expect(hits.length).toBe(1);
    expect(hits[0]!.sessionId).toBe("s-b");
    expect(hits[0]!.chunk).toContain("记忆检索和检索记忆");
  });

  test("「检索记忆」同样只命中 s-b（同一句里两种顺序都出现过）", () => {
    const { hits } = findEpisodes(db, "检索记忆");
    expect(hits.length).toBe(1);
    expect(hits[0]!.sessionId).toBe("s-b");
  });

  test("不存在的短语顺序不命中（否则就是丢顺序）", () => {
    const { hits } = findEpisodes(db, "记忆方案");
    expect(hits.length).toBe(0);
  });
});

describe("原话检索：长串不允许假阳性", () => {
  test("12 位 hash 精确命中 1 条", () => {
    const { hits } = findEpisodes(db, HASH);
    expect(hits.length).toBe(1);
    expect(hits[0]!.sessionId).toBe("s-c");
  });

  test("session_id 里的 hash 不许把无关会话串进来（线上假阳性 28.9 倍的现场）", () => {
    const { hits } = findEpisodes(db, HASH);
    // trap 行的 session_id 就是 "s-<HASH>-trap"，正文只有"占位。"——它绝不该出现在结果里
    expect(hits.some((h) => h.sessionId.includes("trap"))).toBe(false);
    expect(hits.every((h) => h.chunk.includes(HASH))).toBe(true);
  });

  test("hash 片段也能定位（后 4 位）", () => {
    const { hits } = findEpisodes(db, "e52");
    expect(hits.some((h) => h.chunk.includes(HASH))).toBe(true);
    expect(hits.some((h) => h.sessionId.includes("trap"))).toBe(false);
  });
});

describe("原话检索：自然语言长句降级 OR", () => {
  test("整句提问能召回相关原话，并自报家门", () => {
    const { hits, note } = findEpisodes(db, "上次说的那个向量检索的方案是什么来着");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.chunk.includes("向量检索方案"))).toBe(true);
    expect(note).toContain("关键词组合");
  });

  test("短语能命中时不走 OR（不掺噪音、不给 note）", () => {
    const { note } = findEpisodes(db, "向量检索方案");
    expect(note).toBeUndefined();
  });
});

describe("原话检索：边界与一致性", () => {
  test("空查询返回空且带说明，不抛", () => {
    const r = findEpisodes(db, "   ");
    expect(r.hits).toEqual([]);
    expect(r.note).toBe("查询为空");
  });

  test("sessionId 限定只在该会话内命中", () => {
    const { hits } = findEpisodes(db, "检索", { sessionId: "s-a" });
    expect(hits.every((h) => h.sessionId === "s-a")).toBe(true);
  });

  test("上下文窗口带出邻块，position 单调", () => {
    const { hits } = findEpisodes(db, "向量检索方案", { ctx: 2 });
    expect(hits.length).toBe(1);
    const pos = hits[0]!.context.map((c) => c.position);
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
  });
});

describe("索引一致性：bigram 与 chunks 的 rowid 必须对齐", () => {
  test("appendEpisode 返回的 firstChunk 同时存在于两张表", () => {
    const r = appendEpisode(db, {
      sessionId: "s-e",
      role: "user",
      content: "对齐检查：这句话用来验证两张索引表的 rowid 是否一致。",
      source: "test",
      externalId: "e-align",
      dedupeKey: ingestDedupeKey("test", "s-e", "e-align"),
    });
    expect(r.inserted).toBe(true);
    const rid = r.firstChunk!;
    const inChunks = db.query("SELECT rowid FROM episode_chunks WHERE rowid = ?").get(rid);
    const inBigrams = db.query("SELECT rowid FROM episode_bigrams WHERE rowid = ?").get(rid);
    expect(inChunks).not.toBeNull();
    expect(inBigrams).not.toBeNull();
  });

  test("重复写入被去重，不产生第二份倒排", () => {
    const before = (db.query("SELECT count(*) c FROM episode_bigrams").get() as { c: number }).c;
    const again = appendEpisode(db, {
      sessionId: "s-e",
      role: "user",
      content: "对齐检查：这句话用来验证两张索引表的 rowid 是否一致。",
      source: "test",
      externalId: "e-align",
      dedupeKey: ingestDedupeKey("test", "s-e", "e-align"),
    });
    expect(again.inserted).toBe(false);
    const after = (db.query("SELECT count(*) c FROM episode_bigrams").get() as { c: number }).c;
    expect(after).toBe(before);
  });
});
