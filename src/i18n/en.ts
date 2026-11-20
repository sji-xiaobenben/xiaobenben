// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * English copy. 不是中文的逐字直译 —— 每句都按英文读者重新组织过。
 *
 * 改这里的规矩：
 *   1. 术语必须与官网英文文档一致（记忆 = memory，原话 = transcript，召回 = recall，
 *      情景层 = episode layer，凭证层 = ledger）。译名漂移比不翻译更糟：
 *      用户在 CLI 里看到一个词、在文档里看到另一个词，会以为说的是两种东西。
 *   2. 「未检测到」永远译成 "not detected"，**不能**译成 "not connected" —— 我们只能证明
 *      没找到证据，不能证明它不存在。这条在 `connect.ts` 的注释里有完整理由。
 *   3. 品牌名 `小本本` 不译。`banner()` 里 `小本本 (xiaobenben)` 两种语言下完全一致，
 *      用户报 bug 时贴的就是这一行，翻译它等于让人对不上号。
 */
import type { Dict } from "./types";
import { helpEn } from "./help/en";

export const en: Dict = {
  langNames: { zh: "Chinese", en: "English" },

  help: helpEn,

  banner: { built: "built", fingerprint: "fingerprint", site: "official site" },

  langCmd: {
    current: "Current",
    choices: "Choices",
    switchHint: "Switch",
    storedAt: (path) =>
      `Language preference is stored in ${path} (it lives with the program directory, so moving the database won't reset it)`,
    envOverride: "The XBB_LANG environment variable takes precedence over this setting",
    envActive: (value) => `⚠️ XBB_LANG=${value} is currently in effect and outranks this setting`,
    switched: (tag) =>
      `Switched to ${tag}. Applies from the next command (restart an already-open admin window).`,
    switchedButEnvWins: (tag, env) =>
      `Recorded ${tag} in the config file, but XBB_LANG=${env} still overrides it — ${env} is what's actually in effect. Unset that variable to let the config apply.`,
    unknown: (input) =>
      `Unrecognized language "${input}". Available: zh (Chinese) / en (English). Region tags are fine too — zh-CN, en-US; only the leading language code is used.`,
  },

  stats: {
    labels: {
      file: "Database",
      memories: "Memories",
      recalled: "Recalled",
      links: "Links",
      transcripts: "Transcripts",
    },
    meta: (sizeMb, when) => `${sizeMb} MB · last written ${when}`,
    memories: (n) => `${n} (superseded and forgotten ones included — marked, never deleted)`,
    recalled: (used, hits) => `used at least once: ${used} · ${hits} recalls in total`,
    links: (n) => `${n} links`,
    transcripts: (episodes, sessions) =>
      `${episodes} utterances across ${sessions} sessions (collected automatically, never uploaded)`,
    adminHint: (url) => `Admin window ${url} — same numbers, plus trends.`,
    unreadable: "unavailable",
  },

  missingDb: {
    notFound: (path) => `\n❌ Memory database not found: ${path}\n`,
    noAutoCreate:
      "xiaobenben never creates an empty database: a blank one is worse than none — it looks like your memories were lost.",
    howToFind: "Where is it: xbb home     scan the disk for an existing one: xbb home find",
  },

  config: {
    corruptSaved: (path, backup) =>
      `\n⚠️  Config file is unreadable (invalid JSON): ${path}\n   The original was kept at: ${backup}\n`,
    corruptWhat:
      'The new config has been written. If it used to point at a database location, run xbb home set "<dir>" once\nagain, then xbb home to confirm which database it resolves to.',
    corruptCantBackup: (path, reason) =>
      `\n❌ Config file is unreadable (${reason}), and backing it up failed too: ${path}\n   Nothing was written — losing the original would lose any database path it still holds.\n   Fix the hand-edited JSON, or move the file away, then try again.\n`,
  },

  connect: {
    noneAtAll: "Clients: none detected on this machine · run xbb connect for details",
    noneConfigured: (total, tail) =>
      `Clients: none detected (${total} client(s) installed${tail}) · run xbb connect`,
    allBroken: (total, broken, tail) =>
      `Clients: 0/${total} (${broken} configured but unreachable)${tail} · run xbb connect`,
    connected: (names, n, total, tail, warn) =>
      `Clients: ${names} (${n}/${total})${tail}${warn} · run xbb connect for the full list`,
    tailInUse: (n) => ` · ${n} more in use`,
    warnBroken: (n) => ` · ${n} misconfigured`,
  },
};
