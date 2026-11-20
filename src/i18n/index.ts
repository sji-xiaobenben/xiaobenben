// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 界面语言的判定与取用 —— **全本地、零网络、零副作用**。
 *
 * 这是「单机也支持多语言」的落点。要求很硬：
 *   · 语言判定不能问服务器。用户可能在飞机上、内网隔离区、或者根本没配网络 ——
 *     一条要联网才能决定显示什么语言的程序，在最需要它的时候恰好不可用。
 *   · 不能在 import 时读文件。`xbb mcp` 的 stdout 是 MCP 协议通道，
 *     任何模块顶层求值出岔子都可能把错误打进协议流。所以判定是懒的：
 *     第一次 `dict()` 才解析，之后缓存。
 *   · 不能因为配置坏了就崩。锚点文件是用户能手改的，一个手滑的 JSON
 *     不该让整个客户端起不来 —— 解析失败一律当作"没设过语言"。
 *
 * 判定优先级（高 → 低）：
 *   1. `XBB_LANG` 环境变量   —— 显式、可脚本化、CI 与测试靠它钉死
 *   2. `config.json` 的 `lang` —— 用户用 `xbb lang en` 表达的选择
 *   3. 系统 locale           —— LC_ALL / LC_MESSAGES / LANG，再退到 Intl
 *   4. `zh`                  —— 产品默认；也保证既有中文输出逐字节不变
 *
 * 第 2 条压过第 3 条是有意的：用户在中文 Windows 上敲了 `xbb lang en`，
 * 他要的是英文，不是"系统是中文所以还给你中文"。
 */
import { existsSync, readFileSync } from "node:fs";
import { homeConfigPath } from "../paths";
import type { Dict, Lang } from "./types";
import { zh } from "./zh";
import { en } from "./en";

export type { Dict, Lang };

const DICTS: Record<Lang, Dict> = { zh, en };

/** 支持的语言（顺序即切换器里的展示顺序，默认语言排第一） */
export const LANGS: readonly Lang[] = ["zh", "en"];

export function isLang(v: unknown): v is Lang {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(DICTS, v);
}

/**
 * `zh-CN` / `zh_CN.UTF-8` / `en_US` / `EN` → 语言码；认不出返回 null（**不猜**）。
 *
 * 只取第一段：区域差异目前不影响任何一句文案，硬去区分 zh-TW 与 zh-CN
 * 只会让"支持的语言"列表变成谎言。将来真要做繁体，应该是新增 `zh-Hant`
 * 这个独立的语言码，而不是在这里加一层区域映射。
 */
export function normalizeLang(tag: string | undefined | null): Lang | null {
  if (typeof tag !== "string") return null;
  const base = tag.trim().toLowerCase().split(/[.\-_@]/)[0];
  return isLang(base) ? base : null;
}

export type LangSource = "env" | "config" | "system" | "default";

export interface Resolution {
  lang: Lang;
  /** 结论是怎么来的 —— `xbb lang` 要能回答"为什么是英文"，排障时这比结论本身有用 */
  source: LangSource;
  /** 原始输入（环境变量值或 locale 串），便于解释"为什么认成了 en" */
  raw: string | null;
}

/** 只读锚点里的 `lang` 字段。**不引 `home.ts`**：那会把 bun:sqlite 拉进来，
 *  并且制造 i18n ↔ home 的循环依赖。这里只解析一个键，容忍任何损坏。 */
function readLangPreference(): string | null {
  try {
    const p = homeConfigPath();
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const v = (raw as { lang?: unknown }).lang;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * 测试专用：覆盖「系统 locale」这一层（`undefined` = 不覆盖，走真实环境）。
 *
 * 不加这个钩子，`无配置 + 无 env → zh` 这条断言就取决于跑测试那台机器的系统语言：
 * 在英文 Windows 上会红，而代码是对的。测试必须能被任何人在任何机器上跑出同一个结论，
 * 否则它守的不是行为，是机器。
 */
let systemOverride: string | null | undefined;

export function __setSystemLocaleForTest(tag: string | null | undefined): void {
  systemOverride = tag;
  cached = null;
}

function systemLocale(): string | null {
  // 环境变量先看：它们比"系统显示语言"更直接，也是 POSIX 上唯一可靠的一层。
  // 注意测试钩子**不能**挡在它前面 —— 钩子代替的是 Intl 那一层（Windows 的显示语言），
  // 不是代替 LC_ALL/LANG。挡前面会让「LANG=en_US 应该生效」这类测试假红。
  const envTag = process.env.LC_ALL?.trim() || process.env.LC_MESSAGES?.trim() || process.env.LANG?.trim() || "";
  if (envTag && envTag !== "C" && envTag !== "POSIX") return envTag;
  if (systemOverride !== undefined) return systemOverride;
  try {
    // Windows 上 LANG 通常不存在，系统"显示语言"只有 Intl 知道。
    const tag = new Intl.DateTimeFormat().resolvedOptions().locale;
    return tag || null;
  } catch {
    return null;
  }
}

let cached: Resolution | null = null;

export function resolveLang(): Resolution {
  if (cached) return cached;

  const envRaw = process.env.XBB_LANG?.trim() || null;
  const fromEnv = normalizeLang(envRaw);
  if (fromEnv) return (cached = { lang: fromEnv, source: "env", raw: envRaw });

  const cfgRaw = readLangPreference();
  const fromCfg = normalizeLang(cfgRaw);
  if (fromCfg) return (cached = { lang: fromCfg, source: "config", raw: cfgRaw });

  const sysRaw = systemLocale();
  const fromSys = normalizeLang(sysRaw);
  if (fromSys) return (cached = { lang: fromSys, source: "system", raw: sysRaw });

  return (cached = { lang: "zh", source: "default", raw: null });
}

/**
 * 清掉缓存 —— 只在**测试**里用（改完 env / XBB_HOME 后要重新判定）。
 * 生产代码没有任何一处需要重新判定：进程活多久，语言就该定多久。
 */
export function resetLangCache(): void {
  cached = null;
}

export function currentLang(): Lang {
  return resolveLang().lang;
}

/** 当前语言的完整字典。叫 `dict()` 而不是 `t()`：`index.ts` 里已经有个 `t` 是 help topic，
 *  短名字在这里省不了多少，反而容易读错。 */
export function dict(): Dict {
  return DICTS[resolveLang().lang];
}

/** 数字按当前语言格式化。`readUsageCounts` 用 -1 表示"读不到"，
 *  所以负数先拦掉、交给调用方换成词，绝不显示成 "-1" 或 "0"。 */
export function formatNumber(n: number): string {
  return n < 0 ? dict().stats.unreadable : n.toLocaleString(currentLang() === "zh" ? "zh-CN" : "en-US");
}

/**
 * 时间戳 → `YYYY-MM-DD HH:mm:ss`，**两种语言同一套格式**。
 *
 * 为什么不交给 `toLocaleString`：en-US 会给出 `11/20/2026, 20:25:18`（还带个逗号），
 * zh-CN 给出 `2026/11/20 20:25:18`，同一个时间在两种语言下长得像两条不同的信息；
 * 而 `11/20` 与 `20/11` 的歧义是**读错日期**级别的坑，不该由语言设置来决定。
 * 时间戳是数据不是文案 —— 统一成 ISO 顺序，谁看都不会认错。
 */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
