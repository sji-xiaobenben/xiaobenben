/**
 * 客户端会话采集器（V8）——「应采尽采」的落地实现。
 *
 * 为什么引擎要自己去读客户端库：
 *   MCP 是请求-响应协议，server 永远看不到对话流；靠 AI 每轮主动 log_episodes 上报，
 *   实测只有 42 句原话（全是事后补录）。而 opencode / Cursor / WorkBuddy / Claude Code
 *   本来就把完整会话落在本机盘上 —— 引擎直接读，不依赖任何客户端配合，
 *   也就不存在「每新增一个 agent 就要写一个插件」的问题。
 *
 * 三条纪律：
 *  1. **只读**：源库一律 readonly 打开，绝不写回（客户端可能正开着）。
 *  2. **幂等**：去重键 = sha256(source|session|external_id)，唯一索引兜底；
 *     重扫、并发扫、半途中断后重扫，都不会产生重复行。
 *  3. **游标**：SQLite 源用 (时间, id)；JSONL 源用字节偏移（半行不消费，留到下次）。
 *
 * V9 起多一条：
 *  4. **认结构，不认客户端**：专用 extract 只做「优先命中」，不中就走 descriptor
 *     再走通用嗅探（sniff.ts）。上游改字段名不再致命；同时记结构指纹与 unparsed，
 *     改版当天就能从 --status 看出来，而不是几个月后发现记忆断了。
 *
 * 采不到的（Trae 库加密、豆包/MiniMax 会话在云端）如实报 unavailable，不假装。
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { appendEpisodes, ingestDedupeKey, type EpisodeInput } from "./episodes";
import {
  applyDescriptor,
  looksLikeMessage,
  sniffMessage,
  structureFingerprint,
  type FormatDescriptor,
} from "./sniff";

export type SourceId = "opencode" | "cursor" | "workbuddy" | "claude" | "codex";

export interface RawTurn {
  sessionId: string;
  externalId: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** 客户端原始时间（毫秒）；无则用采集时刻 */
  atMs?: number;
}

/** 单条上限：超长正文（个别 agent 会把整篇文档塞进一条）截断并留痕，避免单行撑爆库 */
const MAX_TURN_CHARS = 100_000;

/** 每次内存批次：一次读太多行会把 JSON 解析堆在同一次事件循环里 */
const BATCH = 500;

/** 单次读盘粒度：一次只把这个量的字节读进内存再切行。
 *  以前是「从 offset 一次读到文件尾」——单个会话文件 181MB 时实测 RSS 冲到 1.1GB
 *  （Buffer 181MB + UTF-16 字符串 362MB + split 出的行副本），低内存机器直接 OOM。 */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

/** 每源每轮最多消费的字节数：大的存量文件分摊到多轮读，避免一轮把事件循环锁死几秒、
 *  也避免 5 分钟定时器与 HTTP 服务被同步 IO 卡住。落后时游标会自己往前追，不丢数据。 */
const CYCLE_BYTE_BUDGET = 32 * 1024 * 1024;

// ── 通用工具 ────────────────────────────────────────────────────────────────

function fmtLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function trimTurn(s: string, what: string): string {
  const t = s.replace(/\u0000/g, "").trim();
  if (t.length <= MAX_TURN_CHARS) return t;
  return `${t.slice(0, MAX_TURN_CHARS)}\n\n…（原长 ${t.length} 字符，超单条上限已截断）`;
}

/** 剥掉宿主注入的系统包裹，只留人真正说的话。
 *  WorkBuddy / CodeBuddy 会把 <system-reminder>（含用户档案、记忆、时间）塞进 user 消息里，
 *  原样入库等于把同一份档案重复存几千遍。有 <user_query> 就以它为准。 */
export function cleanUserText(s: string): string {
  let t = s.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, "");
  const q = t.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (q) t = q[1];
  return t.trim();
}

/** 入库前的最后一道闸：user 消息里的系统包裹一律剥掉，剥完为空就整条丢弃。
 *  为空意味着这条根本没人说话 —— 是 opencode 的 "[BACKGROUND TASK COMPLETED]"、
 *  WorkBuddy 的用户档案壳这类宿主注入。丢弃**不计入 unparsed**（它是正常结构，
 *  只是没有人的内容），否则解析率会常年虚低、真出问题时反而看不出来。
 *  assistant 消息不动：模型自己写的 <system-reminder> 字样属于原文。 */
export function cleanTurn<T extends { role: string; content: string }>(t: T): T | null {
  if (t.role !== "user") return t;
  const cleaned = cleanUserText(t.content);
  if (!cleaned) return null;
  return cleaned === t.content ? t : ({ ...t, content: cleaned } as T);
}

function roleOf(v: unknown): "user" | "assistant" | "system" | null {
  const r = String(v ?? "").toLowerCase();
  if (r === "user" || r === "human") return "user";
  if (r === "assistant" || r === "ai" || r === "model") return "assistant";
  if (r === "system") return "system";
  return null;
}

/** 通用字段探测：各家壳的 id / session / time 取名五花八门，嗅探路径靠这几张表兜底 */
const ID_KEYS = ["id", "uuid", "messageId", "message_id", "msgId", "msg_id"] as const;
const SESSION_KEYS = [
  "sessionId",
  "session_id",
  "conversationId",
  "conversation_id",
  "chatId",
  "chat_id",
  "threadId",
  "thread_id",
] as const;
const TIME_KEYS = ["timestamp", "createdAt", "created_at", "time", "ts", "time_created", "date"] as const;

function pickString(o: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function pickTime(o: Record<string, unknown>): number | undefined {
  for (const k of TIME_KEYS) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const ms = Date.parse(v);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return undefined;
}

function openReadonly(path: string): Database {
  const db = new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 3000");
  } catch {
    /* 老版本 SQLite 无此 pragma，忽略 */
  }
  return db;
}

/** 递归列文件（限深，避免误入 node_modules 这类无底洞） */
function listFiles(root: string, filter: (name: string) => boolean, maxDepth = 5): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) walk(p, depth + 1);
      } else if (filter(e.name)) out.push(p);
    }
  };
  if (existsSync(root)) walk(root, 0);
  return out.sort();
}

/** 从 offset 读**至多** maxBytes，只消费到最后一个完整行（按块读，内存上限与文件大小脱钩）。
 *
 *  返回的 next 是消费后的偏移；`next <= offset` 表示这段里没有整行可消费（尾部半行，
 *  或单行超长且已读到文件尾）。单行比 maxBytes 还长时逐步加倍读取量——有的 agent 会把
 *  整篇文档塞进一条消息，那种行必须整行拿到才能 JSON.parse，无法再切小。
 */
function readChunk(path: string, offset: number, maxBytes: number): { text: string; next: number; size: number } {
  const size = (() => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  })();
  if (size <= offset) return { text: "", next: size, size };

  let len = Math.min(size - offset, maxBytes);
  const fd = openSync(path, "r");
  try {
    for (;;) {
      const buf = Buffer.allocUnsafe(len);
      readSync(fd, buf, 0, len, offset);
      // 直接在字节层找换行：UTF-8 多字节序列的每个字节都 ≥0x80，绝不会是 0x0a，
      // 所以按 0x0a 切永远不会切坏字符；也省掉「先整段解码再找换行」的额外一份字符串。
      const nl = buf.lastIndexOf(0x0a);
      if (nl >= 0) {
        return { text: buf.toString("utf8", 0, nl), next: offset + nl + 1, size };
      }
      if (offset + len >= size) return { text: "", next: offset, size }; // 尾部还没写完整
      len = Math.min(size - offset, len * 4);
    }
  } finally {
    closeSync(fd);
  }
}

// ── 游标存取 ────────────────────────────────────────────────────────────────

interface FileCursorRow {
  path: string;
  offset: number;
  headHash: string | null;
}

function fileCursors(db: Database, source: SourceId): Map<string, FileCursorRow> {
  const rows = db.query("SELECT path, offset, head_hash FROM ingest_files WHERE source = ?").all(source) as Array<{
    path: string;
    offset: number;
    head_hash: string | null;
  }>;
  return new Map(rows.map((r) => [r.path, { path: r.path, offset: r.offset ?? 0, headHash: r.head_hash ?? null }]));
}

function saveFileCursor(
  db: Database,
  source: SourceId,
  path: string,
  offset: number,
  turns: number,
  headHash?: string,
): void {
  db.prepare(
    `INSERT INTO ingest_files (source, path, offset, turns, updated_at, head_hash)
     VALUES (?, ?, ?, ?, datetime('now','localtime'), ?)
     ON CONFLICT(source, path) DO UPDATE SET offset = excluded.offset, turns = turns + excluded.turns,
       updated_at = excluded.updated_at, head_hash = COALESCE(excluded.head_hash, ingest_files.head_hash)`,
  ).run(source, path, offset ?? 0, turns ?? 0, headHash ?? null);
}

/**
 * 文件前 len 字节的指纹 —— 用来识别「原地重写」。
 *
 * 关键在 len 取的是**上次已消费的前缀长度**（上限 512），不是文件大小：
 * 取全文就退化成「追加也会变」→ 每次轮询都重读全文；取固定 512 对小文件又失效。
 * 只 hash 已经消费过的那一小段前缀，追加不动它、重写必然动它，两种场景都对。
 */
function headHash(path: string, len: number): string {
  if (len <= 0) return "";
  try {
    const size = statSync(path).size;
    const n = Math.min(len, size, 512);
    if (n <= 0) return "";
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.allocUnsafe(n);
      readSync(fd, buf, 0, n, 0);
      return createHash("sha256").update(buf).digest("hex").slice(0, 16);
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/**
 * 行内容短指纹，拼进 externalId —— 让「同位置但内容变了」也能区分开。
 *
 * 只取首尾各 16 字符 + 长度，不 hash 全文：单行可能有几十万字符（有的 agent
 * 会把整篇文档塞进一条），全量 sha256 会让首刷从秒级变成几十秒。
 * 冲突需要「同偏移 + 同长度 + 首尾 16 字符全同」同时成立，而偏移本身已经不同。
 */
function shortHash(s: string): string {
  const n = s.length;
  const probe = n <= 40 ? s : `${s.slice(0, 16)}\u0000${s.slice(-16)}\u0000${n}`;
  return createHash("sha256").update(probe).digest("hex").slice(0, 8);
}

function loadCursor(db: Database, source: SourceId): string | null {
  const r = db.query("SELECT cursor FROM ingest_sources WHERE source = ?").get(source) as { cursor: string | null } | null;
  return r?.cursor ?? null;
}

function saveSourceState(
  db: Database,
  source: SourceId,
  state: {
    available: boolean;
    cursor?: string | null;
    inserted: number;
    note: string;
    fingerprint?: string | null;
    unparsed?: number;
    totalLines?: number;
  },
): void {
  db.prepare(
    `INSERT INTO ingest_sources (source, available, last_run_at, last_new, cursor, note, fingerprint, unparsed, total_lines)
     VALUES (?, ?, datetime('now','localtime'), ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET available = excluded.available, last_run_at = excluded.last_run_at,
       last_new = excluded.last_new, cursor = COALESCE(excluded.cursor, ingest_sources.cursor), note = excluded.note,
       fingerprint = COALESCE(excluded.fingerprint, ingest_sources.fingerprint),
       -- 增量轮常常一行新数据都没有，此时 suspects=0；不能把上次的诊断结果清零，
       -- 否则 --status 里的解析率会在"有事的下一秒"变回 "-"，等于自毁告警。
       unparsed = CASE WHEN excluded.total_lines > 0 THEN excluded.unparsed ELSE ingest_sources.unparsed END,
       total_lines = CASE WHEN excluded.total_lines > 0 THEN excluded.total_lines ELSE ingest_sources.total_lines END`,
  ).run(
    source,
    state.available ? 1 : 0,
    state.inserted,
    state.cursor ?? null,
    state.note,
    state.fingerprint ?? null,
    state.unparsed ?? 0,
    state.totalLines ?? 0,
  );
}

/** 上次的结构指纹——用来判断「上游是不是改版了」 */
function loadFingerprint(db: Database, source: SourceId): string | null {
  const r = db.query("SELECT fingerprint FROM ingest_sources WHERE source = ?").get(source) as {
    fingerprint: string | null;
  } | null;
  return r?.fingerprint ?? null;
}

/** 已装载的格式声明（descriptor）；没有表/空表都返回空数组，绝不让采集因它失败 */
function loadDescriptors(db: Database, source: SourceId): FormatDescriptor[] {
  try {
    const rows = db
      .query("SELECT descriptor FROM ingest_formats WHERE source IS NULL OR source = ?")
      .all(source) as Array<{ descriptor: string }>;
    const out: FormatDescriptor[] = [];
    for (const r of rows) {
      try {
        const d = JSON.parse(r.descriptor) as FormatDescriptor;
        if (d && typeof d.id === "string" && d.role?.field && d.text?.field) out.push(d);
      } catch {
        /* 单条坏 descriptor 不该拖垮采集 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ── 源定位 ──────────────────────────────────────────────────────────────────

function firstExisting(paths: Array<string | false | undefined>): string | null {
  for (const p of paths) if (p && existsSync(p)) return p;
  return null;
}

export function findOpencodeDb(): string | null {
  const h = homedir();
  return firstExisting([
    process.env.XDG_DATA_HOME && join(process.env.XDG_DATA_HOME, "opencode", "opencode.db"),
    join(h, ".local", "share", "opencode", "opencode.db"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "opencode", "opencode.db"),
    process.env.APPDATA && join(process.env.APPDATA, "opencode", "opencode.db"),
    join(h, "Library", "Application Support", "opencode", "opencode.db"),
  ]);
}

export function findCursorDb(): string | null {
  const h = homedir();
  return firstExisting([
    process.env.APPDATA && join(process.env.APPDATA, "Cursor", "User", "globalStorage", "state.vscdb"),
    join(h, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
    join(h, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
  ]);
}

export function findWorkbuddyRoot(): string | null {
  const h = homedir();
  return firstExisting([join(h, ".workbuddy", "projects"), join(h, ".codebuddy", "projects")]);
}

export function findClaudeRoots(): string[] {
  const h = homedir();
  return [join(h, ".claude", "projects"), join(h, ".claude", "transcripts")].filter((p) => existsSync(p));
}

export function findCodexRoot(): string | null {
  return firstExisting([join(homedir(), ".codex", "sessions")]);
}

// ── opencode ────────────────────────────────────────────────────────────────

/** cursor 形如 `<time_created>|<part_id>`：同毫秒多条时用 id 续切，不比单时间戳丢行 */
function parseCursorPair(c: string | null): [number, string] {
  if (!c) return [0, ""];
  const i = c.indexOf("|");
  if (i < 0) return [Number(c) || 0, ""];
  return [Number(c.slice(0, i)) || 0, c.slice(i + 1)];
}

function collectOpencode(
  db: Database,
  maxTurns: number,
  pathOverride?: string,
): { turns: RawTurn[]; cursor: string; scanned: number; note: string; suspects: number; unparsed: number; keySets: string[][] } {
  const path = pathOverride ?? findOpencodeDb();
  if (!path) return { turns: [], cursor: "", scanned: 0, note: "未找到 opencode.db", suspects: 0, unparsed: 0, keySets: [] };
  const src = openReadonly(path);
  try {
    let [lastTs, lastId] = parseCursorPair(loadCursor(db, "opencode"));
    const stmt = src.query(
      `SELECT p.id AS id, p.session_id AS sid, p.time_created AS ts, p.data AS pd, m.data AS md
         FROM part p JOIN message m ON m.id = p.message_id
        WHERE (p.time_created > ?) OR (p.time_created = ? AND p.id > ?)
        ORDER BY p.time_created ASC, p.id ASC LIMIT ?`,
    );
    const turns: RawTurn[] = [];
    const keySets: string[][] = [];
    let scanned = 0;
    let suspects = 0;
    let unparsed = 0;
    for (;;) {
      const rows = stmt.all(lastTs, lastTs, lastId, BATCH) as Array<{
        id: string;
        sid: string;
        ts: number;
        pd: string;
        md: string;
      }>;
      if (!rows.length) break;
      for (const r of rows) {
        // 游标必须对**每一行**前进，不能只对已采纳的行前进 ——
        // 否则遇到连续的 step-start/step-finish 就会卡在原地永远重扫同一段。
        lastTs = r.ts;
        lastId = r.id;
        scanned++;
        let part: { type?: string; text?: string };
        try {
          part = JSON.parse(r.pd);
        } catch {
          unparsed++; // data 列本该是 JSON，坏了就是真坏
          continue;
        }
        // 只收对话正文：reasoning 是模型内心独白、step-* 是元信息、tool 是调用参数
        if (part?.type !== "text") continue;
        suspects++;
        keySets.push(Object.keys(part).sort());
        if (!part.text || !part.text.trim()) {
          unparsed++;
          continue;
        }
        let role: "user" | "assistant" | "system" | null = null;
        try {
          role = roleOf(JSON.parse(r.md).role);
        } catch {
          role = null;
        }
        if (!role) {
          unparsed++;
          continue;
        }
        const u = cleanTurn({ sessionId: r.sid, externalId: r.id, role, content: trimTurn(part.text, "opencode"), atMs: r.ts });
        if (!u) continue; // 整条是宿主注入的系统通知，不是人说的话
        turns.push(u);
        if (turns.length >= maxTurns) break;
      }
      if (turns.length >= maxTurns || rows.length < BATCH) break;
    }
    return { turns, cursor: `${lastTs}|${lastId}`, scanned, note: "", suspects, unparsed, keySets };
  } finally {
    src.close();
  }
}

// ── Cursor ──────────────────────────────────────────────────────────────────

/**
 * Cursor 的会话在 cursorDiskKV 里：`composerData:<id>` 存元信息 + 有序气泡头，
 * `bubbleId:<composerId>:<bubbleId>` 存单条正文（type 1=用户 2=助手）。
 *
 * 增量策略：先用 `length(value)` 做变更检测（只读 key 与长度，不拉 1MB 的 JSON），
 * 长度变了才解析。首跑全量，之后每条会话只在有新气泡时重扫。
 */
function collectCursor(
  db: Database,
  maxTurns: number,
  persist: boolean,
  pathOverride?: string,
): { turns: RawTurn[]; scanned: number; note: string; suspects: number; unparsed: number; keySets: string[][] } {
  const path = pathOverride ?? findCursorDb();
  if (!path)
    return { turns: [], scanned: 0, note: "未找到 Cursor state.vscdb", suspects: 0, unparsed: 0, keySets: [] };
  const src = openReadonly(path);
  try {
    const keys = src.query("SELECT key AS k, COALESCE(length(value), 0) AS len FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all() as Array<{
      k: string;
      len: number;
    }>;
    const prev = fileCursors(db, "cursor");
    const bubbleStmt = src.query("SELECT value FROM cursorDiskKV WHERE key = ?");
    const turns: RawTurn[] = [];
    const keySets: string[][] = [];
    let scanned = 0;
    let parsedComposers = 0;
    let suspects = 0;
    let unparsed = 0;

    for (const { k, len } of keys) {
      const cid = k.slice("composerData:".length);
      const seen = prev.get(cid);
      if (seen && seen.offset === len && len > 0) continue; // 没变化，跳过（省下整段 JSON 解析）

      const row = src.query("SELECT value FROM cursorDiskKV WHERE key = ?").get(k) as { value: string } | null;
      if (!row) continue;
      let composer: {
        createdAt?: number;
        fullConversationHeadersOnly?: Array<{ bubbleId?: string; type?: number }>;
      } | null;
      try {
        composer = JSON.parse(row.value);
      } catch {
        continue;
      }
      // 空会话在库里是字面量 null（实测 289 条中 7 条）——直接跳过，别让一条脏数据废掉整源
      if (!composer || typeof composer !== "object") {
        if (persist) saveFileCursor(db, "cursor", cid, len, 0);
        continue;
      }
      parsedComposers++;
      const headers = composer.fullConversationHeadersOnly ?? [];
      const base = composer.createdAt ?? Date.now();
      let complete = true;

      for (let i = 0; i < headers.length; i++) {
        const h = headers[i];
        if (!h.bubbleId) continue;
        scanned++;
        const b = bubbleStmt.get(`bubbleId:${cid}:${h.bubbleId}`) as { value: string } | null;
        // headers 里登记了但 KV 里没有 —— 库不一致（同步中/被清理），算解析不出
        if (!b) {
          unparsed++;
          continue;
        }
        let bj: { text?: string; createdAt?: string; type?: number };
        try {
          bj = JSON.parse(b.value);
        } catch {
          unparsed++;
          continue;
        }
        suspects++;
        keySets.push(Object.keys(bj).sort());
        const text = typeof bj.text === "string" ? bj.text : "";
        if (!text.trim()) continue; // 纯工具调用气泡没有 text，不算对话
        const role: "user" | "assistant" = (h.type ?? bj.type) === 1 ? "user" : "assistant";
        const at = bj.createdAt ? Date.parse(bj.createdAt) : base;
        const cu = cleanTurn({
          sessionId: cid,
          externalId: h.bubbleId,
          role,
          content: trimTurn(text, "cursor"),
          atMs: Number.isFinite(at) ? at : base,
        });
        if (!cu) continue;
        turns.push(cu);
        if (turns.length >= maxTurns) {
          complete = false;
          break;
        }
      }
      // 只有整条会话读完才推进该会话的水位；半途停下就不记，下轮重扫（去重键保证不重复）
      if (complete && persist) saveFileCursor(db, "cursor", cid, len, 0);
      if (turns.length >= maxTurns) break;
    }
    return {
      turns,
      scanned,
      note: parsedComposers ? `解析 ${parsedComposers} 条会话（${keys.length} 条总量）` : `${keys.length} 条会话均无变化`,
      suspects,
      unparsed,
      keySets,
    };
  } finally {
    src.close();
  }
}

// ── JSONL 类：WorkBuddy / Claude Code / Codex ────────────────────────────────

/** 通用 JSONL 尾部采集：每文件按字节偏移续读，只动新增的行 */
export interface JsonlStats {
  turns: RawTurn[];
  /** 读过的非空行数 */
  scanned: number;
  files: number;
  note: string;
  /** 「看起来是消息」的行数——解析率的分母 */
  suspects: number;
  /** 疑似消息但两条路都解析不出——上游改版的直接证据 */
  unparsed: number;
  /** 每条命中消息的键集合，喂给 structureFingerprint */
  keySets: string[][];
}

function collectJsonl(
  db: Database,
  source: SourceId,
  files: string[],
  extract: (obj: Record<string, unknown>, file: string, stableId: string) => RawTurn | null,
  maxTurns: number,
  persist: boolean,
  descriptors: FormatDescriptor[] = [],
): JsonlStats {
  const cursors = fileCursors(db, source);
  const turns: RawTurn[] = [];
  const keySets: string[][] = [];
  let scanned = 0;
  let suspects = 0;
  let unparsed = 0;
  /** 本轮已消费的字节数（跨文件累计，受 CYCLE_BYTE_BUDGET 约束） */
  let consumedBytes = 0;
  const touchedFiles = new Set<string>();

  for (const file of files) {
    if (turns.length >= maxTurns || consumedBytes >= CYCLE_BYTE_BUDGET) break;
    const prev = cursors.get(file);
    let offset = prev?.offset ?? 0;
    if (offset > 0) {
      let reset = false;
      try {
        // 文件被截断/轮转（size < offset）⇒ 从头再来
        if (statSync(file).size < offset) reset = true;
      } catch {
        reset = true;
      }
      // 已消费前缀的指纹变了 = 文件被原地重写（Claude Code 的 /compact 就是这种）。
      // 追加不会动这段前缀，所以不会误判；重写必然动它，所以能识破。
      if (!reset && prev?.headHash) {
        const probe = headHash(file, prev.offset);
        if (probe && probe !== prev.headHash) reset = true;
      }
      if (reset) offset = 0;
    }

    // 分块读完这个文件；单轮消费量有上限，剩下的留给下一轮（游标接着走，不丢数据）
    let pendingTurns = 0; // 自上次保存游标以来新增的条数（ingest_files.turns 是累加语义）
    for (;;) {
      if (turns.length >= maxTurns || consumedBytes >= CYCLE_BYTE_BUDGET) break;
      const chunkStart = offset;
      const { text, next, size } = readChunk(file, offset, READ_CHUNK_BYTES);
      if (next <= offset) break; // 没有整行可消费（尾部半行 / 空文件）
      touchedFiles.add(file);

      const lines = text.split("\n");
      // 行的绝对字节偏移——externalId 必须用它，不能用"本次读到的第几行"：
      // 增量读时同一个 i 会指向不同内容，那会让同一条消息每次扫描都换 id → 重复入库。
      let cur = chunkStart;
      let stop = false;
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const lineStart = cur;
        cur += Buffer.byteLength(raw, "utf8") + 1; // +1 = 被 split 掉的 "\n"
        const line = raw.trim();
        if (!line) continue;
        scanned++;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // 整行不是 JSON：无法判断是否消息（日志混排文件常见），不计入解析率
          continue;
        }
        const stableId = `${basename(file)}#${lineStart}-${shortHash(line)}`;
        const suspect = looksLikeMessage(obj);
        if (suspect) suspects++;

        const t = extract(obj, file, stableId) ?? fallbackTurn(obj, file, stableId, descriptors);
        if (!t) {
          if (suspect) unparsed++;
          continue;
        }
        keySets.push(Object.keys(obj).sort());
        // 专用 extract 与嗅探兜底出来的都可能带宿主注入，统一在这道闸剥一次（幂等）
        const cleanedTurn = cleanTurn(t);
        if (!cleanedTurn) continue;
        turns.push(cleanedTurn);
        pendingTurns++;
        if (turns.length >= maxTurns) {
          stop = true;
          break;
        }
      }

      // 中途停下时把游标停在「下一条尚未处理的行」上，下一轮从这儿接着读——
      // 以前半途停下就整块不推进，下一轮得把同一大段重扫一遍（大文件上很贵）。
      const consumedUpTo = stop ? cur : next;
      consumedBytes += consumedUpTo - chunkStart;
      offset = consumedUpTo;
      if (persist) {
        saveFileCursor(db, source, file, consumedUpTo, pendingTurns, headHash(file, consumedUpTo));
        pendingTurns = 0;
      }
      if (stop || offset >= size) break;
    }
  }
  return {
    turns,
    scanned,
    files: touchedFiles.size,
    note: touchedFiles.size ? `读取 ${touchedFiles.size} 个文件的增量` : "无新增内容",
    suspects,
    unparsed,
    keySets,
  };
}

/** 专用 extract 不认时依次试：descriptor（固化下来的规则）→ 通用嗅探 */
function fallbackTurn(
  obj: Record<string, unknown>,
  file: string,
  stableId: string,
  descriptors: FormatDescriptor[],
): RawTurn | null {
  for (const d of descriptors) {
    const a = applyDescriptor(obj, d);
    if (!a) continue;
    let text = a.text;
    if (a.role === "user") text = cleanUserText(text);
    if (!text.trim()) continue;
    return {
      sessionId: a.sessionId ?? guessSession(obj, file),
      externalId: a.id ?? stableId,
      role: a.role,
      content: trimTurn(text, "descriptor"),
      atMs: a.atMs,
    };
  }
  const s = sniffMessage(obj);
  if (!s) return null;
  let text = s.text;
  if (s.role === "user") text = cleanUserText(text);
  if (!text.trim()) return null;
  return {
    sessionId: guessSession(obj, file),
    externalId: stableId,
    role: s.role,
    content: trimTurn(text, "sniff"),
    atMs: pickTime(obj),
  };
}

/** 全无 session 字段时退回文件名——客户端普遍一会话一文件，这个假设最省事也最稳 */
function guessSession(obj: Record<string, unknown>, file: string): string {
  const direct = pickString(obj, SESSION_KEYS);
  if (direct) return direct;
  for (const k of ["message", "payload", "data", "session"]) {
    const c = obj[k];
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const v = pickString(c as Record<string, unknown>, SESSION_KEYS);
      if (v) return v;
    }
  }
  return basename(file, ".jsonl");
}

function extractWorkbuddy(obj: Record<string, unknown>, file: string, stableId: string): RawTurn | null {
  if (obj.type !== "message") return null;
  const role = roleOf(obj.role);
  if (!role) return null;
  const content = obj.content;
  const pieces: string[] = [];
  if (typeof content === "string") pieces.push(content);
  else if (Array.isArray(content)) {
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      const part = c as { type?: string; text?: unknown };
      // input_text = 用户输入；output_text = 助手正文；thinking/tool 一律不要
      if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
        pieces.push(part.text);
      }
    }
  }
  let text = pieces.join("\n").trim();
  if (!text) return null;
  if (role === "user") text = cleanUserText(text);
  if (!text.trim()) return null;
  const id = typeof obj.id === "string" && obj.id ? obj.id : stableId;
  const sid = typeof obj.sessionId === "string" && obj.sessionId ? obj.sessionId : basename(file, ".jsonl");
  const ts = typeof obj.timestamp === "number" ? obj.timestamp : undefined;
  return { sessionId: sid, externalId: id, role, content: trimTurn(text, "workbuddy"), atMs: ts };
}

function extractClaude(obj: Record<string, unknown>, file: string, stableId: string): RawTurn | null {
  const type = String(obj.type ?? "");
  const sid = typeof obj.sessionId === "string" && obj.sessionId ? obj.sessionId : basename(file, ".jsonl");
  const ts = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : typeof obj.timestamp === "number" ? obj.timestamp : undefined;
  const eid = typeof obj.uuid === "string" && obj.uuid ? obj.uuid : stableId;

  // 形态 A（projects/*.jsonl）：{type:'user'|'assistant', message:{role, content:[{type:'text',text}]}}
  // 形态 B（transcripts/*.jsonl）：{type:'user', content:'原文'} —— 旧存档直接挂在 obj 上，没有 message 壳
  if (type === "user" || type === "assistant") {
    const msg = obj.message as { role?: unknown; content?: unknown } | undefined;
    const role = roleOf(msg?.role ?? type);
    if (!role) return null;
    let text = "";
    const c = msg?.content ?? obj.content;
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      text = c
        .map((x) => {
          if (!x || typeof x !== "object") return "";
          const p = x as { type?: string; text?: unknown };
          return p.type === "text" && typeof p.text === "string" ? p.text : "";
        })
        .filter(Boolean)
        .join("\n");
    }
    if (!text.trim()) return null;
    if (role === "user") text = cleanUserText(text);
    return text.trim() ? { sessionId: sid, externalId: eid, role, content: trimTurn(text, "claude"), atMs: ts } : null;
  }
  return null;
}

/** Codex rollout（本机未验证过实际文件，按公开结构做防御性解析；解析不到就返回 null） */
function extractCodex(obj: Record<string, unknown>, file: string, stableId: string): RawTurn | null {
  const payload = obj.payload as Record<string, unknown> | undefined;
  if (!payload) return null;
  const sid = typeof obj.sessionId === "string" ? obj.sessionId : basename(file, ".jsonl");
  const ts = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : undefined;
  const eid = stableId;

  const ptype = String(payload.type ?? "");
  if (ptype === "user_message" || ptype === "agent_message") {
    const text = typeof payload.message === "string" ? payload.message : "";
    if (!text.trim()) return null;
    const role = ptype === "user_message" ? "user" : "assistant";
    return { sessionId: sid, externalId: eid, role, content: trimTurn(role === "user" ? cleanUserText(text) : text, "codex"), atMs: ts };
  }
  if (ptype === "message") {
    const role = roleOf(payload.role);
    if (!role) return null;
    const c = payload.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      text = c
        .map((x) => {
          if (!x || typeof x !== "object") return "";
          const p = x as { type?: string; text?: unknown };
          return typeof p.text === "string" ? p.text : "";
        })
        .filter(Boolean)
        .join("\n");
    }
    if (!text.trim()) return null;
    return { sessionId: sid, externalId: eid, role, content: trimTurn(role === "user" ? cleanUserText(text) : text, "codex"), atMs: ts };
  }
  return null;
}

// ── 编排 ────────────────────────────────────────────────────────────────────

export interface CollectOptions {
  /** 只扫这些源；缺省 = 全部 */
  sources?: SourceId[];
  /** 每源本次最多入档多少条（首刷分页用） */
  maxTurns?: number;
  /** 只统计不写库（含不推进游标），用来先看会灌进来多少 */
  dryRun?: boolean;
  /** 覆盖源路径（测试用；也可用于非常规安装位置）：数据库给文件路径，JSONL 类给目录 */
  paths?: Partial<Record<SourceId, string>>;
}

export interface SourceResult {
  source: SourceId;
  label: string;
  available: boolean;
  scanned: number;
  inserted: number;
  skipped: number;
  ms: number;
  note: string;
  /** 疑似消息总数（解析率分母）；0 表示该源没有可判定的行 */
  suspects: number;
  /** 疑似消息但两条路都解析不出——上游改版的直接证据 */
  unparsed: number;
  /** 本次结构指纹（键集合 hash）；空串 = 未产出可识别消息 */
  fingerprint: string;
  /** 指纹与上次不同 = 字段集变了，多半是客户端改版 */
  fingerprintChanged: boolean;
}

const LABELS: Record<SourceId, string> = {
  opencode: "opencode",
  cursor: "Cursor",
  workbuddy: "WorkBuddy",
  claude: "Claude Code",
  codex: "Codex",
};

export const ALL_SOURCES: SourceId[] = ["opencode", "cursor", "workbuddy", "claude", "codex"];

function detect(source: SourceId, override?: string): { available: boolean; note: string; files: string[] } {
  if (source === "opencode") {
    const p = override ?? findOpencodeDb();
    return { available: !!p, note: p ?? "未找到 opencode.db", files: [] };
  }
  if (source === "cursor") {
    const p = override ?? findCursorDb();
    return { available: !!p, note: p ?? "未找到 Cursor state.vscdb", files: [] };
  }
  if (source === "workbuddy") {
    const root = override ?? findWorkbuddyRoot();
    const files = root ? listFiles(root, (n) => n.endsWith(".jsonl")) : [];
    return { available: !!root && files.length > 0, note: root ? `${files.length} 个会话文件` : "未找到 ~/.workbuddy/projects", files };
  }
  if (source === "claude") {
    const roots = override ? [override] : findClaudeRoots();
    const files = roots.flatMap((r) => listFiles(r, (n) => n.endsWith(".jsonl")));
    return { available: files.length > 0, note: roots.length ? `${files.length} 个会话文件` : "未找到 ~/.claude", files };
  }
  const root = override ?? findCodexRoot();
  const files = root ? listFiles(root, (n) => n.endsWith(".jsonl")) : [];
  return { available: files.length > 0, note: root ? `${files.length} 个 rollout 文件` : "未找到 ~/.codex/sessions", files };
}

/** 各源可用性（给 `xbb ingest --status` 用，不写库） */
export function probeSources(): Array<{ source: SourceId; label: string; available: boolean; note: string; files: number }> {
  return ALL_SOURCES.map((s) => {
    const d = detect(s);
    return { source: s, label: LABELS[s], available: d.available, note: d.note, files: d.files.length };
  });
}

/**
 * 采集一轮。**幂等**：同样的源跑一百次，第二次起新增为 0。
 * 单源失败不影响其它源（Trae 的库不是 SQLite、客户端锁库都是常态）。
 */
export function collectClientSessions(db: Database, opts: CollectOptions = {}): { results: SourceResult[]; inserted: number; scanned: number } {
  const want = opts.sources?.length ? opts.sources : ALL_SOURCES;
  const maxTurns = Math.max(1, Math.min(opts.maxTurns ?? 20_000, 200_000));
  const results: SourceResult[] = [];

  for (const source of want) {
    const t0 = Date.now();
    const override = opts.paths?.[source];
    const d = detect(source, override);
    // 存量条数：用来识别「id 算法变了导致全量重入」。踩过一次 ——
    // externalId 从 `file:行号:时间戳` 换成 `file#字节偏移-hash` 后，
    // 同一批数据去重键全变，22k 条里 1.8k 被当新数据又存了一遍。
    const prevCount = d.available
      ? ((db.query("SELECT count(*) c FROM episodes WHERE source = ?").get(source) as { c: number }).c ?? 0)
      : 0;
    if (!d.available) {
      results.push({
        source,
        label: LABELS[source],
        available: false,
        scanned: 0,
        inserted: 0,
        skipped: 0,
        ms: Date.now() - t0,
        note: d.note,
        suspects: 0,
        unparsed: 0,
        fingerprint: "",
        fingerprintChanged: false,
      });
      if (!opts.dryRun)
        saveSourceState(db, source, { available: false, inserted: 0, note: d.note, unparsed: 0, totalLines: 0 });
      continue;
    }

    const prevFingerprint = loadFingerprint(db, source);
    const descriptors = loadDescriptors(db, source);
    let turns: RawTurn[] = [];
    let scanned = 0;
    let note = d.note;
    let cursor: string | null = null;
    let suspects = 0;
    let unparsed = 0;
    let keySets: string[][] = [];
    try {
      if (source === "opencode") {
        const r = collectOpencode(db, maxTurns, override);
        turns = r.turns;
        scanned = r.scanned;
        cursor = r.cursor || null;
        suspects = r.suspects;
        unparsed = r.unparsed;
        keySets = r.keySets;
        if (r.note) note = r.note;
      } else if (source === "cursor") {
        const r = collectCursor(db, maxTurns, !opts.dryRun, override);
        turns = r.turns;
        scanned = r.scanned;
        suspects = r.suspects;
        unparsed = r.unparsed;
        keySets = r.keySets;
        note = r.note;
      } else if (source === "workbuddy") {
        const r = collectJsonl(db, source, d.files, extractWorkbuddy, maxTurns, !opts.dryRun, descriptors);
        turns = r.turns;
        scanned = r.scanned;
        suspects = r.suspects;
        unparsed = r.unparsed;
        keySets = r.keySets;
        note = r.note;
      } else if (source === "claude") {
        const r = collectJsonl(db, source, d.files, extractClaude, maxTurns, !opts.dryRun, descriptors);
        turns = r.turns;
        scanned = r.scanned;
        suspects = r.suspects;
        unparsed = r.unparsed;
        keySets = r.keySets;
        note = r.note;
      } else {
        const r = collectJsonl(db, source, d.files, extractCodex, maxTurns, !opts.dryRun, descriptors);
        turns = r.turns;
        scanned = r.scanned;
        suspects = r.suspects;
        unparsed = r.unparsed;
        keySets = r.keySets;
        note = r.note;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        source,
        label: LABELS[source],
        available: true,
        scanned,
        inserted: 0,
        skipped: 0,
        ms: Date.now() - t0,
        note: `失败: ${msg}`,
        suspects: 0,
        unparsed: 0,
        fingerprint: "",
        fingerprintChanged: false,
      });
      if (!opts.dryRun)
        saveSourceState(db, source, {
          available: true,
          inserted: 0,
          note: `失败: ${msg}`,
          unparsed: 0,
          totalLines: 0,
        });
      continue;
    }

    // 本次没读到新行时 keySets 为空 —— 不能因此把已存指纹当成"变成空"，那是假告警
    const fingerprint = structureFingerprint(keySets) || prevFingerprint || "";
    // 首次采（没有旧指纹）不算变更；旧指纹为空也不算，避免刚升级就一片告警
    const fingerprintChanged = !!fingerprint && !!prevFingerprint && fingerprint !== prevFingerprint;


    // 落库：dryRun 只数不写
    let inserted = 0;
    let skipped = 0;
    if (turns.length) {
      const rows: EpisodeInput[] = turns.map((t) => ({
        sessionId: t.sessionId,
        role: t.role,
        content: t.content,
        source,
        externalId: t.externalId,
        dedupeKey: ingestDedupeKey(source, t.sessionId, t.externalId),
        recordedAt: fmtLocal(t.atMs ?? Date.now()),
      }));
      if (opts.dryRun) {
        inserted = rows.length;
      } else {
        const r = appendEpisodes(db, rows);
        inserted = r.inserted;
        skipped = r.skipped;
      }
    }

    // 一轮就把存量刷掉一半以上 —— 正常增量绝不会这样
    if (!opts.dryRun && looksLikeFullReingest(inserted, prevCount)) {
      note = `⚠ 本轮新增 ${inserted} 条，已达该源存量 ${prevCount} 的一半 —— 疑似 id 算法变更导致全量重入，请核对是否重复｜${note}`;
    }

    if (!opts.dryRun) {
      saveSourceState(db, source, {
        available: true,
        cursor,
        inserted,
        note,
        fingerprint: fingerprint || null,
        unparsed,
        totalLines: suspects,
      });
    }
    results.push({
      source,
      label: LABELS[source],
      available: true,
      scanned,
      inserted,
      skipped,
      ms: Date.now() - t0,
      note,
      suspects,
      unparsed,
      fingerprint,
      fingerprintChanged,
    });
  }

  return {
    results,
    inserted: results.reduce((a, r) => a + r.inserted, 0),
    scanned: results.reduce((a, r) => a + r.scanned, 0),
  };
}

/** 一轮就把存量刷掉一半以上 —— 正常增量绝不会这样。九成是 externalId 算法变了，
 *  去重键跟着全变，同一批数据被当新数据重存（真实踩过：Claude 1,847 条被重存一遍）。
 *  宁可吵，不可静默把库灌成两倍。 */
export function looksLikeFullReingest(inserted: number, prevCount: number): boolean {
  return prevCount > 200 && inserted > prevCount * 0.5;
}

/** 采集现状（各源最近一次结果 + episodes 分源计数） */
export function ingestStatus(db: Database): Array<{
  source: string;
  available: boolean;
  lastRun: string | null;
  lastNew: number;
  episodes: number;
  sessions: number;
  note: string | null;
  fingerprint: string | null;
  unparsed: number;
  totalLines: number;
  /** 解析率（0~1）；totalLines 为 0 时返回 null，不假装 100% */
  parseRate: number | null;
}> {
  const rows = db
    .query(
      "SELECT source, available, last_run_at, last_new, note, fingerprint, unparsed, total_lines FROM ingest_sources ORDER BY source",
    )
    .all() as Array<{
    source: string;
    available: number;
    last_run_at: string | null;
    last_new: number;
    note: string | null;
    fingerprint: string | null;
    unparsed: number;
    total_lines: number;
  }>;
  return rows.map((r) => {
    const c = db.query("SELECT count(*) c, count(DISTINCT session_id) s FROM episodes WHERE source = ?").get(r.source) as {
      c: number;
      s: number;
    };
    const total = r.total_lines ?? 0;
    const bad = r.unparsed ?? 0;
    return {
      source: r.source,
      available: !!r.available,
      lastRun: r.last_run_at,
      lastNew: r.last_new,
      episodes: c.c,
      sessions: c.s,
      note: r.note,
      fingerprint: r.fingerprint,
      unparsed: bad,
      totalLines: total,
      parseRate: total > 0 ? Math.max(0, (total - bad) / total) : null,
    };
  });
}

/** 摘要层与原话层的配比 —— 用来发现「AI 开始写流水账」。
 *
 *  采集器上线后，原话层会自动涨到几万条，而摘要层是 AI 手写的、每次只写几条，
 *  所以正常比值会稳定在 1:50 以上。一旦 AI 把对话复述一遍当摘要写（"用户问了 X，我答了 Y"），
 *  摘要层会跟着对话量一起涨，比值很快塌到 1:10 以内 —— 这是最早能看出来的信号，
 *  比翻库看内容快得多。只报数、不阻断：宁可库脏一点，也不能因为指标误判就不让 AI 写。
 */
export function layerBalance(db: Database): {
  memories: number;
  episodes: number;
  /** 原话 / 摘要。episodes 为 0 时返回 null（还没采集，比值无意义） */
  perMemory: number | null;
  level: "idle" | "healthy" | "watch" | "watery";
} {
  const mem = (db.query("SELECT count(*) c FROM memories WHERE deleted_at IS NULL AND status != 'forgotten'").get() as {
    c: number;
  }).c;
  const ep = (db.query("SELECT count(*) c FROM episodes").get() as { c: number }).c;
  if (!ep) return { memories: mem, episodes: 0, perMemory: null, level: "idle" };
  const perMemory = mem > 0 ? ep / mem : null;
  const level = perMemory === null || perMemory >= 50 ? "healthy" : perMemory >= 20 ? "watch" : "watery";
  return { memories: mem, episodes: ep, perMemory, level };
}
