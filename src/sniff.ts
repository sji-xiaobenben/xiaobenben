// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 通用结构嗅探器 —— 让采集不再依赖「某个客户端的字段名」。
 *
 * 为什么需要它：
 *   ingest.ts 里每个源一份手写 extract，本质是「记住某客户端的私有结构」。
 *   上游把 content 改成 body、把 role 挪进一层 message 壳，整源就废，而且失效是静默的
 *   （游标照常前进 → 那一段永久丢失，界面上只显示"新增 0"）。
 *
 * 三条设计取舍：
 *  1. **认语义，不认名字**：不问"这是 WorkBuddy 吗"，只问"这个对象有角色、有正文吗"。
 *     角色/正文各给一张同义词表，改字段名就落在表里，不再是致命伤。
 *  2. **只看两层，不做深度递归**：顶层 + 一层知名包装键（message/msg/data/payload…）。
 *     深度递归会把 tool 调用参数里的假对话抓出来，那是脏数据，比漏采更糟。
 *  3. **role 与 text 必须同处一个对象**：这条约束是防误采的主闸。
 *
 * 它不负责剥宿主注入（<system-reminder> 之类）—— 那是 cleanUserText 的事，
 * 保持嗅探器纯粹、不依赖 ingest.ts，避免循环引用。
 */
import { createHash } from "node:crypto";

export type SniffRole = "user" | "assistant" | "system";

/** 角色字段名候选。`type` 单独处理：它既是角色也常是消息种类（'message' / 'text'）。 */
const ROLE_KEYS = ["role", "author", "sender", "from", "speaker", "actor"] as const;

/** 正文字段名候选。顺序即优先级。 */
const TEXT_KEYS = ["text", "content", "message", "body", "value", "chunk", "delta"] as const;

/** 一层下钻的包装键：`{type:'user', message:{role,content}}` 这类形态靠它覆盖。 */
const WRAPPER_KEYS = ["message", "msg", "data", "payload", "item", "record"] as const;

/** 精确角色词表 */
const ROLE_EXACT: Record<string, SniffRole> = {
  user: "user",
  human: "user",
  input: "user",
  prompt: "user",
  question: "user",
  request: "user",
  assistant: "assistant",
  ai: "assistant",
  model: "assistant",
  bot: "assistant",
  agent: "assistant",
  output: "assistant",
  completion: "assistant",
  reply: "assistant",
  response: "assistant",
  system: "system",
  developer: "system",
  instruction: "system",
};

/**
 * 角色值归一。
 * 先查精确表；查不到才做包含匹配（覆盖 `user_message` / `agent_message` 这类复合词）。
 * 包含匹配只认 user/assistant/model 这几个强词，`tool_result`、`reasoning`、`step-start`
 * 都不会命中 —— 它们本来就不该进记忆。
 */
export function roleOfValue(v: unknown): SniffRole | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (!s) return null;
  const exact = ROLE_EXACT[s];
  if (exact) return exact;
  if (/[\s_-]/.test(s)) {
    if (s.includes("user") || s.includes("human")) return "user";
    if (s.includes("assistant") || s.includes("agent") || s.includes("model")) return "assistant";
  }
  return null;
}

/** 从 content / text 的任意形态里抽出纯文本。工具块、思考块一律跳过。 */
export function textOfValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const p of v) {
      if (typeof p === "string") {
        parts.push(p);
        continue;
      }
      if (!p || typeof p !== "object") continue;
      const o = p as Record<string, unknown>;
      const kind = String(o.type ?? "").toLowerCase();
      // tool_use / tool_result / reasoning / thinking / image / file 都不是对话正文
      if (kind && /tool|reasoning|thinking|image|audio|file|attachment/.test(kind)) continue;
      const s = o.text ?? o.content ?? o.value;
      if (typeof s === "string" && s.trim()) parts.push(s);
    }
    return parts.join("\n");
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
  }
  return "";
}

export interface SniffedMessage {
  role: SniffRole;
  text: string;
  /** 命中对象的键集合（已排序）—— 结构指纹的原始材料 */
  keys: string[];
  /** 正文取自哪个键，便于排查 */
  textField: string;
}

/** 在一个对象自身尝试匹配（不看子节点）。 */
function matchHere(o: Record<string, unknown>): SniffedMessage | null {
  // 角色：先看专门字段，再看 type
  let role: SniffRole | null = null;
  for (const k of ROLE_KEYS) {
    role = roleOfValue(o[k]);
    if (role) break;
  }
  // type 兜底：只有值确实是角色词时才采纳，'message' / 'text' / 'summary' 都不会命中
  if (!role) role = roleOfValue(o.type);
  if (!role) return null;

  for (const k of TEXT_KEYS) {
    if (!(k in o)) continue;
    const text = textOfValue(o[k]).trim();
    if (!text) continue; // 是工具调用气泡（无 text），继续试下一个键
    return { role, text, keys: Object.keys(o).sort(), textField: k };
  }
  return null;
}

/**
 * 嗅探一条消息。顶层优先，不中再下钻一层包装壳。
 * 返回 null 表示「这不是一条可入档的对话」——调用方计为 unparsed，而不是当错误抛。
 */
export function sniffMessage(obj: Record<string, unknown>): SniffedMessage | null {
  const direct = matchHere(obj);
  if (direct) return direct;
  for (const k of WRAPPER_KEYS) {
    const child = obj[k];
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const r = matchHere(child as Record<string, unknown>);
      if (r) return r;
    }
  }
  return null;
}

/**
 * 这条记录「看起来该是一条消息」吗？
 *
 * 存在的意义是让 unparsed 计数有信噪比。JSONL 里大量行本来就不是对话
 * （session 元信息、summary、tool 结果、控制事件），它们解析不出 turn 是正常的，
 * 计进 unparsed 会让解析率永远难看、告警永远在响，最后没人看。
 * 只有「疑似消息却解析不出」才是真问题：那说明上游改版了。
 */
export function looksLikeMessage(o: Record<string, unknown>): boolean {
  const isRole = (v: unknown) => typeof v === "string" && roleOfValue(v) !== null;
  for (const k of ROLE_KEYS) if (isRole(o[k])) return true;
  if (isRole(o.type)) return true;

  // payload 壳（Codex rollout、部分网关日志）
  const p = o.payload;
  if (p && typeof p === "object" && !Array.isArray(p)) {
    const po = p as Record<string, unknown>;
    for (const k of ROLE_KEYS) if (isRole(po[k])) return true;
    if (isRole(po.type)) return true;
  }
  // message 壳（Claude projects）
  const m = o.message;
  if (m && typeof m === "object" && !Array.isArray(m)) {
    const mo = m as Record<string, unknown>;
    for (const k of ROLE_KEYS) if (isRole(mo[k])) return true;
  }
  return false;
}

/**
 * 结构指纹：把「每条命中消息的键集合」规范化后取 sha256 前 16 位。
 * 用途不是识别客户端，而是**发现上游改版**：指纹一变就说明字段集动了，
 * 此刻 unparsed 通常也在涨 —— 两者一起看，改版当天就能发现，而不是几个月后
 * 发现记忆断了。用去重后的键集合而不是原始顺序，避免客户端字段顺序抖动造成假告警。
 */
export function structureFingerprint(perMessageKeys: string[][]): string {
  if (!perMessageKeys.length) return "";
  // 每个键集都在这里重新排序，不指望调用方已经排过：
  // 字段顺序抖动（客户端换序列化库很常见）不该被当成"格式变了"。
  const lines = [...new Set(perMessageKeys.map((k) => [...k].sort().join(",")))].sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

// ── 格式声明（descriptor）────────────────────────────────────────────────────

/**
 * 格式描述文件：把「怎么从一个 JSON 对象里取出一条消息」写成数据，而不是代码。
 *
 * 这是给第二步（AI 辅助解析格式）留的接口，但第一步就要能用：
 * 只要有人写出 descriptor，引擎无需重新编译就能采一个新客户端。
 *
 * match.keys 与消息对象的键集合（排序后）完全相等才生效 —— 所以 descriptor
 * 天然按「结构版本」绑定，同一客户端改版前后各存一份，自动选中的是对的。
 */
export interface FormatDescriptor {
  id: string;
  /** 必填：命中条件。空数组 = 匹配任意对象（不建议） */
  match: { keys: string[] };
  role: { field: string; map?: Record<string, SniffRole> };
  text: { field: string; partTypes?: string[]; skipPartTypes?: string[] };
  idField?: string;
  sessionField?: string;
  timeField?: string;
  /** 该格式下 user 消息要剥掉的包裹标签（如 system-reminder） */
  stripTags?: string[];
  origin?: "builtin" | "learned" | "manual";
}

export interface AppliedDescriptor {
  role: SniffRole;
  text: string;
  id?: string;
  sessionId?: string;
  atMs?: number;
}

function keysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 按 descriptor 解析一条记录；不匹配返回 null。 */
export function applyDescriptor(o: Record<string, unknown>, d: FormatDescriptor): AppliedDescriptor | null {
  const keys = Object.keys(o).sort();
  if (d.match.keys.length && !keysEqual(keys, [...d.match.keys].sort())) return null;

  const rawRole = o[d.role.field];
  const role = (d.role.map?.[String(rawRole)] ?? roleOfValue(rawRole)) || null;
  if (!role) return null;

  const rawText = o[d.text.field];
  let text = "";
  if (Array.isArray(rawText)) {
    const allow = d.text.partTypes ? new Set(d.text.partTypes) : null;
    const skip = d.text.skipPartTypes ? new Set(d.text.skipPartTypes) : null;
    const parts: string[] = [];
    for (const p of rawText) {
      if (!p || typeof p !== "object") {
        if (typeof p === "string") parts.push(p);
        continue;
      }
      const po = p as Record<string, unknown>;
      const kind = String(po.type ?? "");
      if (allow && !allow.has(kind)) continue;
      if (skip && skip.has(kind)) continue;
      const s = po.text ?? po.content;
      if (typeof s === "string" && s.trim()) parts.push(s);
    }
    text = parts.join("\n");
  } else {
    text = textOfValue(rawText);
  }
  text = text.trim();
  if (!text) return null;

  const out: AppliedDescriptor = { role, text };
  if (d.idField && typeof o[d.idField] === "string") out.id = o[d.idField] as string;
  if (d.sessionField && typeof o[d.sessionField] === "string") out.sessionId = o[d.sessionField] as string;
  if (d.timeField) {
    const t = o[d.timeField];
    const ms = typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : NaN;
    if (Number.isFinite(ms)) out.atMs = ms;
  }
  return out;
}
