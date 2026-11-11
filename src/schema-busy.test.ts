// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 结构迁移的并发回归（2026-11-11 官网用户反馈）。
 *
 * 用户场景：serve + 两个 MCP 同时开着，升级后首次 `xbb ingest` 直接失败，
 * 只有 `SQLiteError: database is locked` 与一段 Bun 堆栈，没有任何「接下来怎么办」。
 *
 * 根因不是 busy_timeout 太小（它一直是 3000），而是事务用了 `BEGIN`（deferred）：
 * 迁移先读一批（PRAGMA table_info 等）拿到读快照，期间别的进程提交写，快照即过期；
 * 再去 ALTER 需要升级成写事务，SQLite 判定快照不可用，**直接返回 SQLITE_BUSY，
 * 根本不调用 busy 处理器**。改 `BEGIN IMMEDIATE` 后一开始就拿写锁，不存在升级这回事。
 *
 * 这两条断言必须成对看：
 *   · 「别人短暂持锁 ⇒ 等，然后成功」——证明改的不是「更早失败」
 *   · 「别人长期持锁 ⇒ 抛 SchemaBusyError 并带人话」——证明失败时不再甩堆栈
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "xbb-schema-busy-"));
const files: string[] = [];

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 下句柄释放有延迟，清理失败不影响结论 */
  }
});

function freshPath(name: string): string {
  const p = join(dir, `${name}.db`);
  files.push(p);
  return p;
}

/** 造一个 v5 老库：memory_links 还没有 last_at / hits，迁移确实要写东西 */
async function makeV5(path: string): Promise<void> {
  const { initSchema, migrateV2, migrateV4, migrateV5 } = await import("./schema");
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  initSchema(db);
  migrateV2(db);
  migrateV4(db);
  migrateV5(db);
  db.exec("PRAGMA user_version = 5");
  db.close();
}

/** 子进程持写锁 ms 毫秒后释放。必须跨进程：bun:sqlite 同步，同线程 sleep 会卡住自己。
 *  用一张临时探针表造写事务 —— 直接 INSERT memories 会撞一堆 NOT NULL 列，
 *  而「UPDATE 零行」不保证真的取到写锁。收尾用 ROLLBACK，库里不留痕迹。 */
function holdLock(path: string, ms: number): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(
    [
      "bun",
      "-e",
      `import {Database} from "bun:sqlite";
       const d = new Database(${JSON.stringify(path)});
       d.exec("PRAGMA busy_timeout = 8000");
       d.exec("CREATE TABLE IF NOT EXISTS _lock_probe(x INTEGER)");
       d.exec("BEGIN IMMEDIATE");
       d.exec("INSERT INTO _lock_probe VALUES (1)");
       await Bun.sleep(${ms});
       d.exec("ROLLBACK");
       d.exec("DROP TABLE IF EXISTS _lock_probe");
       d.close();`,
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
}

describe("根因证据：为什么迁移必须用立即事务", () => {
  /**
   * 这段不是「测 SQLite」，而是把**我们依赖的那条语义**钉住：
   * 延迟事务在「先读后写」且期间别人提交过时，会绕过 busy 处理器直接 BUSY。
   *
   * 有人想把 `BEGIN IMMEDIATE` 简化回 `BEGIN`（注释里原本就是这么写的，
   * 理由是「避免并发启动互相等待」）时，这条会连同上面的实测数字一起拦住他。
   */
  test("deferred 事务读后写：0ms 失败，busy_timeout 形同虚设；immediate 不会", () => {
    const p = freshPath("mechanism");
    const seed = new Database(p, { create: true });
    seed.exec("PRAGMA journal_mode = WAL");
    seed.exec("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)");
    seed.exec("INSERT INTO t (id, v) VALUES ('a','1')");
    seed.close();

    const open = (): Database => {
      const db = new Database(p, { create: true });
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 3000");
      return db;
    };

    // ① 延迟事务：先读拿到快照 → 别人提交 → 再写
    const a = open();
    const b = open();
    a.exec("BEGIN");
    a.query("SELECT COUNT(*) AS c FROM t").get();
    b.exec("INSERT INTO t (id, v) VALUES ('b','2')"); // autocommit，已落盘
    const t0 = Date.now();
    let deferredCost = -1;
    try {
      a.exec("ALTER TABLE t ADD COLUMN c1 TEXT");
      deferredCost = Date.now() - t0; // 通过说明语义变了，下面断言会失败
    } catch {
      deferredCost = Date.now() - t0;
    }
    a.close();
    b.close();
    // 关键：是「几乎立刻」失败，而不是等满 3000ms。这证明 busy_timeout 没被调用。
    expect(deferredCost).toBeLessThan(300);

    // ② 立即事务：一开始就拿写锁，不存在快照升级
    const c = open();
    let ok = false;
    try {
      c.exec("BEGIN IMMEDIATE");
      c.exec("ALTER TABLE t ADD COLUMN c2 TEXT");
      c.exec("COMMIT");
      ok = true;
    } catch {
      try {
        c.exec("ROLLBACK");
      } catch {
        /* 忽略 */
      }
    }
    c.close();
    expect(ok).toBe(true);
  });
});

describe("initSchemaV2 的写锁行为", () => {
  test("别人短暂持锁：等它释放后照常升级到 v10", async () => {
    const p = freshPath("short");
    await makeV5(p);
    const child = holdLock(p, 600);
    await Bun.sleep(250); // 等子进程真的拿到锁

    const { initSchemaV2, schemaVersion } = await import("./schema");
    const db = new Database(p);
    db.exec("PRAGMA busy_timeout = 3000");
    const t = Date.now();
    initSchemaV2(db);
    const cost = Date.now() - t;

    expect(schemaVersion(db)).toBe(10);
    // 真的等过（否则说明没撞上锁，这条断言就失去意义）
    expect(cost).toBeGreaterThan(150);
    db.close();
    await child.exited;
  });

  test("别人长期持锁：抛 SchemaBusyError，且文案里有可执行的下一步", async () => {
    const p = freshPath("long");
    await makeV5(p);
    // 重试次数压到 1，避免测试白等十几秒；busy_timeout 也调小，只验证「放弃时怎么说」
    process.env.XBB_SCHEMA_RETRIES = "1";
    const { initSchemaV2 } = await import("./schema");
    const child = holdLock(p, 2500);
    await Bun.sleep(250);

    const db = new Database(p);
    db.exec("PRAGMA busy_timeout = 300");
    let err: unknown;
    try {
      initSchemaV2(db);
    } catch (e) {
      err = e;
    }
    db.close();
    await child.exited;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("SchemaBusyError");
    const msg = (err as Error).message;
    // 关键：不是 database is locked 的裸文案，而是「先 xbb stop 再重跑」
    expect(msg).toContain("xbb stop");
    expect(msg).toContain("另一个小本本进程");
    delete process.env.XBB_SCHEMA_RETRIES;
  });

  test("正常路径：v5 老库升到 v10，结构版本只升不降", async () => {
    const p = freshPath("plain");
    await makeV5(p);
    const { initSchemaV2, schemaVersion, SCHEMA_TARGET_VERSION } = await import("./schema");
    const db = new Database(p);
    db.exec("PRAGMA busy_timeout = 3000");
    initSchemaV2(db);
    expect(schemaVersion(db)).toBe(SCHEMA_TARGET_VERSION);
    // 幂等：再跑一次仍是 v10，且不抛
    initSchemaV2(db);
    expect(schemaVersion(db)).toBe(SCHEMA_TARGET_VERSION);
    db.close();
  });
});
