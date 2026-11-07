/**
 * 载荷登记（本地版 V1）。
 *
 * 一句话：**只登记引用，不搬字节**。字节始终待在用户原位置，本模块只回答三件事：
 *   ① 这份字节是什么（sha256 / bytes / mime）—— 内容寻址，天然去重
 *   ② 它被哪几条记忆引用（memory_payloads）
 *   ③ 它现在还在不在、还是不是当初那份（state 三态）
 *
 * 本地版**不落盘任何字节**：没有 XBB_HOME/payloads/、没有上传、没有对象存储。
 * 这是「本地默认只记引用」的直接推论，也是 V1 零基础设施的原因。
 *
 * 三条纪律（违反了就不是这套机制了）：
 * - **`mime` 只作元数据**，永不参与分支判断（铁律：代码里不许出现 `if mime.startsWith(...)`）。
 * - **`state` 实时算、不落库**：落库会陈旧（文件可能又回来了），且全表校验磁盘不可接受。
 * - **附件进不去 ≠ 记忆写不进**：`admitAttachments` **永不抛**，失败项进 `dropped` 由调用方回执。
 */
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Database } from "bun:sqlite";
import { uuidv7 } from "@xbb/core";
import { ORG_PERSONAL } from "./schema";

/** 单条记忆的附件上限（与 `items[]` 的 max 10 对齐：上下文预算 + 防滥用） */
export const MAX_ATTACHMENTS = 10;

/** 写入侧入参（**刻意不加 role 枚举**——"evidence / style" 是预设语义） */
export interface AttachmentInput {
  /** **本机绝对路径**（2026-10-15 定，否决了「参数收 base64」方案——膨胀 33% 吃宿主上下文） */
  ref: string;
  /** 可选；不填则由扩展名推断（仅作元数据） */
  mime?: string;
  /**
   * 宿主给的**内容细述** —— 把这个文件到底是什么写展开（不是一句话概括）。
   * **可选**，但强烈建议写：附件本身无法全文检索，这段文字是它**唯一的检索入口**。
   * 写详尽 ⇒ 召回准；宿主仍应把描述写进 `content`/`terms`（那是本条记忆的着陆垫），
   * 本字段的价值是**跨记忆复用**：同一张图被 12 条记忆引用时只描述一次。
   * ⚠️ 名字曾为 `digest`（撞 sha256 的 message digest）与 `caption`（预设“这是图”），
   *    2026-10-15 定名 `description`。
   */
  description?: string;
  tags?: string[];
}

export interface PayloadRow {
  id: string;
  sha256: string;
  bytes: number;
  mime: string | null;
  description: string | null;
  tags: string | null;
  storage_kind: string;
  storage_ref: string;
  status: string;
}

/** 引用状态三态。**实时算、不落库**。 */
export type PayloadState = "ok" | "changed" | "missing";

/** 回给调用方的载荷视图（`payloads` 字段的形状） */
export interface PayloadView {
  id: string;
  mime: string | null;
  bytes: number;
  description: string | null;
  tags: string[];
  /** 取货凭据的本体：本地版 = 绝对路径（云端版将由签名 URL 取代） */
  ref: string;
  state: PayloadState;
}

// ── 字节指纹 ──────────────────────────────────────────────────────────────────

/**
 * 流式 sha256 + 字节数。**不整读进内存** —— 用户完全可能记一个几 G 的视频，
 * 一次性 `readFileSync` 会当场 OOM。分块喂 hash，内存 O(chunk)。
 */
export function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hasher = createHash("sha256");
    let bytes = 0;
    const s = createReadStream(path);
    s.on("data", (c) => {
      hasher.update(c);
      bytes += (c as Buffer).length;
    });
    s.on("end", () => resolve({ sha256: hasher.digest("hex"), bytes }));
    s.on("error", reject);
  });
}

/**
 * 轻校验（recall 用）：**只 stat，不读内容**。
 * 一次 recall 可能带几十个附件，逐个算完整 hash 不可接受。
 * ⚠️ 精度边界：大小相同而内容不同（改了 1 字节）会判 `ok` ⇒ 重校验在 `get_asset`（那里值得付完整 hash 的代价）。
 */
export function payloadStateLight(row: PayloadRow): PayloadState {
  try {
    const st = statSync(row.storage_ref);
    if (!st.isFile()) return "missing";
    return st.size === Number(row.bytes) ? "ok" : "changed";
  } catch {
    return "missing";
  }
}

/** 重校验（get_asset 用）：完整 sha256 比对。慢但准 —— 「这个文件还能不能当原件给」值得这个代价。 */
export async function payloadStateDeep(row: PayloadRow): Promise<PayloadState> {
  try {
    if (!statSync(row.storage_ref).isFile()) return "missing";
  } catch {
    return "missing";
  }
  try {
    const { sha256 } = await hashFile(row.storage_ref);
    return sha256 === row.sha256 ? "ok" : "changed";
  } catch {
    return "missing";
  }
}

// ── MIME 推断（仅元数据，不作判据）────────────────────────────────────────────

/**
 * 极小的扩展名 → MIME 映射。**只填元数据、不参与任何分支判断**（允许的唯一 mime 用途之一）。
 * 认不出就 `undefined` —— 不是错误，也没有任何后果（mime 是路由键，不是准入判据）。
 */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv",
  json: "application/json", xml: "application/xml", html: "text/html", css: "text/css",
  js: "text/javascript", mjs: "text/javascript", ts: "text/plain", py: "text/plain",
  sh: "text/plain", ps1: "text/plain", sql: "text/plain", log: "text/plain",
  yaml: "text/yaml", yml: "text/yaml", toml: "text/plain", ini: "text/plain",
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar", "7z": "application/x-7z-compressed",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", webm: "video/webm", avi: "video/x-msvideo",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac",
  glb: "model/gltf-binary", gltf: "model/gltf+json", obj: "model/obj", stl: "model/stl",
};

export function guessMime(path: string): string | undefined {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? MIME_BY_EXT[m[1].toLowerCase()] : undefined;
}

// ── 写入侧：登记 + 挂载 ───────────────────────────────────────────────────────

export interface AdmittedAttachment {
  ref: string;
  payloadId: string;
  sha256: string;
  bytes: number;
  mime: string | null;
  /** 内容寻址命中已有的载荷 ⇒ **零新增**（本次没落任何东西，只是挂了个引用） */
  reused: boolean;
}

export interface DroppedAttachment {
  ref: string;
  reason: "empty_ref" | "not_absolute" | "not_found" | "not_a_file" | "read_failed" | "too_many";
}

/**
 * 把 attachments 登记成载荷并挂到记忆上。
 *
 * **永不抛**（降级铁律）：记忆是主产品，附件是附属证据 —— 为附属证据拒收主产品是本末倒置。
 * 进不去的项进 `dropped`，由调用方**回执给宿主**（不静默 —— 纪律④）。
 *
 * 去重语义：`UNIQUE(org_id, sha256)` ⇒ 同一份字节**只登记一次**；
 * 第二次引用它**零新增**，只多一条 `memory_payloads` 挂载行。
 * ⚠️ 这拦的是「字节完全相同」；**内容改过的文件 sha256 全变，是新对象** ——
 *     「版本」语义属记忆层（supersede 链），payload 层不知道谁是谁的新版本。
 */
export async function admitAttachments(
  db: Database,
  memoryId: string,
  atts: AttachmentInput[] | undefined,
  opts: { actor?: string; max?: number } = {},
): Promise<{ stored: AdmittedAttachment[]; dropped: DroppedAttachment[] }> {
  const stored: AdmittedAttachment[] = [];
  const dropped: DroppedAttachment[] = [];
  if (!atts?.length) return { stored, dropped };

  const limit = opts.max ?? MAX_ATTACHMENTS;
  const actor = opts.actor ?? "user";
  const nowIso = new Date().toISOString();

  const findPayload = db.prepare("SELECT id, description FROM payloads WHERE org_id = ? AND sha256 = ?");
  const insPayload = db.prepare(`
    INSERT INTO payloads (id, org_id, sha256, bytes, mime, storage_kind, storage_ref, description, tags,
                          uploaded_by, created_at, status)
    VALUES (?, ?, ?, ?, ?, 'local_path', ?, ?, ?, ?, ?, 'ready')
  `);
  const insMount = db.prepare(
    "INSERT OR IGNORE INTO memory_payloads (memory_id, payload_id, created_at) VALUES (?, ?, ?)",
  );
  // 「先到先得」：已有描述不被覆盖（跨记忆复用时避免抖动），只补空缺
  const fillDescription = db.prepare(
    "UPDATE payloads SET description = ? WHERE id = ? AND (description IS NULL OR description = '')",
  );

  for (const [i, att] of atts.entries()) {
    const ref = (att?.ref ?? "").trim();
    if (!ref) { dropped.push({ ref, reason: "empty_ref" }); continue; }
    if (i >= limit) { dropped.push({ ref, reason: "too_many" }); continue; }
    // 只认本机绝对路径。相对路径的「本机」是宿主的 cwd，与我们无关，无法可靠解析。
    if (!isAbsolute(ref)) { dropped.push({ ref, reason: "not_absolute" }); continue; }

    try {
      if (!statSync(ref).isFile()) { dropped.push({ ref, reason: "not_a_file" }); continue; }
    } catch { dropped.push({ ref, reason: "not_found" }); continue; }

    let sha256: string;
    let bytes: number;
    try {
      ({ sha256, bytes } = await hashFile(ref));
    } catch { dropped.push({ ref, reason: "read_failed" }); continue; }

    const mime = att.mime?.trim() || guessMime(ref) || null;
    const hit = findPayload.get(ORG_PERSONAL, sha256) as { id: string; description: string | null } | undefined;

    let payloadId: string;
    let reused: boolean;
    if (hit) {
      payloadId = hit.id;
      reused = true;
      if (att.description?.trim()) fillDescription.run(att.description.trim(), payloadId);
    } else {
      payloadId = uuidv7();
      reused = false;
      insPayload.run(
        payloadId, ORG_PERSONAL, sha256, bytes, mime,
        ref,
        att.description?.trim() || null,
        att.tags?.length ? JSON.stringify(att.tags) : null,
        actor, nowIso,
      );
    }
    insMount.run(memoryId, payloadId, nowIso);
    stored.push({ ref, payloadId, sha256, bytes, mime, reused });
  }

  return { stored, dropped };
}

// ── 读取侧：提货单 ────────────────────────────────────────────────────────────

const toView = (row: PayloadRow, state: PayloadState): PayloadView => {
  let tags: string[] = [];
  try { tags = row.tags ? JSON.parse(row.tags) : []; } catch { tags = []; }
  return {
    id: row.id,
    mime: row.mime,
    bytes: Number(row.bytes),
    description: row.description,
    tags,
    ref: row.storage_ref,
    state,
  };
};

/**
 * 批量取多条记忆的载荷（recall 系列用）。**一次 SQL + 逐个 stat**，避免 N+1 查询。
 * 无载荷的记忆**不出现在返回的 Map 里** —— 调用方据此**完全不输出 `payloads` 字段**
 * （而非空数组），以免污染既有宿主的上下文（向后兼容要求）。
 */
export function loadPayloadsFor(db: Database, memoryIds: string[]): Map<string, PayloadView[]> {
  const out = new Map<string, PayloadView[]>();
  const ids = [...new Set(memoryIds.filter(Boolean))];
  if (!ids.length) return out;

  const ph = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT mp.memory_id, p.id, p.sha256, p.bytes, p.mime, p.description, p.tags,
           p.storage_kind, p.storage_ref, p.status
      FROM memory_payloads mp
      JOIN payloads p ON p.id = mp.payload_id
     WHERE mp.memory_id IN (${ph})
       AND p.status <> 'evicted'
     ORDER BY mp.created_at ASC
  `).all(...ids) as Array<PayloadRow & { memory_id: string }>;

  for (const r of rows) {
    if (!out.has(r.memory_id)) out.set(r.memory_id, []);
    // 轻校验：只 stat。完整 hash 留给 get_asset
    out.get(r.memory_id)!.push(toView(r, payloadStateLight(r)));
  }
  return out;
}

/** 给一组扁平记忆对象补 `payloads`（无载荷的条目**不写这个键**）。就地变异并回传，便于链式调用。 */
export function attachPayloads<T extends { id: string }>(db: Database, rows: T[]): T[] {
  if (!rows.length) return rows;
  const map = loadPayloadsFor(db, rows.map((r) => r.id));
  for (const r of rows) {
    const ps = map.get(r.id);
    if (ps?.length) (r as T & { payloads?: PayloadView[] }).payloads = ps;
  }
  return rows;
}

export function getPayloadRow(db: Database, payloadId: string): PayloadRow | null {
  return (db.prepare(`
    SELECT id, sha256, bytes, mime, description, tags, storage_kind, storage_ref, status
      FROM payloads WHERE id = ?
  `).get(payloadId) as PayloadRow | undefined) ?? null;
}

export function toPayloadView(row: PayloadRow, state: PayloadState): PayloadView {
  return toView(row, state);
}
