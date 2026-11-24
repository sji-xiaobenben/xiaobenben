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
import { adminEn } from "./admin/en";

export const en: Dict = {
  langNames: { zh: "Chinese", en: "English" },

  help: helpEn,

  admin: adminEn,

  org: { personalSpace: "Personal space" },

  shortcut: { description: "xiaobenben · a personal memory store for AI" },

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
    search: {
      title: (days, n) => `Retrieval health (last ${days} days, ${n} searches)`,
      latency: (p50, p90, empty) => `Latency  median ${p50}ms · p90 ${p90}ms · empty ${empty}`,
      vec: (rate, share, f) => `Semantic  used in ${rate} · ${share} found only by it · ${f}`,
      failures: (n) => `${n} ${n === "1" ? "failure" : "failures"}`,
      chan: (parts) => `Channels ${parts}`,
      labels: { fts: "full-text", inv: "inverted", ent: "entity", ng: "split" },
      none: "Retrieval health  no searches recorded yet (numbers appear once you start using it)",
    },
  },

  doctor: {
    title: (path) => `Memory database  ${path}`,
    meta: (sizeMb, alive, all) => `${sizeMb} MB · ${alive} active of ${all} (superseded and forgotten included)`,
    secChannel: "Retrieval parts",
    secIntegrity: "Structure",
    secFixable: "Fixable (xbb doctor --fix)",
    secMissing: "Not fixable (needs AI or your call)",
    secSplit: "Entity split",
    secNext: "Next",
    labels: {
      inv: "Inverted",
      ent: "Entity",
      vec: "Semantic",
      fts: "Full-text",
      orphan: "Orphan rows",
      dangling: "Dangling heads",
      cycles: "Cycles",
      dupHash: "Duplicate content",
      tagTerms: "Tag terms",
      entityTerms: "Entity terms",
      entityRows: "Entity edges",
      blankTerms: "Blank terms",
      type: "Missing type",
      entities: "Missing entities",
      occurredAt: "Missing date",
    },
    gap: (n) => `${n} short`,
    count: (n) => `${n}`,
    groups: (n) => `${n} ${n === "1" ? "group" : "groups"}`,
    ftsOk: "index in sync",
    ftsBroken: "index out of sync — rebuild fixes it, the database itself is fine",
    ftsUnchecked: "not verified (no write access)",
    whyType: "they get skipped when filtering by type",
    whyEntities: "the entity channel is blind to them",
    whyOccurred: "the time gate falls back to when it was written",
    splitLine: (n) => `${n}: one name split into several entities, cutting recall in half`,
    nextFix: "xbb doctor --fix             fill in the fixable rows above (rebuilds indexes only, never content)",
    nextDry: "xbb doctor --fix --dry-run   preview the changes without touching the database",
    nextManual:
      'The rows under "Not fixable" need the AI\'s or your own judgement; newly written memories carry these parts automatically.',
    clean: "Every retrieval part is present and all indexes are in sync — nothing to fix.",
    fixedTitle: "Fixed",
    dryRunNote: "Preview only (--dry-run, nothing was written)",
    fixedLine: (label, n) => `${label}  ${n}`,
    fixedNone: "Nothing to fix — every fixable row above is already 0.",
    readonlyHint: "The database is not writable right now (read-only file or insufficient permissions), so --fix cannot run.",
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

    title: "xiaobenben · AI client connection status",
    cols: { client: "Client", installed: "Installed", status: "Status", engine: "Engine" },
    cell: { yes: "yes", no: "no", dash: "—" },
    status: { ok: "yes", broken: "error", inUse: "in use", notDetected: "not detected" },
    engine: { npx: "npx package", desktop: "desktop app", pkg: "npm cache binary", other: "other" },
    badJson: (detail) => `config is not valid JSON (${detail})`,
    notObject: "config top level is not an object",
    exeMissing: (path) => `the executable this config points at no longer exists: ${path}`,
    summary: (parts) => "  " + parts.join(", ") + ".",
    summaryFound: (n) => `found ${n} client${n === 1 ? "" : "s"}`,
    summaryNone: "no AI clients found on this machine",
    summaryConnected: (n) => `${n} connected`,
    summaryInUse: (n) => `${n} in use (config not located)`,
    brokenTitle: "  ⚠ Configured but unreachable (the entry looks fine inside the client):",
    brokenAt: (path) => `     config: ${path}`,
    inUseTitle: "  In use, but no config found in the usual places:",
    inUseWho: (host) => ` (host process ${host})`,
    inUseLine: (label, who) => `     ${label}${who} — an xbb mcp child process is running, so it already works.`,
    inUseDontReconfigure:
      "     Do not reconfigure: these clients may keep their config in the project directory or internal storage.",
    pendingTitle: "  Not detected as connected — paste the block below into its own config file:",
    pendingHead: (label, path) => `  ── ${label} ──  ${path}`,
    allReady: "  Every installed client is ready. Nothing to do.",
    unknownTitle: "  Other MCP processes are running, but which client spawned them is unknown:",
    unknownHosted: (host) => `under ${host}`,
    unknownHostGone: "host has exited",
    unknownFromShell: " (looks like it was started by hand in a terminal)",
    unknownLine: (pid, who, fromShell) => `     pid ${pid} · ${who}${fromShell}`,
    noteNotDetected: [
      '  Note: "not detected" only means this command found no config in the usual places.',
      "        Some clients keep their config in the project directory or an internal database —",
      "        unreadable from here, but still working. If you know a client is in use, do not reconfigure it.",
    ],
    noteNpxY: [
      '  Note: the npx line must include -y. On first run it asks "Ok to proceed?",',
      "        and under MCP nobody can answer — the client just hangs instead of reporting an error.",
    ],
    noteRestart: "  Restart the client after editing its config (they only read it at startup).",
    noteReadOnly: "  This command reads config and processes only. It modifies no files.",
  },

  dbGate: {
    missing: (d) => {
      const lines: string[] = [];
      lines.push(`The memory database is not where it should be: ${d.dbPath}`);
      if (d.kind === "default-missing-but-installed") {
        lines.push("   This is the default install directory, and **the program's own files are all here**");
        lines.push("   (bin / models / logs / cloud.json and so on). So this installation has been used before —");
        lines.push("   the database was most likely moved, renamed, or deleted by accident.");
        lines.push("   Starting is refused here: creating a fresh empty database would look like total memory loss.");
      } else if (d.kind === "env-missing") {
        lines.push("   The location comes from the XBB_DATA_DIR environment variable (temporary override, nothing written to disk)");
      } else {
        lines.push(`   The location comes from the config file: ${d.configPath}`);
      }
      if (d.kind === "configured-missing-but-legacy-exists") {
        lines.push("");
        lines.push(`⚠️ But the default location **does** have a database: ${d.legacyDbPath}`);
        lines.push("   This is not a first run — the database still exists, the new config just does not point at it.");
        lines.push("   Creating an empty database would look like total memory loss, so starting is refused.");
      } else if (d.kind === "configured-missing" || d.kind === "env-missing") {
        lines.push("");
        lines.push("Possible causes: (1) the drive is not mounted or was unplugged  (2) the database was moved, renamed or deleted  (3) the config points at the wrong path");
      }
      lines.push("");
      lines.push("Investigate: xbb home show    shows where the program and the database actually are, their size and last write time");
      lines.push("             xbb home find    scans every drive for memory.db (for when you forget where you put it)");
      if (d.source === "env") {
        // env 的优先级高于配置文件：这时候 move/set 写进去也没用，说清楚免得白折腾一趟
        lines.push("             ↳ The location comes from an environment variable, which **overrides the config file** — clear or fix XBB_DATA_DIR for changes to take effect");
      } else if (d.kind === "configured-missing-but-legacy-exists") {
        lines.push(`             xbb home move "${d.legacyDbPath.replace(/[\/][^\/]*$/, "")}"   move the default-location database there and repoint the config`);
        lines.push(`             xbb home reset   drop the config and go back to the default location (${d.legacyDbPath})`);
      } else if (d.kind === "default-missing-but-installed") {
        lines.push(`             xbb home set "<the directory holding the memory.db you found>"   point at it once you find it`);
      }
      lines.push("Start from zero anyway: xbb home init --force (creates an empty database, and --force must be explicit)");
      return lines.join("\n");
    },
    corrupt: (file, detail) =>
      [
        `The xiaobenben memory database cannot be opened: this file is damaged (${detail}).`,
        `   File: ${file}`,
        "   ⚠️ Do not delete it yet — leaving the original untouched keeps recovery possible; overwriting or deleting is what makes it truly gone.",
        "   What to do:",
        "     1. Preserve it: copy memory.db together with memory.db-wal / -shm somewhere else",
        "     2. If a historical backup sits in the same directory, try swapping it in: memory.db.bak-* / memory.db.gen1",
        "     3. To start from zero for real: rename the file out of the way (memory.db → memory.db.corrupt),",
        "        then run xbb home init --force",
        "   Investigate: xbb home show   shows the database location, size and last write time",
      ].join("\n"),
    busy: (detail) =>
      [
        "Another xiaobenben process is writing to the database, so the schema upgrade could not take the write lock.",
        `  Underlying cause: ${detail}`,
        "  What to do: stop every xbb process, then rerun the command you just ran. The least work is to close the AI",
        "             client sessions that are using xiaobenben (each session spawns its own process). From a terminal you can:",
        "               xbb stop                  when the desktop build is installed (xbb is on PATH)",
        "               npx -y xiaobenben stop    when you connected through npx and xbb is not on PATH",
        "            Start your AI clients again once the upgrade finishes. No data is lost; the upgrade is idempotent.",
      ].join("\n"),
    writeBusy: (detail) =>
      [
        "This write did not reach the memory database: another xiaobenben process is holding the write lock and three retries were not enough.",
        `  Underlying cause: ${detail}`,
        "  Nothing was lost — the whole write was rolled back (writes are atomic, so no half-saved memory).",
        "  Retrying once usually works. If it keeps happening, some process is stuck; close the AI client",
        "  sessions that are using xiaobenben, or from a terminal:",
        "    xbb stop                  when the desktop build is installed (xbb is on PATH)",
        "    npx -y xiaobenben stop    when you connected through npx and xbb is not on PATH",
        "  Then run the same step again.",
      ].join("\n"),
  },

  cmd: {
    serveFail: {
      missing: (detail) => [
        "\n❌ xiaobenben did not start: no database at the expected location\n",
        detail,
        "\nThe service stayed down on purpose: running on an empty database is worse than not starting at all.\n",
      ],
      busy: (detail) => [
        "\n❌ xiaobenben did not start: another process is writing to the database\n",
        detail,
        "\nThe service stayed down on purpose: serving on a half-migrated schema would look like a successful upgrade.\n",
      ],
      corrupt: (detail) => [
        "\n❌ xiaobenben did not start: the memory database file is damaged\n",
        detail,
        "\nThe service stayed down on purpose: writing to a damaged database only makes recovery harder.\n",
      ],
    },

    bind: {
      usage: 'Usage: xbb bind "xubb://bind?ticket=…&api=…" or xbb bind <ticket>',
      ok: (f) => [
        "✅ Connected to your personal cloud space",
        `   API:     ${f.api}`,
        `   Org:     ${f.org} (${f.orgId})`,
        `   Space:   ${f.space ?? "(resolved automatically on first write)"}`,
        `   Key:     ${f.keyShort}… (plaintext is kept only on this machine: ${f.path})`,
        "",
        "   " + "─".repeat(60),
        "   ⚠️  Restart your AI client for this to take effect",
        "       opencode / Cursor / WorkBuddy etc. (or relaunch xbb mcp)",
        "",
        "       Clients that are already running keep working in LOCAL mode —",
        "       memories written meanwhile land in the local database and are not",
        "       synced to the org you just connected to. New sessions after a",
        "       restart go through the cloud (transcripts and the vault stay local).",
        "   " + "─".repeat(60),
      ],
    },

    unbind: (had) =>
      !had
        ? ["No cloud connection to remove"]
        : [
            "Cloud connection removed (your local database is untouched)",
            "",
            "   " + "─".repeat(60),
            "   ⚠️  Restart your AI client for this to take effect",
            "       Clients that are already running keep working in CLOUD mode and",
            "       will keep writing to the previous org. New sessions after a",
            "       restart go back to local-only mode.",
            "",
            "   💡 Only want local mode for a while? Use `xbb cloud off` — it keeps the",
            "      key, and `xbb cloud on` brings you right back without generating a",
            "      new ticket in the console. The unbind above deletes the key for good.",
            "   " + "─".repeat(60),
          ],

    cloud: {
      noKey: [
        "❌ No cloud key on this machine, so there is nothing to switch to.",
        "   Two ways in: ① generate a bind ticket in the console → `xbb bind <ticket>`",
        "                ② you already have a long-lived key → `xbb bind-key <xbb_live_…>`,",
        "                   or paste it at http://127.0.0.1:17630/ui",
      ],
      switched: (toCloud) => [
        `✅ Switched to ${toCloud ? "cloud" : "local"} mode (the key is kept, not deleted)`,
        "",
        "   ⚠️  Restart your AI client (opencode / Cursor / WorkBuddy etc.) for new sessions to pick this up;",
        "       until then, running clients keep reading and writing in the old mode.",
      ],
      nothingToSwitch: "No cloud config on this machine — already local-only, nothing to switch",
      statusNone: ["Mode:     local (this machine only) — no cloud org connected yet"],
      status: (f) => {
        const lines = [`Mode:     ${f.cloud ? "cloud" : "local (cloud switched off, key kept)"}`];
        lines.push(`Org:      ${f.org}${f.orgId ? ` (${f.orgId})` : ""}`);
        lines.push(`API:      ${f.api}`);
        lines.push(`Key:      ${f.keyShort}… (plaintext is kept only on this machine: ${f.path})`);
        return lines;
      },
      unknownSub: (sub) => `Unknown subcommand: ${sub} (available: on / off / status)`,
      bindErr: {
        badLink: "Invalid xubb link",
        badTicket: "Invalid bind ticket (expected 32-128 hex characters, single use, expires in 60 seconds — generate a new one in the console)",
        bindFailed: (code, message) => `Binding failed ${code}: ${message}`,
        keyEmpty: "The key cannot be empty",
        unreachable: (api, message) => `Cannot reach ${api} (${message}) — check your network or the API address`,
        keyRejected: "The key is invalid or has been revoked (the server refused authentication)",
        verifyFailed: (code, message) => `Verification failed ${code}: ${message}`,
        readFailed: "unreadable response",
      },
      protocol: {
        devRun: (exe) =>
          `This is a bun development run (${exe}) and cannot be registered as a protocol handler. Pass the compiled exe path: xbb register-protocol "C:\\path\\to\\xbb.exe"`,
        unsupportedOs: (os) => `Unsupported platform: ${os}`,
        failed: (message) => `Registration failed: ${message}`,
        regFailed: (op, output) => `reg ${op} failed: ${output}`,
        registeredWin: (exe) => `Registered HKCU\\Software\\Classes\\xubb → "${exe}" bind "%1" (takes effect immediately in browsers, no restart needed)`,
        lsregisterFailed: "lsregister failed",
        registeredMac: (app) => `Registered xubb:// → ${app} (if the first attempt does nothing, click "Connect my xiaobenben" once more)`,
        xdgFailed: "xdg-mime failed (desktops other than GNOME/KDE may need to be associated by hand)",
        registeredLinux: (desktop) => `Registered xubb:// → ${desktop}`,
      },
    },

    bindKey: {
      usage: [
        "",
        "Usage: xbb bind-key <xbb_live_…> [apiBase]",
        "",
        "  How this differs from `xbb bind <ticket>`: a bind ticket is single-use and expires in 60",
        "  seconds, so it has to be generated in the console on the spot. This command takes the",
        "  long-lived key you already hold — for sharing one key across machines, or after you",
        "  accidentally deleted the config. apiBase defaults to https://api.xiaobenben.net",
        "  (pass it explicitly for a self-hosted deployment).",
      ],
      ok: (f) => {
        const lines = [
          "✅ Connected to cloud",
          `   API:     ${f.api}`,
          `   Org:     ${f.org}${f.orgId ? ` (${f.orgId})` : ""}`,
        ];
        if (f.member) lines.push(`   Member:  ${f.member}`);
        lines.push(`   Space:   ${f.space ?? "(resolved automatically on first write)"}`);
        lines.push(`   Key:     ${f.keyShort}… (plaintext is kept only on this machine: ${f.path})`);
        lines.push("");
        lines.push("   " + "─".repeat(60));
        lines.push("   ⚠️  Restart your AI client for this to take effect");
        lines.push("       opencode / Cursor / WorkBuddy etc. (or relaunch xbb mcp)");
        lines.push("   " + "─".repeat(60));
        return lines;
      },
    },

    autostart: {
      onResult: (ok, message) => {
        const lines = [`${ok ? "✅" : "❌"} Start at login ${ok ? "enabled" : "could not be enabled"}\n   ${message}`];
        if (ok) {
          lines.push("");
          lines.push("   After you log in, the background service starts silently — no console window, no admin page.");
          lines.push("   Open the admin page anytime: http://127.0.0.1:17630/ui (or click \"Open admin window\" in the tray).");
          lines.push("   ⚠️ A launcher flashes for about 0.2s at login — the service itself never opens a window.");
          lines.push("   Want to see it now: xbb serve --detach");
        }
        return lines;
      },
      offResult: (ok, message) => {
        const lines = [`${ok ? "✅" : "❌"} ${message}`];
        if (ok) lines.push("   It will not turn itself back on (xbb autostart on restores it)");
        return lines;
      },
      unknownSub: (sub) => `Unknown subcommand: ${sub} (available: on / off / status)`,
      status: (f) => {
        const lines = [`Start at login: ${f.state} (${f.location})`];
        if (f.command) lines.push(`  Command: ${f.command}`);
        // 意图与现状不一致是排障时最容易卡住的一类：用户以为关了，系统里还留着。
        if (f.pref === "off") lines.push("  Your intent: off (serve will not write it again)");
        else if (f.pref === "on") lines.push("  Your intent: on");
        else lines.push("  Your intent: on by default (never turned off; a missing or changed entry is repaired automatically)");
        return lines;
      },
      msg: {
        winOnly: (op, platform) =>
          `${op === "write" ? "writeAutostartEntry" : "removeAutostartEntry"} only applies to the Windows registry (currently ${platform})`,
        writeFailed: (code, out) => `write failed (reg exit code ${code}): ${out}`,
        readbackMismatch: (expected, actual) => `read-back does not match — expected ${expected}, got ${actual ?? "(none)"}`,
        absentValue: (valueName) => `"${valueName}" was not there to begin with, nothing to do`,
        deleteFailed: (code, out) => `delete failed (reg exit code ${code}): ${out}`,
        stillPresentPolicy: "still present on read-back after deletion (group policy may have written it back)",
        removedValue: (valueName, before) => `removed "${valueName}" (previous value ${before})`,
        fileWriteFailed: (msg) => `write failed: ${msg}`,
        fileDeleteFailed: (msg) => `delete failed: ${msg}`,
        stillPresentFile: "the file is still there after deletion (missing permissions?)",
        absentFile: (path) => `${path} was not there to begin with, nothing to do`,
        removedFile: (path) => `removed ${path}`,
        fileWithCommand: (path, command) => `${path}\n   Command: ${command}`,
        bootstrapPending: (out) => `\n   (launchctl bootstrap did not take effect immediately; the file is in place and loads at next login: ${out})`,
        bootoutNonZero: (out) => `\n   (launchctl bootout returned non-zero; it may simply not have been loaded: ${out})`,
        launchdHosted: (exe) => `${exe} serve --no-open (supervised by launchd)`,
        launchdLocation: (path, label) => `${path} (launchd · ${label})`,
        xdgLocation: (path) => `${path} (XDG autostart entry)`,
        noMechanism: (platform) => `${platform} has no known autostart mechanism`,
        notCompiled: (exe) => `Refusing to write: this is not a compiled build (${exe}). Run this command with an installed xbb.`,
        winNeedsExe: (exe) => `Refusing to write: a Windows startup entry must point at a .exe (currently ${exe})`,
        unsupported: (platform) =>
          `${platform} does not support configuring start-at-login yet (Windows / macOS / Linux are covered).\n` +
          "  Elsewhere: point your platform's own service manager at `xbb serve --no-open`.",
      },
    },

    ingestNote: {
      notFoundDb: (name) => `${name} not found`,
      notFoundPath: (path) => `${path} not found`,
      sessionFiles: (n) => `${n} session file${n === 1 ? "" : "s"}`,
      rolloutFiles: (n) => `${n} rollout file${n === 1 ? "" : "s"}`,
      composerParsed: (parsed, total) => `parsed ${parsed} of ${total} conversation${total === 1 ? "" : "s"}`,
      composerUnchanged: (n) => `all ${n} conversation${n === 1 ? "" : "s"} unchanged`,
      incrementalFiles: (n) => `read deltas from ${n} file${n === 1 ? "" : "s"}`,
      noNew: "nothing new",
      failed: (msg) => `failed: ${msg}`,
      stalled: (hours) => `⚠ newest v2 data is ${hours}h ahead of the cursor, zero output this run — the parsing rules may no longer match`,
      v2Pending: (n) => `${n} still in flight inside the v2 watermark`,
      maxTurns: "per-run limit reached, the rest continues next run",
      schemaTwice: "⚠ session_message used to be readable and is not anymore — the upstream schema changed again",
    },

    ingest: {
      busy: (detail) => [`\n❌ Collection could not start: ${detail}\n`],
      corrupt: (detail) => [`\n❌ Collection could not start: the memory database file is damaged\n`, detail],
      toggled: (on) =>
        on
          ? "Automatic collection on: the service starts reading local sessions within 30 seconds"
          : "Automatic collection off: it stops within 30 seconds and reads no more raw text. What is already stored stays; see xbb ingest --status",
      statusCols: ["Source", "Ready", "Stored", "Sessions", "New", "Parse", "Last run", "Note"],
      statusTotal: (n) => `\nepisodes total: ${n} (cold archive on this machine, never uploaded)`,
      balanceIdle: "Layer balance: the transcript layer is still empty (nothing collected), so the ratio is meaningless",
      balance: (memories, episodes, ratio, tag) =>
        `Layer balance: summaries ${memories} : transcripts ${episodes} ≈ ${ratio}  ${tag}`,
      balanceTags: { healthy: "✅ healthy", watch: "⚠ watch", flooding: "⚠ summaries may be flooding" },
      balanceAdvice: [
        "  A healthy ratio is ≥1:50 (transcripts are collected automatically; summaries should only carry conclusions).",
        '  A collapsing ratio usually means the AI is paraphrasing the conversation instead of distilling it: ask "will this',
        '  be useful in 3 months, and can it be found by searching the transcript?" — if yes, skip writing it.',
      ],
      unparsed: (n, total) => ` [unparsed ${n}/${total}]`,
      unknownSource: (bad, ok) => `Unknown source: ${bad} (available: ${ok})`,
      runCols: ["Source", "Ready", "Scanned", "New", "Skipped", "Parse", "Time", "Note"],
      runTitle: (dryRun) => `${dryRun ? "[dry run, nothing written] " : ""}Client session collection`,
      driftTitle: "\n⚠ Schema fingerprint changed — the upstream tool may have been redesigned:",
      driftLine: (label, fingerprint, unparsed, suspects) =>
        `   ${label}: new fingerprint ${fingerprint}, unparsed this run ${unparsed}/${suspects}`,
      driftAdvice: "   Check the unparsed counts in --status first; if they keep growing, the parsing rules no longer match.",
      runSummary: (scanned, inserted, ms, total, dryRun) =>
        `\nScanned ${scanned}, ${dryRun ? "would insert" : "inserted"} ${inserted} in ${ms}ms; episodes now ${total}`,
      cumulative: (s) => "Total: " + s,
    },

    updateStatus: {
      source: (v) => `Manifest:  ${v}`,
      noSource: "(disabled: XBB_UPDATE_URL is empty)",
      form: (v) => `Build form: ${v}`,
      formExe: "compiled exe",
      formDev: "dev (not compiled, self-update disabled)",
      dir: (v) => `Work dir:  ${v}`,
      pendingNone: "pending:  none",
      // 措辞必须与 decideBootAction 的三态一致：写成"将回退"会把只是首次引导的人吓到
      pendingAdopt: (version) =>
        `pending:  yes (v${version} first boot) — it will be ADOPTED on next start; the marker clears once serve passes its health check`,
      pendingRollback: (version) =>
        `pending:  yes (v${version}) — it will be ROLLED BACK and blocklisted on next start (the last boot never reached the confirmation point)`,
      blocklist: (v) => `Blocklist: ${v}`,
      blocklistEmpty: "empty",
    },

    home: {
      progDir: (v) => `Program dir  ${v}   (exe / updates / tray / config)`,
      dataDir: (v) => `Data dir     ${v}`,
      srcLabel: (v) => `Source       ${v}`,
      srcEnv: "environment variable XBB_DATA_DIR (temporary override, not written to disk)",
      srcConfig: (path) => `config file ${path}`,
      srcDefault: "default location (not configured, backwards compatible)",
      dbCounts: (memories, episodes, events, integrity) =>
        `\n          memories ${memories} / transcripts ${episodes} / events ${events} · integrity ${integrity}`,
      dbNewer: (schema, target) =>
        `\n          ⚠️ Schema v${schema} is newer than v${target} supported by this build — reads and writes work but the schema is left alone; upgrading is recommended`,
      dbOpenFailed: (msg) => `\n          ⚠️ cannot open: ${msg}`,
      dbCorruptHint:
        "\n          ⚠️ looks like a damaged database file — copy it along with -wal / -shm and keep that copy; do not delete, do not overwrite",
      dbPath: (path) => `Database     ${path}`,
      lastWritten: (when) => ` · last written ${when}`,
      dbMissing:
        "          ⚠️ not in place — starting now would be refused (on purpose: running on an empty database is worse than not starting)",
      dbElsewhere: (path) => `          The default location does have a database: ${path} — fix the pointer with xbb home move / reset`,
      models: (path, size) => `Models       ${path}   ${size}`,
      modelsNotDownloaded: "(not downloaded yet)",
      configFile: (path) => `Config       ${path}`,
      configAbsent: "   (absent = default location)",
      setUsage: [
        'Usage: xbb home set "<dir>" [--force]',
        "  The target directory must already contain memory.db — to move the database there, use `xbb home move`.",
      ],
      setNoDb: (abs) => [
        `❌ ${abs} contains no memory.db`,
        '   · To move the database there: xbb home move "' + abs + '" (copy + verify + repoint, all in one)',
        "   · Database lives on an external disk that is not plugged in right now: confirm the path and add --force to write the pointer anyway",
      ],
      setOk: (abs) => `✅ Now pointing at ${abs}`,
      setDbReady: (path) => `   Database is in place: ${path}`,
      setDbMissing: "   ⚠️ No database there right now — the next start will be refused (it will not create an empty one)",
      setModelsCopied: (from, to, size) => `   Models copied as well: ${from}  →  ${to} (${size})`,
      setNoModels: [
        "   ⚠️  That location has no semantic-search model, and there is no local copy to bring along:",
        "       search falls back to keyword matching. One restart with a network connection downloads it again.",
      ],
      setRestart: [
        "",
        "   ⚠️  Restart your AI clients (opencode / Cursor / WorkBuddy) and xbb serve for this to take effect;",
        "       running processes still hold the old path.",
      ],
      moveUsage: [
        'Usage: xbb home move "<dir>" [--cleanup] [--force]',
        "  Copy → verify (integrity + row-by-row counts) → only then repoint. A failed verification repoints nothing.",
        "  --cleanup  delete the old copy once verification passes (default is to keep it — delete it yourself after",
        "             confirming the new location works).",
        "  --force    skip the \"is the database in use\" check (use it when you have confirmed nothing is running;",
        "             verification still runs).",
      ],
      moving: "Moving (copy first, verify next, repoint last)…",
      moveOk: (from, to) => `✅ Moved: ${from}  →  ${to}`,
      moveEntries: (entries, size) => `   Carried over ${entries}, ${size} in total`,
      moveVerify: (integrity, memories, episodes, events) =>
        `   Verified: integrity ${integrity} · memories ${memories} / transcripts ${episodes} / events ${events} (matches the source item by item)`,
      moveConfig: (path) => `   Config: ${path}`,
      moveRestart: "   ⚠️  Restart xbb serve and all AI clients before the new location is used.",
      moveKeepOld: (from) => `   The old copy is still at ${from}; delete it once the new location is confirmed working.`,
      moveErrSamePath: (to) => `That is already the current location: ${to}`,
      moveErrProcs: (list) =>
        `xbb processes are still running: ${list.join(", ")}\n` +
        `  Moving now would lose writes that are still sitting in the WAL. Stop them first: xbb stop\n` +
        `  (quitting from the tray menu works too; Cursor / opencode / WorkBuddy each spawn their own xbb mcp,` +
        ` and those only disappear once the client is closed — killing one gets it respawned immediately.)\n` +
        `  If you are sure none of them are left but you are still blocked: xbb home move "<dir>" --force`,
      moveErrBusy: (srcDb) =>
        `The database is in use; moving it now would lose writes that have not hit disk yet: ${srcDb}\n` +
        `  · First try: xbb stop (stops the background service), and close any AI client with xiaobenben open\n` +
        `  · Still seeing this message: xbb home move "<dir>" --force (skips this check, verification still runs)`,
      moveErrTargetHasDb: (dstDb, to) =>
        `There is already a database at the target: ${dstDb}\n` +
        `   To avoid overwriting someone else's memories, this stops here.\n` +
        `   · Want to use that one: xbb home set "${to}" (make sure it is the one you mean)\n` +
        `   · Want somewhere else: pick an empty directory`,
      moveErrNothing: (from) => `There is nothing to move at the current location: ${from}`,
      moveErrNoVerify: (dstDb) => `Verification after copying produced no result: ${dstDb}`,
      moveErrIntegrity: (integrity, dstDb, srcDb) =>
        `Integrity check failed after copying (${integrity}): ${dstDb}\n   Config was not switched, the original database is intact: ${srcDb}`,
      moveErrDstMissing: (dstDb) => `The target database does not exist after copying: ${dstDb}`,
      moveErrRowMismatch: (key, src, dst, srcDb) =>
        `Row counts differ after copying (${key}: source ${src} / target ${dst}) — config was not switched, the original database is intact: ${srcDb}`,
      lockProbeFailed: (dbPath, msg) =>
        `Could not confirm the database is idle: ${dbPath}\n` +
        `  Reason: ${msg}\n` +
        `  This is not "in use" — the check itself failed. Please send us that line verbatim.\n` +
        `  Once you have confirmed no xbb process is running you can skip the check: xbb home move "<dir>" --force`,
      findScanning: "Scanning (drive roots + home, depth 4, 15 second budget)…",
      findDeepScanning: "Deep scanning the whole disk (may take minutes)…",
      findNone: "No memory.db found. If it lives on an external disk, plug it in and scan again; or use --deep.",
      findCols: "Memories  Size       Last write         Path",
      findCurrent: " ← current",
      findTotal: (n) => `\n${n} found. Switch to one: xbb home set "<its directory>"`,
      initRefused: (path, exists) => [
        "Refusing to run: creating an empty database is an **irreversible judgement call** (users take it to mean all memories are gone).",
        `   Current location: ${path}${exists ? " (has a database, init not needed)" : " (empty)"}`,
        "   If you really want to start from zero, add --force: xbb home init --force",
        "   More likely you want: xbb home show / xbb home find / xbb home reset",
      ],
      initOk: (path) => [
        `✅ Created an empty database at ${path}`,
        "   ⚠️  This is a brand-new empty database — previous memories are not in it.",
      ],
      resetOk: (path, exists) => [
        `✅ Data directory config removed, back to the default location: ${path}`,
        `   ${exists ? "The database is there." : "⚠️ No database there — try xbb home find."}`,
      ],
      unknownSub: (sub) => `Unknown subcommand: ${sub} (available: show / set / move / find / init / reset)`,
    },

    stop: {
      none: "No xbb processes are running.",
      found: (list, n) => `Found ${n} xbb process${n === 1 ? "" : "es"}: ${list}`,
      stopped: (pid, name) => `  ✅ Stopped PID ${pid} ${name}`,
      kept: (pid, name, why) => `  ⏭  Kept PID ${pid} ${name} (${why})`,
      keptWhyNoCmd: "no command line available, skipped to be safe",
      keptWhyMcpBusy: "mcp, this session is still using it",
      keptWhyMcp: "mcp",
      signalTimeout: "exit signal sent, but it did not exit within 3 seconds",
      failed: (pid, name, err) => `  ❌ Could not stop PID ${pid} ${name}: ${err}`,
      failedHint: "\n  Processes that will not stop are usually a permissions problem: retry as administrator on Windows, check the owner on Unix.",
      undecidable: (n) => [
        `\n  ⚠️ Startup arguments unavailable for ${n} process${n === 1 ? "" : "es"} (the OS restricts process queries); all of them were skipped —`,
        "     better to leave one serve running than to kill an mcp that is feeding you memories right now. Drop --keep-mcp to stop everything.",
      ],
      keptMcp: [
        "",
        "  --keep-mcp kept the mcp processes: memory tools in this session are unaffected, serve is stopped.",
        "  The mcp processes still hold the database, so xbb home move will still report it as in use.",
        "  Quit the AI clients first, then run xbb stop again without --keep-mcp.",
      ],
      stoppedHint: [
        "",
        "  Note: an mcp spawned by Cursor / opencode / WorkBuddy is restarted automatically by that client.",
        "  To stop everything, quit those clients first and run xbb stop again.",
        "  To bring the background service back: xbb serve --detach (or click \"Open admin window\" in the tray).",
      ],
    },

    plain: {
      serveNotReady: (extra) => `Background service: not ready${extra}`,
      portBusy: (port) => ` — port ${port} is taken by another program`,
      seeLog: " — see logs/serve.log",
      toastAlreadyTitle: "xiaobenben is already running",
      toastStartedTitle: "xiaobenben AI memory started",
      toastBody: "The tray icon is in the bottom-right corner. If you cannot see it, click ^ and drag it onto the taskbar.",
      serveRunning: (port) => `Background service: running (127.0.0.1:${port})`,
      serveStarted: (ms) => `Background service: started and ready (${ms}ms)`,
      cloudLocalOnly: "Mode: local (this machine only) — no cloud connected",
      cloudLive: (org, api) => `Mode: cloud · ${org}  @ ${api}`,
      cloudOff: (org) => `Mode: local (cloud switched off, key kept) · switch back to ${org} anytime`,
      unknownCommand: (cmd) => `Unknown command: ${cmd} (run xbb --help for the full list)`,
    },
  },

  tray: {
    bound: "bound",
    openWindow: "Open admin window",
    modeCloud: (org) => `Mode: cloud · ${org}`,
    modeLocalKeep: "Mode: local (cloud off, key kept)",
    modeLocalOnly: "Mode: local (this machine only)",
    switchHint: "Restart your AI client for the switch to take effect",
    toCloudBound: (org) => `Switch to cloud · ${org}`,
    toCloudUnbound: "Switch to cloud…",
    toLocal: "Switch to local (keep key)",
    bindKey: "Enter a cloud key…",
    verify: "Verify hash chain",
    report: "Export diagnostics",
    update: "Check for updates",
    autostart: (on) => `Start at login: ${on ? "on" : "off"}`,
    exit: "Exit",
    tipCloud: (org) => `xiaobenben · cloud mode · ${org}`,
    tipLocal: "xiaobenben · local mode (127.0.0.1:17630)",
  },
};
