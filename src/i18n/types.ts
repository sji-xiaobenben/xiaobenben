// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 语言字典的**唯一契约**。
 *
 * 为什么是显式 interface 而不是 `type Dict = typeof zh`：
 *   后者要 `types.ts` 反向 import `zh.ts`，而 `zh.ts` 又要 import 这个类型 —— 循环。
 *   显式声明虽然多写一遍，但它同时是一份「哪些话术已纳入多语言」的清单，看这一个文件
 *   就知道覆盖面，不用去翻两个语言包做差集。
 *
 * 为什么字典里允许函数：
 *   中文的「条 / 场 / 次」是量词，英文的 "1 memory / 2 memories" 是复数变化，
 *   用 `"{n} 条"` 这种占位符模板去拼，两种语言必有一种别扭。让每个语言自己决定整句，
 *   是唯一能让两边都读起来像人话的办法。代价是文案不能做静态抽取 —— 可接受，
 *   这些字符串本来也不会被 CAT 工具处理。
 */

import type { HelpDict } from "./help/types";

export type { HelpDict };

export type Lang = "zh" | "en";

export interface Dict {
  /** 语言名在**当前**语言下的写法（语言切换器要列自己，所以不能都写成中文） */
  langNames: Record<Lang, string>;

  /** 帮助文案（判据见 `help/types.ts` 顶部：谁读它，不是"是不是字符串"） */
  help: HelpDict;

  banner: {
    /** 版本行里「构建 <时刻>」的那个词 */
    built: string;
    /** 版本行里「指纹 <hash>」的那个词 */
    fingerprint: string;
    /** 版权行里「官方站点 <url>」的那个词 */
    site: string;
  };

  langCmd: {
    current: string;
    choices: string;
    switchHint: string;
    storedAt: (path: string) => string;
    envOverride: string;
    /** `XBB_LANG` 正在生效时追加的一行 —— 否则用户敲完 `xbb lang en` 会发现"没变化" */
    envActive: (value: string) => string;
    switched: (tag: Lang) => string;
    /** 写进配置了，但环境变量压着它 —— 必须说清"为什么看起来没生效" */
    switchedButEnvWins: (tag: Lang, env: string) => string;
    unknown: (input: string) => string;
  };

  stats: {
    labels: {
      file: string;
      memories: string;
      recalled: string;
      links: string;
      transcripts: string;
    };
    /** 「103.2 MB · 最后写入 2026-11-20 22:00」 */
    meta: (sizeMb: string, when: string) => string;
    memories: (n: string) => string;
    recalled: (used: string, hits: string) => string;
    links: (n: string) => string;
    transcripts: (episodes: string, sessions: string) => string;
    adminHint: (url: string) => string;
    /** 数字读不到时显示的词 —— 绝不显示 0（0 是结论，不是未知） */
    unreadable: string;
  };

  missingDb: {
    notFound: (path: string) => string;
    noAutoCreate: string;
    howToFind: string;
  };

  connect: {
    /** 一个客户端都没装 */
    noneAtAll: string;
    /** 装了但一条配置都没读到 */
    noneConfigured: (total: number, tail: string) => string;
    /** 配了 N 个但全连不上 */
    allBroken: (total: number, broken: number, tail: string) => string;
    connected: (names: string, n: number, total: number, tail: string, warn: string) => string;
    /** 「 · 另 N 个正在使用」 */
    tailInUse: (n: number) => string;
    /** 「 · N 个配置异常」 */
    warnBroken: (n: number) => string;
  };
}
