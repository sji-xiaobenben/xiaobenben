import { describe, expect, test } from "bun:test";
import { eventHash, payloadHash } from "./hash";

describe("payloadHash", () => {
  test("SHA-256 输出 64 位 hex", async () => {
    const h = await payloadHash({ a: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("同输入同输出（确定性）", async () => {
    const a = await payloadHash({ k: "v", n: [1, 2, 3] });
    const b = await payloadHash({ k: "v", n: [1, 2, 3] });
    expect(a).toBe(b);
  });

  test("键序不同 → hash 不同（JSON 序列化语义）", async () => {
    const a = await payloadHash({ a: 1, b: 2 });
    const b = await payloadHash({ b: 2, a: 1 });
    expect(a).not.toBe(b);
  });
});

describe("eventHash", () => {
  test("链式结构：prevHash 改变则 hash 改变（篡改可检测）", async () => {
    const base = { orgId: "org1", seq: 1, payloadHash: "aa" };
    const h1 = await eventHash({ ...base, prevHash: "genesis" });
    const h2 = await eventHash({ ...base, prevHash: "tampered" });
    expect(h1).not.toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  test("seq 参与 hash：乱序重放可检测", async () => {
    const base = { orgId: "org1", prevHash: "x", payloadHash: "y" };
    const h1 = await eventHash({ ...base, seq: 1 });
    const h2 = await eventHash({ ...base, seq: 2 });
    expect(h1).not.toBe(h2);
  });
});
