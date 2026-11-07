import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  MAX_PER_SYNC,
  emptyState,
  loadState,
  planNotifications,
  saveState,
  truncate,
  type InboxItem,
  type NotifyState,
  type OutboxItem,
} from "./notify-watch";

// 隔离到临时 XBB_HOME：statePath() 每次调用时读 env
const dir = mkdtempSync(join(tmpdir(), "xbb-notify-test-"));
const prevHome = process.env.XBB_HOME;
process.env.XBB_HOME = dir;
afterAll(() => {
  if (prevHome === undefined) delete process.env.XBB_HOME;
  else process.env.XBB_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

const CONSOLE = "https://console.example.test";
const inboxItem = (id: string, over: Partial<InboxItem> = {}): InboxItem => ({
  id, content: `内容 ${id}`, ownerName: "小明", actor: "小明", ...over,
});
const outboxItem = (memoryId: string, targets: OutboxItem["targets"]): OutboxItem => ({
  memoryId, content: `投递 ${memoryId}`, targets,
});
const seen = (over: Partial<NotifyState> = {}): NotifyState => ({ ...emptyState(), seeded: true, ...over });

describe("planNotifications · 播种", () => {
  test("首次运行（未播种）：**一条都不弹**，但快照要记全（否则下次会把历史全弹一遍）", () => {
    const { items, next } = planNotifications(emptyState(), [inboxItem("m1")], [
      outboxItem("o1", [{ memberId: "u1", displayName: "小红", ackedAt: "2026-10-07T00:00:00Z", arrivedAt: null }]),
    ], CONSOLE);
    expect(items).toEqual([]);
    expect(next.seeded).toBe(true);
    expect(next.seenInbox).toEqual(["m1"]);
    expect(next.outbox.o1).toEqual({ acked: ["u1"], arrived: [] });
  });
});

describe("planNotifications · 收件箱（别人投递给我）", () => {
  test("新增一条 → 弹「投递人 发来一条待签收记忆」，带收件箱深链", () => {
    const { items } = planNotifications(seen({ seenInbox: [] }), [inboxItem("m1")], [], CONSOLE);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("delivered");
    expect(items[0]!.title).toBe("小明 发来一条待签收记忆");
    expect(items[0]!.body).toBe("内容 m1");
    expect(items[0]!.url).toBe(`${CONSOLE}/me-inbox`);
  });

  test("已在收件箱里的不重复弹（**防重复才是差分存在的理由**）", () => {
    const { items } = planNotifications(seen({ seenInbox: ["m1"] }), [inboxItem("m1")], [], CONSOLE);
    expect(items).toEqual([]);
  });

  test("seenInbox 有界：等于当前 pending 集合，签收离开后自动收缩（文件不会无限长）", () => {
    const { next } = planNotifications(seen({ seenInbox: ["m1", "m2", "m3"] }), [inboxItem("m3")], [], CONSOLE);
    expect(next.seenInbox).toEqual(["m3"]);
  });

  test("归属名缺失时回落 actor 字符串（不显示 undefined）", () => {
    const { items } = planNotifications(seen({ seenInbox: [] }), [
      inboxItem("m1", { ownerName: null, actor: "阿强" }),
    ], [], CONSOLE);
    expect(items[0]!.title).toBe("阿强 发来一条待签收记忆");
  });

  test("consoleUrl 推不出 → url 为 null，绝不编造一个点不开的地址", () => {
    const { items } = planNotifications(seen({ seenInbox: [] }), [inboxItem("m1")], [], null);
    expect(items[0]!.url).toBeNull();
  });
});

describe("planNotifications · 出件箱（我投递出去的东西有动静了）", () => {
  const hong = { memberId: "u1", displayName: "小红", ackedAt: null as string | null, arrivedAt: null as string | null };

  test("某人从「未读」变「已读」→ 弹「已查看」，带记忆库深链", () => {
    const { items } = planNotifications(
      seen({ outbox: { o1: { acked: [], arrived: [] } } }),
      [],
      [outboxItem("o1", [{ ...hong, arrivedAt: "2026-10-07T01:00:00Z" }])],
      CONSOLE,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("arrived");
    expect(items[0]!.title).toBe("小红 已查看");
    expect(items[0]!.url).toBe(`${CONSOLE}/me-space`);
  });

  test("从「未签」变「已签」→ 弹「已确认」", () => {
    const { items } = planNotifications(
      seen({ outbox: { o1: { acked: [], arrived: ["u1"] } } }),
      [],
      [outboxItem("o1", [{ ...hong, arrivedAt: "2026-10-07T01:00:00Z", ackedAt: "2026-10-07T02:00:00Z" }])],
      CONSOLE,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("acked");
    expect(items[0]!.title).toBe("小红 已确认");
  });

  test("一轮内「直接看过并签了」只弹一条（已确认）——两句话说的是同一件事，弹两条是噪音", () => {
    const { items } = planNotifications(
      seen({ outbox: { o1: { acked: [], arrived: [] } } }),
      [],
      [outboxItem("o1", [{ ...hong, arrivedAt: "2026-10-07T01:00:00Z", ackedAt: "2026-10-07T01:00:05Z" }])],
      CONSOLE,
    );
    expect(items.map((i) => i.kind)).toEqual(["acked"]);
  });

  test("状态没变 → 不弹（每次唤醒都回拉，绝大多数轮次都是无事发生）", () => {
    const t = [{ ...hong, arrivedAt: "2026-10-07T01:00:00Z", ackedAt: "2026-10-07T02:00:00Z" }];
    const { items } = planNotifications(seen({ outbox: { o1: { acked: ["u1"], arrived: ["u1"] } } }), [], [outboxItem("o1", t)], CONSOLE);
    expect(items).toEqual([]);
  });

  test("多人分别签收 → 各弹一条（谁签的要说清）", () => {
    const { items } = planNotifications(
      seen({ outbox: { o1: { acked: [], arrived: [] } } }),
      [],
      [outboxItem("o1", [
        { memberId: "u1", displayName: "小红", ackedAt: "2026-10-07T01:00:00Z", arrivedAt: "2026-10-07T00:30:00Z" },
        { memberId: "u2", displayName: "阿强", ackedAt: "2026-10-07T01:10:00Z", arrivedAt: "2026-10-07T00:40:00Z" },
      ])],
      CONSOLE,
    );
    expect(items.map((i) => i.title).sort()).toEqual(["小红 已确认", "阿强 已确认"]);
    expect(items.every((i) => i.kind === "acked")).toBe(true);
  });

  test("出件箱里消失的记忆 → 快照同步收缩（不残留幽灵条目）", () => {
    const { next } = planNotifications(seen({ outbox: { o1: { acked: [], arrived: [] } } }), [], [], CONSOLE);
    expect(next.outbox).toEqual({});
  });
});

describe("planNotifications · 上限", () => {
  test("单次最多 MAX_PER_SYNC 条（宁可少弹，收件箱里都在）", () => {
    const many = Array.from({ length: MAX_PER_SYNC + 3 }, (_, i) => inboxItem(`m${i}`));
    const { items } = planNotifications(seen({ seenInbox: [] }), many, [], CONSOLE);
    expect(items).toHaveLength(MAX_PER_SYNC);
  });
});

describe("truncate", () => {
  test("折叠空白 + 按长度截断（气泡只有两行）", () => {
    expect(truncate("  a\n\nb\tc  ")).toBe("a b c");
    expect(truncate("x".repeat(100), 10)).toBe(`${"x".repeat(10)}…`);
    expect(truncate("短", 10)).toBe("短");
  });
});

describe("loadState / saveState", () => {
  test("往返一致", () => {
    const s: NotifyState = { seeded: true, seenInbox: ["a"], outbox: { o: { acked: ["u"], arrived: [] } }, lastSeq: 17 };
    saveState(s, join(dir, "roundtrip.json"));
    expect(loadState(join(dir, "roundtrip.json"))).toEqual(s);
  });

  test("文件损坏 / 缺失 → 空状态（一个坏 json 不该让通知永久失效）", () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    expect(loadState(bad)).toEqual(emptyState());
    expect(loadState(join(dir, "nope.json"))).toEqual(emptyState());
  });

  test("字段类型不对时逐字段回落（不整份丢弃，也不带进脏类型）", () => {
    const weird = join(dir, "weird.json");
    writeFileSync(weird, JSON.stringify({ seeded: "yes", seenInbox: [1, "ok"], outbox: null, lastSeq: "9" }));
    expect(loadState(weird)).toEqual({ seeded: false, seenInbox: ["ok"], outbox: {}, lastSeq: 0 });
  });
});
