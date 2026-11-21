// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 蒸馏状态判定 —— 「记忆层是不是停在那儿不动了」。
 *
 * 为什么需要它（2026-11-14 真实事故）：
 * 库里有两层。`episodes`（逐字原话）由采集器自动写，不需要 AI 做任何事；
 * `memories`（蒸馏过的长期记忆）**只能由 AI 主动调 write_memory 才会产生**。
 * 于是「原话一直在涨、记忆层原地不动」是一种会反复出现的常态故障——
 * 数据一条没丢，但 AI 回答时只翻记忆层（`memory-search.ts` 里没有任何一处引用
 * `episodes`，除非显式调 `recall_transcript`），用户看到的就是「它把我这几天说的全忘了」。
 *
 * 老板 2026-11-14 亲口问「为什么我看小本本里的记忆都是几天前的」，根因正是这个：
 * 记忆层停在 11-10，而原话已经攒到 11-14、共 693 条。此前**没有任何界面**能看出
 * 这件事，用户只能靠「感觉它没记住」来发现。
 *
 * ⚠️ 口径边界（很重要，别写过头）：
 * 这个判定**回答不了「哪几条原话已经被蒸馏」**——引擎不知道 AI 读过哪些原文，
 * 也无法分辨「写了 1 条记忆覆盖 100 条原话」这种部分蒸馏。所以文案里不许出现
 * 「还有 N 条待蒸馏」这种断言，那是猜的。它只能说：距上次写入记忆过了多久、
 * 之后又攒了多少原话。两者都把事实摊开，判断留给用户。
 *
 * 判定放在后端而不是浏览器里，是为了能被 bun test 直接测边界；前端只负责渲染
 * （见 admin.ts 的 distillRender）。
 */

/** 文案全部来自 `dict().admin.distill` —— 判定是纯逻辑，措辞是语言包的事。 */
import { dict } from "../i18n";

export interface DistillInput {
  /** 最近一条记忆的写入时间（ISO UTC，带 Z）。空库传 null。 */
  lastMemoryAt: string | null;
  /** 记忆写入之后新增的原话条数。 */
  episodeSince: number;
  /** 库里的记忆总数。 */
  memoryTotal: number;
  /** 注入时钟（毫秒），测试用。 */
  now?: number;
}

export interface DistillHint {
  tone: "warn" | "tip";
  title: string;
  detail: string;
  /** 距最近一次写入记忆多少天（向下取整）；无记忆时为 null。 */
  ageDays: number | null;
}

const DAY_MS = 86400000;

/**
 * 返回 null 表示「正常，别打扰用户」。
 *
 * 阈值是有意保守的：一天不写记忆完全正常（周末、只聊几句），天天弹提示等于训练用户
 * 忽略提示。所以两条路才亮：**超过一周没写**，或者**攒了 30 条以上原话且已过两天**。
 */
export function distillHint(i: DistillInput): DistillHint | null {
  const now = i.now ?? Date.now();
  const since = Math.max(0, Math.floor(i.episodeSince));

  if (!i.lastMemoryAt) {
    // 空库：只有真的攒下原话才提，否则新装用户一打开就看到警告
    if (since <= 0) return null;
    const d = dict().admin.distill;
    return {
      tone: "tip",
      title: d.emptyTitle(since),
      detail: d.emptyDetail,
      ageDays: null,
    };
  }

  const at = Date.parse(i.lastMemoryAt);
  // 时间解析不出来（脏数据/异常格式）就当没有信号——误报比不报更伤信任
  if (!Number.isFinite(at)) return null;

  const ageDays = Math.floor((now - at) / DAY_MS);
  if (ageDays < 2) return null;
  // 没有新原话 = 没东西可蒸馏，别为了「天数」而提示
  if (since <= 0) return null;
  if (ageDays < 7 && since < 30) return null;

  const d = dict().admin.distill;
  return {
    tone: "warn",
    title: d.staleTitle(ageDays),
    detail: d.staleDetail(since, i.memoryTotal),
    ageDays,
  };
}
