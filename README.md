<div align="center">

<a href="https://xiaobenben.net"><img src="assets/brand/logo.svg" width="96" height="96" alt="XiaoBenBen logo" /></a>

<h1>XiaoBenBen</h1>

**Local-first memory for AI agents.**

One SQLite file on your own disk. Any MCP client. Memory that outlives sessions, models and reinstalls.

<a href="https://github.com/sji-xiaobenben/xiaobenben/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/sji-xiaobenben/xiaobenben?style=flat-square&label=release&color=F22222"></a>
<a href="LICENSE"><img alt="License: AGPL-3.0-only" src="https://img.shields.io/badge/license-AGPL--3.0--only-F22222?style=flat-square"></a>
<a href="https://github.com/sji-xiaobenben/xiaobenben/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/sji-xiaobenben/xiaobenben/ci.yml?branch=master&style=flat-square&label=CI"></a>
<img alt="Platforms" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-4a4a4a?style=flat-square">
<img alt="MCP stdio" src="https://img.shields.io/badge/MCP-stdio-4a4a4a?style=flat-square">
<a href="CONTRIBUTING.md"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-2ea44f?style=flat-square"></a>

[Website](https://xiaobenben.net) &middot; [Docs](https://xiaobenben.net/docs/personal-local/intro/) &middot; [Changelog](https://xiaobenben.net/docs/personal-local/changelog/) &middot; [Leaderboard](#leaderboard) &middot; [Install](#install) &middot; [CLI](#cli-reference) &middot; [FAQ](https://xiaobenben.net/docs/personal-local/faq/)

</div>

> [!IMPORTANT]
> **Download only from [xiaobenben.net](https://xiaobenben.net) or this repository's [Releases](https://github.com/sji-xiaobenben/xiaobenben/releases).**
> The self-updater only trusts manifests signed by the official key, and only official builds
> (compiled from this repository) look for updates at all. A mirrored binary or a copy of this
> README does not make anything official.

XiaoBenBen (小本本, "the little notebook") is a memory service that your AI client launches as an MCP stdio server. Memories live in a single SQLite file on your machine. Your AI queries it before answering, writes conclusions into it when a decision is made, and the next session — or the next model, or the next IDE — picks up where you left off.

No account. No login. No telemetry. Works fully offline (only cloud collaboration needs the network). One executable, no system service, no config file to write first, no companion archive — semantic retrieval is built in (see [Install](#install)).

## Why this exists

AI memory today breaks in three places:

1. **Every conversation starts from zero.** The context window closes and yesterday's design decisions, last week's traps, your preferences and dealbreakers are gone. You retype the same background over and over.
2. **Switching clients erases it.** What you told opencode, Cursor and Claude Code stays in opencode, Cursor and Claude Code. Nothing is shared.
3. **To be remembered, you have to hand it over.** Almost every "AI memory" product is a cloud service, so your project layout, customer names, internal decisions and key fragments pass through somebody else's servers.

XiaoBenBen puts the database on your disk and lets the AI reach it over MCP. Change client, change model, change machine (via the cloud organisation mode) — the memory follows you, not the app.

## What you get

### Memory model

| Capability | What it does |
|---|---|
| **Two layers** | `episodes` keeps the raw record (what was actually said, append-only cold storage) and `memories` keeps the distilled layer (what we decided, as retrievable atomic facts). They point at each other through `source_chunk`, so a conclusion can always be traced back to the sentence it came from |
| **Types and intents** | Five content types `fact` / `preference` / `decision` / `event` / `procedure`, plus four intents `kind` = `memory` / `directive` (time-boxed instruction) / `habit` (long-term habit) / `constraint` (hard rule). Same tools, same table — different retrieval semantics |
| **Supersede chains** | An update never deletes the old entry, it chains it: **the head of the chain is the current truth**, older rings stay queryable. A preference you changed cannot be recalled alongside its stale version |
| **Two timelines** | `occurred_at` (when it happened, may be month-precision only) is stored separately from `created_at` (when it was recorded). That is what makes "what were we doing this time last year" answerable |
| **Entities and aliases** | Case variants, abbreviations and former names of the same person / project / product collapse into one entity; `recall_topic` aggregates per entity |
| **Explicit links** | Four relations — `related_to` / `elaborates` / `caused_by` / `contradicts` — with Hebbian weights: links you keep recalling together get stronger, unused ones decay |
| **Attachments** | Images, PDFs, logs, design files addressed by content (sha256) and attached to memories. Locally the library **registers the reference and never copies the bytes**; the same file attached to twelve memories is stored once |
| **Secret extraction** | Credentials are pulled out of the body into a local vault, leaving a `[[xbb_secret_id:N]]` placeholder behind. Copy, export or sync a memory and the secret does not travel with it |
| **Auditable** | Every change lands in a SHA-256 hash chain (`events`, linked by `prev_hash`). One command — `xbb verify` — proves the whole library is intact |
| **Forget is a tombstone** | `forget` marks a tombstone instead of `DELETE`: it disappears from retrieval immediately, but the audit chain still shows it happened |

### Retrieval

| Capability | What it does |
|---|---|
| **Three lexical passes in parallel** | FTS5 trigram (substring matching that behaves for CJK) ∥ a landing-pad inverted index (synonyms / hypernyms / situational terms generated at write time) ∥ exact entity match — fused with IDF weighting |
| **A fourth, vector pass** | `bge-small-zh-v1.5` INT8 runs locally (24 MB, 512 dims) and joins the lexical results via RRF. **No network, no model API** |
| **Chain-head redirect** | A hit on a historical ring jumps to the chain head (current truth) and shows the old value as an annotation — the single most common memory failure is confidently recalling a stale fact |
| **1-hop expansion** | A hit brings along the neighbours it declares, ranked by link strength, expandable hop by hop |
| **Miss guidance** | On an empty result you get `related_tags` — "try these phrasings instead" — rather than a bare "nothing found" |
| **Hard budgets** | Row count and token count are both capped; the library is never dumped into a context window |
| **Silent degradation** | Model missing / load failure / inference error → quietly fall back to lexical-only. Plain text is still stored, and **a broken model never breaks the app** |

### Integration

| Capability | What it does |
|---|---|
| **MCP stdio** | One config stanza and the host spawns it, reaps it on exit. No client-side code |
| **Turn hooks for six hosts** | One zero-dependency script covers Claude Code / Cursor / Trae / WorkBuddy / Codex CLI, plus a dedicated plugin for opencode. Each turn is forwarded to the local service for in-memory retrieval, invisibly to the host |
| **Five session collectors** | Read the local session stores of opencode / Cursor / WorkBuddy / Claude Code / Codex — read-only, idempotent, in place |
| **Structure not client names** | A dedicated parser tries first, then a format descriptor, then generic sniffing. An upstream field rename is no longer fatal, and structural fingerprints show up in `xbb ingest --status` the day it changes |

### Privacy and sovereignty

- **No login** — no account, no email, no binding. Install and go
- **No telemetry** — the codebase contains no channel that reports usage, crashes or metrics
- **Local-first** — personal memory is 100% local SQLite; organisation (enterprise) memory is 100% not local
- **No silent upload** — outbound traffic happens only when you explicitly use a cloud feature
- **The raw layer never goes to the cloud** — `episodes` is local-only cold storage; the cloud backend does not implement it
- **Collection stays local** — reading other AI tools' data happens between memory and local file, nowhere else

### Security and supply chain

- **Verify before compare** — the update manifest is ed25519-signed; a bad signature is rejected outright. There is no "skip verification on failure" branch
- **Double check** — sha256 plus file size; either mismatch refuses the swap
- **Roll back on failure** — a build that will not start gets replaced by the previous one and blacklisted
- **Compiled builds only** — only a compiled single-file binary may be swapped in
- **Local service origin checks** — Host / Origin are checked **before any route**, defeating DNS rebinding and cross-site calls
- **Published threat model** — no inflated claims; [`SECURITY.md`](SECURITY.md) lists every known trade-off, including "the secret vault is masking, not encryption"

### Desktop experience

- **Start on login** — on by default on all three platforms (Windows registry / macOS launchd / Linux XDG); a windowless service plus a tray icon after login
- **Tray menu** — open the admin window, verify, export diagnostics, check for updates, switch local/cloud, toggle autostart, quit
- **Admin window** — `http://127.0.0.1:17630/ui`: browse, search, per-session recall, filter by intent (memory / directive / habit / constraint), edit, delete (tombstone), vault, cloud binding, cleanup preview, diagnostics
- **Desktop notifications** — when a colleague sends you a memory or acknowledges something you sent (Windows Toast / macOS Notification Center / libnotify)
- **Local ⇄ cloud in one switch** — switching back to local **keeps your key**, so you can switch on again without a new binding ceremony

## How it works

### Who writes what

MCP is request/response; the engine cannot see the conversation. So there are three entry points, each owning one layer:

| Entry point | How it arrives | Which layer it writes |
|---|---|---|
| `xbb mcp` | The AI host spawns it as an MCP stdio server | **Distilled layer**, `memories` — atomic facts the AI chose to distil |
| `xbb serve` turn hook | Plugin / hook POSTs to `/hooks/turn` | **Raw layer**, `episodes` — live turns |
| `xbb ingest` | Read-only scan of client session stores | **Raw layer**, `episodes` — historical sessions |

- **The distilled layer is written by the AI.** The AI decides what is worth keeping long term — conclusions, decisions, traps, your corrections — and distils it into atomic facts with retrieval landing pads. This is where memory quality comes from.
- **The raw layer is captured by the engine.** Hooks take live turns; collectors read what the clients already wrote to disk. No client cooperation required, so there is no "write a plugin for every new agent".

Both layers live in the same SQLite file and point at each other via `source_chunk`: the distilled layer records the conclusion, the raw layer keeps the evidence.

### The retrieval pipeline

```
query terms (expanded by the AI: synonyms / hypernyms / situational words / entity names)
   ├─ FTS5 trigram substring match
   ├─ landing-pad inverted index (>= 3 chars)
   ├─ landing-pad inverted index (1-2 chars)
   └─ local vector cosine (512 dims)
         ↓
   IDF-weighted fusion + RRF (vector track)
         ↓
   chain-head redirect → budget cap → 1-hop expansion → miss guidance
```

Everything is local SQL and local inference. **Zero network, zero model API.** The query terms are expanded by the AI before the call — which is the point of "mechanism, not semantics": the engine ships the retrieval machinery and leaves meaning to the model that can actually see the conversation.

### Three rules everything follows

1. **Mechanism, not semantics.** The engine presets no categories and enumerates no "domains". A constraint's `domain` is an empty container: which domains exist (UI design, code style, tone of voice) is merged dynamically as the AI writes. Memory `terms` are generated by the AI. There is no hard-coded business taxonomy in the code, so a new use case needs no engine change.
2. **Append-only.** Changes go through an event hash chain, forgetting is a tombstone, raw speech is cold storage. Every "edit" leaves a trace, and `xbb verify` proves the ledger was not rewritten.
3. **Conservative by default.** Cloud visibility defaults to private (sharing must be explicit); a library that is not where it is expected **refuses to start** (better to fail than to silently run on an empty database); creating a database requires an explicit `--force`; autostart can be switched off permanently and never quietly re-enabled.

### How this differs from cloud memory SaaS

| Dimension | XiaoBenBen (local-first) | Typical cloud memory SaaS |
|---|---|---|
| Where data lives | Your own disk, one SQLite file | Vendor servers |
| Offline | Works (except cloud collaboration) | Usually unavailable or degraded |
| Latency | Local SQL, no round trip | One round trip per retrieval |
| Secrets / sensitive data | Extracted into a local vault, never leaves the machine | Usually uploaded |
| Audit | Hash chain on your disk, self-verifiable | Depends on vendor logs |
| Cross-device | Personal: local; organisation: cloud API | Native |
| Switching clients | MCP is a standard, works everywhere | Each ecosystem its own |

Local is not the right answer for everything: for geographically distributed teams that need central retrieval, cloud is correct. XiaoBenBen's choice is **local by default, upstream only when you ask**.

## Leaderboard

Sixteen products, twenty-one capabilities, every cell scored 0–10 (0 means the mechanism does not exist). Scored October 2026.

| # | Product | Origin | Retrieval<br><sub>41.1%</sub> | Memory structure<br><sub>19.9%</sub> | Delivery &amp; sovereignty<br><sub>24.5%</sub> | Storage &amp; context<br><sub>14.6%</sub> | Overall |
|---:|---|---|---:|---:|---:|---:|---:|
| 1 | **XiaoBenBen** | China | **8.78** | **9.37** | **9.70** | **9.86** | **9.28** |
| 2 | Graphiti | United States | 7.46 | 5.40 | 6.64 | 8.09 | 6.94 |
| 3 | Zep | United States | 7.68 | 5.40 | 7.15 | 6.14 | 6.87 |
| 4 | MemOS | China | 7.01 | 4.83 | 6.09 | 7.32 | 6.40 |
| 5 | Mem0 | United States | 6.80 | 4.83 | 6.22 | 7.09 | 6.31 |
| 6 | Cognee | Germany | 6.00 | 4.73 | 6.09 | 7.09 | 5.93 |
| 7 | Letta | United States | 5.85 | 4.90 | 5.43 | 7.05 | 5.73 |
| 8 | Obsidian | Canada | 4.14 | 4.83 | 8.39 | 6.95 | 5.73 |
| 9 | QwenWork | China | 5.22 | 5.23 | 6.05 | 7.05 | 5.69 |
| 10 | DouBao Work | China | 5.65 | 6.17 | 5.43 | 4.80 | 5.58 |
| 11 | WorkBuddy | China | 5.17 | 4.47 | 6.34 | 6.23 | 5.47 |
| 12 | Supermemory | United States | 5.27 | 4.23 | 6.46 | 5.32 | 5.36 |
| 13 | Qoder | China | 3.97 | 6.00 | 5.96 | 6.45 | 5.22 |
| 14 | Codex | United States | 3.56 | 4.33 | 6.65 | 7.23 | 5.01 |
| 15 | Kimi Work | China | 4.89 | 4.73 | 4.68 | 5.09 | 4.83 |
| 16 | ima | China | 4.69 | 2.73 | 4.74 | 4.95 | 4.35 |

**How to read it.** The four groups are weighted means of the 21 capabilities (retrieval 7 columns, memory structure 4, delivery / portability / sovereignty / cost 6, storage / capacity / context cost 4). Weights sum to 151; the group percentages are those weights divided by 151. Overall is the weighted mean of all 21 cells, which is why the group scores and the total always agree — re-weighting the groups gives you the same total back.

**Read a row, not the ranking.** A single number hides the interesting part. Obsidian scores 4.14 on retrieval and 8.39 on delivery, because it is a notebook rather than a memory engine — and if what you want is a notebook, it is the right answer.

**Where we don't lead.** Three of the 21 capabilities: **semantic retrieval** (7.5, behind Mem0's 8.5 — our vector track is a small local INT8 model, theirs is a hosted embedding service), **temporal** (8.5, behind Graphiti and Zep at 9 — their graph stores are built around time), and **cross-platform** (8.5, behind Zep's 9.5 — we ship desktop binaries, not a managed SaaS with a browser client). All three are deliberate trade-offs, not oversights.

**Scores are ours.** The matrix reflects what we think matters for a memory layer that an AI calls every turn, and it is arithmetic, not a survey: no external reviewers scored these cells. The full 21-column matrix — every cell, heat-mapped, with per-column weights — is on the [website](https://xiaobenben.net/#matrix), so you can check any single claim rather than trust the summary.

## Install

Download your platform's executable from <https://xiaobenben.net> or [Releases](https://github.com/sji-xiaobenben/xiaobenben/releases). **One file, nothing to install alongside it.** Since 0.4.50 the ONNX runtime (CPU backend only) is embedded in the binary and unpacked to `~/.xiaobenben/ort/` on first run — about a second, once.

| Platform | Binary | Semantic retrieval |
|---|:---:|---|
| Windows x64 · macOS arm64 · Linux x64 | ✅ | ✅ built in |
| macOS x64 (Intel) | ✅ | ❌ — upstream publishes no onnxruntime native library for this platform, so retrieval is lexical-only with no way to opt in |

Embedding it is not free in bytes but it is free in *steps*: the GPU backends (36 MB of DirectML) are dropped because the session is CPU-only, which keeps the single binary smaller than the old "binary + runtime archive" pair it replaces.

Nothing to initialise: the database is created on your first MCP handshake. `xbb home init` is only for non-default locations. After that the binary updates itself from the signed official manifest; what changed in each version is in the [changelog](https://xiaobenben.net/docs/personal-local/changelog/).

```bash
xbb --help          # every command, zero side effects
xbb serve           # start the local service (127.0.0.1:17630)
xbb stop            # stop it
xbb stop --keep-mcp # stop the service but keep MCP connections
xbb version         # version + build fingerprint
```

`--help` is intercepted before anything else runs, works anywhere in the line, and executes nothing — `xbb stop --help` will not stop anything.

## Connect your AI client

Add `xbb` as a stdio server in your client's MCP config. The host spawns the process; you do not run it by hand.

```json
{
  "mcpServers": {
    "xiaobenben": { "command": "xbb", "args": ["mcp"] }
  }
}
```

On Windows, if the exe is not on `PATH`, use the full path (e.g. `C:\\Users\\you\\.xiaobenben\\bin\\xbb.exe`).

Twelve hosts are verified. Six of them go beyond MCP:

| Host | MCP stdio | Turn hook | Session collector |
|---|:---:|:---:|:---:|
| opencode | ✅ | ✅ (dedicated plugin) | ✅ |
| Claude Code | ✅ | ✅ | ✅ |
| Cursor | ✅ | ✅ | ✅ |
| WorkBuddy | ✅ | ✅ | ✅ |
| Codex CLI | ✅ | ✅ | ✅ |
| Trae | ✅ | ✅ | — |
| Copilot · Qoder · Kimi Code · OpenClaw · MaxClaw · Muse | ✅ | — | — |

Per-client steps (and the screenshots) are in the [install guide](https://xiaobenben.net/docs/personal-local/install/).

### Tool surface

Tools are ordered as one retrieval journey: write → retrieve → fetch → rules → maintain → organisation.

The count is not a metric — the context window is scarce, and every extra tool costs a paragraph of description and one more chance to pick wrong. That is why there is deliberately **no** "manage memory categories" entry: categorisation is the AI's job at write time, it should not become a taxonomy tree users maintain.

| Group | Tools | What for |
|---|---|---|
| Write | `write_memory` `log_episodes` | Land 3–5 atomic facts in one call; backfill raw turns |
| Retrieve | `search_memory` `recall_topic` `recall_session` `recall_timeline` `recall_episodes` `recall_transcript` | Hybrid search, entity aggregation, session replay, timeline reconstruction, paging through the raw record |
| Fetch | `get_memory` `get_related` `get_asset` `reveal_secret` | Full text plus chain, 1-hop neighbours, attachment bytes, secret plaintext |
| Rules | `recall_directives` `recall_constraints` | Must-ask at session start: habits + time-boxed instructions + global constraints + domain constraints matched by task terms |
| Maintain | `supersede` `forget` `stats` `inbox` `ack` `outbox` | Repair chains, tombstones, usage, pending inbox, acknowledgement, sent box |
| Organisation | `list_spaces` `list_members` `set_memory_audience` | Space tree, members, visibility (cloud organisation mode) |

Tool descriptions are **judgement criteria for the model**, not parameter docs: what to remember, what never to remember ("skip anything the raw record already contains; keep the conclusions the raw record will never state"), when retrieval is mandatory, how to mark a secret. Those criteria are what the library's long-term quality actually rests on.

### Turn hooks (optional)

To have XiaoBenBen participate **on every turn** (relevant memories land in the inbox), install one zero-dependency script:

- `plugins/opencode/xbb-push.js` → drop into `~/.config/opencode/plugins/`
- `plugins/hooks/xbb-hook.mjs` → generic across six hosts, wiring in [`plugins/hooks/README.md`](plugins/hooks/README.md)

The hard rule is **candidates are never injected**: the script's stdout is always empty, so no memory content ever enters the host context (Trae and friends treat stdout as context). Any failure exits 0 silently and never blocks the host's turn.

## Cloud mode (optional, backend not open source)

**By default not a single byte leaves the machine.** Only after you explicitly run `xbb bind` (a one-shot ticket from the console) or `xbb bind-key` (reuse an existing key across machines) does the client talk to `api.xiaobenben.net` — and only while you use a cloud feature.

This layer solves **collaboration**, not storage:

- **Personal memory stays local** — what goes up is organisation (enterprise) memory, which is 100% not local and physically separate from your personal library
- **Private by default** — each memory is visible to its author only; sharing with a department or the whole organisation must be explicit, and the write response echoes the effective visibility instead of making you guess
- **Reversible** — `xbb cloud off` only pauses (the key is kept, `on` brings it back); only `xbb unbind` actually deletes. Without that, "going to the cloud" is a one-way door
- **Multi-device** — the same long-lived key works on any number of machines

### Getting access

No application, no invite list: after signing in you get 1 GB of free reads and writes per month, then ¥10/GB from your balance, which never expires (prices and quotas: <https://xiaobenben.net/versions/personal-cloud/#pricing>).

Binding takes two steps, and **the ticket is not the key**:

```bash
xbb register-protocol                    # one-off: point the xubb:// protocol at this exe
xbb bind "xubb://bind?ticket=…&api=…"    # generated by "connect my XiaoBenBen", single use, 60 s
xbb bind-key <xbb_live_…>                # existing long-lived key: another machine, or after losing config
```

`register-protocol` **does not run automatically**. Skip it and the console's "connect my XiaoBenBen" button does precisely nothing — with no error, no feedback. This is the single most common place to get stuck.

The ticket **establishes** trust (one-shot, expires in 60 seconds, must be generated fresh); the key **reuses** trust (long-lived, many machines). On a second machine, repeat only the last step.

Where to go: <https://account.xiaobenben.net> for quota and balance, <https://console.xiaobenben.net> to generate a binding ticket.

The server, console and organisation management are not in this repository and are not open source. That is a boundary statement, not a feature list — implementation details would not be verifiable anyway. **What is verifiable is this:** without binding, every local feature of `xbb mcp` and `xbb serve` works with the network unplugged, and none of that code path participates at all.

The client-side integration point is one file: [`src/cloud.ts`](src/cloud.ts) (six tools routed local/cloud by profile).

## Start on login (on by default)

The first `xbb serve` writes a startup entry, and every login afterwards starts a silent resident service — no console window, no admin page popping up, the XiaoBenBen icon in the taskbar / menu bar.

```bash
xbb autostart           # inspect: where, pointing at what, what the user asked for
xbb autostart off       # turn off, and do not write it back later
xbb autostart on        # turn back on
```

Every platform uses its native mechanism; no extra service is installed:

| Platform | Location | Runs at login |
|---|---|---|
| Windows | `HKCU\…\CurrentVersion\Run` → `小本本服务` | `"xbb.exe" serve --detach` (windowless) |
| macOS | `~/Library/LaunchAgents/net.xiaobenben.xbb.plist` | launchd runs `xbb serve --no-open` |
| Linux | `~/.config/autostart/xbb.desktop` | `xbb serve --detach` (XDG autostart) |

Two things worth knowing:

- **`xbb autostart off` is sticky.** It records `autostart: "off"` in `config.json`, and `serve` will not re-add the entry afterwards. The tray menu's "Start on login: on/off" is the same switch.
- **Keep the exe in a fixed location** (e.g. `~/.xiaobenben/bin/xbb`). The startup entry stores an absolute path: run it straight from Downloads, clean up Downloads, and the entry points at a file that no longer exists. Running the exe again fixes it, and `xbb autostart status` always shows where it currently points.

## CLI reference

```
Service and access
  xbb                                        status overview (mode / where the library is / common commands)
  xbb serve [--detach|--no-open|--headless]  start service + tray + admin window (:17630)
  xbb mcp                                    MCP stdio (the entry point AI hosts spawn)
  xbb stop [--keep-mcp]                      stop every local xbb process
  xbb autostart [on|off|status]              start on login (on by default; all three platforms)

Data location
  xbb home                 where the program is, where the library is, why it decided that
  xbb home move <dir>      move the library: copy → verify → only then switch config; no verify, no switch
  xbb home set <dir>       change config without moving (target must already hold memory.db)
  xbb home find [--deep]   scan drives for memory.db, sorted by memory count
  xbb home reset           drop the config, return to the default location
  xbb home init --force    create an empty library here (the only way to create one)

Cloud
  xbb cloud [on|off|status]   local ⇄ cloud switch (keeps the key)
  xbb bind <ticket>           bind the cloud (xubb:// invocation, or a 60 s single-use ticket)
  xbb bind-key <key>          bind with a long-lived key you already have
  xbb unbind                  unbind and delete the local key (irreversible)
  xbb register-protocol       register the xubb:// protocol handler (three platforms)

Collection and maintenance
  xbb ingest [--status|--dry-run|--source=…|--limit=N]   collect session text from local AI clients
  xbb verify                  audit: personal library hash-chain integrity
  xbb version                 version banner + build fingerprint

Update
  xbb update                  check for and apply updates (clears the rollback blacklist)
  xbb update-status           self-update status
```

The command set has the same discipline as the rest: `xbb home move` copies, then verifies integrity and compares row counts item by item, and only then switches the config — any failed step aborts and leaves the original library untouched. `xbb home init` requires an explicit `--force`, because "create an empty library" is irreversible and looks exactly like "all my memories vanished, but the app is fine".

## Where your data lives

| Content | Location |
|---|---|
| Library `memory.db` | The program directory (movable to any drive with `xbb home move`) |
| Config `config.json` | The program directory — **the anchor follows the program, never the library**, so "anchor present, cargo missing" is a detectable anomaly instead of a first run |
| Vector model | `models/` under the data directory (defaults to the program dir, ~24 MB, downloaded on first start) |
| Cloud key | `~/.xiaobenben/cloud.json` (cloud mode only) |

Forgot where the library is? `xbb home find --deep` — sorted by memory count, because empty databases with the same name are everywhere and only the count tells you which one is real.

## Engineering

| Item | Measured |
|---|---|
| Tests | Smoke tests pin **specific disasters**, not coverage numbers: a badly signed manifest must be rejected, a tampered manifest must be caught, a missing vector model must degrade silently instead of erroring, upstream field renames must still work through sniffing, the tray asset must really be embedded in the exe, the exe icon must be byte-identical to the source `.ico`, and migrations must be able to roll back. CI runs on Windows and Linux |
| Types | `tsc --noEmit` clean (`strict: true`) |
| Artifact | Single file: Windows ~87 MB / Linux ~83 MB / macOS ~65 MB (arm64) and ~71 MB (x64), including SQLite and the ONNX runtime |
| Cold start | `xbb --help` ~140 ms |
| Dependencies | 4 production dependencies (MCP SDK / ONNX Runtime / tray / zod), all from the official npmjs registry; `bun.lock` contains no internal mirrors |

Every third-party component that actually ships inside the binary (including transitive ones) and its full licence text is in [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md) — generated from `bun build --metafile` output, i.e. what is really bundled, not a lockfile dump.

`core/` is a vendored copy of `@xbb/core` (uuidv7 / event hash chain / ports and error codes) published with this repository, so `git clone` builds without access to any private repo. **Do not edit files under `core/` directly**; see [`core/README.md`](core/README.md).

## Build from source

Requires [Bun](https://bun.sh) ≥ 1.4.2 (matching `package.json`'s `engines`; CI pins 1.4.2).
Nothing else — no private registry, no token, no clone of a second repository.

**One line, from nothing to a working binary for the machine you are on:**

```bash
git clone https://github.com/sji-xiaobenben/xiaobenben && cd xiaobenben && bun install && bun run build
```

`bun run build` compiles for the host platform and names the artifact accordingly, so the next
command works without you renaming anything:

| Host | Artifact |
|---|---|
| Windows x64 | `dist/xbb-windows-x64.exe` |
| Linux x64 | `dist/xbb-linux-x64` |
| macOS Apple Silicon | `dist/xbb-darwin-arm64` |
| macOS Intel | `dist/xbb-darwin-x64` |

Cross-compiling uses the explicit variants (a Bun target triple each):

```bash
bun run build:win      # dist/xbb-windows-x64.exe
bun run build:linux    # dist/xbb-linux-x64
bun run build:mac-arm  # dist/xbb-darwin-arm64
bun run build:mac-intel
```

Verify the toolchain before building, if you want:

```bash
bun run typecheck
bun run test:ci
```

All of these go through `tools/build.ts`, which is the single definition of "how an artifact is
compiled": it stamps the icon, product name, publisher and file version into the Windows resource
section (from `assets/app.ico` and `package.json`), then reads the resource section back to prove
the icon landed. Regenerate the icons with `bun run gen:app-icon` (exe / logo) or
`bun run gen:tray-icon` (tray).

A locally built artifact reports `build local` in `xbb version` and **does not take part in self-update by default**: it embeds the official public key and CDN, so updating normally would only replace your build with the official exe. Point `XBB_UPDATE_URL` at the official source (or your own mirror) to opt in; to distribute your own version long term you also need your own key — see "Distributing your own build after forking" in [`CONTRIBUTING.md`](CONTRIBUTING.md).

The criterion is **publisher identity**, not "was it compiled": the artifact embeds `BUILD_REPO`, and the built-in update source is trusted only when it equals `OFFICIAL_REPO`. So even an exe from your own fork's CI will not ask the official site for updates, even though it has a real build timestamp. To check: `xbb update` reports a non-official build, disables self-update, and names the source repository.

> `bun.lock` records the official registry `registry.npmjs.org`. If installs are slow from mainland China, mirror it temporarily:
> `bun install --registry https://registry.npmmirror.com`

## Privacy

- **No telemetry** — there is no channel in the code that reports usage; self-update fetches a version manifest and carries no identifier
- **Model download on first start** — the embedding model ships separately and is downloaded from a public source (HuggingFace / hf-mirror) with sha256 verification; on failure it degrades to full-text retrieval, which does not affect usability
- **Collection scope** — it reads other AI tools' local data (`opencode.db`, only the `composerData:` and `bubbleId:` keys in Cursor's `state.vscdb`, `.claude`, `.codex`, `.workbuddy`). All processing is local and nothing is uploaded automatically
- **The raw layer never goes to the cloud** — `episodes` is local only; the cloud backend does not implement it
- **Cloud visibility defaults to private** — each memory is visible to its author; sharing with the organisation or a department must be explicit, and the write response echoes the effective visibility

The threat model of the local service and every known design trade-off are in [`SECURITY.md`](SECURITY.md) — worth reading before you use it. The short version: local HTTP has no authentication (the boundary is "same user on this machine"), the database is not encrypted (it relies on file permissions), and the secret vault is **masking, not encryption**.

## License

Released under the **GNU Affero General Public License v3.0 only (AGPL-3.0-only)** — see [`LICENSE`](LICENSE).

A commercial licence is available for closed-source distribution, closed-source hosted services, OEM bundling and similar; see [`LICENSE-Commercial.md`](LICENSE-Commercial.md) or write to `admin@sji.xin`.

**Internal use triggers no open-source obligation** — deploying inside your company, forking for internal development, or processing your own data with this software needs no commercial licence.

Every source file carries a machine-readable licence identifier:

```
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
```

`LicenseRef-Commercial` is the SPDX-spec way to reference a custom licence — in this case the commercial document above. A scanner reporting "unknown licence `LicenseRef-Commercial`" is expected: it is not a standard identifier, and it should not be replaced with `MIT`, `Apache-2.0` or anything similar. For compliance review, read [`LICENSE-Commercial.md`](LICENSE-Commercial.md).

## Trademark

"小本本", "xiaobenben", "SJi" and the associated names and marks are trademarks or business identifiers of [世纪之城（广州）信息科技有限公司](https://sji.xin) (SJI). The copyright licence **does not include a trademark licence**: you may modify and distribute the code, but you may not name or promote a derivative with the same or a confusingly similar mark. See [`NOTICE`](NOTICE).

## Contributing

Issues and pull requests are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) first — **every external contribution requires signing the CLA**, which is what lets the project keep running on the AGPL + commercial dual track. Also see [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Security

Do not open a public issue for a vulnerability. Report it as described in [`SECURITY.md`](SECURITY.md).

## Support

| Topic | Where |
|---|---|
| Usage questions, bugs, feature requests | Prefer an [issue](https://github.com/sji-xiaobenben/xiaobenben/issues) (public and searchable, so others benefit); `support@sji.xin` if it cannot be public |
| Commercial licence / OEM | [`LICENSE-Commercial.md`](LICENSE-Commercial.md), `admin@sji.xin` |
| Security vulnerabilities | [`SECURITY.md`](SECURITY.md) — never a public issue |

## A note on this repository's history

The public history starts at `v0.4.47`; earlier development history is retained privately by the copyright holder. This repository contains the client only — the server and cloud capabilities are not here and are not open source.

Release tags are SSH-signed by the copyright holder, and [`archive.yml`](.github/workflows/archive.yml)
refuses to publish an archive for a tag whose signature does not verify. The maintainer's public key
ships in this repository, so there is nothing to look up:

```bash
git -c gpg.ssh.allowedSignersFile=.github/signing-keys/allowed_signers tag -v v0.4.48
```

`v0.4.47`, `v0.4.48` and `oss-start` verify against it. `v0.4.49` was tagged before this became a
gate and carries no signature; every tag after it must pass. Individual commits are not signed —
the tag is what binds a version number to a signed identity, and that is the guarantee this
repository offers.

---

Copyright (C) 2026 [世纪之城（广州）信息科技有限公司](https://sji.xin)
