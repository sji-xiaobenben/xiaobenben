// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 采集调度器的行为闸。
 *
 * 这里**不跑真实子进程**：那会把本机几万条会话读一遍、再写进真库，测试该是幂等且快的。
 * 所以只锁三件容易写错、且错了用户能明显感知的事：
 *   ① 开关优先级（环境变量 > 落盘 > 默认开）；
 *   ② 空闲闸（有人在用页面就不能开跑，否则写完锁会挡住用户点击）；
 *   ③ 快照字段（页面的「温馨提示」直接吃这些字段，改名字就会静默不显示）。
 */
import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "xbb-ingest-job-"));
const OLD_HOME = process.env.XBB_HOME;
const OLD_INGEST = process.env.XBB_INGEST;

// programDir() 每次调用都读 env，所以这里改的是"这台机器"，不是模块级缓存
process.env.XBB_HOME = dir;
delete process.env.XBB_INGEST;

const { readIngestEnabled, writeIngestEnabled, startIngestScheduler, selfArgv, openExistingDb } = await import("./ingest-job");

const okRun = { ok: true, inserted: 7, scanned: 9, ms: 3, sources: [] };

afterAll(() => {
  if (OLD_HOME === undefined) delete process.env.XBB_HOME;
  else process.env.XBB_HOME = OLD_HOME;
  if (OLD_INGEST === undefined) delete process.env.XBB_INGEST;
  else process.env.XBB_INGEST = OLD_INGEST;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* 临时目录残留不影响断言 */
  }
});

describe("采集开关：环境变量 > 落盘 > 默认开", () => {
  test("没有落盘文件时默认开", () => {
    expect(readIngestEnabled()).toBe(true);
  });

  test("XBB_INGEST=0 一票否决，且不依赖落盘文件", () => {
    writeIngestEnabled(true);
    process.env.XBB_INGEST = "0";
    expect(readIngestEnabled()).toBe(false);
    delete process.env.XBB_INGEST;
    expect(readIngestEnabled()).toBe(true);
  });

  test("落盘开关可往返，且是合法 JSON", () => {
    writeIngestEnabled(false);
    expect(readIngestEnabled()).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "ingest.json"), "utf8"))).toEqual({ enabled: false });
    writeIngestEnabled(true);
    expect(readIngestEnabled()).toBe(true);
  });

  test("落盘文件损坏时回落到默认开，而不是静默关掉采集", () => {
    const p = join(dir, "ingest.json");
    Bun.write(p, "{ 这不是 JSON");
    // 写入是异步的，等它落盘再读（同步读只有几毫秒的窗口）
    return Bun.sleep(50).then(() => expect(readIngestEnabled()).toBe(true));
  });
});

describe("调度器：空闲闸与快照", () => {
  test("有空闲窗口就跑一轮，并把结果写进快照", async () => {
    let calls = 0;
    const s = startIngestScheduler({
      firstDelayMs: 0,
      intervalMs: 60_000,
      idleFor: () => Infinity,
      runner: async () => {
        calls += 1;
        return okRun;
      },
    });
    await Bun.sleep(80);
    const snap = s.snapshot();
    s.stop();
    expect(calls).toBe(1);
    expect(snap.active).toBe(true);
    expect(snap.runs).toBe(1);
    expect(snap.lastInserted).toBe(7);
    expect(snap.totalInserted).toBe(7);
    expect(snap.running).toBe(false);
    expect(snap.lastError).toBe(null);
  });

  test("有人正在用页面（刚发过请求）就不开跑，改为延后再看", async () => {
    let calls = 0;
    const s = startIngestScheduler({
      firstDelayMs: 0,
      intervalMs: 60_000,
      idleMs: 2_000,
      idleFor: () => 10, // 10ms 前刚有人请求
      runner: async () => {
        calls += 1;
        return okRun;
      },
    });
    await Bun.sleep(120);
    s.stop();
    expect(calls).toBe(0); // 让路，一条都没跑
  });

  test("失败会记进快照并累加连续失败数（页面据此提示，而不是弹窗）", async () => {
    const s = startIngestScheduler({
      firstDelayMs: 0,
      intervalMs: 40,
      idleFor: () => Infinity,
      runner: async () => ({ ok: false, inserted: 0, scanned: 0, ms: 1, sources: [], error: "读不到 Cursor 库" }),
    });
    await Bun.sleep(120);
    const snap = s.snapshot();
    s.stop();
    expect(snap.failStreak).toBeGreaterThanOrEqual(1);
    expect(snap.lastError).toContain("Cursor");
  });

  test("关掉后立刻生效：不再触发新一轮，且落盘", async () => {
    let calls = 0;
    const s = startIngestScheduler({
      firstDelayMs: 60_000,
      intervalMs: 60_000,
      idleFor: () => Infinity,
      runner: async () => {
        calls += 1;
        return okRun;
      },
    });
    const off = s.setEnabled(false);
    expect(off.enabled).toBe(false);
    expect(readIngestEnabled()).toBe(false);
    s.poke(); // 关着的时候 poke 也不该跑
    await Bun.sleep(80);
    s.stop();
    expect(calls).toBe(0);
    writeIngestEnabled(true); // 还原，别影响后面的用例
  });
});

describe("子进程入参", () => {
  test("开发态必须带上 run + 入口路径（否则 bun 会把 __ingest 当文件名）", () => {
    const isBunRuntime = /[\\/]bun(\.exe)?$/i.test(process.execPath);
    const argv = selfArgv(["__ingest"]);
    if (isBunRuntime) {
      expect(argv[0]).toBe("run");
      expect(argv[1]).toContain("."); // 入口脚本路径
      expect(argv[argv.length - 1]).toBe("__ingest");
    } else {
      expect(argv).toEqual(["__ingest"]); // 编译产物：参数直传
    }
  });
});

describe("子进程打开库：不建、不迁移", () => {
  test("打不开不存在的库，且不会顺手把它建出来", () => {
    const missing = join(dir, "nope.db");
    expect(existsSync(missing)).toBe(false);
    expect(() => openExistingDb(missing)).toThrow(/不在预期位置/);
    expect(existsSync(missing)).toBe(false); // 关键：失败不能留下一个空库
  });

  test("打开已存在的库可读写（readwrite+create:false 的组合是 bun 的要求）", async () => {
    const file = join(dir, "tiny.db");
    const made = new Database(file, { create: true });
    made.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('x')");
    made.close();
    const db = openExistingDb(file);
    expect((db.query("SELECT v FROM t").get() as { v: string }).v).toBe("x");
    db.exec("PRAGMA busy_timeout = 8000"); // 子进程里紧接着就会跑这句
    db.close();
    await Bun.sleep(10);
  });
});
