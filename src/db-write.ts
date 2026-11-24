// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 写事务的统一入口。
 *
 * ## 为什么需要它
 *
 * 同一个 `memory.db` 上至少有四个写者，而且是**四个进程**：
 *   · `xbb mcp`（AI 调 write_memory / supersede / log_episodes）
 *   · `xbb serve`（采集器、管理页操作）
 *   · `ingest-job`（原话成批落库，独立子进程）
 *   · `recall-feedback`（每次检索都 `UPDATE hit_count`）—— 读操作里藏着写
 *
 * SQLite 的写锁是独占的：WAL 只放开"多读"，写永远只有一个。所以问题不是「能不能
 * 并发写」，而是「抢不到锁的那一方会怎样」。
 *
 * ## 两个坑，都在这里堵
 *
 * **① `BEGIN`（deferred）会让 `busy_timeout` 失效。**
 * deferred 事务先拿读锁，第一条写语句时才尝试升级成写锁。若这期间别人提交过写，
 * 手里的读快照已经过期，SQLite 判定无法升级，**直接返回 SQLITE_BUSY，根本不调用
 * 忙等待处理器** —— `PRAGMA busy_timeout = 3000` 形同虚设。
 * 实测（同库同条件）：`BEGIN` 0ms 失败；`BEGIN IMMEDIATE` 4ms 成功；
 * `BEGIN IMMEDIATE` + 对方持锁 1.2s → 861ms 等到锁后成功。
 *
 * **② 撞上锁就抛错，用户看到的是"保存失败"，真实原因只是"晚了几毫秒"。**
 * 单靠 busy_timeout 干等也够用，但等满 3 秒再失败对交互太糟。这里加一层**短退避重试**：
 * 10 / 40 / 120ms 三次。写事务通常毫秒级结束，撞上多半是对方正在提交，
 * 几十毫秒内就能排上队。
 *
 * ## 重试为什么是安全的
 *
 * `BEGIN IMMEDIATE` 失败时事务**根本没开始**，回调一次都没跑。
 * 回调内部失败时会先回滚再重试，前一次的写入全部作废。
 * 所以调用方可以放心重跑，前提是**回调本身没有副作用** ——
 * 累积结果请用返回值往外带，不要往闭包变量里 push（重试会重复累积）。
 */

import type { Database } from "bun:sqlite";
import { dict } from "./i18n";

/**
 * 是不是"锁被占"这一类错误。
 *
 * 判据必须**只认锁**：把「这不是库」「磁盘满」「权限不足」混进来，会让一个编码错误
 * 伪装成环境问题，用户按提示去关进程、关到天荒地老也没用（`dbLocked` 就这么踩过）。
 *
 * 同时认 `SQLITE_LOCKED`：SQLite 用错误码区分「别人持有锁」（BUSY）与
 * 「同连接/同表冲突」（LOCKED），对调用方而言处置方式一样 —— 等一下再试。
 */
export function isBusyError(e: unknown): boolean {
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|table is locked/i.test(
    e instanceof Error ? e.message : String(e),
  );
}

/**
 * 唯一约束冲突。
 *
 * 事件链的 `(org_id, org_seq)` 靠它发现"我算的 seq 被人抢了"，
 * 与锁冲突不同 —— 这个不需要等待，重新读一遍最新水位再算即可。
 */
export function isUniqueViolation(e: unknown): boolean {
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(
    e instanceof Error ? e.message : String(e),
  );
}

/** 同步退避睡眠；`Atomics.wait` 不烧 CPU（写路径是同步的，只能用同步等待）。 */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 重试退避序列（毫秒）。用尽后抛错。
 *
 * 刻意**比结构迁移的退避短得多**（那边是 200/400/600ms）：迁移要跑几百条 DDL、
 * 持锁几百毫秒是正常的，值得老实多等；一次普通写入持锁是微秒到毫秒级，
 * 等不到就是真的被卡住了，再等也没用，不如早点把话说清楚。
 *
 * 环境变量可在测试里压到 0 次，验证"重试用尽"这条路径而不必真的等 170ms。
 */
export function writeBackoff(): number[] {
  const raw = process.env.XBB_WRITE_BACKOFF;
  if (raw != null) {
    const list = raw
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0);
    if (list.length) return list;
  }
  return [10, 40, 120];
}

export interface WriteTxOptions {
  /** 撞锁后额外重试几次。默认取 writeBackoff() 的长度 */
  retries?: number;
  /** 自定义退避序列（毫秒），长度决定重试次数 */
  backoffMs?: number[];
  /** 撞锁重试用尽时抛什么。默认 DbBusyError，测试可换成哨兵值 */
  onExhausted?: (detail: string) => Error;
}

/**
 * 在一个 `BEGIN IMMEDIATE` 事务里跑 `fn`，撞锁则退避重试。
 *
 * 已经在事务里时**直接执行 fn**，不嵌套 BEGIN（SQLite 不支持嵌套事务，
 * 硬开会抛 `cannot start a transaction within a transaction`）。
 * 嵌套时也**不接管回滚**：外层事务的边界由外层负责，内层擅自 ROLLBACK
 * 会把外层还没做完的写入一起丢掉。
 */
export function withWriteTx<T>(db: Database, fn: () => T, opts: WriteTxOptions = {}): T {
  if (db.inTransaction) return fn();

  const backoff = opts.backoffMs ?? writeBackoff();
  const retries = opts.retries ?? backoff.length;
  const makeError = opts.onExhausted ?? ((detail: string) => new DbBusyError(detail));

  let lastDetail = "";
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        // 回滚失败不再抛：SQLite 在部分错误下已自动回滚，此时 ROLLBACK 会报
        // 「no transaction is active」，盖掉真正的错误原因。原错误必须原样抛出。
        try {
          db.exec("ROLLBACK");
        } catch {
          /* 已自动回滚 */
        }
        throw e;
      }
    } catch (e) {
      if (!isBusyError(e)) throw e;
      lastDetail = e instanceof Error ? e.message : String(e);
      if (attempt >= retries) throw makeError(lastDetail);
      sleepSync(backoff[attempt] ?? backoff[backoff.length - 1] ?? 0);
    }
  }
}

/**
 * 写库撞锁、重试用尽 —— 必须给人话。
 *
 * 与 `SchemaBusyError` 分开：那条讲的是"结构升级等着大家停一下"，这条讲的是
 * "这次没写进去"。把两者混成一句话，用户会以为升级又失败了。
 */
export class DbBusyError extends Error {
  constructor(detail: string) {
    super(dict().dbGate.writeBusy(detail));
    this.name = "DbBusyError";
  }
}
