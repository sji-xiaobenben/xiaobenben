// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * English help text.
 *
 * 翻译原则（与 `../en.ts` 同一套）：
 *   1. **不是逐字直译。** 中文帮助里最有价值的是"为什么这么设计"，英文版保留这层理由，
 *      但不保留中文的四字节奏与破折号堆叠 —— 那是中文的修辞，直译成英文只会显得啰嗦。
 *   2. **命令名、参数名、错误码、路径原样不动。** 它们是接口，不是文案。
 *   3. 术语与官网英文文档一致：记忆 = memory，原话 = transcript，召回 = recall，
 *      情景层 = episode layer，凭证层 = ledger。
 */
import type { HelpDict } from "./types";

const dataLocation = `  xbb home                 where the program is, where the database is, and why it thinks so (default = show)
  xbb home move <dir>      move the database to another drive: copy → verify → then switch config
  xbb home set <dir>       config only, no copy (target must already hold memory.db; models come along)
  xbb home find [--deep]   scan every drive for memory.db (for when you forgot where you put it)
  xbb home reset           drop the config and fall back to the default location
  xbb home init --force    create an empty database here (the only creation path, needs explicit consent)`;

export const helpEn: HelpDict = {
  dataLocation,

  overview: `xbb — the xiaobenben desktop client

Usage: xbb <command> [args]
       xbb                     make sure the service is up (start it if not) + quick status
       xbb <command> --help    full docs for that command (works anywhere, **takes no action**)

Service & clients
  xbb serve [--detach|--no-open|--headless]   local service + tray + admin window (:17630)
  xbb start [--open]                          ensure the service is up + notify; use this for shortcuts
  xbb mcp                                     MCP stdio — how AI hosts attach (they launch it)
  xbb connect [--json]                        which AI clients are wired up (read-only, changes nothing)
  xbb stop [--keep-mcp]                       stop every xbb process on this machine
  xbb autostart [on|off|status]               start at login (on by default; all three platforms)

Data location
${dataLocation}

Cloud
  xbb cloud [on|off|status]   local ⇄ cloud switch (keeps your key; default = show status)
  xbb bind <ticket>           bind a cloud org (via xubb:// or a 60-second single-use ticket)
  xbb bind-key <key>          bind directly with a long-lived key you already have
  xbb unbind                  unbind and delete the local key (not recoverable)
  xbb register-protocol       register the xubb:// handler (all three platforms)

Collection & upkeep
  xbb ingest [on|off|--status|--dry-run|--source=…]   collect raw session transcripts from AI clients
  xbb verify                  audit: hash-chain integrity of your local ledger
  xbb stats                   database size and recall numbers (read-only, starts nothing)
  xbb doctor [--fix]          data hygiene check: are the retrieval parts all there (--fix rebuilds indexes only)
  xbb version                 version banner + build fingerprint

Interface
  xbb lang [zh|en]            interface language (default = show; writes config.json, offline)

Updates
  xbb update                  check for and apply an update (bypasses the rollback blacklist)
  xbb update-status           quick view of updater state (feed / pending / blacklist)

You can also switch local ⇄ cloud from the tray icon, or in the admin window at http://127.0.0.1:17630/ui .`,

  serve: `Usage: xbb serve [options]

Starts the local service, the tray icon and the admin window (default http://127.0.0.1:17630).

  --detach     run in the background: no console window, no admin page (this is what autostart uses)
  --no-open    run in the foreground, but don't open the admin page
  --headless   no tray, no window (CI / machines without a display)

Notes:
  If the database is not where it should be, this **refuses to start** (exit 2). That is deliberate —
  better to fail than to keep running on an empty database. To diagnose: xbb home show / xbb home find
  Stop it with xbb stop rather than killing the process: serve spawns companions like ingest.`,

  start: `Usage: xbb start [--open | -o]

Makes sure the background service is running, and tells you the outcome. **Idempotent**: if it is
already up, this does nothing.

This is **the command for icons** — point your desktop shortcut, Start menu entry and taskbar at it.
On double-click:

  not running   → start in the background (no window) → wait for healthz to actually report ready →
                  show a system notification "xiaobenben AI memory is running"
  already up    → just a notification saying so, no second instance (there is only one port)

  --open / -o   open the admin page once ready (http://127.0.0.1:17630/ui)

How this differs from the other two ways to start:

  xbb serve           foreground, Ctrl+C to stop, opens the admin page — for development and debugging
  xbb serve --detach  background, returns immediately, no wait and no notification — what autostart uses
  xbb start           background + **waits until actually ready** + notifies — hence good for double-click

Why start waits instead of saying "started": bind failures, a corrupt database and a taken port all
happen *after* spawn. Announcing "started" and then failing silently sends the user looking for a tray
icon that will never appear — worse than saying nothing.

⚠️ Whether the tray icon gets folded into the ^ overflow area is up to Windows; no program can force it.
   If you don't see it at first: open ^, drag "xiaobenben" onto the taskbar, and Windows will remember.`,

  mcp: `Usage: xbb mcp

Runs in MCP stdio mode — this is how AI hosts (opencode / Cursor / WorkBuddy, etc.) attach.
The host launches it; you normally never run this by hand.

  A broken database does not crash it: all 23 tools stay registered, they return a readable reason,
  and write tools degrade with a handshake hint.

Manual debugging: run xbb home show to confirm the database exists, then look for xbb's stderr in the
host's MCP log.`,

  connect: `Usage: xbb connect [--json]

Shows **which AI clients on this machine are wired into xiaobenben**, and where each one's config lives.

Why this needs its own command: installing the engine and attaching a client are two different things.
npx only puts an executable on disk; attaching happens the other way around — you add a command entry
to the client's own config, and the client launches it at startup. So "where did I install it" can never
be answered by the install step; it can only be answered by reading those configs back.

  Output covers:
    · whether the client is installed (does its config directory exist)
    · whether it is attached, and whether it points at the desktop build or the npx package
    · whether the executable it points at **still exists** (breaks after upgrades or moving dirs —
      the hardest failure to self-diagnose)
    · for clients that aren't attached, a paste-ready snippet formatted the way that client expects

  --json    machine-readable output (for scripts and installers)

**This command is read-only and modifies no files.** Writing client configs automatically needs
backup, per-field confirmation and idempotent design — a different risk class from "report status",
so it will not be smuggled into the same command.

The npx line must carry -y: on first run it asks "Ok to proceed?", and under MCP stdio nobody can
answer. The symptom is a client that never connects — not an error.`,

  stop: `Usage: xbb stop [--keep-mcp]

Stops every xbb process on this machine (including the background serve). Process names get changed,
so the test is "the first token of the command line is xbb", not a name-prefix match.

  --keep-mcp   keep the mcp processes that AI clients launched; stop only serve / tray

Two boundaries you must know:
  · **Without --keep-mcp this stops mcp too.** Memory tools in your current session go dead until you
    restart the AI client; the host will also relaunch the killed mcp by itself (stop isn't broken).
  · **mcp processes kept by --keep-mcp still hold the database open**, so "xbb home move" will still
    report it as in use. Close your AI clients first, then run stop with no flags.

If nothing stops, it's usually permissions: retry as administrator on Windows, check process ownership
on Unix.`,

  home: `Usage: xbb home <subcommand>

The single source of truth for where your data lives. Iron rule: **the anchor follows the program,
never the database** — config.json lives in the program directory, so it survives a lost database, and
"anchor present, goods missing" becomes a detectable fault instead of a silent "first run".

  show                  program dir / data dir / where that came from / size and counts / models, config
  move <dir>            copy → verify (integrity + per-table row counts) → only then switch config
  set <dir>             config only; the target must already hold memory.db, models are copied over
  find [--deep]         scan every drive for memory.db, sorted by memory count (empty same-name files abound)
  reset                 drop the config and fall back to the default location
  init --force          create an empty database (the only creation path, needs explicit --force)

  xbb home move --help  every option for moving (--cleanup / --force)`,

  homeShow: `Usage: xbb home show

Program dir / data dir / where that came from / database size and counts / models dir / config contents,
all at once. "Why is it this path" must be answerable — otherwise debugging is guesswork.

Exit code: 0 if the database is in place, 1 if not — scripts can branch on it directly.

Other subcommands: xbb home --help`,

  homeMove: `Usage: xbb home move "<dir>" [--cleanup] [--force]

Moves your memory database to another drive. The program stays put; the config points at the new place.

  --cleanup   delete the old copy once verification passes (default is to keep it — delete only after
              you've confirmed the new location works)
  --force     skip the "is the database in use" check (when you've confirmed no process holds it;
              **verification still runs**)

Steps: copy → verify (PRAGMA integrity_check plus per-table row counts for memories/transcripts/events)
→ write config. Any failing step aborts with the original database intact and the config untouched —
a half-copied database mistaken for the real one is worse than having none.

If it's blocked, try in order:
  1. xbb stop            stop the background serve (no --keep-mcp, so mcp stops too)
  2. close Cursor / opencode / WorkBuddy — each hosts an xbb mcp and will relaunch what you kill
  3. xbb home move "<dir>" --force

After moving, restart xbb serve and all AI clients before the new location takes effect.`,

  homeSet: `Usage: xbb home set "<dir>" [--force]

Changes the config only; nothing is copied. The target directory **must already contain memory.db**,
otherwise this refuses — pointing at an empty directory just walks you into the next startup's error.

  --force   write the config even though the target has no database yet (external drive not plugged in
            right now, will be later)

Models (~24MB) are copied over automatically from the current data dir or the program dir. Missing
models do not raise an error — they **silently degrade to keyword-only search**, which is why this step
matters: you should not be leaving users to discover on their own that "it got dumber".`,

  homeFind: `Usage: xbb home find [--deep]

Scans drives for every memory.db and sorts them by memory count — empty files with the same name are
everywhere; the count is what tells you which one is real.

By default it scans each drive root plus your home directory, depth 4, at most 25,000 directories,
15 seconds (a full deep scan on Windows can take ten minutes).
  --deep   raise depth to 10 and the budget to 120 seconds

To switch to one: xbb home set "<the directory you found>"`,

  homeReset: `Usage: xbb home reset

Removes dataDir from config.json and falls back to the default location (the program directory). Your
old database is usually right there. It also reports whether the database is in place afterwards; if
not, run xbb home find.

Other subcommands: xbb home --help`,

  homeInit: `Usage: xbb home init --force

Creates an empty database at the current location. This is the **only** place allowed to create one,
and it requires an explicit --force.

Why so strict: creating an empty database is an irreversible judgement — the user will conclude their
memories are gone while xiaobenben looks perfectly healthy. Confirm you truly don't need the old one:
  xbb home show    what it points at now, and how many memories are in it
  xbb home find    the old database may still be on another drive
  xbb home reset   if the config points somewhere wrong, just drop it`,

  cloud: `Usage: xbb cloud [on|off|status]

Local ⇄ cloud mode switch (default = status).

  on       switch to cloud (uses the key already on this machine; nothing is deleted)
  off      switch back to local (**the key is kept**, so you can turn it on again any time)
  status   show current mode, organization and API base

Restart your AI clients for the change to reach new sessions; clients already running keep reading and
writing in the old mode.`,

  bind: `Usage: xbb bind "<ticket or xubb:// link>"

Binds this machine to a cloud organization using a single-use ticket from "Connect my xiaobenben" in
the console (valid for 60 seconds, one use). You can also paste the full
xubb://bind?ticket=…&api=… link.

Already have a long-lived key (shared across machines, or recovering after a deleted config)? Use
xbb bind-key. To unbind (deletes the local key, not recoverable) use xbb unbind; to merely go back to
local for now, use xbb cloud off.`,

  bindKey: `Usage: xbb bind-key <xbb_live_…> [apiBase]

Binds directly with a long-lived key you already have (sharing across machines, or recovering after
cloud.json was deleted). apiBase defaults to https://api.xiaobenben.net — pass it explicitly for a
self-hosted deployment.`,

  unbind: `Usage: xbb unbind

Unbinds from the cloud and **deletes the key** from this machine (not recoverable).

Just want to stop using the cloud for a while? Use xbb cloud off — it keeps the key, and \`on\` brings
you right back.`,

  autostart: `Usage: xbb autostart [on|off|status]

Start at login (default = status — look before you touch).

**It is on by default**: the first run after installation writes a startup entry, and every login
after that quietly brings up a background service — no console window, no admin page, just the
xiaobenben icon in the tray / menu bar. Don't want it? \`xbb autostart off\` (or click
"start at login: on" in the tray menu) and it will not be written back automatically.

Each platform uses its native mechanism:
  Windows   HKCU\\…\\CurrentVersion\\Run → "小本本服务"
  macOS     ~/Library/LaunchAgents/net.xiaobenben.xbb.plist (launchd)
  Linux     ~/.config/autostart/xbb.desktop (XDG)

To see it right now: xbb serve --detach`,

  ingest: `Usage: xbb ingest [on|off] [--status] [--dry-run] [--source=a,b] [--limit=N]

Collects raw session transcripts from the AI clients on this machine (the episode layer). Idempotent —
re-running it does not duplicate anything.

  on / off           turn **automatic** collection on or off (the background service runs every 5
                     minutes; once off it stops reading local sessions)
  --status           per-source availability, archived counts, parse rate, layer split
  --dry-run          count without writing (see how much would land first)
  --source=opencode,cursor   collect only from the listed sources
  --limit=5000       per-source cap for a single run (for the first paged backfill)

The episode layer is a local cold archive and is never uploaded.`,

  doctor: `Usage: xbb doctor [--fix] [--dry-run] [--json] [--strict]

Data hygiene check. "You can read this memory" and "search can find this memory" are two
different things: search consumes parts — content feeds full-text, terms feed the inverted index,
entities feed the entity channel, embeddings feed the semantic channel. Miss one and that channel
goes completely blind to it, with no error from SQLite at all — you just feel that it remembered
but you can't find it.

Three sections, three different remedies:
  Retrieval parts  coverage per channel (denominator = what search can actually see)
  Structure        indexes out of step with the table, orphan rows, chain cycles, duplicate content
  Fixable          terms and edges that can be copied verbatim from tags / the entity table

  xbb doctor --fix            fill in "Fixable" and rebuild an out-of-sync full-text index
  xbb doctor --fix --dry-run  report what would change, without touching the database
  xbb doctor --json           machine-readable (English field names)
  xbb doctor --strict         exit 1 when structure problems exist (for CI and cron)

--fix only rebuilds indexes and clears orphan rows: it never changes content, type, or entity names.
Missing types and missing entities stay under "Not fixable" — guessing a type from content is worse
than leaving it blank: blank only means you can't filter by it, a wrong guess means filtering
returns the wrong memories.

Works on a read-only connection too (the full-text check is then skipped and reported as unverified
rather than claimed as in sync).`,

  stats: `Usage: xbb stats

Numbers only, no writes: how big the database is, how much is recorded, and whether any of it has
actually been used. **Opens read-only** — no creation, no migration, no service, no network — so it is
safe to run any time.

How to read the three numbers:
  Memories      hundreds to a few thousand is normal. Tens of thousands means either a long history or
                fragments recorded too finely.
  Recalled      how many have actually been used by an AI, plus the total recall count. If this barely
                moves over time, what you record and what gets queried don't line up.
  Transcripts   raw session text collected automatically. Grows only, and is the main reason the file
                gets bigger.`,

  lang: `Usage: xbb lang [zh|en]

Interface language. With no argument it shows the current language and why it is that one.
With an argument it writes config.json, effective from the next command.

Resolution order (high → low):
  XBB_LANG environment variable > config.json "lang" > system locale > Chinese

Region tags work: zh-CN, en_US, en-GB.UTF-8 — only the leading language code is used, so
XBB_LANG=en_US in a script is fine.

This only writes a local config file: no network, no database changes, no effect on your memories.
The admin window needs a restart to follow (it reads the setting once at startup).`,

  verify: `Usage: xbb verify

Audit: verifies the hash chain of your local ledger (records can only be appended, never altered).
Prints chain OK / CHAIN BROKEN, with exit code 0 / 1.`,

  registerProtocol: `Usage: xbb register-protocol [path to exe]

Registers the xubb:// protocol handler (all three platforms) so "Connect my xiaobenben" in the console
can launch the local client. Defaults to the current executable. On Windows this writes HKCU — no
administrator needed.`,

  version: `Usage: xbb version (same as --version / -v)

Prints the version banner and build fingerprint. Both come from build-meta written at compile time —
they exist for verifying which build you're on, so never hand-write them.`,

  update: `Usage: xbb update

Checks for and applies an update manually (bypasses the rollback blacklist, for debugging and
emergencies). The background never swaps the exe silently — whether to update is your call; this
command means "update now".

Restart xbb serve and all AI clients afterwards for it to take effect.`,

  updateStatus: `Usage: xbb update-status

Quick view of updater state: manifest source, runtime form (compiled build / dev), the pending flag,
and the rollback blacklist.

"pending" means one of two things — don't mix them up:
  · a new build was just swapped in and serve hasn't confirmed it yet → next start **accepts** it
  · the last boot never reached the confirmation point → next start **rolls back** and blacklists it
    — the output of this command tells you which one you're looking at`,
};
