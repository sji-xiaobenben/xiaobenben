// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 写事务的守门测试。
 *
 * 这里每条都在钉一个**具体的历史故障**，不是泛泛地测"能不能写"：
 *  · 半条记忆（正文进去了、词项没进）
 *  · 撞锁后 0ms 瞬败（busy_timeout 形同虚设）
 *  · 撞锁退避用尽却把半截写入留在库里
 *  · 嵌套事务抛 "cannot start a transaction within a transaction"
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { DbBusyError, isBusyError, sleepSync, withWriteTx } from "./db-write";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    // Windows 上 WAL/SHM 的句柄会晚几毫秒才真正释放，`force` 只忽略"不存在"、忽略不了 EBUSY。
    // 清理临时目录失败不该记成测试失败 —— 那会把一个环境噪音变成"红线"。
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 交给系统临时目录清理 */
    }
  }
});

function freshPath(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `xbb-dw-${tag}-`));
  dirs.push(d);
  return join(d, "t.db");
}

/** 造一张只有两列的小表：写入路径要短，测的是事务边界而不是业务 */
function seed(path: string): void {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)");
  db.close();
}

/**
 * 子进程持写锁 ms 毫秒。
 *
 * **必须跨进程**：bun:sqlite 是同步 API，同线程里 sleep 会把持锁者自己一起卡住。
 * 用信号文件报"锁已拿到"，主进程不必靠 sleep 猜启动时间 —— 猜早了会误判成"没撞锁"，
 * 那样这个测试就只能证明"写入能成功"，完全测不到退避。
 */
function holdLock(path: string, ms: number, tag: string): { waitLocked: () => void } {
  const sig = `${path}.${tag}.locked`;
  const child = Bun.spawn(
    [
      "bun",
      "-e",
      `import {Database} from "bun:sqlite";
       import {writeFileSync} from "node:fs";
       const d = new Database(${JSON.stringify(path)});
       d.exec("PRAGMA busy_timeout = 8000");
       d.exec("CREATE TABLE IF NOT EXISTS _lock_probe(x INTEGER)");
       d.exec("BEGIN IMMEDIATE");
       d.exec("INSERT INTO _lock_probe VALUES (1)");
       writeFileSync(${JSON.stringify(sig)}, "1");
       await Bun.sleep(${ms});
       d.exec("ROLLBACK");
       d.exec("DROP TABLE IF EXISTS _lock_probe");
       d.close();`,
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
  return {
    waitLocked: () => {
      for (let i = 0; i < 600; i++) {
        if (existsSync(sig)) return;
        sleepSync(10);
      }
      throw new Error("持锁子进程 6 秒内没拿到锁，测试环境异常");
    },
  };
}

describe("withWriteTx 的边界", () => {
  test("正常路径：提交后能读到，返回回调的返回值", () => {
    const p = freshPath("ok");
    seed(p);
    const db = new Database(p);
    const out = withWriteTx(db, () => {
      db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run("a", "1");
      return "done";
    });
    expect(out).toBe("done");
    expect((db.query("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c).toBe(1);
    db.close();
  });

  test("回调抛错：第一行写入也必须一起回滚（半条记忆的根）", () => {
    const p = freshPath("rollback");
    seed(p);
    const db = new Database(p);
    expect(() =>
      withWriteTx(db, () => {
        db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run("a", "1");
        throw new Error("第二行失败");
      }),
    ).toThrow("第二行失败");
    // 反面：不包事务的实现，这里会是 1 —— 正是"正文进去了、词项没进"的样子
    expect((db.query("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c).toBe(0);
    // 事务确实退出了，连接还能继续用
    withWriteTx(db, () => db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run("b", "2"));
    expect((db.query("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c).toBe(1);
    db.close();
  });

  test("撞锁后短退避能抢到（而不是 0ms 瞬败放弃）", () => {
    const p = freshPath("retry");
    seed(p);
    const holder = holdLock(p, 40, "retry");
    holder.waitLocked();
    const db = new Database(p);
    // busy_timeout 设 0：让"撞锁"这件事立刻暴露，测的完全是 withWriteTx 自己的退避，
    // 不靠 SQLite 的忙等待兜底 —— 否则删掉退避逻辑测试照样绿。
    db.exec("PRAGMA busy_timeout = 0");
    const ok = withWriteTx(
      db,
      () => {
        db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run("a", "1");
        return true;
      },
      { backoffMs: [20, 40, 200] },
    );
    expect(ok).toBe(true);
    expect((db.query("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c).toBe(1);
    db.close();
  });

  test("退避用尽：抛人话错误，且库里一条都不留", () => {
    const p = freshPath("exhausted");
    seed(p);
    const holder = holdLock(p, 400, "exhausted");
    holder.waitLocked();
    const db = new Database(p);
    db.exec("PRAGMA busy_timeout = 0");
    let caught: unknown = null;
    try {
      withWriteTx(
        db,
        () => db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run("a", "1"),
        { backoffMs: [0, 0] },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DbBusyError);
    // 话术必须能告诉用户"这次没写进去"，而不是甩一句 database is locked
    expect((caught as Error).message).toContain("没写进");
    // 关键：失败的写不许留在库里
    expect((db.query("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c).toBe(0);
    db.close();
  });

  test("已在事务里：直接执行，不嵌套 BEGIN", () => {
    const p = freshPath("nested");
    seed(p);
    const db = new Database(p);
    db.exec("BEGIN IMMEDIATE");
    // 反面：老实现无条件 exec("BEGIN IMMEDIATE")，这一句会抛
    // "cannot start a transaction within a transaction"
    const out = withWriteTx(db, () => {
      db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run("a", "1");
      return "inner";
    });
    expect(out).toBe("inner");
    // 内层不许自行 COMMIT/ROLLBACK —— 外层还没做完，边界归外层
    expect(db.inTransaction).toBe(true);
    db.exec("COMMIT");
    expect((db.query("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c).toBe(1);
    db.close();
  });

  test("内层抛错时不吞掉外层事务（由外层决定回滚）", () => {
    const p = freshPath("nested-throw");
    seed(p);
    const db = new Database(p);
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run("keep", "1");
    expect(() =>
      withWriteTx(db, () => {
        throw new Error("内层失败");
      }),
    ).toThrow("内层失败");
    // 外层还在，前面那条写还在 —— 内层不许替外层做回滚决定
    expect(db.inTransaction).toBe(true);
    db.exec("COMMIT");
    expect((db.query("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c).toBe(1);
    db.close();
  });
});

describe("isBusyError 只认锁", () => {
  test("锁类错误认，非锁错误不认", () => {
    expect(isBusyError(new Error("SQLITE_BUSY: database is locked"))).toBe(true);
    expect(isBusyError(new Error("SQLITE_LOCKED: table is locked"))).toBe(true);
    // 下面这些混进来，等于把编码错误伪装成环境问题 —— 用户会去关进程、关到天荒地老
    expect(isBusyError(new Error("SQLITE_CORRUPT: database disk image is malformed"))).toBe(false);
    expect(isBusyError(new Error("SQLITE_FULL: database or disk is full"))).toBe(false);
    expect(isBusyError(new Error("SQLITE_READONLY: attempt to write a readonly database"))).toBe(false);
    expect(isBusyError(new Error("no such table: memories"))).toBe(false);
  });
});
