// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 管理页（`xbb serve` 的网页）文案契约。
 *
 * 这一段与前两段（`help`、`cmd`）的差别在于**文案要跨一道进程边界**：
 * 页面骨架由服务端渲染，内联脚本却在浏览器里跑。所以分三块，各有各的取法：
 *
 *   · `html`    —— 服务端直接拼进模板字面量（`${a.html.xxx}`）；
 *   · `api`     —— 服务端拼进 JSON 响应，页面拿到后原样显示（toast / 预览区）；
 *   · `distill` —— 同上，但判定在 `web/distill.ts`（纯函数，可单测）；
 *   · `js`      —— **只能是纯字符串**，因为要 `JSON.stringify` 成一份 JSON 塞进页面，
 *                  浏览器侧再 `JSON.parse` 出来当字典用。所以这一块**不能放函数**，
 *                  需要插值的地方统一写成 `{name}` 占位，由页面里的 `fmt()` 填。
 *
 * 为什么不把 `js` 也做成函数：函数没法序列化。要保住"让每种语言自己决定整句"
 * 那个好处，只有两条路 —— 要么把每一句都变成 `{a}…{b}` 的拼装（英文语序会被中文语序绑架），
 * 要么把同一件事拆成有限个完整句式（`ledgerFullAll` / `ledgerFullSome` 这样）。
 * 这里选了后者：句式多几个键，但每句读起来还是人话。
 *
 * ⚠️ `js` 里少数值带 HTML 标签（`<b>`、`<a>`）。这是有意的：英文语序里
 * "keep the key" 的强调位置与中文不同，把标签留在文案里，翻译才能整句重排。
 * 取用时一律直接进 `innerHTML`，**动态值仍然必须过 `esc()`**。
 */

/** 内联脚本用的字典：纯字符串 + `{name}` 占位。 */
export interface AdminJsDict {
  /** 语言开关请求失败时的提示（`alert` 里那半句，前面不拼任何固定话） */
  langFail: string;
  // ── 类型徽章 ──
  kindMemory: string;
  kindDirective: string;
  kindHabit: string;
  kindConstraint: string;
  kindSystem: string;
  typeDecision: string;
  typePreference: string;
  typeFact: string;
  typeEvent: string;
  typeProcedure: string;

  // ── 空态 ──
  emptySession: string;
  emptyList: string;
  emptyEpFiltered: string;
  emptyEpNone: string;
  emptyVault: string;

  // ── 卡片元信息 ──
  domainTag: string;
  expiredTag: string;
  untilTag: string;
  similarSessions: string;
  hitCount: string;
  supersededBy: string;

  // ── 分页 ──
  pagePrev: string;
  pageNext: string;
  pageJumpTo: string;
  pageJumpUnit: string;
  pageJumpBtn: string;
  pageJumpAria: string;
  pageJumpTitle: string;
  pageInfo: string;
  unitEpisodes: string;
  unitItems: string;

  // ── 数据位置 ──
  homeTitle: string;
  homeSrcEnv: string;
  homeSrcConfig: string;
  homeSrcDefault: string;
  homeCounts: string;
  homeMissing: string;
  homeReveal: string;
  homeDetails: string;
  homeProgramDir: string;
  homeDataDir: string;
  homeSource: string;
  homeModelsDir: string;
  homeConfigFile: string;
  homeLastWrite: string;
  homeConfigBody: string;
  homeNotDownloaded: string;
  homeMoveHint: string;
  homeOpenFailed: string;

  // ── 账本 ──
  ledgerNoteNoDb: string;
  ledgerNoteUnreadable: string;
  ledgerNoteNoMemories: string;
  ledgerFullAll: string;
  ledgerFullSome: string;
  ledgerNoEpAll: string;
  ledgerNoEpSome: string;
  ledgerNoEpisodesAll: string;
  ledgerNoEpisodesSome: string;

  // ── 云端 ──
  cloudMode: string;
  localMode: string;
  bound: string;
  cloudWritesTo: string;
  cloudBoundAt: string;
  cloudToLocal: string;
  cloudToCloud: string;
  unbind: string;
  localKeepKey: string;
  localUnbound: string;
  keyChange: string;
  keyFill: string;
  keyPh: string;
  connect: string;
  apiPh: string;
  keyHintBefore: string;
  keyHintConsole: string;
  /** 包住控制台链接的那对括号 —— 中文是全角，英文是半角加空格，不能写死在代码里 */
  keyHintConsoleLine: string;
  keyHintAfter: string;
  cloudRestartHint: string;
  toastSwitchedCloud: string;
  toastSwitchedLocal: string;
  toastSwitchFailed: string;
  toastSwitchReqFailed: string;
  toastNeedKey: string;
  toastConnected: string;
  toastConnectFailed: string;
  toastConnectReqFailed: string;
  confirmUnbind: string;
  toastUnbound: string;
  toastUnbindFailed: string;
  toastReqFailed: string;

  // ── 统计行 ──
  statsMemories: string;
  statsKind: string;
  statsEpisodes: string;
  statsDistillToday: string;
  statsDistillDays: string;
  statsDomains: string;
  statsDevices: string;
  sepList: string;
  sepMd: string;
  allSources: string;
  srcOption: string;

  // ── 会话视图 / 原话筛选 ──
  sessionLabel: string;
  epFilterPrefix: string;
  epFilterJoin: string;
  epFilterSession: string;
  epFilterQuery: string;
  epFilterDay: string;
  epFilterSource: string;

  // ── 原话卡片 ──
  roleMe: string;
  roleAi: string;
  charsHint: string;
  loading: string;
  loadFailed: string;
  toastEpLoadFailed: string;

  // ── 保险箱 ──
  refsNone: string;
  refsSome: string;
  vaultValue: string;
  vaultLabel: string;
  vaultNoLabel: string;
  vaultEditValue: string;
  vaultEditLabel: string;
  del: string;
  promptNewValue: string;
  promptNewLabel: string;
  toastValueEmpty: string;
  toastValueChanged: string;
  toastSaved: string;
  toastFailed: string;
  confirmVaultDelete: string;
  toastDeleted: string;

  // ── 搜索 ──
  toastPasteSession: string;
  toastNoHits: string;

  // ── 详情弹窗 ──
  memoryTitle: string;
  sessionBadge: string;
  startsAt: string;
  similarSessionsN: string;
  chainHead: string;
  chainCurrent: string;
  chainHistory: string;
  relatedHead: string;
  toastSaveFailed: string;
  confirmDelete: string;
  toastDeleteFailed: string;

  // ── 危险区 ──
  purging: string;
  noCustomDomain: string;
  domainOption: string;
  purgeWillDelete: string;
  purgeSampleRow: string;
  purgeMore: string;
  purgeConfirmBtn: string;
  purgeNothing: string;
  toastPreviewFirst: string;
  confirmPurge: string;
  toastPurged: string;
  startDate: string;
  endDate: string;

  // ── 更新提示 ──
  updateReady: string;
  updateRestart: string;
  updateFound: string;
  updateAsk: string;
  updateNow: string;
  updateLater: string;
  updateDownloading: string;
  toastUpdateReady: string;
  toastUpToDate: string;
  toastUpdateIncomplete: string;
  unknown: string;
  toastUpdateReqFailed: string;

  // ── 采集提示条 ──
  toastIngested: string;
  ingestBusyTitle: string;
  ingestBusyBody: string;
  ingestOffTitle: string;
  ingestOffBody: string;
  ingestReopen: string;
  ingestWarnTitle: string;
  ingestUnknownReason: string;
  ingestRetry: string;
  ingestTipTitle: string;
  ingestTipBody: string;
  ingestGotIt: string;
  lookAtEpisodes: string;
  ingestDisable: string;
  toastIngestUnsupported: string;
  toastIngestNoEffect: string;
  toastIngestOn: string;
  toastIngestOff: string;
}

export interface AdminDict {
  /** 页面骨架：由服务端拼进 `ADMIN_HTML` 模板 */
  html: {
    /** `<html lang>` —— 无障碍与浏览器断词规则要靠它，不能永远写 zh-CN */
    langTag: string;
    docTitle: string;
    /** 给读屏软件的隐藏标题（页面上看不见，但**确实被人听见**） */
    srHeading: string;
    ledgerAria: string;
    statEp: string;
    statSess: string;
    statMem: string;
    statUsed: string;
    statHits: string;
    statLinks: string;
    ledgerReading: string;
    /** 顶栏指示灯旁的初始文字（随后由 `cloudRender` 按绑定状态改写） */
    ledLocal: string;
    qPlaceholder: string;
    btnSearch: string;
    btnSession: string;
    kindAll: string;
    kindMemory: string;
    kindDirective: string;
    kindHabit: string;
    kindConstraint: string;
    kindVault: string;
    kindEpisodes: string;
    srcAll: string;
    epDayTitle: string;
    epClear: string;
    exitSession: string;
    purgeSummary: string;
    purgeModeSession: string;
    purgeModeTime: string;
    purgeModeDomain: string;
    purgeModeHits: string;
    purgeModeAll: string;
    purgeSessPh: string;
    purgeHitsPh: string;
    purgeTextPh: string;
    btnPreview: string;
    btnDelete: string;
    btnCancel: string;
    btnSave: string;
    /**
     * 「清空全部记忆」的通行词 —— 页面要用户键入它，服务端拿同一个词比对。
     * 放进字典是必须的：写死中文的话，英文界面会要求用户键入一句中文。
     */
    purgeTypeWord: string;
    /** 右上角语言开关的 aria-label（屏幕阅读器念的那句） */
    langSwitchAria: string;
  };

  /** 服务端 API 的错误与描述（页面拿到后原样显示） */
  api: {
    /** `POST /api/lang` 收到认不出的语言码 */
    badLang: string;
    dupContent: (id: string) => string;
    systemProtected: string;
    badParams: string;
    noConfirm: string;
    purgeTypeMismatch: (word: string) => string;
    idRequired: string;
    vaultMissing: string;
    keyRequired: string;
    cloudNoKey: string;
    purgeDescSession: (sid: string) => string;
    purgeDescTime: (from: string, to: string) => string;
    purgeDescDomain: (domain: string) => string;
    purgeDescHits: (n: number) => string;
    purgeDescAll: string;
  };

  /** 「记忆层停在那儿了」提示条 */
  distill: {
    emptyTitle: (since: number) => string;
    emptyDetail: string;
    staleTitle: (days: number) => string;
    staleDetail: (since: number, total: number) => string;
  };

  /** 内联脚本用的字典（会被序列化成 JSON 塞进页面，**不能有函数**） */
  js: AdminJsDict;
}
