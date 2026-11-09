// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 会话采集的**后台执行器** —— 让采集永远不占主线程。
 *
 * 起因（2026-11-09 实测，本机 110MB 库）：
 *   opencode 1534ms + Cursor 5025ms + WorkBuddy 125ms + Claude 147ms ≈ **6.8 秒**。
 *   `collectClientSessions` 是同步的，跑在主线程上 ⇒ 这 6.8 秒里 HTTP 服务完全不回话：
 *   用户在管理页点一下，页面卡住；每 5 分钟一轮 = 周期性冻结。改样式解决不了，得换线程。
 *
 * 为什么用子进程而不是 Worker：
 *   ① 采集是「读别人的大库（Cursor state.vscdb 可达 GB 级）+ 写自己的库」，进程隔离后
 *      单条脏 JSON 撑爆内存也只是子进程退出，服务本身不受牵连；
 *   ② 单文件 exe 里 `child_process` 的语义比 Worker 稳（不依赖打包器把 worker 入口也塞进产物）。
 *   代价是一轮多花 ~60ms 进程启动 —— 相对 6.8 秒可以忽略。
 *
 * 三条纪律：
 *   · **空闲才开跑**：最近 `idleMs` 内有请求就往后让，不跟用户的操作抢写锁；
 *   · **超时即杀**：一轮超 `timeoutMs` 直接 kill，避免网络盘卡死时留着永久占位的孤儿；
 *   · **失败不吵**：错误只记进状态，页面在"连续失败"时才提一句，不弹窗。
 */
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { programDir, resolveDbPath } from "./home";

/** 子进程回传结果的标记：stdout 里可能有采集本身的日志，靠前缀定位真正那一行。 */
const MARK = "@@XBB_INGEST@@";

const FIRST_DELAY_MS = 20_000; // 首轮：先让端口、托盘、页面安顿好
const INTERVAL_MS = 5 * 60_000;
const IDLE_MS = 2_000; // 最近 2 秒内有人用页面就先让路
const TIMEOUT_MS = 120_000; // 正常一轮 < 10s，120s 还没完必然是卡住了
const DEFER_MS = 5_000; // 不满足空闲条件时，过 5 秒再看

export interface IngestSourceResult {
  label: string;
  inserted: number;
  scanned: number;
  ms: number;
  available: boolean;
}

export interface IngestRunResult {
  ok: boolean;
  inserted: number;
  scanned: number;
  ms: number;
  sources: IngestSourceResult[];
  error?: string;
}

/** 给页面看的快照。字段名就是契约，改之前先看 admin.ts 的 ingestRender。 */
export interface IngestSnapshot {
  /** 本机是否挂了采集器（测试/被关掉的场合为 false，页面据此不显示任何提示） */
  active: boolean;
  enabled: boolean;
  running: boolean;
  /** 本轮已跑多久（毫秒）；不在跑时为 null */
  runningMs: number | null;
  lastRunAt: string | null;
  lastMs: number | null;
  lastInserted: number;
  totalInserted: number;
  runs: number;
  lastError: string | null;
  /** 连续失败轮数：≥2 时页面才提"采集没成功" */
  failStreak: number;
}

// ── 开关：落盘到程序目录，跟 cloud.json / config.json 做邻居 ──────────────
function prefsPath(): string {
  return join(programDir(), "ingest.json");
}

/**
 * 采集开关。
 * 优先级：环境变量 `XBB_INGEST=0`（运维/无头环境的硬开关） > 落盘的开关 > 默认开。
 * 默认开的理由：采不到原话，回忆就只能靠用户手写，产品核心体验直接残一半；
 * 但它只读本机会话、只写本地库，代价是磁盘和一点 CPU，属于"开了更好、且可关"。
 */
export function readIngestEnabled(): boolean {
  if (process.env.XBB_INGEST === "0") return false;
  try {
    const raw = JSON.parse(readFileSync(prefsPath(), "utf8")) as { enabled?: unknown };
    return raw.enabled !== false;
  } catch {
    return true; // 文件不存在/损坏一律按默认开，别让坏文件把用户的采集静默关掉
  }
}

export function writeIngestEnabled(enabled: boolean): void {
  const p = prefsPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  // 先写临时文件再 rename：断电/被杀不会留下半截 JSON（读半边会解析失败→回落默认值→开关"自己变回来"）
  writeFileSync(tmp, JSON.stringify({ enabled }) + "\n", "utf8");
  renameSync(tmp, p);
}

/**
 * 子进程的 argv 前缀。
 * 编译产物：`process.execPath` 就是 xbb 自己 ⇒ 直接接参数。
 * 开发态：`process.execPath` 是 bun 本体 ⇒ 必须补 `run <入口>`，否则 bun 会把 `__ingest`
 * 当成文件名去找（这正是 `detachedServeArgs` 只在编译态可用的那个坑）。
 */
export function selfArgv(args: string[]): string[] {
  const isBunRuntime = /[\\/]bun(\.exe)?$/i.test(process.execPath);
  if (!isBunRuntime) return args;
  return ["run", Bun.main, ...args];
}

/**
 * 打开一个**已经存在**的库：不新建、不迁移。
 *
 * `{ create: false }` 单独传会让 bun:sqlite 抛 SQLITE_MISUSE（1.4.2 实测），
 * 必须把 readwrite 也显式写上 —— 这个坑第一次写时踩到了，靠页面上那条
 *「自动整理连续 N 次没成功」才暴露出来，所以留成函数并配单测。
 */
export function openExistingDb(file: string): Database {
  if (!existsSync(file)) throw new Error(`记忆库不在预期位置：${file}（先启动一次 xbb serve）`);
  return new Database(file, { readwrite: true, create: false });
}

/**
 * 子进程本体：跑一轮采集，把结果以 `MARK + JSON` 打到 stdout。
 * 只做这件事就退出 —— 不装配服务、不挂托盘、不弹窗。
 */
export async function runIngestChild(): Promise<number> {
  const { collectClientSessions } = await import("./ingest");
  const t0 = Date.now();
  let db: Database | null = null;
  try {
    // **不建库、不迁移**：`PersonalStore.open()` 每次都会跑一遍建表迁移（一个写事务，
    // 里面还有 DROP/CREATE VIEW）。父进程服务用户的同时再来一个进程做 DDL，用户点删除就可能
    // 撞上 SQLITE_BUSY。采集只需要"往已有的库里插原话"，库是父进程建的、也是父进程迁移的。
    db = openExistingDb(resolveDbPath());
    // 与父进程同时写库是常态（用户正好在删记忆）：给人让路，多等几秒也别失败
    db.exec("PRAGMA busy_timeout = 8000");
    const r = collectClientSessions(db);
    const payload: IngestRunResult = {
      ok: true,
      inserted: r.inserted,
      scanned: r.scanned,
      ms: Date.now() - t0,
      sources: r.results.map((x) => ({
        label: x.label,
        inserted: x.inserted,
        scanned: x.scanned,
        ms: x.ms,
        available: x.available,
      })),
    };
    process.stdout.write(`\n${MARK}${JSON.stringify(payload)}\n`);
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const payload: IngestRunResult = {
      ok: false,
      inserted: 0,
      scanned: 0,
      ms: Date.now() - t0,
      sources: [],
      error: msg,
    };
    process.stdout.write(`\n${MARK}${JSON.stringify(payload)}\n`);
    return 3;
  } finally {
    try {
      db?.close();
    } catch {
      /* 已经关了 */
    }
  }
}

// ── 调度器 ────────────────────────────────────────────────────────────
export interface IngestSchedulerOptions {
  firstDelayMs?: number;
  intervalMs?: number;
  idleMs?: number;
  timeoutMs?: number;
  /** 距上次 HTTP 请求多少毫秒（从未有请求 ⇒ Infinity）。默认恒为 Infinity（测试/无服务场合）。 */
  idleFor?: () => number;
  /** 注入执行器，仅供测试替换真实子进程 */
  runner?: (timeoutMs: number) => Promise<IngestRunResult>;
  /** 一轮结束后的回调（日志/回显用） */
  onResult?: (r: IngestRunResult) => void;
}

export interface IngestScheduler {
  snapshot(): IngestSnapshot;
  setEnabled(on: boolean): IngestSnapshot;
  /** 立即尝试跑一轮（跳过首轮延迟，仍守空闲闸） */
  poke(): void;
  stop(): void;
}

function spawnChild(timeoutMs: number): Promise<IngestRunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = "";
    let err = "";
    let timedOut = false;
    let done = false;
    const finish = (r: IngestRunResult) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const child = spawn(process.execPath, selfArgv(["__ingest"]), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true, // 别闪一个黑窗口——这条路径每 5 分钟走一次
    });
    const killer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* 已经退了 */
      }
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (err.length < 4096) err += d.toString(); // 只留诊断用的头部，别把内存吃进日志
    });
    child.on("error", (e: Error) => {
      clearTimeout(killer);
      finish({ ok: false, inserted: 0, scanned: 0, ms: Date.now() - started, sources: [], error: `启动失败：${e.message}` });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(killer);
      const line = out
        .split("\n")
        .reverse()
        .find((l) => l.startsWith(MARK));
      if (line) {
        try {
          finish(JSON.parse(line.slice(MARK.length)) as IngestRunResult);
          return;
        } catch {
          /* 落到下面的兜底 */
        }
      }
      const why = timedOut
        ? `超过 ${Math.round(timeoutMs / 1000)} 秒未完成，已中止`
        : `子进程退出（code ${code ?? "?"}）`;
      const tail = err.trim().split("\n").slice(-2).join(" ").slice(0, 300);
      finish({ ok: false, inserted: 0, scanned: 0, ms: Date.now() - started, sources: [], error: tail ? `${why}：${tail}` : why });
    });
  });
}

export function startIngestScheduler(opts: IngestSchedulerOptions = {}): IngestScheduler {
  const firstDelayMs = opts.firstDelayMs ?? FIRST_DELAY_MS;
  const intervalMs = opts.intervalMs ?? INTERVAL_MS;
  const idleMs = opts.idleMs ?? IDLE_MS;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const idleFor = opts.idleFor ?? (() => Infinity);
  const runner = opts.runner ?? spawnChild;

  let enabled = readIngestEnabled();
  let running = false;
  let runningSince = 0;
  let lastRunAt: number | null = null;
  let lastMs: number | null = null;
  let lastInserted = 0;
  let totalInserted = 0;
  let runs = 0;
  let lastError: string | null = null;
  let failStreak = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const later = (ms: number) => {
    if (stopped) return;
    clear();
    timer = setTimeout(tick, ms);
    timer.unref?.();
  };

  async function runOnce() {
    running = true;
    runningSince = Date.now();
    const r = await runner(timeoutMs);
    running = false;
    runs += 1;
    lastRunAt = Date.now();
    lastMs = r.ms;
    lastInserted = r.inserted;
    totalInserted += r.inserted;
    if (r.ok) {
      failStreak = 0;
      lastError = null;
    } else {
      failStreak += 1;
      lastError = r.error ?? "未知错误";
    }
    try {
      opts.onResult?.(r);
    } catch {
      /* 回调出错不该带走调度器 */
    }
    later(intervalMs);
  }

  function tick() {
    if (stopped) return;
    // 磁盘是唯一真源：`xbb ingest off` 改了文件，内存里的开关必须跟上，
    // 否则命令行说"已关闭"、常驻服务却在继续读用户会话 —— 那是最不该撒的谎。
    const disk = readIngestEnabled();
    if (disk !== enabled) enabled = disk;
    if (!enabled) {
      later(60_000); // 关着也留着心跳：用户可能在页面上重新打开
      return;
    }
    if (running) return; // 上一轮还没收尾（超时兜底已 kill，不会真的挂死）
    // 有人正在用页面 ⇒ 往后让。写锁虽然只有一瞬间，但"点了没反应"是最差的体验。
    if (idleFor() < idleMs) {
      later(DEFER_MS);
      return;
    }
    void runOnce();
  }

  const snapshot = (): IngestSnapshot => ({
    active: true,
    enabled,
    running,
    runningMs: running ? Date.now() - runningSince : null,
    lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
    lastMs,
    lastInserted,
    totalInserted,
    runs,
    lastError,
    failStreak,
  });

  later(firstDelayMs);

  // 开关的**旁观者**：命令行改了落盘开关，常驻服务最多 30 秒就跟上。
  // 不靠主循环发现 —— 主循环 5 分钟一轮，用户说了"关掉"却再读 5 分钟会话，
  // 那不是延迟，那是没照做。读一个小 JSON 的成本可以忽略。
  const watcher = setInterval(() => {
    if (stopped) return;
    const disk = readIngestEnabled();
    if (disk === enabled) return;
    enabled = disk;
    if (disk) later(1_000); // 打开：马上试一轮
    else clear(); // 关掉：撤掉已排的下一轮，立刻停手
  }, 30_000);
  watcher.unref?.();

  return {
    snapshot,
    setEnabled(on: boolean) {
      enabled = on;
      try {
        writeIngestEnabled(on);
      } catch {
        /* 落盘失败也要让本次进程内生效，别让用户点了"关"却还在跑 */
      }
      if (on) later(1_000); // 打开后马上试一轮
      return snapshot();
    },
    poke() {
      if (stopped || running) return;
      later(0);
    },
    stop() {
      stopped = true;
      clear();
      clearInterval(watcher);
    },
  };
}

/** 没有调度器的场合（测试、工具脚本）返回的静态快照。 */
export const INACTIVE_SNAPSHOT: IngestSnapshot = {
  active: false,
  enabled: false,
  running: false,
  runningMs: null,
  lastRunAt: null,
  lastMs: null,
  lastInserted: 0,
  totalInserted: 0,
  runs: 0,
  lastError: null,
  failStreak: 0,
};
