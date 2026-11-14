// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 「原话层现在到底有没有人在采」—— 握手指令必须按事实下发，不能对所有宿主说同一句。
 *
 * 起因（2026-11-15）：采集调度只在 `xbb serve` 里装配（`index.ts` 的 serve 分支），
 * `xbb mcp` 这条路上零处 ingest。而 npx 用户恰恰只有 `xbb mcp`——客户端拉起它、
 * 本机没有常驻服务。握手指令却写死了「原话层由引擎自动采集……所以不要为了"记原话"
 * 去调 log_episodes」，AI 老老实实照做 ⇒ 原话层永远空，**而且没有任何报错**。
 * 两层记忆塌成一层，用户只会在几周后问「你怎么什么都不记得」。
 *
 * 三态，各有各的话术，**不许合并**（合并就是把某一态的用户当成另一态）：
 *   auto   常驻服务在跑、采集开着  → 别逐轮上报（上报等于把同一句话存两遍）
 *   paused 服务在跑、用户关了采集  → 尊重开关，不要往回灌
 *   absent 没有常驻服务            → 没人替你存，必须每轮上报
 *
 * 判据只有「服务在不在」+「开关开不开」两件事，不去猜安装方式（npx / 桌面版都走这里）。
 */

export type IngestMode = "auto" | "paused" | "absent";

export interface IngestStatus {
  mode: IngestMode;
  /** 一句话陈述事实（给 stderr 与排障看），**不含任何指令语义** */
  detail: string;
}

/**
 * 握手指令里「原话层由引擎自动采集…」那一段的**原文**。
 *
 * ⚠️ 这是 `src/mcp.ts` 里 `MCP_INSTRUCTIONS` 的逐字副本，用来做定位与替换。
 * 改 `mcp.ts` 那段必须同步改这里，否则替换会落空 —— `ingest-status.test.ts` 会读
 * `src/mcp.ts` 的源文件断言它仍然存在（这就是"单一真源"在没有构建期共享时的替代品）。
 */
export const EPISODE_RULE_AUTO = `**原话层由引擎自动采集**——每 5 分钟从本机客户端库直接读取（opencode / Cursor / WorkBuddy / Claude Code 已覆盖），不需要你逐轮上报，所以**不要为了"记原话"去调 log_episodes**，那只会把同一句话存第二遍。只有两种情形才调：① 用户明确要求把这段对话存档；② 你要给某个话题打标签——采集进来的原话没有 topic，只有打上标签才能按话题追溯。`;

/**
 * 同一件事的**第二处**表述（在【记录纪律·两层分工】里）。
 *
 * 只改长锚点是不够的：这句话独立地又说了一遍"由引擎自动采集、你不必每轮上报"，
 * 留着它就等于握手里同时有两套相反的指令 —— AI 会挑对自己轻松的那条执行。
 */
export const EPISODE_RULE_AUTO_SHORT = `原话层：**由引擎自动采集**（见【原话回跳】），你不必每轮上报。`;

/** 没有常驻服务：规矩反过来，每轮都得传。 */
const EPISODE_RULE_ABSENT = `**原话层在本会话里没有自动采集**——本机没有常驻服务，没有任何人替你存原话。所以这里的规矩是反过来的：**你必须每轮调 log_episodes**，把这一轮用户的原话（尽量保留他自己的说法）和你的回复要点一起传上去；不要攒几轮再传，也不要等用户提醒——不传，这段对话就永久消失了，蒸馏记忆补得出结论，补不出当时怎么说的。用户在别的机器或别的客户端上的会话你同样采不到，那部分只能靠 write_memory 记结论。用户问起"为什么没有自动记原话"或嫌每轮上报啰嗦时，告诉他把常驻服务跑起来就能恢复自动采集：桌面版双击小本本图标，npx 版运行 npx -y xiaobenben serve（关掉那个终端服务就停）——只在用户问到时说一次，不要反复推销。`;

/** 服务在跑但用户主动关了采集：尊重开关，别拿 log_episodes 绕过去。 */
const EPISODE_RULE_PAUSED = `**原话层采集被用户关掉了**——这是用户主动关的（通常为了隐私），**不要**为了"补全"就用 log_episodes 往回灌，那违背他的意思。只有用户明确要求"把这段对话存下来"、或你自己判断某段对话值得留档且已问过用户同意时才调。`;

const EPISODE_SHORT_ABSENT = `原话层：**本会话没有自动采集**（见【原话回跳】），**你必须每轮上报**，漏一轮就是永久丢失。`;
const EPISODE_SHORT_PAUSED = `原话层：**用户关掉了自动采集**（见【原话回跳】），不要主动上报，除非用户明确要求存档。`;

export function episodeRule(mode: IngestMode): string {
  if (mode === "absent") return EPISODE_RULE_ABSENT;
  if (mode === "paused") return EPISODE_RULE_PAUSED;
  return EPISODE_RULE_AUTO;
}

function episodeRuleShort(mode: IngestMode): string {
  if (mode === "absent") return EPISODE_SHORT_ABSENT;
  if (mode === "paused") return EPISODE_SHORT_PAUSED;
  return EPISODE_RULE_AUTO_SHORT;
}

/**
 * 把握手指令里**两处**原话层段落都换成与事实相符的版本。
 *
 * `auto` 时**一个字符都不动**（默认路径零风险）。任何一处找不到锚点都说明文案漂移了：
 * 这时既不能抛（握手失败＝整个会话没有记忆），也不能悄悄按 auto 处理（那就是这次要修的病），
 * 所以降级为文末追加一段"以本段为准"的覆盖说明。
 */
export function applyIngestMode(instructions: string, mode: IngestMode): string {
  if (mode === "auto") return instructions;
  const long = episodeRule(mode);
  const short = episodeRuleShort(mode);
  let out = instructions;
  let missed = false;
  if (out.includes(EPISODE_RULE_AUTO)) out = out.replace(EPISODE_RULE_AUTO, long);
  else missed = true;
  if (out.includes(EPISODE_RULE_AUTO_SHORT)) out = out.replace(EPISODE_RULE_AUTO_SHORT, short);
  else missed = true;
  if (missed) out += `\n【原话层·以下一段覆盖上文相关描述】${long}`;
  return out;
}

export interface ProbeDeps {
  serveAlive?: () => Promise<boolean>;
  /** 采集开关。默认读落盘的 ingest.json（含 XBB_INGEST=0 硬开关） */
  enabled?: () => boolean;
}

/**
 * 探测当前的原话层状态。
 *
 * 为什么要探而不是写死：`xbb mcp` 每次启动都是客户端拉起的短命进程，它自己不知道
 * 本机有没有常驻服务。探测失败（fetch 超时/权限）一律当"没有服务"——**保守方向是让 AI 多报**，
 * 多报只是冗余，少报是永久丢数据。
 */
export async function probeIngestMode(deps: ProbeDeps = {}): Promise<IngestStatus> {
  const serveAlive = deps.serveAlive ?? (async () => (await import("./autostart")).isServeAlive());

  let alive = false;
  try {
    alive = await serveAlive();
  } catch {
    alive = false; // 探测本身永不成为故障源
  }
  if (!alive) {
    return { mode: "absent", detail: "本机没有常驻服务（serve 未运行），采集器不在跑" };
  }

  // 动态 import：这段跑在 MCP 启动路径上，不该为了一个布尔把 sqlite 拉进冷启动
  const enabled = deps.enabled ?? (await import("./ingest-job")).readIngestEnabled;
  let on = true;
  try {
    on = enabled();
  } catch {
    on = true; // 读不到开关时按默认开（与 ingest-job 的口径一致）
  }
  return on
    ? { mode: "auto", detail: "常驻服务在跑，原话层自动采集" }
    : { mode: "paused", detail: "常驻服务在跑，但自动采集已被用户关闭" };
}
