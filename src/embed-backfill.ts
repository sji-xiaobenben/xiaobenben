// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 存量向量回填。
 *
 * 写入路径的向量是 fire-and-forget 的（memory-write.ts 第 10 步）：模型没就绪、进程在
 * embed 完成前就退出、或者早期 bulk_import 灌进来的行 —— 这些行的 embedding 会永久停在
 * NULL，而它们**自己不会重来**。检索侧只认 `embedding IS NOT NULL`（见 vecTopK），
 * 于是这些记忆在语义通道里等于不存在，且没有任何信号：命中数看着正常，只是
 * 「用词不同的那条」永远搜不到。
 *
 * 实测：576 条活跃记忆里 121 条（21%）是 NULL，全部来自 10-03 那次批量导入。
 *
 * 三条纪律：
 *  1. 幂等。同一行被重复 embed 只是白算一遍，写不坏 —— 多个客户端进程并发跑也不打架
 *     （代价仅是同一批 CPU 干两遍，所以这里不做跨进程抢占，那套 claim 状态的复杂度
 *     换来的是「进程被杀后行卡在 pending 里」这种新故障）。
 *  2. 让出事件循环。这是后台活，MCP 还得在这期间回答工具调用，不能一口气霸住单线程。
 *  3. 只写 stderr。MCP 的 stdout 是 JSON-RPC 帧流，任何一行不是帧的输出都会把连接搞死。
 */
import type { Database } from "bun:sqlite";
import { embedder, VEC_MODEL } from "./embedder";
import { invalidateVecCache } from "./memory-search";

/** 一批 16 条：够摊薄往返开销，又不至于让一次检索排在太长的同步块后面 */
const BATCH = 16;

export interface BackfillOutcome {
  /** 本次候选行数（已回填过的不在内） */
  total: number;
  done: number;
  failed: number;
}

/**
 * 回填缺失的向量。自带一次幂等加载（已就绪时立刻返回 true），模型不可用就直接放弃 ——
 * 「模型没下下来」不该变成一次全表空扫，也不该要求调用方记得先 load 过。
 *
 * @param reembed 连 vec_model 对不上的行一起重算（换模型才有意义）。
 *                默认取 `XBB_REEMBED=1` —— 整库重算是几十分钟的 CPU，
 *                必须是有人明确要求，不能因为某次升级就自己跑起来。
 */
export async function backfillEmbeddings(
  db: Database,
  opts: { reembed?: boolean } = {},
): Promise<BackfillOutcome> {
  const reembed = opts.reembed ?? process.env.XBB_REEMBED === "1";
  // 自带一次幂等加载（就绪后立刻返回）。原来这里隐含要求「调用方先 load 过」——
  // 而漏掉这一步的表现是「一条都算不出来」：total 有 121，done 是 0，
  // 日志还写着「下次启动再试」，看着像模型坏了。这个模块存在的理由就是消灭这类沉默，
  // 自己不能是下一个。
  if ((await embedder.load()) !== true) {
    process.stderr.write("[xbb] 向量回填跳过: 模型不可用\n");
    return { total: 0, done: 0, failed: 0 };
  }
  const where = reembed
    ? "deleted_at IS NULL AND status = 'active' AND length(content) > 0 AND (embedding IS NULL OR vec_model IS NULL OR vec_model != ?)"
    : "deleted_at IS NULL AND status = 'active' AND length(content) > 0 AND embedding IS NULL";
  const args: string[] = reembed ? [VEC_MODEL] : [];

  const total = (db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE ${where}`).get(...args) as { c: number }).c;
  if (!total) return { total: 0, done: 0, failed: 0 };
  process.stderr.write(`[xbb] 向量回填开始: ${total} 条${reembed ? "（含换模型重算）" : ""}\n`);

  // 游标走 rowid 而不是 OFFSET：回填会把行从结果集里摘掉，OFFSET 会随之前移漏行。
  const pick = db.prepare(
    `SELECT rowid AS rid, id, content FROM memories WHERE ${where} AND rowid > ? ORDER BY rowid ASC LIMIT ${BATCH}`,
  );
  const save = db.prepare("UPDATE memories SET embedding = ?, vec_model = ? WHERE id = ?");

  let cursor = 0;
  let done = 0;
  let failed = 0;
  for (;;) {
    const rows = pick.all(...args, cursor) as Array<{ rid: number; id: string; content: string }>;
    if (!rows.length) break;
    for (const r of rows) {
      cursor = r.rid; // 成败都推进：失败的行不该把游标钉死在这里形成死循环
      const vec = await embedder.embed(r.content);
      if (!vec) {
        failed++;
        continue;
      }
      save.run(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), VEC_MODEL, r.id);
      done++;
    }
    // 只扫了一遍就断定模型不行，别把整库空跑完（全失败通常是状态是 failed，
    // embed 会立刻返回 null —— 那属于"注定徒劳"，早点交还 CPU）
    if (done === 0 && embedder.status !== "ready") break;
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  // 本连接自己更新已有行：data_version 与 MAX(rowid) 都不变，vecCache 无从察觉
  // （见 memory-search.ts 的失效点说明）。
  if (done) invalidateVecCache();
  process.stderr.write(
    `[xbb] 向量回填完成: ${done}/${total}${failed ? `，失败 ${failed}（下次启动再试）` : ""}\n`,
  );
  return { total, done, failed };
}
