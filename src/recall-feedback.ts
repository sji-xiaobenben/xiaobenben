/**
 * 召回反馈：一次「召回成功」在库里应该留下的两笔账。
 *
 *  1. `hit_count`      —— **节点**属性：「这条记忆被用过几次」。
 *  2. `memory_links`   —— **关系**属性：「这两条总是一起出现」。
 *
 * 两者不可互相替代，这也是本模块存在的理由：
 *  节点计数再多，也说明不了「A 和 B 有关」；而关系强度才是 `get_related` /
 *  链接预览能排序的依据。历史问题正是只有第 1 笔、没有第 2 笔
 *  （`reinforce()` 写好了但全仓 0 调用点，weight 恒为 0.5）。
 *
 * 纪律（改这个文件之前先读）：
 *  - **只强化已存在的边，绝不凭共现新建**。`links` 是 AI 写入时显式声明的语义
 *    （related_to / elaborates / caused_by / contradicts）；共现只能调**强度**，
 *    不能替 AI 编造关系类型。若不设此限，一次 5 条命中的召回就要长 10 条边，
 *    库会随查询次数平方膨胀，而且长出来的全是含义不明的 `related_to`。
 *  - **强化必须与衰减同做**。只 +不− ⇒ 每次召回全体 +0.05，几百次后全表 1.0，
 *    `ORDER BY weight` 重新变成空排序。衰减公式不在这里手写，统一拼
 *    `schema.ts:linkDecayFactor()`（唯一真源）。
 */
import type { Database } from "bun:sqlite";
import { LINK_MAX_WEIGHT, LINK_REINFORCE_STEP, linkDecayFactor } from "./schema";

/** 单次共现最多参与的节点数。召回榜越长，两两组合越爆炸，取榜前 N = 最可能被一起采用的。 */
export const CO_OCCUR_MAX_NODES = 30;

/**
 * 强化起点：**共现一次就至少回到「普通关联」基线**。
 *
 * 为什么不是纯 `w * decay + step`：一条边若 90 天没被共现，衰减到 0.5×0.5³ ≈ 0.06，
 * 之后每共现一次只 +0.05，要 8 次才爬回 0.46 —— 期间它在 `get_related` 里
 * 一直被 0.2 门槛挡着，用户体感是「明明一起出现过却查不到关联」。
 * 所以把基线 0.5（建边默认值）作为回升地板：衰减负责**降**，共现负责**至少回到基线**，
 * 只有反复共现才会升到 0.5 以上 —— 这才是「越用越强」能成立的最小机制。
 */
export const LINK_SEED_WEIGHT = 0.5;

/** 回忆命中计数：任一召回通道命中即 +1（**只统计**，「价值反馈」在云端 rerank 才参与排序） */
export function bumpHits(db: Database, ids: string[]): void {
  if (!ids.length) return;
  const ph = ids.map(() => "?").join(",");
  db.prepare(`UPDATE memories SET hit_count = COALESCE(hit_count, 0) + 1 WHERE id IN (${ph})`).run(...ids);
}

/**
 * 赫布式强化（按**共现对**，不是按节点）。
 *
 * 原始赫布语义：一起激活的两个神经元之间连接变强 —— 落点是**边**。
 * 旧实现 `WHERE from_id = ? OR to_id = ?` 强化的是「被召回的节点的所有边」，
 * 不管两端是否真的一起出现过；那等价于「人缘好的人的所有朋友都变亲密」，
 * 而且还和 `hit_count` 重复计分。
 *
 * 现在：`from_id IN (本次召回集) AND to_id IN (本次召回集)` —— 两端都在榜内才算共现。
 *
 * @returns 被强化的边数（0 = 本次召回没有「彼此已建边」的组合）
 */
export function reinforceCooccurrence(
  db: Database,
  ids: string[],
  now: string = new Date().toISOString(),
): number {
  const uniq = [...new Set(ids.filter(Boolean))].slice(0, CO_OCCUR_MAX_NODES);
  if (uniq.length < 2) return 0; // 一条记忆没有「对」可言

  const ph = uniq.map(() => "?").join(",");
  const r = db
    .prepare(
      `UPDATE memory_links
          SET weight  = MIN(${LINK_MAX_WEIGHT},
                            MAX(weight * ${linkDecayFactor()}, ${LINK_SEED_WEIGHT}) + ${LINK_REINFORCE_STEP}),
              last_at = ?,
              hits    = hits + 1
        WHERE from_id IN (${ph}) AND to_id IN (${ph})`,
    )
    .run(now, ...uniq, ...uniq);
  return r.changes;
}

/**
 * 召回统一出口：所有「这批记忆被返回给 AI」的地方都调它，而不是各写各的。
 *
 * 为什么集中：四个召回入口（search / topic / timeline / session）原先只有
 * `bumpHits` 一个副作用，谁加了新副作用就漏三个。放在一个函数里，
 * 新入口只要调 `onRecalled` 就自动享受全部反馈机制。
 */
export function onRecalled(db: Database, ids: string[]): void {
  if (!ids.length) return;
  bumpHits(db, ids);
  reinforceCooccurrence(db, ids);
}
