import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { PersonalStore } from "./store";
import { ORG_PERSONAL } from "./schema";

const dir = mkdtempSync(join(tmpdir(), "xbb-store-test-"));
const store = PersonalStore.open(join(dir, "test.db"));

afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("PersonalStore", () => {
  test("deliver 写入并落 events", async () => {
    const rec = await store.deliver({ spaceId: "sp-1", actor: "ai-host", content: "我习惯用 Bun 做小工具", tags: ["preference"] });
    expect(rec.id).toBeTruthy();
    expect(rec.status).toBe("active");
    expect(store.stats().memories).toBe(1);
    expect(store.stats().events).toBe(1);
  });

  test("recall 命中（FTS trigram）", async () => {
    await store.deliver({ spaceId: "sp-1", actor: "ai-host", content: "小本本的个人库默认零登录" });
    const hits = store.search("个人库");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.content).toContain("个人库");
  });

  test("recall 短查询走 LIKE 兜底", () => {
    const hits = store.search("Bun");
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  test("recall 不含未命中词", () => {
    const hits = store.search("完全无关的词组xyz");
    expect(hits.length).toBe(0);
  });

  test("forget 墓碑后 recall 不再命中", async () => {
    const rec = await store.deliver({ spaceId: "sp-1", actor: "ai-host", content: "这条要被遗忘的秘密内容" });
    expect(store.search("被遗忘的秘密").length).toBe(1);
    const ok = await store.forget(rec.id, "user");
    expect(ok).toBe(true);
    expect(store.search("被遗忘的秘密").length).toBe(0);
    // 墓碑仍在（append-only，行未删除）
    expect(store.get(rec.id)?.status).toBe("forgotten");
  });

  test("inbox / ack 闭环", async () => {
    const rec = await store.deliver({ spaceId: "sp-1", actor: "ai-host", content: "AI 建议：把部署脚本放进 repo" }, { needsAck: true });
    expect(store.inbox().map((i) => i.id)).toContain(rec.id);
    expect(await store.ack(rec.id, "user")).toBe(true);
    expect(store.inbox().map((i) => i.id)).not.toContain(rec.id);
    expect(await store.ack(rec.id, "user")).toBe(false); // 二次 ack 无效
  });

  test("哈希链 verifyChain 通过", async () => {
    expect(await store.verifyChain(ORG_PERSONAL)).toBe(true);
  });

  test("篡改 hash 后 verifyChain 失败（账不可改）", async () => {
    const evil = PersonalStore.open(join(dir, "evil.db"));
    await evil.deliver({ spaceId: "sp-1", actor: "ai-host", content: "正常记录一" });
    await evil.deliver({ spaceId: "sp-1", actor: "ai-host", content: "正常记录二" });
    evil.db.query("UPDATE events SET hash = 'deadbeef' WHERE org_seq = 2").run();
    expect(await evil.verifyChain(ORG_PERSONAL)).toBe(false);
    evil.db.close();
  });

  test("org_seq 严格递增（org 内全序）", async () => {
    await store.deliver({ spaceId: "sp-1", actor: "ai-host", content: "顺序一" });
    await store.deliver({ spaceId: "sp-1", actor: "ai-host", content: "顺序二" });
    const rows = store.db.query("SELECT org_seq FROM events ORDER BY org_seq ASC").all() as Array<{ org_seq: number }>;
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.org_seq).toBe(rows[i - 1]!.org_seq + 1);
  });

  test("searchProactive：口语回合文本命中 + 通用三连字不噪声", async () => {
    await store.deliver({ spaceId: "sp-1", actor: "ai-host", content: "去年和同事一起挑了美的电饭煲，选了 IH 款" });
    // 口语问句与存储原文不逐字对应，靠三元组命中
    const hits = store.searchProactive("我之前是不是买过一个电饭煲？");
    expect(hits.length).toBe(1);
    expect(hits[0]!.content).toContain("电饭煲");
    // 无关回合：三元组在库内 df 为 0 → 无候选
    expect(store.searchProactive("今天中午吃什么好呢").length).toBe(0);
    // ASCII 词提取：唯一 token 可命中（用唯一词避免与既有记忆的公共词撞 df）
    await store.deliver({ spaceId: "sp-1", actor: "ai-host", content: "项目构建入口是 xbbbuild 脚本" });
    const asciiHits = store.searchProactive("构建脚本是直接用 xbbbuild 跑的吗");
    expect(asciiHits.length).toBe(1);
    expect(asciiHits[0]!.content).toContain("xbbbuild");
  });

  test("pushToInbox 主动推送：引用不复制、去重、落 memory.push 事件", async () => {
    const rec = await store.deliver({ spaceId: "sp-1", actor: "ai-host", content: "钩子推送测试：项目小本本用 Bun 构建" });
    const before = store.stats().events;
    const memBefore = store.stats().memories;
    expect(await store.pushToInbox(rec.id)).toBe(true);
    expect(store.inbox().map((i) => i.id)).toContain(rec.id);
    // 去重：已在 inbox 的二次推送无效
    expect(await store.pushToInbox(rec.id)).toBe(false);
    // 引用不复制：没有新增 memories 行，只多一条 memory.push 事件
    expect(store.stats().memories).toBe(memBefore);
    expect(store.stats().events).toBe(before + 1);
    expect(store.db.query("SELECT type FROM events ORDER BY org_seq DESC LIMIT 1").get()).toMatchObject({ type: "memory.push" });
    // ack 闭环：领取后出 inbox，可再次被推送
    expect(await store.ack(rec.id, "user")).toBe(true);
    expect(store.inbox().map((i) => i.id)).not.toContain(rec.id);
    expect(await store.pushToInbox(rec.id)).toBe(true);
    // 遗忘后推送无效
    await store.ack(rec.id, "user");
    await store.forget(rec.id, "user");
    expect(await store.pushToInbox(rec.id)).toBe(false);
    expect(await store.verifyChain(ORG_PERSONAL)).toBe(true);
  });

  test("stats 库存统计：总数/遗忘/最近写入/bySpace/byTag", async () => {
    const before = store.stats();
    await store.deliver({ spaceId: "00000000-0000-7000-8000-000000000009", actor: "user", content: "统计测试：项目会议定在周一上午", tags: ["project:alpha", "meeting"] });
    const s = store.stats();
    expect(s.memories).toBe(before.memories + 1);
    expect(s.forgotten).toBeGreaterThanOrEqual(1); // 前面用例 forget 过
    expect(s.oldest).toBeTruthy();
    expect(new Date(s.newest!).getTime()).toBeGreaterThanOrEqual(new Date(s.oldest!).getTime());
    expect(s.last7d).toBeGreaterThanOrEqual(1);
    // bySpace：新空间单条计入
    const sp = s.bySpace.find((x) => x.spaceId === "00000000-0000-7000-8000-000000000009");
    expect(sp?.count).toBe(1);
    // byTag：top 聚合含刚打的标签，且不超过 8 条
    expect(s.byTag.find((x) => x.tag === "project:alpha")?.count).toBeGreaterThanOrEqual(1);
    expect(s.byTag.length).toBeLessThanOrEqual(8);
    // pendingAck 与 forgotten 均从现表 count，不改写记忆
    expect(s.pendingAck).toBe(store.stats().pendingAck);
  });
});
