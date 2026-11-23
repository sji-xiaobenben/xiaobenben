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
import { existsSync, readFileSync, statSync } from "node:fs";
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
/** 上面这份缓存是基于配置文件的哪个版本算出来的。`refreshLang()` 靠它判断"用户刚改过"。 */
let cachedKey: string | null = null;

/**
 * 配置文件的「版本」—— mtime（纳秒）+ size，文件不在就是 `absent`。
 *
 * 不用内容哈希：语言设置只有几个字节，改一次 mtime 必变；而哈希要把整个文件读进来，
 * `xbb stats` 这种高频命令每敲一次都多读一次盘不划算。`absent` 单独一个值，
 * 这样「删掉配置、回落到系统语言」也能被察觉 —— 否则从 `{lang:en}` 变成"没有文件"
 * 会被当成没变化。
 *
 * ⚠️ 这个判据**只能守"别的进程改的"**。本进程自己写配置之后不要指望它察觉：
 * 手改/另开一个终端敲 `xbb lang` 必然跨毫秒，但服务自己响应一次点击可能就在同一毫秒里
 * （而且 `en` 与 `zh` 字节数相同，size 帮不上忙）。所以 `POST /api/lang` 写完必须
 * 自己调 `resetLangCache()`，两层各守一半，不是冗余。
 */
function configKey(): string {
  try {
    // **必须取纳秒**（`bigint` + `mtimeNs`）。毫秒粒度下，`{"lang":"en"}` → `{"lang":"zh"}`
    // 这种「字节数一模一样、只差一个字」的改动，在同一毫秒内写完会被判成"没变化"，
    // 于是切了语言页面不动。CI 的 Windows 上就这么红过一次，而本地跑是绿的（机器快慢不一样）。
    const st = statSync(homeConfigPath(), { bigint: true });
    return `${st.mtimeNs}:${st.size}`;
  } catch {
    return "absent";
  }
}

export function resolveLang(): Resolution {
  if (cached) return cached;
  // 记录这次结论基于哪个版本 —— 必须在最前面：无论最后是哪一层生效，都从同一个配置快照算出来。
  cachedKey = configKey();

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

// ── 语言变更订阅 ────────────────────────────────────────────────────────────
//
// 为什么需要它：**不是所有界面都是"请求时求值"的**。管理窗口每次请求重新拼 HTML，
// 所以 `refreshLang()` 一句话就够；但系统托盘不一样 —— 菜单在子进程 spawn 后
// 只下发**一次**（`tray.ts` 的线协议如此），语言变了不重建就永远是旧文案。
// 这里给"持有自己那份渲染结果的人"一个被叫醒的机会。
//
// 纪律：订阅者**不许影响写配置的人**。任何回调抛错一律吞掉 —— 托盘是增强，
// 没有让「切语言」这件事失败的权力（同 `tray.ts` 纪律 1、`notify.ts` 第 1 条）。

type LangChangeListener = (lang: Lang) => void;

const langChangeListeners = new Set<LangChangeListener>();

/**
 * 订阅"界面语言变了"。返回退订函数。
 *
 * 只会因**真的变了**被调用 —— 配置被重写成同一个值、`XBB_LANG` 压过配置导致
 * 文件变了但结论没变，这些都不通知。调用时缓存已经清掉，回调里 `dict()` 拿到的是新字典。
 */
export function onLangChange(cb: LangChangeListener): () => void {
  langChangeListeners.add(cb);
  return () => {
    langChangeListeners.delete(cb);
  };
}

/**
 * 缓存已失效之后调用：结论与 `prev` 不同就通知订阅者。
 *
 * `prev === null` 表示"上一个结论未知"（缓存本来就是空的）——那**不算变化**，
 * 不能通知。否则 `serve` 刚起来、第一条定时器空转一次就会把托盘无缘无故重建一遍。
 */
function notifyLangChange(prev: Lang | null): void {
  if (prev === null) return;
  const now = currentLang();
  if (prev === now) return;
  for (const cb of langChangeListeners) {
    try {
      cb(now);
    } catch {
      /* 订阅者自己的错，不能反向影响写配置的人 */
    }
  }
}

/**
 * 无条件清掉缓存。
 *
 * 两种用法：① 测试里改完 env / `XBB_HOME` 要重新判定；
 * ② `applyLangPreference()` 内部 —— 本进程刚写完配置、还需要通知订阅者时走那条。
 *
 * "写的人自己知道状态变了"这件事不能只交给 `refreshLang()`：同一毫秒内写完、
 * 又只差一个字母时（`en` 与 `zh` 字节数相同）`configKey()` 是分辨不出来的。
 * 从别处来的改动仍然交给 `refreshLang()`：先比对版本，没变就什么都不做。
 */
export function resetLangCache(): void {
  cached = null;
  cachedKey = null;
}

/**
 * **配置文件已经写好了**，`prev` 是写**之前**的结论 —— 失效缓存、必要时通知订阅者。
 *
 * 这是 `POST /api/lang` 唯一该调的东西。为什么参数是旧结论而不是新语言：
 * ① 顺序安全 —— 调用方在 `writeHomeConfig` 之前取 `currentLang()`，拿到的必然是旧值，
 *    不会出现"写太快、读回来已经是新的"这种判断；
 * ② 结论要从「配置文件 + env + locale」重新算一遍，而不是信调用方以为的值 ——
 *    `XBB_LANG` 设了英文时写配置成中文并不会真的切过去，这时通知订阅者重建托盘纯属浪费。
 */
export function applyLangPreference(prev: Lang): void {
  resetLangCache();
  notifyLangChange(prev);
}

/**
 * 配置文件变了就丢掉缓存，返回是否丢了。
 *
 * **只给长期驻留的 `serve` 用**，不是给所有调用点用的：
 *   · CLI 每个命令一个新进程，缓存本来就命中不了第二次，无所谓；
 *   · MCP 的 stdout 是协议通道，会话中途换语言只会让同一次交互里两种话术交替出现；
 *   · 管理窗口不一样 —— 用户在另一个终端敲了 `xbb lang en`，或者点了页面右上角的开关，
 *     刷新就该是新语言。这是唯一需要跟着文件走的地方。
 *
 * 没变化时零副作用：一次 `stat`，不读文件、不重建字典。
 * 变了则顺带通知订阅者（托盘等"自己持有渲染结果"的界面）。
 */
export function refreshLang(): boolean {
  if (cached && cachedKey === configKey()) return false;
  const prev = cached?.lang ?? null;
  cached = null;
  cachedKey = null;
  notifyLangChange(prev);
  return true;
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
