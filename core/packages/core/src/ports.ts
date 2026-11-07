/**
 * 领域端口层：core 只定义"规则需要什么"，IO 实现由各端注入——
 * cli 注入 SQLite / server 注入 PG+RLS / 私有化同 server。"个人还是组织"不是代码分支。
 */
import type { UUIDv7 } from "./ids";

// ---------- 记忆（唯一内容存储之一） ----------
export interface MemoryRecord {
  id: UUIDv7;
  orgId: string | null; // null = 个人库；组织归属由租户属性承载
  spaceId: string;
  actor: string; // 人类成员或 AI 宿主标识
  content: string;
  tags: readonly string[];
  embeddingModel: string | null; // 版本列：换模型=换坐标系
  createdAt: string; // ISO 8601 UTC
}

/** 记忆之间的显式关系（本地 writeMemory links 的四态；企业语义审批类关系待 Q3 拍板，先不预设） */
export type MemoryLinkRelation = "related_to" | "elaborates" | "caused_by" | "contradicts";

export interface MemoryWrite {
  spaceId: string;
  actor: string;
  content: string;
  tags?: readonly string[];
  // —— 组织版写入贯通（2026-10-05 批次B）：与本地 writeMemory 的 MemoryItem 入参逐条对齐，全部 optional ——
  /** 记忆类型（本地 writeMemory 必填；云端缺省 fact，兼容既有只传 content/tags 的调用方） */
  type?: "fact" | "preference" | "decision" | "event" | "procedure";
  /** 双端扩展着陆垫：同义词/上位词/场景词（AI 蒸馏时生成）——落 memory_terms(source='expand') */
  terms?: readonly string[];
  /** 实体锚点（人/项目/概念）——落 entities + memory_entity */
  entities?: readonly string[];
  /** 发生时间：**本地格式字符串** `YYYY-MM-DD HH:MM:SS`（精度为 month/year 时可粗到 `2026-10`）——绝不可用 timestamptz 承载 */
  occurredAt?: string;
  occurredPrecision?: "day" | "month" | "year";
  /** 会话归属（引擎自动盖章或 AI 显式回填），派生 recall_session */
  sessionId?: string;
  /** 出处路径/URL（本地 source_chunk 情景块永不上云，故云端只有 source_ref） */
  sourceRef?: string;
  /** memory=普通 | directive=短时叮嘱（须 dscope）| habit=习惯 | constraint=长期规则（须 domain） */
  kind?: "memory" | "directive" | "habit" | "constraint";
  /** directive 窗口语义（session/today/week）——**由服务端换算绝对窗口**，AI 禁止自行传日期 */
  dscope?: "session" | "today" | "week" | "global";
  /** constraint 的域（合并同域约束的锚） */
  domain?: string;
  /** 记忆网络显式链接（关系可正反遍历） */
  links?: readonly { toId: string; relation: MemoryLinkRelation }[];
  /** 状态更新链：被本条目延续（取代）的旧记忆 id——链头=当前真相 */
  supersedeIds?: readonly string[];
}

export interface MemoryStore {
  append(write: MemoryWrite): Promise<MemoryRecord>;
  get(id: UUIDv7): Promise<MemoryRecord | null>;
  listBySpace(spaceId: string, opts: { limit: number; cursor?: string }): Promise<MemoryRecord[]>;
}

// ---------- 词群（唯一归一桥，AI 自治资产） ----------
export type TermStatus = "provisional" | "confirmed";

export interface TermRecord {
  id: UUIDv7;
  orgId: string;
  term: string;
  definition: string;
  status: TermStatus;
  createdAt: string;
}

/** 写侧 AI 自动扩、落空自动提议 provisional、价值反馈自动转正/剪枝（人工环节=0） */
export interface TermStore {
  upsert(orgId: string, term: string, definition: string, status: TermStatus): Promise<TermRecord>;
  listByOrg(orgId: string): Promise<TermRecord[]>;
  promote(id: UUIDv7): Promise<void>;
  prune(id: UUIDv7): Promise<void>;
}

// ---------- 凭证层（events 哈希链） ----------
export interface EventInput {
  orgId: string;
  actor: string;
  type: string;
  payloadHash: string;
}

export interface EventRecord extends EventInput {
  seq: number;
  prevHash: string;
  hash: string;
  at: string;
}

export interface EventLog {
  append(input: EventInput): Promise<EventRecord>;
  listByOrg(orgId: string, opts: { limit: number; cursor?: number }): Promise<EventRecord[]>;
  verifyChain(orgId: string): Promise<boolean>; // 审计自检（私有化场景用）
}

// ---------- 检索（两段式漏斗，实现住各端） ----------
export interface SearchQuery {
  scopeSpaceIds: readonly string[];
  text: string;
  limit?: number;
}

export interface SearchHit {
  memoryId: UUIDv7;
  score: number;
}

export interface SearchPipeline {
  search(q: SearchQuery): Promise<SearchHit[]>;
}

// ---------- 权限即位置（owner + admin@节点，无头衔枚举） ----------
export interface AuthSubject {
  userId: string;
  orgId: string | null;
  role: "owner" | "admin" | "member";
  adminNodeIds: readonly string[]; // admin 绑定的空间树节点（权力=当前+后代子树）
}

export interface AccessPolicy {
  canWrite(subject: AuthSubject, spaceId: string): boolean;
  canAdmin(subject: AuthSubject, nodeId: string): boolean;
}
