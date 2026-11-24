// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 话题召回与延续链的回归钉子（2026-11-24）。
 *
 * 这一轮的起点是一份真实用户抽测：766 条记忆的库上，`recall_topic` 在中文大实体簇里
 * limit 5 只命中 4/8、limit 20 只命中 5/8，`get_memory` 的链永远只显示 10 条。
 *
 * 查下来不是"排序不好"，是三个**不报错**的缺陷叠在一起：
 *   ① 链的跳数上限 10 同时出现在三处（`resolveChain` / `chainHead` / `searchMemory` 内联），
 *      超过 10 层的链会**停在中途并把这个中间节点当成现状**；
 *   ② `recall_topic` 只认 `memory_entity` 显式挂边，正文提到实体名的记忆永远召不到；
 *   ③ 向量通道无相似度下限，乱码查询也能凑出几条"邻居"，而调用方无从判断。
 *
 * 每一条都要有能在**错误代码上变红**的断言 —— 否则等于没测。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { PersonalStore } from "./store";
import { invalidateVecCache, resolveChain, searchHybrid, searchMemory, walkToHead } from "./memory-search";
import { getMemory, recallTopic } from "./memory-tools";

const dir = mkdtempSync(join(tmpdir(), "xbb-mem-tools-"));
const store = PersonalStore.open(join(dir, "test.db"));
const db = store.db;

afterAll(() => {
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上 WAL 句柄释放有延迟，残留临时目录不影响断言 */
  }
});

const deliver = async (content: string) =>
  (await store.deliver({ spaceId: "sp-1", actor: "ai-host", content })).id;

/** 把 older 标记为被 newer 延续（`superseded_by` 指向 newer） */
const supersede = (older: string, newer: string) =>
  db.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(newer, older);

/**
 * 一条 15 层的链：c[0] 最旧，c[14] 是链头。
 * 15 是用户实测库里的真实最大长度，也正是「10 跳够不够」这条线的反面样本。
 */
const CHAIN_LEN = 15;
const chainIds: string[] = [];

describe("延续链：跳数上限", () => {
  test("准备一条 15 层的链", async () => {
    for (let i = 0; i < CHAIN_LEN; i++) chainIds.push(await deliver(`第 ${i + 1} 代状态`));
    for (let i = 0; i < CHAIN_LEN - 1; i++) supersede(chainIds[i]!, chainIds[i + 1]!);
    expect(chainIds.length).toBe(CHAIN_LEN);
  });

  test("walkToHead 走到真链头，不是走 10 跳就停", () => {
    // 旧实现 10 跳后停在 c[10]，会把它当成链头。c[14] 才是。
    expect(walkToHead(db, chainIds[0]!)).toBe(chainIds[CHAIN_LEN - 1]!);
    // 从半山腰出发同样是真链头（不是"再走 10 跳"）
    expect(walkToHead(db, chainIds[5]!)).toBe(chainIds[CHAIN_LEN - 1]!);
    // 链头自己
    expect(walkToHead(db, chainIds[CHAIN_LEN - 1]!)).toBe(chainIds[CHAIN_LEN - 1]!);
  });

  test("resolveChain 返回整条链，并如实报 total", () => {
    const r = resolveChain(db, chainIds[0]!);
    expect(r.links.length).toBe(CHAIN_LEN); // 旧实现只给 10
    expect(r.total).toBe(CHAIN_LEN);
    expect(r.truncated).toBe(false);
    expect(r.links.at(-1)!.id).toBe(chainIds[CHAIN_LEN - 1]!);
    expect(r.links.at(-1)!.current).toBe(true);
  });

  test("截断时必须说出来：total 是真实值，truncated 为真", () => {
    const r = resolveChain(db, chainIds[0]!, 5);
    expect(r.links.length).toBe(5);
    expect(r.total).toBe(CHAIN_LEN); // 关键：被裁了也要知道真实长度
    expect(r.truncated).toBe(true);
    // 截断保留的是最近的一段，链头必须在里面 —— 少了链头的链等于没展开
    expect(r.links.some((l) => l.current)).toBe(true);
  });

  test("getMemory 的 chain 走完整条，且不含自身", () => {
    const m = getMemory(db, chainIds[CHAIN_LEN - 1]!) as { chain: Array<{ id: string }>; chainNote?: string };
    expect(m.chain.length).toBe(CHAIN_LEN - 1);
    expect(m.chain.some((l) => l.id === chainIds[CHAIN_LEN - 1]!)).toBe(false);
    expect(m.chainNote).toBeUndefined(); // 没截断就不该有这句
  });

  test("searchMemory 命中最旧那条时，交出去的是现状而不是中间态", () => {
    // 着陆垫登记一个只有最旧那条才有的词
    db.prepare("INSERT OR IGNORE INTO memory_terms (term, memory_id, source) VALUES (?,?,?)").run(
      "链锚点词",
      chainIds[0]!,
      "expand",
    );
    const r = searchMemory(db, { terms: ["链锚点词"], limit: 3 });
    // 旧实现走 10 跳停在 c[10]，这里会拿到"第 11 代"当现状
    expect(r.hits[0]!.id).toBe(chainIds[CHAIN_LEN - 1]!);
  });

  test("旁支也要出现（链头有多个直接前驱时，BFS 不能只铺主线）", async () => {
    // 在 c[5] 上再挂一个直接前驱：c[5] 现在有两个孩子（c[4] 和 side）
    const side = await deliver("同一时刻的另一条分支");
    supersede(side, chainIds[5]!);
    const r = resolveChain(db, chainIds[0]!);
    expect(r.total).toBe(CHAIN_LEN + 1); // 15 主线 + 1 旁支
    expect(r.links.some((l) => l.id === side)).toBe(true);
  });

  test("防环：坏数据 A→B→A 不能把进程挂死", async () => {
    const a = await deliver("环 A");
    const b = await deliver("环 B");
    supersede(a, b);
    supersede(b, a); // 人为造环，只有坏数据/手写修复才可能
    // 只要能返回就说明没死循环；返回哪个不重要，重要的是有界
    const head = walkToHead(db, a);
    expect([a, b] as string[]).toContain(head);
    const r = resolveChain(db, a);
    expect(r.total).toBeGreaterThanOrEqual(1);
  });
});

describe("话题召回：实体锚定不全", () => {
  const project = "青岚";
  let anchoredId = "";
  let mentionedId = "";
  let unrelatedId = "";
  let supersededOld = "";

  test("准备：一条挂了实体、一条只提到、一条无关", async () => {
    anchoredId = await deliver("青岚 项目决定下季度交付");
    mentionedId = await deliver("顺便说一句，青岚 那个事我还是不同意");
    unrelatedId = await deliver("今天中午吃了炒饭");

    const ins = db.prepare("INSERT OR IGNORE INTO entities (name, aliases) VALUES (?,?)").run(project, null);
    const eid = Number(ins.lastInsertRowid);
    db.prepare("INSERT OR IGNORE INTO memory_entity (memory_id, entity_id) VALUES (?,?)").run(anchoredId, eid);

    // 一条被延续掉的旧状态：它的链头也必须在场（原来的"链头保障"）
    supersededOld = await deliver("青岚 项目决定三季度交付");
    const newer = await deliver("青岚 项目改为四季度交付");
    db.prepare("INSERT OR IGNORE INTO memory_entity (memory_id, entity_id) VALUES (?,?)").run(supersededOld, eid);
    supersede(supersededOld, newer);
  });

  test("正文提到但没挂实体的记忆，进 mentions 而不是被吞掉", () => {
    const r = recallTopic(db, project) as {
      total: number;
      sessions: Array<{ memories: Array<{ id: string }> }>;
      mentions?: Array<{ memories: Array<{ id: string }> }>;
      mentionsNote?: string;
    };
    const anchored = r.sessions.flatMap((s) => s.memories.map((m) => m.id));
    const mentioned = (r.mentions ?? []).flatMap((s) => s.memories.map((m) => m.id));

    expect(anchored).toContain(anchoredId);
    // 旧实现这里恒空：它只查 memory_entity
    expect(mentioned).toContain(mentionedId);
    expect(mentioned).not.toContain(anchoredId); // 已锚定的不得重复出现在弱证据里
    expect(mentioned).not.toContain(unrelatedId);
    expect(r.mentionsNote).toBeTruthy(); // 弱证据必须自带说明
  });

  test("两批分开：sessions 是强证据，mentions 是弱证据", () => {
    const r = recallTopic(db, project) as {
      sessions: Array<{ memories: Array<{ id: string }> }>;
      mentions?: Array<{ memories: Array<{ id: string }> }>;
    };
    const anchored = r.sessions.flatMap((s) => s.memories.map((m) => m.id));
    const mentioned = (r.mentions ?? []).flatMap((s) => s.memories.map((m) => m.id));
    // 交集必须为空 —— 混在一起就等于把"顺口提了一句"当成"专门聊过"
    expect(anchored.filter((id) => mentioned.includes(id))).toEqual([]);
  });

  test("被延续的旧状态换成了真链头，不是停在中间态", () => {
    const r = recallTopic(db, project) as { sessions: Array<{ memories: Array<{ id: string; supersededBy: string | null }> }> };
    const all = r.sessions.flatMap((s) => s.memories);
    // 旧那条即使还在结果里，也必须带 supersededBy 指出去；链头必须在场且 supersededBy 为 null
    const heads = all.filter((m) => !m.supersededBy);
    expect(heads.length).toBeGreaterThan(0);
  });

  test("实体不存在、但正文提到过 → 不再返回空", async () => {
    await deliver("这里提到了一个没建实体的词：鲸落计划");
    const r = recallTopic(db, "鲸落计划") as { total: number; mentions?: unknown[] };
    expect(r.total).toBe(0); // 没有锚定
    expect((r.mentions ?? []).length).toBeGreaterThan(0); // 但正文提过，不能假装没这回事
  });

  test("既无实体也无提及 → 干净的空", () => {
    const r = recallTopic(db, "不存在的东西xyz") as { total: number; mentions?: unknown[]; sessions: unknown[] };
    expect(r.total).toBe(0);
    expect(r.sessions).toEqual([]);
    expect(r.mentions).toBeUndefined();
  });

  test("大小写不同的同名实体合并成一个话题", async () => {
    // 真实库实测：`小本本`(216) / `XiaoBenBen`(28) / `xiaobenben`(21) 是三个独立实体。
    // 只取最大的那个，剩下 49 条就是黑洞 —— 这是「提到 limit 上限仍召不到」的另一个成因。
    const m1 = await deliver("Zephyr 主线记录");
    const m2 = await deliver("zephyr 小写记录");
    const id1 = Number(db.prepare("INSERT INTO entities (name, aliases) VALUES (?,?)").run("Zephyr", null).lastInsertRowid);
    const id2 = Number(db.prepare("INSERT INTO entities (name, aliases) VALUES (?,?)").run("zephyr", null).lastInsertRowid);
    db.prepare("INSERT INTO memory_entity (memory_id, entity_id) VALUES (?,?)").run(m1, id1);
    db.prepare("INSERT INTO memory_entity (memory_id, entity_id) VALUES (?,?)").run(m2, id2);

    const r = recallTopic(db, "Zephyr") as {
      total: number;
      sessions: Array<{ memories: Array<{ id: string }> }>;
      mergedEntities?: number;
    };
    const ids = r.sessions.flatMap((s) => s.memories.map((m) => m.id));
    expect(ids).toContain(m1);
    expect(ids).toContain(m2); // 旧实现只取第一个实体，这条永远拿不到
    expect(r.mergedEntities).toBe(1);
  });

  test("2 字实体走 LIKE：通配符必须转义，不能当通配用", async () => {
    // `_` 在 LIKE 里是"任意一个字符"。**必须造一条能被它误命中的样本**，
    // 否则这条测试在"没转义"的代码上也照样绿（第一版就是空的，变异验证抓到的）。
    // 用 2 字是因为 ≥3 字会走 FTS（trigram 索引），测不到 likeEsc。
    await deliver("记录一个叫 a_ 的命名前缀");
    await deliver("这里是 axiom 但跟下划线命名无关");
    const r = recallTopic(db, "a_") as { mentions?: Array<{ memories: Array<{ content: string }> }> };
    const texts = (r.mentions ?? []).flatMap((s) => s.memories.map((m) => m.content));
    expect(texts.some((t) => t.includes("a_"))).toBe(true);
    expect(texts.every((t) => t.includes("a_"))).toBe(true); // 不许把 axiom 也算进来
  });

  test("≥3 字实体走 FTS trigram，结果仍是精确子串", async () => {
    await deliver("记录一个叫 b_c 的命名前缀");
    await deliver("这里是 bxc 但跟下划线命名无关");
    const r = recallTopic(db, "b_c") as { mentions?: Array<{ memories: Array<{ content: string }> }> };
    const texts = (r.mentions ?? []).flatMap((s) => s.memories.map((m) => m.content));
    expect(texts.some((t) => t.includes("b_c"))).toBe(true);
    expect(texts.every((t) => t.includes("b_c"))).toBe(true);
  });
});

describe("低置信：乱码查询不该被当成答案", () => {
  const dims = 8;
  const vec = (idx: number) => {
    const v = new Float32Array(dims);
    v[idx] = 1;
    return v;
  };

  test("准备：一条与 query 正交的向量", async () => {
    const id = await deliver("这条记忆与乱码的正交向量无关");
    db.prepare("UPDATE memories SET embedding = ?, vec_model = ? WHERE id = ?").run(
      new Uint8Array(vec(0).buffer),
      "bge-small-zh-v1.5/int8",
      id,
    );
    invalidateVecCache(); // 本连接的 UPDATE 不会自己让缓存失效
  });

  test("词法全空 + 语义不够像 → lowConfidence", async () => {
    const r = await searchHybrid(db, async () => vec(1), { terms: ["zzz乱码zzz"], limit: 3 });
    expect(r.lowConfidence).toBe(true);
    expect(r.confidenceNote).toContain("证据很弱");
    // 正交向量 ⇒ 相似度 ≈ 0，远低于任何合理阈值；这条断言只是确认"确实低"
    expect(r.vecTop1).toBeLessThan(0.5);
  });

  test("语义确实像 → 不标低置信（别误伤正常结果）", async () => {
    const r = await searchHybrid(db, async () => vec(0), { terms: ["zzz乱码zzz"], limit: 3 });
    expect(r.lowConfidence).toBeUndefined();
    expect(r.vecTop1).toBeGreaterThan(0.9);
  });

  test("词法有硬命中 → 即使语义分低也不标（有字面依据就不是瞎猜）", async () => {
    const r = await searchHybrid(db, async () => vec(1), { terms: ["链锚点词"], limit: 3 });
    // 倒排命中 ⇒ hardHits > 0
    expect(r.stats!.invN).toBeGreaterThan(0);
    expect(r.lowConfidence).toBeUndefined();
  });
});

/**
 * 弱证据的条数上限（2026-11-25）。
 *
 * 原先 `want = Math.min(cap, 10)`：正文提到话题、但写入时没挂实体的记忆，
 * 一次最多兜回 10 条。这 10 是为了控体积拍的数，实际后果是**真实召回被吃掉**——
 * 本机实测正文含「小本本」而没有实体挂边的有 38 条，剩下 28 条在话题召回里
 * 永远看不见，而它们在库里明明存在。
 *
 * 现在跟随调用方的 `limit`（`cap` 仍限到 30），并且**超额部分必须报数**。
 * 「悄悄吞掉」是这条链上最常见的那种病：没有任何报错，用户只会觉得"记了但找不到"。
 */
describe("弱证据条数：跟随 limit，超额必须报数", () => {
  /** 独立库：主库里已经堆了链和实体，容易被别的断言串味 */
  const d2 = mkdtempSync(join(tmpdir(), "xbb-mention-cap-"));
  const s2 = PersonalStore.open(join(d2, "t.db"));
  const db2 = s2.db;
  const TOPIC = "紫电计划";
  const N = 25;

  afterAll(() => {
    db2.close();
    try {
      rmSync(d2, { recursive: true, force: true });
    } catch {
      /* Windows 上 WAL 句柄释放有延迟 */
    }
  });

  const ids = (r: unknown) =>
    ((r as { mentions?: Array<{ memories: Array<{ id: string }> }> }).mentions ?? []).flatMap((s) =>
      s.memories.map((m) => m.id),
    );

  test("准备 25 条只在正文里提到话题、没有实体挂边的记忆", async () => {
    for (let i = 0; i < N; i++) {
      await s2.deliver({ spaceId: "sp-1", actor: "ai-host", content: `第 ${i + 1} 次讨论：${TOPIC} 的排期与风险` });
    }
    // 弱证据是它们唯一的入口 —— 一条挂边都没有，才测得出这条路径
    expect((db2.query("SELECT COUNT(*) AS c FROM memory_entity").get() as { c: number }).c).toBe(0);
  });

  test("limit 20 就给 20 条（旧实现钉死在 10）", () => {
    const r = recallTopic(db2, TOPIC, 20);
    // 反面：`want = Math.min(cap, 10)` 的实现这里只有 10 条，且没有任何提示
    expect(ids(r).length).toBe(20);
  });

  test("超出的部分要报数，数字还必须出现在给模型读的那段话里", () => {
    const r = recallTopic(db2, TOPIC, 20) as { mentionsOmitted?: number; mentionsNote?: string };
    expect(r.mentionsOmitted).toBe(5);
    // 只放机器字段等于没人看见：MCP 的直接消费者是模型，它读的是 note
    expect(r.mentionsNote).toContain("5");
  });

  test("limit 小就少给，超额如实报（别固定发满 10 条的无用载荷）", () => {
    const r = recallTopic(db2, TOPIC, 3) as { mentionsOmitted?: number };
    expect(ids(r).length).toBe(3);
    expect(r.mentionsOmitted).toBe(22);
  });

  test("凑得齐时不留截断字段（别让调用方以为永远还有隐藏条目）", () => {
    const r = recallTopic(db2, TOPIC, 30) as { mentionsOmitted?: number };
    expect(ids(r).length).toBe(N);
    expect(r.mentionsOmitted).toBeUndefined();
  });

  test("给出来的 + 报出来的 = 库里真实可召条数（对得上账）", () => {
    const r = recallTopic(db2, TOPIC, 20) as { mentionsOmitted?: number };
    expect(ids(r).length + (r.mentionsOmitted ?? 0)).toBe(N);
  });
});

/**
 * 弱证据与实体锚定的边界（2026-11-25）。
 *
 * `mentionsNote` 对 AI 说的话是「这些只在正文里提到过、**并没有建立实体关联**」——
 * 这是一句事实陈述，必须兑现。第一版直接拿 FTS 命中当池子，结果 171 条正文含
 * 「小本本」的记忆里 133 条本来就挂在该实体上，它们没进 `sessions` 只是因为
 * `limit` 卡在 30。混进 `mentions` 等于对 AI 说"这些记忆缺关联"，是硬性错误信息，
 * 还会误导用户去补根本不缺的标注（本机真实库：171 条里真正无挂边的只有 38 条）。
 */
describe("弱证据的边界：有挂边的不许冒充「没建关联」", () => {
  const d3 = mkdtempSync(join(tmpdir(), "xbb-mention-scope-"));
  const s3 = PersonalStore.open(join(d3, "t.db"));
  const db3 = s3.db;
  const ENT = "苍梧工程";
  const ANCHORED = 25;
  let mentionOnly = "";

  afterAll(() => {
    db3.close();
    try {
      rmSync(d3, { recursive: true, force: true });
    } catch {
      /* Windows 上 WAL 句柄释放有延迟 */
    }
  });

  test("准备：25 条挂在实体上 + 1 条只在正文提到", async () => {
    const eid = Number(
      db3.prepare("INSERT INTO entities (name, aliases) VALUES (?,?)").run(ENT, null).lastInsertRowid,
    );
    for (let i = 0; i < ANCHORED; i++) {
      const id = (await s3.deliver({ spaceId: "sp-1", actor: "ai-host", content: `第 ${i + 1} 条：${ENT} 的施工日志` })).id;
      db3.prepare("INSERT INTO memory_entity (memory_id, entity_id) VALUES (?,?)").run(id, eid);
    }
    mentionOnly = (await s3.deliver({ spaceId: "sp-1", actor: "ai-host", content: `顺口一提，${ENT} 那边好像停工了` })).id;
    expect((db3.query("SELECT COUNT(*) AS c FROM memory_entity").get() as { c: number }).c).toBe(ANCHORED);
  });

  const ids = (r: unknown) =>
    ((r as { mentions?: Array<{ memories: Array<{ id: string }> }> }).mentions ?? []).flatMap((s) =>
      s.memories.map((m) => m.id),
    );

  test("挂边总数要报出来：给了 5 条，库里其实 25 条", () => {
    const r = recallTopic(db3, ENT, 5) as { total: number; entityTotal?: number; entityOmitted?: number };
    expect(r.total).toBe(5);
    // 不说这一句，调用方会把 total:5 当成"这个话题只有 5 条"，据此下结论
    expect(r.entityTotal).toBe(ANCHORED);
    expect(r.entityOmitted).toBe(ANCHORED - 5);
  });

  test("有挂边、只是没进 limit 的条目不进 mentions", () => {
    const r = recallTopic(db3, ENT, 5);
    // 反面：不排挂边的实现会把剩下 20 条塞进 mentions，然后对 AI 说"这些没建关联"
    expect(ids(r)).toEqual([mentionOnly]);
  });

  test("锚定结果里不许有重复 id", () => {
    const r = recallTopic(db3, ENT, 5) as { sessions: Array<{ memories: Array<{ id: string }> }> };
    const all = r.sessions.flatMap((s) => s.memories.map((m) => m.id));
    // 反面：headOf 空分支不查 seenIds 的实现会把每条推两遍，一直推到 hardCap
    expect(all.length).toBe(5);
    expect(new Set(all).size).toBe(all.length);
  });

  test("只有一条真·无挂边时不留截断字段", () => {
    const r = recallTopic(db3, ENT, 5) as { mentionsOmitted?: number };
    expect(r.mentionsOmitted).toBeUndefined();
  });
});
