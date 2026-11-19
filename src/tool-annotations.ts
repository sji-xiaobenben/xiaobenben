// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * MCP 工具的四个行为提示（annotations），23 个工具一份真源。
 *
 * 为什么单独成文件、而不是写散在各处 `server.tool(...)` 里：
 *  1. 宿主（Claude Code / Cursor / ChatGPT）就是靠这四个布尔值决定"要不要弹批准、
 *     要不要提示危险操作"。写错等于给用户造噪音，或者给 AI 留后门 —— 必须能一眼对着表审查。
 *  2. `Record<ToolName, …>` 把「新加了一个工具却忘了标注」变成**编译错误**，
 *     而不是线上少个字段（少字段的后果是宿主按规范取默认值 destructive=true，
 *     等于把每个读操作都当成危险操作）。
 *
 * 四个字段按 MCP 规范原文取值：
 *  - readOnlyHint     true = 不修改环境
 *  - destructiveHint  true = 可能做破坏性更新；false = 只做追加（readOnly=false 时才有意义）
 *  - idempotentHint   true = 同参重复调用不产生额外效果
 *  - openWorldHint    true = 会与"开放世界"的外部实体交互
 *
 * 三处刻意判断，写在这里以免被当成漏看：
 *  1. **四个召回工具会写内部信号**。search_memory / recall_topic / recall_timeline /
 *     recall_session 命中后会把 hit_count +1、memory_links.weight 做赫布式强化
 *     （`recall-feedback.ts:onRecalled`）。那是**排序用的内部计数**，不动任何用户可见内容，
 *     所以 readOnlyHint 仍为 true；但计数确实在动，因此 idempotentHint 如实给 false。
 *     宁可暴露"读会动内部计数"，也不把有副作用的函数谎称纯函数。
 *  2. **write_memory 是追加，不是破坏**。确定性去重命中时它只补挂附件、不改原文
 *     （`memory-write.ts:221-228` 直接返回 deduped），supersede 也只是加一条边、
 *     旧条目仍在链上可查 —— 故 destructiveHint=false。这一条最容易被误标成 true：
 *     一旦标 true，宿主会在**每轮写入**前弹批准，把最常用的工具变成噪音源。
 *  3. **openWorldHint 全部 false**。23 个工具只碰用户自己的库与本机文件；云端模式
 *     请求的是我们自己的 API，不是"开放世界"（无任意第三方端点、无网页抓取）。
 *
 * ⚠️ 改这张表等于改产品行为：把某个工具的 readOnlyHint 从 false 改成 true，
 *    宿主就不再对它设防。改之前先确认 handler 真的不写用户可见状态。
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** 工具面全名。新增工具必须先加到这里，否则 `TOOL_ANNOTATIONS` 缺键会编译失败。 */
export type ToolName =
  | "write_memory"
  | "search_memory"
  | "recall_topic"
  | "recall_timeline"
  | "recall_session"
  | "get_memory"
  | "get_related"
  | "get_asset"
  | "recall_directives"
  | "recall_constraints"
  | "reveal_secret"
  | "log_episodes"
  | "recall_episodes"
  | "recall_transcript"
  | "inbox"
  | "ack"
  | "outbox"
  | "forget"
  | "stats"
  | "list_members"
  | "supersede"
  | "list_spaces"
  | "set_memory_audience";

/** 四个提示都必须显式给出布尔值：宿主不认缺省，缺一个就等于把它丢回「默认危险」。 */
type Hints = Required<Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint">>;

export const TOOL_ANNOTATIONS: Record<ToolName, Hints> = {
  // ── 写 ──
  // 追加新条目；去重命中只补附件不改原文；supersede 只加边。重复调用每次都可能新增条目 ⇒ 非幂等。
  write_memory: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },

  // ── 检索（会更新 hit_count/权重，故非幂等）──
  search_memory: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  recall_topic: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  recall_timeline: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  recall_session: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },

  // ── 纯读（零副作用）──
  get_memory: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_related: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // 取附件字节：本地读文件、云端带鉴权 GET，都不改任何东西
  get_asset: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  recall_directives: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  recall_constraints: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  reveal_secret: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  recall_episodes: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  recall_transcript: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inbox: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  outbox: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  stats: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_members: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_spaces: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

  // ── 写入（追加型）──
  // 原话层逐句追加，调用方被要求"每轮一次、不要重调" —— 重复调用会多存一份 ⇒ 非幂等
  log_episodes: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  // 签收：只在 pending 时落时间戳，重复调用是 no-op ⇒ 幂等
  ack: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // 补链：不动内容、只加 superseded_by 边；已链过的目标 no-op ⇒ 幂等
  supersede: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },

  // ── 破坏型（两个，只有这两个）──
  // 墓碑：条目从召回消失。审计链还留着痕迹，但对用户就是"删了" ⇒ destructive
  forget: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  // 可见范围是覆盖写：旧范围不留历史，收窄即等于撤权 ⇒ destructive
  set_memory_audience: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};
