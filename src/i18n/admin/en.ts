// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 管理页英文文案。
 *
 * 几条写作纪律（与中文包刻意不一致的地方，都是有意为之）：
 *
 *  1. **英文句子独立成句，不照中文语序拼装。** 中文先说「将物理删除 3 条」，英文
 *     把数量放到标签后面（"Memories: 604"）更自然 —— 顺带绕开了单复数变化，
 *     这些行里不会出现 "1 memories" 这种洋相。
 *  2. **徽章与统计行一律首字母大写**（`Memories` / `Directives`），因为它们在
 *     同一行里以「标签: 数字」的形式并排出现，大小写必须齐。
 *  3. 带 `{name}` 占位的地方，占位名必须与中文包**逐字对应** —— 页面里的 `fmt()`
 *     按同一份名字填值，改一个名字就是一处静默空白。
 *  4. 少数值里带 `<b>` / `<code>` 标签：英文的强调位置与中文不同，把标签留在
 *     文案里，语序才能整句重排。动态值仍然必须过页面的 `esc()`。
 */
import type { AdminDict } from "./types";

export const adminEn: AdminDict = {
  html: {
    langTag: "en",
    docTitle: "xiaobenben · Memory admin",
    srHeading: "xiaobenben memory admin: search, view, edit and delete memories",
    ledgerAria: "Memory ledger",
    statEp: "episodes",
    statSess: "sessions",
    statMem: "memories",
    statUsed: "recalled",
    statHits: "hits",
    statLinks: "links",
    ledgerReading: "Reading the ledger…",
    ledLocal: "Local mode",
    qPlaceholder: "Search memories, or paste a session id",
    btnSearch: "Search",
    btnSession: "By session",
    kindAll: "All",
    kindMemory: "Memories",
    kindDirective: "Directives",
    kindHabit: "Habits",
    kindConstraint: "Constraints",
    kindVault: "Vault",
    kindEpisodes: "Transcripts",
    srcAll: "All sources",
    epDayTitle: "Only transcripts recorded on this day",
    epClear: "Clear filters",
    exitSession: "✕ Exit session view",
    purgeSummary: "Danger zone · bulk hard delete (irreversible; default constraints are exempt)",
    purgeModeSession: "By session id",
    purgeModeTime: "By ingest date range",
    purgeModeDomain: "By constraint domain",
    purgeModeHits: "By recall hit count",
    purgeModeAll: "Wipe all memories",
    purgeSessPh: "session id",
    purgeHitsPh: "max hit count, e.g. 0",
    purgeTextPh: "type: delete all memories",
    btnPreview: "Preview",
    btnDelete: "Delete",
    btnCancel: "Cancel",
    btnSave: "Save",
    purgeTypeWord: "delete all memories",
    langSwitchAria: "Interface language",
  },

  api: {
    dupContent: (id) => "Content duplicates memory #" + id,
    systemProtected:
      "The built-in default constraints are protected by the engine and cannot be deleted (reword them instead)",
    badLang: "Unrecognized language (available: zh / en)",
    badParams: "Incomplete parameters or unknown dimension",
    noConfirm: "Missing explicit confirmation",
    purgeTypeMismatch: (word) => 'To wipe everything, type "' + word + '" in the box first',
    idRequired: "id is required",
    vaultMissing: "Vault entry does not exist",
    keyRequired: "Key cannot be empty",
    cloudNoKey:
      "No cloud key on this machine yet, so the mode cannot be switched — paste a key below (or bind from the console) first",
    purgeDescSession: (sid) => 'session "' + sid + '"',
    purgeDescTime: (from, to) => "memories ingested " + from + " ~ " + to,
    purgeDescDomain: (domain) => 'domain "' + domain + '"',
    purgeDescHits: (n) => "memories recalled " + n + " times or fewer",
    purgeDescAll: "all memories",
  },

  distill: {
    emptyTitle: (since) => `No memories yet, ${since} ${since === 1 ? "transcript" : "transcripts"} collected`,
    emptyDetail:
      "Transcripts are a verbatim archive and day-to-day recall never reads them. Ask the AI to distill what is worth keeping into memories, and it will remember next time you ask.",
    staleTitle: (days) => `No new memories for ${days} days`,
    staleDetail: (since, total) =>
      `${since} ${since === 1 ? "transcript was" : "transcripts were"} collected in that time, ` +
      `but the memory count is still ${total}. ` +
      "Day-to-day recall only reads memories, not transcripts, so it will not bring up what you discussed. " +
      "Ask the AI to distill what is worth keeping, or to read the raw transcripts directly.",
  },

  js: {
    langFail: "Switch failed; the language is unchanged.",
    kindMemory: "Memories",
    kindDirective: "Directives",
    kindHabit: "Habits",
    kindConstraint: "Constraints",
    kindSystem: "System",
    typeDecision: "decision",
    typePreference: "preference",
    typeFact: "fact",
    typeEvent: "event",
    typeProcedure: "procedure",

    emptySession: "No memories under this session id — note that session_id must match exactly.",
    emptyList: "No memories yet. Chat with your AI client and let it write things down for you.",
    emptyEpFiltered: "No transcripts match this filter — try loosening it.",
    emptyEpNone: "No transcripts collected yet.",
    emptyVault:
      "The vault is empty. When the AI writes a memory containing a [[xbb_secret_value:value]] marker, the credential lands here automatically.",

    domainTag: "domain: {d}",
    expiredTag: "expired · ",
    untilTag: "valid until ",
    similarSessions: "×{n} sessions",
    hitCount: "hits ×{n}",
    supersededBy: "superseded → {id}",

    pagePrev: "Previous",
    pageNext: "Next",
    pageJumpTo: "Page",
    // 英文把量词吃进上一句（"Page [3]"），这里刻意留空 —— 唯一允许为空的键，见 i18n.test.ts
    pageJumpUnit: "",
    pageJumpBtn: "Jump",
    pageJumpAria: "Go to page",
    pageJumpTitle: "Enter a page between 1 and {n}, then press Enter",
    pageInfo: "Page {p} of {n} · {unit}{c}",
    unitEpisodes: "transcripts: ",
    unitItems: "items: ",

    homeTitle: "Database",
    homeSrcEnv: "environment variable XBB_DATA_DIR",
    homeSrcConfig: "config file",
    homeSrcDefault: "default location",
    homeCounts: " · memories: {m} / transcripts: {e}",
    homeMissing: "⚠️ Database is not where it should be — the next start will be refused rather than run on an empty DB",
    homeReveal: "Open containing folder",
    homeDetails: "Details",
    homeProgramDir: "Program dir",
    homeDataDir: "Data dir",
    homeSource: "Location from",
    homeModelsDir: "Models dir",
    homeConfigFile: "Config file",
    homeLastWrite: "Last write",
    homeConfigBody: "Config content",
    homeNotDownloaded: " (not downloaded yet)",
    homeMoveHint:
      'To move it, use the command line: <code>xbb home move "D:\\xbb-data"</code>' +
      " — copies, verifies (integrity plus row-by-row counts), and only then switches the config." +
      " If verification fails nothing is switched and the original DB stays untouched.",
    homeOpenFailed: "Could not open the folder",

    ledgerNoteNoDb: "No database yet — it is created on the first write. This is not a failure.",
    ledgerNoteUnreadable: "The ledger cannot be read (older database or missing columns). Normal use is unaffected.",
    ledgerNoteNoMemories: "No memories yet — counting starts once the AI writes the first one.",
    ledgerFullAll:
      "{ep} transcripts ({sess} sessions) distilled into {mem} memories, and every one of them has been recalled. That is rare.",
    ledgerFullSome:
      "{ep} transcripts ({sess} sessions) distilled into {mem} memories; {unused} of them have not been recalled yet" +
      " — normal, a new memory only comes back once a related topic comes up.",
    ledgerNoEpAll:
      "This database has no transcripts table (created by an early version), so the ledger only counts memories; every one of them has been recalled. That is rare.",
    ledgerNoEpSome:
      "This database has no transcripts table (created by an early version), so the ledger only counts memories; {unused} of them have not been recalled yet" +
      " — normal, a new memory only comes back once a related topic comes up.",
    ledgerNoEpisodesAll:
      "No raw AI conversation has been read yet — memories are what the AI wrote directly; every one of them has been recalled. That is rare.",
    ledgerNoEpisodesSome:
      "No raw AI conversation has been read yet — memories are what the AI wrote directly; {unused} of them have not been recalled yet" +
      " — normal, a new memory only comes back once a related topic comes up.",

    cloudMode: "Cloud mode",
    localMode: "Local mode",
    bound: "bound",
    cloudWritesTo: "Memories are written to org <b>{org}</b>",
    cloudBoundAt: "bound on {date}",
    cloudToLocal: "Switch to local (keep key)",
    cloudToCloud: "Switch to cloud",
    unbind: "Unbind",
    localKeepKey: "Memories stay on this machine · <b>the cloud key is kept</b>, switch back anytime",
    localUnbound: "Memories stay on this machine · no cloud org bound",
    keyChange: "Replace / enter a cloud key manually",
    keyFill: "Enter a cloud key manually to connect",
    keyPh: "Paste the cloud key",
    connect: "Connect",
    apiPh: "API base (default {api}; only needed for self-hosted deployments)",
    keyHintBefore: "Generate and copy the key in the cloud console",
    keyHintConsole: "open console",
    keyHintConsoleLine: " ({link})",
    keyHintAfter:
      ". Binding validates it against the server once; <b>if validation fails, nothing on this machine is changed</b>.",
    cloudRestartHint:
      "Switching, binding or unbinding only takes effect after you restart your AI client (opencode, Cursor, WorkBuddy, …)" +
      " — <b>a client that has not been restarted keeps reading and writing the old target</b>, so memories written in the meantime" +
      " land in the old place (the cloud before switching to local, the local database before switching to cloud).",
    toastSwitchedCloud: "Switched to cloud mode",
    toastSwitchedLocal: "Switched to local mode (key kept)",
    toastSwitchFailed: "Switch failed",
    toastSwitchReqFailed: "Switch request failed",
    toastNeedKey: "Paste the cloud key first",
    toastConnected: "Connected to cloud: {label}",
    toastConnectFailed: "Connection failed",
    toastConnectReqFailed: "Connection request failed",
    confirmUnbind:
      "Unbinding deletes the cloud key from this machine and cannot be undone — the only way back is to bind again from the cloud console.\n\n" +
      'If you only want local mode for a while, click "Switch to local (keep key)" instead; the key stays and you can switch back anytime.\n\n' +
      "Unbind now?",
    toastUnbound: "Cloud binding removed",
    toastUnbindFailed: "Unbind failed",
    toastReqFailed: "Request failed",

    statsMemories: "Memories: {n}",
    statsKind: "{kind}: {n}",
    statsEpisodes: "Transcripts: {n} · Sessions: {sess}",
    statsDistillToday: "a memory was written today",
    statsDistillDays: "last memory written {n} days ago ({date})",
    statsDomains: "Domains: {list}",
    statsDevices: "Devices: {list}",
    sepList: ", ",
    sepMd: " · ",
    allSources: "All sources",
    srcOption: "{src} ({n})",

    sessionLabel: "All memories of session {sid} (in recording order)",
    epFilterPrefix: "Filtering: {bits}",
    epFilterJoin: " · ",
    epFilterSession: "session {sid}…",
    epFilterQuery: 'containing "{q}"',
    epFilterDay: "on {day}",
    epFilterSource: "source {src}",

    roleMe: "Me",
    roleAi: "AI",
    charsHint: "{n} chars · click to expand",
    loading: "Loading…",
    loadFailed: "Could not load",
    toastEpLoadFailed: "Could not load transcripts",

    refsNone: "no references · safe to clean up",
    refsSome: "references: {n}",
    vaultValue: "value {mask}",
    vaultLabel: "purpose: {label}",
    vaultNoLabel: "no purpose label",
    vaultEditValue: "Change value",
    vaultEditLabel: "Change label",
    del: "Delete",
    promptNewValue: "New value (every memory referencing this id picks it up automatically):",
    promptNewLabel: "Purpose label (e.g. server SSH password; leave empty to clear):",
    toastValueEmpty: "Value cannot be empty",
    toastValueChanged: "Value changed",
    toastSaved: "Saved",
    toastFailed: "Failed",
    confirmVaultDelete: "Delete vault entry #{id}? Memories referencing it will only keep the dangling id.",
    toastDeleted: "Deleted",

    toastPasteSession: "Paste a session id into the search box first, then click By session",
    toastNoHits: "Nothing found — try another word",

    memoryTitle: "Memory {id}",
    sessionBadge: "session {sid} ↗",
    startsAt: "since {t}",
    similarSessionsN: "similar sessions: {n}",
    chainHead: "📜 Succession chain · {n} links ([head] = current, click to jump)",
    chainCurrent: "[head · current]",
    chainHistory: "[history]",
    relatedHead: "🕸 Hebbian links · {n} (sorted by weight, click to jump)",
    toastSaveFailed: "Could not save",
    confirmDelete: "Delete memory #{id}? (soft delete — recoverable from the database)",
    toastDeleteFailed: "Could not delete",

    purging: "Loading…",
    noCustomDomain: "No custom domains",
    domainOption: "{d} ({n})",
    purgeWillDelete: "To be hard-deleted: {n} ({desc})",
    purgeSampleRow: "#{id} · hits×{hits} · {date} · {content}",
    purgeMore: "… only the first 10 are shown; the total count is what gets deleted",
    purgeConfirmBtn: "Confirm hard delete (irreversible)",
    purgeNothing: "Nothing to delete in this dimension.",
    toastPreviewFirst: "Click Preview first",
    confirmPurge: "A hard delete cannot be recovered from the database. Proceed?",
    toastPurged: "Hard-deleted: {n}",
    startDate: "Start date",
    endDate: "End date",

    updateReady: "Version v{v} is ready",
    updateRestart: "Restart xiaobenben to apply.",
    updateFound: "A new xiaobenben version v{v} is available",
    updateAsk: "(currently v{current}) Update to v{latest}?",
    updateNow: "Update now",
    updateLater: "Later",
    updateDownloading: "Downloading and verifying…",
    toastUpdateReady: "New version is ready — restart xiaobenben to apply",
    toastUpToDate: "Already up to date",
    toastUpdateIncomplete: "Update did not finish: {reason}",
    unknown: "unknown",
    toastUpdateReqFailed: "Update request failed",

    toastIngested: "New transcripts: {n}",
    ingestBusyTitle: "Ingesting local session transcripts in the background…",
    ingestBusyBody:
      "It only reads local conversation logs and only writes to the database on this machine — your current work is unaffected.",
    ingestOffTitle: "Auto-ingest is off",
    ingestOffBody:
      "xiaobenben will no longer read local session transcripts. Transcripts already stored are still there; view or clean them up under Transcripts.",
    ingestReopen: "Turn back on",
    ingestWarnTitle: "Auto-ingest failed {n} times in a row",
    ingestUnknownReason: "reason unknown",
    ingestRetry: "Try again",
    ingestTipTitle: "Heads-up: xiaobenben is ingesting your AI sessions in the background",
    ingestTipBody:
      "So that recall can follow the thread of the conversation, it periodically reads the raw chat logs of local AI clients" +
      " (opencode / Cursor / Claude Code / Codex) into the local database — on this machine only, never uploaded." +
      " Ingesting runs in the background and does not get in your way.",
    ingestGotIt: "Got it",
    lookAtEpisodes: "View transcripts",
    ingestDisable: "Do not auto-ingest",
    toastIngestUnsupported: "Auto-ingest is not supported in this build",
    toastIngestNoEffect: "That did not take effect",
    toastIngestOn: "Turned on — will ingest shortly",
    toastIngestOff: "Auto-ingest turned off",
  },
};
