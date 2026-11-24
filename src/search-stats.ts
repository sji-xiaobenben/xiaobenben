// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 检索观测的落库与摘要。
 *
 * 这个模块只做两件事：把 `SearchStats` 写进 `search_stats` 表、把最近若干次读成一个
 * 摘要。它**不参与检索决策**，任何一行代码都不该影响检索结果 —— 所以写入路径整体包在
 * `try/catch` 里静默吞咽。观测系统自己把检索搞挂，比没有观测更糟。
 *
 * 为什么单独一张表、而不是写 `events`：见 `schema.ts` 的 `migrateV12` 注释 ——
 * `events` 是哈希链凭证层，每条要算 prev_hash、`verifyChain` 会全表遍历。
 * 检索是读操作，一次搜索一条凭证既不合账本语义，也会把链拖成 O(搜索次数)。
 *
 * 表有封顶：检索次数天然无上界，一天几百次、一年十几万行，比记忆本身还大。
 * 只留最近若干条 —— 归因要看的是「最近怎么了」，不是全历史。
 */
import type { Database } from "bun:sqlite";
import type { SearchStats } from "./memory-search";

/** 表里最多留多少行。超过就裁到 KEEP_ROWS。 */
const MAX_ROWS = 5000;
/** 裁剪后保留的行数。留出余量，避免每插入一行就裁一次。 */
const KEEP_ROWS = 4000;
/** 距上次裁剪至少又插入了这么多行，才再裁一次。 */
const TRIM_EVERY = 64;

/** 上次裁剪时的 id 水位。模块级：跨进程无效也没关系，最坏多裁一次。 */
let trimmedAt = 0;

/**
 * 记一条。**永不抛错、永不返回失败** —— 调用方不该为观测写分支。
 *
 * 注意这里没有 `await`：表是普通表，一条 INSERT 是微秒级，故意同步做完，
 * 免得给检索路径塞一个未等待的 Promise（`xbb mcp` 进程退出时可能被吞掉）。
 */
export function recordSearchStats(db: Database, s: SearchStats): void {
  try {
    const r = db
      .query(
        `INSERT INTO search_stats
           (at, terms_n, fts_n, inv_n, ent_n, ng_n, cand_n, hit_n,
            vec_status, vec_n, tokens, ms_lex, ms_all, src_top, has_win, budget)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        s.termsN,
        s.ftsN,
        s.invN,
        s.entN,
        s.ngN,
        s.candN,
        s.hitN,
        s.vecStatus ?? null,
        s.vecN ?? null,
        s.tokens,
        s.msLex,
        s.msAll,
        s.srcTop,
        s.hasWindow ? 1 : 0,
        s.budget,
      );
    const id = Number(r.lastInsertRowid);
    // 判据用 id 而不是 count：`id` 单调且走主键索引，count 要扫。AUTOINCREMENT 保证
    // 不复用旧 id，所以 `id <= 水位` 一定是「更旧的那批」。
    if (id > MAX_ROWS && id - trimmedAt >= TRIM_EVERY) {
      trimmedAt = id;
      db.query("DELETE FROM search_stats WHERE id <= ?").run(id - KEEP_ROWS);
    }
  } catch {
    /* 表不存在（旧库还没迁移）、库只读、磁盘满 —— 都不该让检索失败 */
  }
}

export interface SearchHealth {
  /** 窗口内统计到的检索次数 */
  n: number;
  days: number;
  p50ms: number | null;
  p90ms: number | null;
  /** 语义通道真出故障（not-ready / error）的次数 */
  degraded: number;
  /** 语义通道根本没跑（empty-index 或纯词法调用）的次数 */
  noVec: number;
  /** 各通道「命中数 > 0」的检索占比，0..1；分母是 n */
  chanRate: { fts: number; inv: number; ent: number; ng: number };
  /**
   * 混合检索结果里纯向量命中的占比，0..1；窗口内没有成功混合检索时为 null。
   *
   * 这个数掉到 0 而 `n` 还在涨，等于「语义通道在跑但一条都没捞到」——
   * 它塌掉时结果集看起来完全正常（词法那几路照样出东西），只有这个比值会说话。
   */
  vecShare: number | null;
  /** 一条都没搜到的检索占比 */
  emptyRate: number;
  lastAt: string | null;
}

/**
 * 读最近 `days` 天的摘要。表不存在（旧库）返回 `null`，由调用方决定怎么显示。
 *
 * 时间比较一律用 ISO 字符串、两边都带 Z：ISO 8601 在 UTC 下字典序 == 时间序。
 * **不能**拿 `datetime('now', '-7 days')` 去和这里的 `at` 比 —— 那个函数返回空格分隔格式，
 * 而 `'T'`(0x54) > `' '`(0x20)，同一天内会把边界之外的记录算进来（这个坑在原话层踩过）。
 */
export function readSearchHealth(db: Database, days = 7): SearchHealth | null {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  let rows: Array<{
    at: string;
    ms_all: number;
    hit_n: number;
    fts_n: number;
    inv_n: number;
    ent_n: number;
    ng_n: number;
    vec_status: string | null;
    vec_n: number | null;
    src_top: string;
  }>;
  try {
    rows = db
      .query(
        `SELECT at, ms_all, hit_n, fts_n, inv_n, ent_n, ng_n, vec_status, vec_n, src_top
           FROM search_stats WHERE at >= ? ORDER BY id DESC LIMIT 5000`,
      )
      .all(cutoff) as typeof rows;
  } catch {
    return null; // 表不存在
  }
  if (!rows.length) {
    return {
      n: 0,
      days,
      p50ms: null,
      p90ms: null,
      degraded: 0,
      noVec: 0,
      chanRate: { fts: 0, inv: 0, ent: 0, ng: 0 },
      vecShare: null,
      emptyRate: 0,
      lastAt: null,
    };
  }

  const n = rows.length;
  const times = rows.map((r) => r.ms_all).sort((a, b) => a - b);
  // 分位取「不超过该位置的最后一个」，与 store.stats 里 links.weight 的口径一致。
  const at = (p: number) => Math.round(times[Math.min(n - 1, Math.floor(p * n))]! * 100) / 100;
  const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;

  let vecTotal = 0;
  let vecOnly = 0;
  for (const r of rows) {
    if (r.vec_status !== "ok") continue;
    const s = r.src_top ?? "";
    // 只数「语义通道真的参与并出了结果」的那批，空串不贡献分母 ——
    // 否则向量占比会被一堆没走向量的检索稀释成一个永远偏低的数。
    if (!s) continue;
    vecTotal += s.length;
    for (const ch of s) if (ch === "V") vecOnly++;
  }

  return {
    n,
    days,
    p50ms: at(0.5),
    p90ms: at(0.9),
    degraded: count((r) => r.vec_status != null && r.vec_status !== "ok" && r.vec_status !== "empty-index"),
    noVec: count((r) => r.vec_status == null || r.vec_status === "empty-index"),
    chanRate: {
      fts: count((r) => r.fts_n > 0) / n,
      inv: count((r) => r.inv_n > 0) / n,
      ent: count((r) => r.ent_n > 0) / n,
      ng: count((r) => r.ng_n > 0) / n,
    },
    vecShare: vecTotal ? vecOnly / vecTotal : null,
    emptyRate: count((r) => r.hit_n === 0) / n,
    lastAt: rows[0]!.at,
  };
}
