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
import type { AdminDict } from "./admin/types";

export type { HelpDict, AdminDict };

export type Lang = "zh" | "en";

export interface Dict {
  /** 语言名在**当前**语言下的写法（语言切换器要列自己，所以不能都写成中文） */
  langNames: Record<Lang, string>;

  /** 帮助文案（判据见 `help/types.ts` 顶部：谁读它，不是"是不是字符串"） */
  help: HelpDict;

  /** 管理页（`xbb serve` 网页）文案 —— 含服务端渲染、API 错误与内联脚本三块 */
  admin: AdminDict;

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

  /**
   * 锚点文件（config.json）损坏时的告警 —— 只在**要写**它的时候出现。
   *
   * 为什么必须说：坏掉的文件里可能还写着 `dataDir`，那是"库在哪"的唯一线索。
   * 静默覆盖它，用户下次启动只会看到「找不到记忆库」，而没有人会想到
   * 是自己刚敲了一句 `xbb lang en` 造成的。所以：先留证，再写入，并且明说。
   */
  config: {
    /** 已把读不懂的原文件改名留存，附原路径与备份路径 */
    corruptSaved: (path: string, backup: string) => string;
    /** 备份成功之后：说明写进去了什么、以及可能需要补什么 */
    corruptWhat: string;
    /** 备份失败（只读盘 / 被别的进程占着）—— 此时**放弃写入**，绝不拿原内容冒险 */
    corruptCantBackup: (path: string, reason: string) => string;
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

    // ── 渲染层（`xbb connect` 的整屏输出）─────────────────────────────
    title: string;
    cols: { client: string; installed: string; status: string; engine: string };
    /** 表格单元里的三个短词。客户端的名字（Cursor / Claude Desktop）属于品牌，不译 */
    cell: { yes: string; no: string; dash: string };
    /** 接入状态列 —— 四个词各自代表一种处境，不能合并 */
    status: { ok: string; broken: string; inUse: string; notDetected: string };
    /** 「npx 包 / 桌面版 / npm 缓存二进制 / 其他」 */
    engine: { npx: string; desktop: string; pkg: string; other: string };
    /** 配置读不通/指向的东西不存在 —— 这三条会出现在 broken 列，用户必须看懂 */
    badJson: (detail: string) => string;
    notObject: string;
    exeMissing: (path: string) => string;
    /** 表格下方那句汇总：「检测到 2 个客户端，1 个已接入。」 */
    summary: (parts: string[]) => string;
    summaryFound: (n: number) => string;
    summaryNone: string;
    summaryConnected: (n: number) => string;
    summaryInUse: (n: number) => string;
    brokenTitle: string;
    brokenAt: (path: string) => string;
    inUseTitle: string;
    inUseWho: (host: string) => string;
    inUseLine: (label: string, who: string) => string;
    inUseDontReconfigure: string;
    pendingTitle: string;
    pendingHead: (label: string, path: string) => string;
    allReady: string;
    unknownTitle: string;
    unknownHosted: (host: string) => string;
    unknownHostGone: string;
    unknownFromShell: string;
    unknownLine: (pid: number, who: string, fromShell: string) => string;
    noteNotDetected: string[];
    noteNpxY: string[];
    noteRestart: string;
    noteReadOnly: string;
  };

  /**
   * 开库判定闸的三段话术（缺库 / 损坏 / 写锁被占）。
   *
   * 这三条单独成段而不是并进 `cmd`：它们是**错误对象自己的 message**，会被
   * `xbb serve`、`xbb ingest`、`xbb verify` 等所有开库路径复用，而且英文用户
   * 最需要看懂的就是这里 —— 看不懂报错等于没有报错。
   */
  dbGate: {
    missing: (f: DbGateMissingFields) => string;
    corrupt: (file: string, detail: string) => string;
    busy: (detail: string) => string;
  };

  /**
   * 命令输出的文案。
   *
   * 这里大量使用「返回整块 string[]」而不是逐行提供键：一整块提示的**行序与语序**
   * 本身就是文案的一部分（中文先说「必须重启」再说原因，英文反过来才顺）。
   * 逐行给键会把行序钉死在代码里，两种语言只能有一种读起来自然。
   */
  cmd: {
    /** `xbb serve` / `xbb start` 起不来的三条 —— detail 是错误类自己的 message */
    serveFail: {
      missing: (detail: string) => string[];
      busy: (detail: string) => string[];
      corrupt: (detail: string) => string[];
    };

    bind: {
      usage: string;
      ok: (f: BindFields) => string[];
    };
    unbind: (had: boolean) => string[];
    cloud: {
      noKey: string[];
      switched: (toCloud: boolean) => string[];
      nothingToSwitch: string;
      statusNone: string[];
      status: (f: CloudStatusFields) => string[];
      unknownSub: (sub: string) => string;
    };
    bindKey: {
      usage: string[];
      ok: (f: BindFields) => string[];
    };

    autostart: {
      onResult: (ok: boolean, message: string) => string[];
      offResult: (ok: boolean, message: string) => string[];
      unknownSub: (sub: string) => string;
      status: (f: AutostartFields) => string[];
    };

    /** `xbb ingest` 表格「说明」列里的短语 —— 出现在终端上，所以要翻 */
    ingestNote: {
      notFoundDb: (name: string) => string;
      notFoundPath: (path: string) => string;
      sessionFiles: (n: number) => string;
      rolloutFiles: (n: number) => string;
      composerParsed: (parsed: number, total: number) => string;
      composerUnchanged: (n: number) => string;
      incrementalFiles: (n: number) => string;
      noNew: string;
      failed: (msg: string) => string;
      stalled: (hours: number) => string;
      v2Pending: (n: number) => string;
      maxTurns: string;
      schemaTwice: string;
    };

    ingest: {
      busy: (detail: string) => string[];
      corrupt: (detail: string) => string[];
      toggled: (on: boolean) => string;
      /** 表头与数据行必须共用同一套列宽，所以列宽由调用方现算后传入 */
      statusCols: string[];
      statusTotal: (n: number) => string;
      balanceIdle: string;
      balance: (memories: number, episodes: number, ratio: string, tag: string) => string;
      balanceTags: { healthy: string; watch: string; flooding: string };
      balanceAdvice: string[];
      unparsed: (n: number, total: number) => string;
      unknownSource: (bad: string, ok: string) => string;
      runCols: string[];
      runTitle: (dryRun: boolean) => string;
      driftTitle: string;
      driftLine: (label: string, fingerprint: string, unparsed: number, suspects: number) => string;
      driftAdvice: string;
      runSummary: (scanned: number, inserted: number, ms: number, total: number, dryRun: boolean) => string;
      cumulative: (s: string) => string;
    };

    updateStatus: {
      source: (v: string) => string;
      noSource: string;
      form: (v: string) => string;
      formExe: string;
      formDev: string;
      dir: (v: string) => string;
      pendingNone: string;
      pendingAdopt: (version: string) => string;
      pendingRollback: (version: string) => string;
      blocklist: (v: string) => string;
      blocklistEmpty: string;
    };

    home: {
      progDir: (v: string) => string;
      dataDir: (v: string) => string;
      srcLabel: (v: string) => string;
      srcEnv: string;
      srcConfig: (path: string) => string;
      srcDefault: string;
      dbCounts: (memories: number, episodes: number, events: number, integrity: string) => string;
      dbNewer: (schema: number, target: number) => string;
      dbOpenFailed: (msg: string) => string;
      dbCorruptHint: string;
      dbPath: (path: string) => string;
      lastWritten: (when: string) => string;
      dbMissing: string;
      dbElsewhere: (path: string) => string;
      models: (path: string, size: string) => string;
      modelsNotDownloaded: string;
      configFile: (path: string) => string;
      configAbsent: string;
      setUsage: string[];
      setNoDb: (abs: string) => string[];
      setOk: (abs: string) => string;
      setDbReady: (path: string) => string;
      setDbMissing: string;
      setModelsCopied: (from: string, to: string, mb: string) => string;
      setNoModels: string[];
      setRestart: string[];
      moveUsage: string[];
      moving: string;
      moveOk: (from: string, to: string) => string;
      moveEntries: (entries: string, size: string) => string;
      moveVerify: (integrity: string, memories: number, episodes: number, events: number) => string;
      moveConfig: (path: string) => string;
      moveRestart: string;
      moveKeepOld: (from: string) => string;
      findScanning: string;
      findDeepScanning: string;
      findNone: string;
      findCols: string;
      findCurrent: string;
      findTotal: (n: number) => string;
      initRefused: (path: string, exists: boolean) => string[];
      initOk: (path: string) => string[];
      resetOk: (path: string, exists: boolean) => string[];
      unknownSub: (sub: string) => string;
    };

    stop: {
      none: string;
      found: (list: string, n: number) => string;
      stopped: (pid: number, name: string) => string;
      kept: (pid: number, name: string, why: string) => string;
      keptWhyNoCmd: string;
      keptWhyMcpBusy: string;
      keptWhyMcp: string;
      failed: (pid: number, name: string, err: string) => string;
      failedHint: string;
      undecidable: (n: number) => string[];
      keptMcp: string[];
      stoppedHint: string[];
    };

    /** 裸调用 `xbb`（多半是双击图标）时的状态行与通知 */
    plain: {
      serveNotReady: (portBusy: string) => string;
      portBusy: (port: number) => string;
      seeLog: string;
      toastAlreadyTitle: string;
      toastStartedTitle: string;
      toastBody: string;
      serveRunning: (port: number) => string;
      serveStarted: (ms: number) => string;
      cloudLocalOnly: string;
      cloudLive: (org: string, api: string) => string;
      cloudOff: (org: string) => string;
      unknownCommand: (cmd: string) => string;
    };
  };

  /**
   * 托盘菜单 —— 用户**看得见**的一块界面，所以与命令行输出同等对待。
   *
   * 一处特别的约束：菜单是**起进程时一次性下发**给托盘程序的（线协议只在 spawn 后收一行
   * menu），所以语言跟着进程启动那一刻走。用户改完 `xbb lang` 得重启才变 ——
   * 这与"切云端模式要重启 AI 客户端"是同一类事实，不需要额外解释。
   */
  tray: {
    /** 菜单里出现空组织名时的兜底词 */
    bound: string;
    openWindow: string;
    modeCloud: (org: string) => string;
    modeLocalKeep: string;
    modeLocalOnly: string;
    /** 模式行下面那行灰字：切换不会立即生效 */
    switchHint: string;
    toCloudBound: (org: string) => string;
    toCloudUnbound: string;
    toLocal: string;
    bindKey: string;
    verify: string;
    report: string;
    update: string;
    /** 标题直接写现状，不写"点此开启/关闭"（用户不必先猜状态） */
    autostart: (on: boolean) => string;
    exit: string;
    /** 托盘图标的悬浮提示（品牌名不译） */
    tipCloud: (org: string) => string;
    tipLocal: string;
  };

}

/** 缺库话术需要的字段。`kind` 的取值见 home.ts 的 `DbMissingKind` */
export interface DbGateMissingFields {
  kind: string;
  dbPath: string;
  source: string;
  configPath: string;
  legacyDbPath: string;
}

/** 绑定成功后要展示的一组字段（两种语言的标签名与行序都不同） */
export interface BindFields {
  api: string;
  org: string;
  orgId: string;
  member: string | null;
  space: string | null;
  keyShort: string;
  /** 明文密钥落在哪个文件 */
  path: string;
}

export interface CloudStatusFields {
  cloud: boolean;
  org: string;
  orgId: string;
  api: string;
  keyShort: string;
  path: string;
}

export interface AutostartFields {
  /** 已开启 / 已禁用（系统设置里关掉了）/ 未开启 —— 由字典给的现成词 */
  state: string;
  location: string;
  command: string | null;
  pref: "on" | "off" | null;
}
