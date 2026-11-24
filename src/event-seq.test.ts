// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 事件链的序号分配必须扛得住并发。
 *
 * `org_seq = 读最大序号 + 1`，读和写之间没有锁。两个进程同时追加时会算出同一个 seq，
 * 一个成功、另一个撞 `events_org_seq_uq`。以前撞了就抛错给用户 —— 而用户只是在
 * 正常地让 AI 记一条东西。
 *
 * 这里用触发器精确模拟"我刚算完、还没插进去，别人先插了"，比 mock 更接近真实：
 * 冲突是真的由 SQLite 抛出来的唯一约束错误。
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { PersonalStore } from "./store";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上 WAL 句柄释放有延迟 */
    }
  }
});

function fresh(tag: string): PersonalStore {
  const d = mkdtempSync(join(tmpdir(), `xbb-seq-${tag}-`));
  dirs.push(d);
  return PersonalStore.open(join(d, "t.db"));
}

const ORG = "personal";

describe("appendEvent 的序号分配", () => {
  test("两个写入真正交错时：一个撞唯一约束，重算后接着排，链不断", async () => {
    const d = mkdtempSync(join(tmpdir(), "xbb-seq-race-"));
    dirs.push(d);
    const p = join(d, "t.db");
    // 两个独立连接指向同一个库 —— 这才是"两个进程同时写"的真实形状。
    const s1 = PersonalStore.open(p);
    const s2 = PersonalStore.open(p);
    s1.db.exec("PRAGMA busy_timeout = 3000");
    s2.db.exec("PRAGMA busy_timeout = 3000");

    /**
     * 靠 `eventHash` 的 await 让两个调用交错：两边都先读到"表里一条都没有"、
     * 各自算出 seq=1，然后才依次插入。后插入的那个必定撞 `events_org_seq_uq`。
     *
     * 这比用触发器模拟更可信：冲突是真的由两个连接并发产生的，中间没有人为干预。
     */
    const [a, b] = await Promise.all([
      s1.appendEvent({ orgId: ORG, actor: "user", type: "memory.deliver", payloadHash: "pa" }),
      s2.appendEvent({ orgId: ORG, actor: "user", type: "memory.deliver", payloadHash: "pb" }),
    ]);

    // 反面：不做冲突重试的实现，这里会直接抛 UNIQUE constraint failed
    expect([a.seq, b.seq].sort((x, y) => x - y)).toEqual([1, 2]);

    // 链必须连上：seq=2 那条的 prev_hash 等于 seq=1 那条的 hash
    const first = a.seq === 1 ? a : b;
    const second = a.seq === 1 ? b : a;
    expect(second.prevHash).toBe(first.hash);

    // 库里恰好两条，seq 连续无洞、无分叉
    const rows = s1.db.query("SELECT org_seq FROM events WHERE org_id = ? ORDER BY org_seq").all(ORG) as Array<{ org_seq: number }>;
    expect(rows.map((r) => r.org_seq)).toEqual([1, 2]);
    s1.db.close();
    s2.db.close();
  });

  test("每次都被抢：有限次后报错，不死循环", async () => {
    const store = fresh("always");
    const db = store.db;
    // 无条件触发：每次 INSERT 都被抢先，把重试次数用尽
    db.exec(`
      CREATE TRIGGER steal BEFORE INSERT ON events
      BEGIN
        INSERT INTO events (id, org_id, org_seq, actor, type, payload_hash, prev_hash, hash, at)
        VALUES ('stolen-' || NEW.org_seq, NEW.org_id, NEW.org_seq, 'other', 'x', 'p', 'g', 'h-' || NEW.org_seq, '2026-01-01T00:00:00.000Z');
      END
    `);
    let caught: unknown = null;
    try {
      await store.appendEvent({ orgId: ORG, actor: "user", type: "memory.deliver", payloadHash: "ph" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toMatch(/UNIQUE constraint failed/);
    // 用尽后必须抛，不能悄悄吞掉 —— 哈希链少一条就是凭证缺口
    db.close();
  });

  test("串行追加：序号从 1 递增，链能验通过", async () => {
    const store = fresh("serial");
    const db = store.db;
    for (let i = 0; i < 4; i++) {
      const ev = await store.appendEvent({ orgId: ORG, actor: "user", type: "memory.deliver", payloadHash: `p${i}` });
      expect(ev.seq).toBe(i + 1);
    }
    expect(await store.verifyChain(ORG)).toBe(true);
    db.close();
  });
});
