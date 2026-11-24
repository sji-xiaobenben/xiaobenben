// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 检索管线。
 * 三路确定性检索（FTS trigram ∥ 着陆垫倒排 ∥ 实体精确）+ IDF 加权融合
 * + 延续链重定向（现状优先，历史环随链附注）+ 预算封顶 + 1-hop 链接扩展 + related_tags 换词引导。
 * 全部本地 SQL，零模型。查询词群由客户端 AI 扩展后传入。
 *
 * 移植适配点：
 *  1. id: number → string（UUIDv7）
 *  2. recorded_at → created_at（对外字段名 createdAt）
 *  3. 存活过滤：deleted_at IS NULL + status != 'forgotten'（双列同步写，双保险）
 *  4. 向量通道将作为第四路并入 RRF——本文件保持三路纯度
 */
import type { Database } from "bun:sqlite";
import { onRecalled } from "./recall-feedback";
import { LINK_VISIBLE_MIN } from "./schema";

// 命中计数 / 共现强化已统一收进 recall-feedback.ts（一次召回的两种反馈，不该分家）。

// ── 召回侧密钥过扫（第二道闸，防御纵深；主闸=写入侧标记协议）──
const SECRET_FORMATS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /glpat-[A-Za-z0-9_-]{15,}/g,
  /AIza[A-Za-z0-9_-]{30,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /https?:\/\/[^\s/:@]+:[^\s/@]{6,}@[^\s]+/g,
];

/** 已知凭据形态 → 脱敏占位（召回载荷里永不出现明文） */
export function maskSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_FORMATS) out = out.replace(re, "[[secret:masked]]");
  return out;
}

// ── 延续链（记忆的故事线）──

export interface ChainLink {
  id: string;
  content: string;
  occurredAt: string | null;
  createdAt: string;
  /** true = 链头（现状）；false = 历史环（已延续） */
  current: boolean;
}

/**
 * 走到**真正的**链头（`superseded_by` 一路向上，直到没有后继）。
 *
 * ⚠️ **这里不许有跳数上限。**
 * 原先有三处各自写了 `hops < 10`：本文件的 `resolveChain`、`memory-tools.ts` 的
 * `chainHead`、以及 `searchMemory` 里链重定向那段内联循环。链一旦超过 10 层，
 * 三处都会**停在中途并把这个中间节点当成现状**：`get_memory` 显示的"当前"是 10 代前的旧状态，
 * `recall_topic` 的"链头保障在场"保障了一个假链头，`search_memory` 会把早已被推翻的旧值
 * 当命中结果交出去。三者都不报错，因为"没走到头"和"本来就到头了"长得一模一样。
 *
 * 防环靠 `seen`，不靠跳数：数据库里若真出现 A→B→A 这种坏数据（曾经有过手写修复），
 * 无上限循环会把进程挂死，跳到环上就停在原地 —— 返回一个错的答案，好过返回不了答案。
 */
export function walkToHead(db: Database, id: string, qNext?: ChainNextStmt): string {
  const q = qNext ?? db.prepare("SELECT superseded_by FROM memories WHERE id = ? AND deleted_at IS NULL");
  const seen = new Set<string>([id]);
  let cur = id;
  for (;;) {
    const r = q.get(cur) as { superseded_by: string | null } | undefined;
    if (!r || !r.superseded_by) return cur;
    if (seen.has(r.superseded_by)) return cur; // 环：停在原地，绝不无限循环
    seen.add(r.superseded_by);
    cur = r.superseded_by;
  }
}

type ChainNextStmt = ReturnType<Database["prepare"]>;

/**
 * 遍历安全阀。
 *
 * 只防**异常长链**（坏数据、或某天有人把整本日志串成一条链），不是展示上限：
 * 正常链 10~20 层，触到 500 说明数据形态已经不对了。在此之前一条都不会少。
 */
const CHAIN_SCAN_CAP = 500;

/** 一次链展开的结果。**带 total/truncated** —— 不截断就别让人猜有没有截断。 */
export interface ChainResolution {
  links: ChainLink[];
  /** 整条链的真实成员数（含链头） */
  total: number;
  /** true = `links` 被 `limit` 裁过，链里还有更早的成员没返回 */
  truncated: boolean;
}

/**
 * 展开某条记忆所在的延续链，返回按时间正序的链成员（链头带 current=true）。
 *
 * `limit` 是**输出**上限（默认 50，远大于实际链长），不是遍历上限 —— 遍历会走完整条链，
 * 所以 `total` 永远是真实值。以前那个 10 既当遍历上限又当输出上限，导致
 * 「链里有 15 条」这件事在返回值里完全看不出来。
 */
export function resolveChain(db: Database, id: string, limit = 50): ChainResolution {
  // 三条 SQL 各自只编译一次：原写法在 while 里 prepare，链越长编译次数越多，
  // 而语句字符串是常量、结果只随参数变，逐圈重编译是纯浪费。
  const qNext = db.prepare("SELECT superseded_by FROM memories WHERE id = ? AND deleted_at IS NULL");
  const qChildren = db.prepare(
    "SELECT id, content, occurred_at, created_at FROM memories WHERE superseded_by = ? AND deleted_at IS NULL ORDER BY created_at ASC",
  );
  const qOne = db.prepare("SELECT id, content, occurred_at, created_at FROM memories WHERE id = ?");
  const head = walkToHead(db, id, qNext);
  const members: { id: string; content: string; occurred_at: string | null; created_at: string; current: boolean }[] = [];
  const seen = new Set<string>([head]);
  const queue: string[] = [head];
  while (queue.length && members.length < CHAIN_SCAN_CAP) {
    const cur = queue.shift()!;
    const rows = qChildren.all(cur) as Array<{ id: string; content: string; occurred_at: string | null; created_at: string }>;
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      members.push({ id: r.id, content: r.content, occurred_at: r.occurred_at ?? null, created_at: r.created_at, current: false });
      queue.push(r.id);
    }
  }
  const headRow = qOne.get(head) as { id: string; content: string; occurred_at: string | null; created_at: string } | undefined;
  if (headRow) members.push({ id: headRow.id, content: headRow.content, occurred_at: headRow.occurred_at ?? null, created_at: headRow.created_at, current: true });
  const key = (m: { occurred_at: string | null; created_at: string }) => normTime(m.occurred_at ?? m.created_at);
  members.sort((a, b) => (key(a) < key(b) ? -1 : 1));
  const total = members.length;
  const kept = total > limit ? members.slice(-limit) : members;
  // 截断时保留的是"最近的一批"，链头一般本来就在里面；万一不在（时钟倒挂），
  // 就把链头补进去并挤掉最早那条 —— 少了链头的链等于没展开。
  if (total > kept.length && !kept.some((m) => m.current)) kept[0] = members[members.length - 1]!;
  return {
    links: kept.map((m) => ({
      id: m.id, content: m.content, occurredAt: m.occurred_at, createdAt: m.created_at, current: m.current,
    })),
    total,
    truncated: total > kept.length,
  };
}

export interface SearchParams {
  /** AI 扩展后的词群（同义词/上位词/场景词/实体名），>=3 字走 FTS，1-2 字走倒排 */
  terms: string[];
  occurredFrom?: string;
  occurredTo?: string;
  limit?: number;
  budget?: number;
}

export interface SearchHit {
  id: string;
  content: string;
  type: string;
  occurredAt: string | null;
  deviceId: string | null;
  sessionId: string | null;
  sourceRef: string | null;
  score: number;
  matchedTerms: string[];
  onThisDevice: boolean;
  chain?: { id: string; content: string; occurredAt: string | null; createdAt: string; superseded: boolean }[];
}

/**
 * 一次检索的观测快照。
 *
 * 存在的理由是**归因**，不是做报表：这个模块曾经两次静默失效（`linkedPreview` 永远空、
 * 107 条被时间闸吞掉），两次都不是崩溃，都是「某一路悄悄返回了空/被裁掉了而没人察觉」。
 * 事后想复盘「上周召回变差是哪天开始的、是哪一路塌的」，除了这张表**没有任何数据**。
 *
 * 因此这里的字段选择标准只有一条：**能不能用来区分「没有」和「坏了」**。
 * 通道命中数分开记（而不是只记总数）就是为了这个 —— FTS 恒为 0 和 FTS 偶尔为 0
 * 是完全不同的两个故障。耗时则用来区分「算得慢」和「在等锁」。
 */
export interface SearchStats {
  /** 词群大小 */
  termsN: number;
  /** FTS trigram 通道命中条数 */
  ftsN: number;
  /** 倒排 `memory_terms` 通道命中条数（不含 n-gram 回退） */
  invN: number;
  /** 实体精确通道命中条数 */
  entN: number;
  /** n-gram 拆词回退命中条数（只在 ABC 全空时才有非零值） */
  ngN: number;
  /** 去重后的候选条数 */
  candN: number;
  hitN: number;
  /** 只在混合检索里出现：ok / empty-index / not-ready / error */
  vecStatus?: string;
  /** 时间闸之后真正参与 RRF 的向量命中条数 */
  vecN?: number;
  tokens: number;
  /** 词法管线耗时（ms） */
  msLex: number;
  /** 端到端耗时，含向量编码（ms） */
  msAll: number;
  /**
   * 最终结果里每条命中的来源，按返回顺序：`L` = 词法榜、`V` = 纯向量榜。
   *
   * 「前 10 条里有几条是向量才捞到的」是最值钱的一个数：向量通道塌了的时候，
   * 结果集看起来仍然完全正常（词法那几路照样能出东西），只有这个比值会掉到 0。
   */
  srcTop: string;
  hasWindow: boolean;
  budget: number;
}

export interface SearchResult {
  hits: SearchHit[];
  linkedPreview: { id: string; relation: string; preview: string }[];
  relatedTags: string[];
  tokensUsed: number;
  /**
   * 向量通道状态。`undefined` = 根本没走混合检索（纯词法 `searchMemory`）；
   * `"ok"` = 参与了并有命中；其余都是**降级**，本次结果只有词法一路。
   *
   * 为什么必须显式带出来：降级时返回的是一份看起来完全正常的词法结果，AI 分不清
   * 「库里没有这段记忆」和「语义通道没跑、用词不同的那条漏了」—— 它会直接对用户
   * 说「没有相关记录」。这条沉默比任何性能问题都伤。
   */
  vecStatus?: "ok" | "empty-index" | "not-ready" | "error";
  /** 降级原因的人话说明，直接透传给 AI（非降级时不带）。 */
  vecNote?: string;
  /**
   * 词法侧的降级说明（n-gram 回退生效时才带）。
   *
   * 和 vecNote 同一个理由：AI 分不清「库里真没有」和「词没对上，我给你拆词凑了凑」。
   * 后者必须说出来 —— 否则它会把一堆字面相近的邻居当成答案。
   */
  lexNote?: string;
  /**
   * 本次检索的观测快照。**由调用方决定要不要落库** —— 检索本身是纯读函数，
   * 不在这里产生写副作用（`searchMemory` 被测试直接调用了几十次，写库会污染计数）。
   */
  stats?: SearchStats;
  /**
   * 最高原始余弦相似度（只在走混合检索、且向量通道有命中时出现）。
   *
   * `vecTopK` 是**无下限**取 top-100 的（设计如此：宁多不漏，交给 RRF 去排）。
   * 后果是任何查询——包括一段乱码——都能凑出 2~4 条"语义邻居"。这个数把
   * "最高的一条到底有多像"暴露出来，调用方才有办法判断这批是不是硬凑的。
   */
  vecTop1?: number;
  /**
   * `true` = 这批结果证据很弱：词法三路**一条硬命中都没有**（只有 n-gram 拆词凑的，
   * 或干脆全空），同时语义相似度也没上来。
   *
   * 为什么不直接丢结果：返回空比返回弱相关更糟 —— 用户明明记得有这回事，
   * 得到"没查到"会认为记忆库坏了。正确做法是**给结果并标明它不可靠**。
   */
  lowConfidence?: boolean;
  /** 低置信时给调用方的人话说明（非低置信时不带）。 */
  confidenceNote?: string;
}

/** 估算一条记忆的 token 占用（中文 ~1 字 ≈ 1 token，保守 + 头部开销） */
function estTokens(s: string): number {
  return Math.ceil(s.length * 0.8) + 24;
}

/** 一条 1-hop 链接预览的固定记账成本（折叠成单行，实际 20~25 token）。 */
const PREVIEW_TOKEN_COST = 25;

/**
 * 时间归一化（移植适配）：occurred_at=本地格式 "YYYY-MM-DD HH:MM:SS"，
 * created_at=ISO UTC——两种格式直接字符串比较会错序（同格式无此问题）。
 * 排序 key 一律经此归一为本地 "YYYY-MM-DD HH:MM:SS" 再比较。
 */
function normTime(t: string): string {
  if (!t.includes("T")) return t;
  const d = new Date(t);
  if (isNaN(d.getTime())) return t;
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 一条记忆的「有效时间」：有事件时间用事件时间，没有就用录入时间。 */
function effTime(m: { occurred_at: string | null; created_at: string }): string {
  return normTime(m.occurred_at ?? m.created_at);
}

/**
 * 时间窗判定的两个边界。**上界补 "z"** 是「包含整天」的老技巧：日期串
 * `2026-11-11` 与时刻串 `2026-11-11 18:00:00` 在第 11 位分大小，空格(0x20) < 'z'(0x7A)，
 * 所以补 z 之后当天任意时刻都算 ≤ 上界；若上界本身带时刻，`18:00` < `18:00z` 同样成立
 * （':' 0x3A < 'z'），也包含该时刻内的秒级尾数。抽出来是因为**词法路与向量路必须用
 * 同一套边界**，两份实现迟早漂移。
 */
function timeWindow(from?: string, to?: string): { lo: string | null; hi: string | null } {
  return { lo: from ? normTime(from) : null, hi: to ? normTime(to) + "z" : null };
}

function withinWindow(t: string | null, lo: string | null, hi: string | null): boolean {
  if (t == null) return false;
  if (lo && t < lo) return false;
  if (hi && t > hi) return false;
  return true;
}

/** 只对含中日韩统一表意文字的词做 n-gram 拆分（纯 ASCII 拆出来全是噪音） */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/**
 * 把中文复合词拆成相邻 2-gram：`发版流水线` → 发版 / 版流 / 流水 / 水线。
 *
 * 为什么要这一步：倒排（memory_terms）是 `term = ?` 的**精确等值**，而写入侧 AI 给的
 * terms 是 2-4 字短词（实测占 71%），查询侧给的却是「发版流水线」「怎么配置」这类复合词。
 * 一个 5 字复合词在倒排里一条都对不上；FTS 的 trigram 又要求三字连续滑窗全部命中，
 * 复合词同样落空 ⇒ 词法三路全空，向量路（无相似度下限）接管整份结果，返回一堆语义邻居
 * 且**不给任何信号**。576 条库里 100% 复现，与库大小无关。
 *
 * 中文里二字词是有意义的原子粒度，命中「发版」就能捞出真实发版记录 —— 拆词比不拆强得多。
 */
function bigramsOf(term: string): string[] {
  const ch = [...term];
  if (ch.length < 3 || !CJK_RE.test(term)) return [];
  const out: string[] = [];
  for (let i = 0; i + 1 < ch.length; i++) out.push(ch[i]! + ch[i + 1]!);
  return out;
}

/**
 * 给一批记忆算 1-hop 邻居预览（不含正文，只有 id + 关系 + 30 字）。
 *
 * 抽成函数是因为它有**两个调用方**：词法管线的命中，以及混合检索里纯向量命中的
 * 那部分。两份实现一定会漂移——而这一处漂移过一次（见下面那条注释），代价是
 * 「功能永远返回空数组，且没人发现」。
 *
 * `exclude` 放已在结果里的 id：邻居本身已经给过正文，就不该再花 25 token 给一份
 * 摘要，那纯属同一信息付两次钱。
 *
 * 排序读的是**有效权重**（含时间衰减）：久不共现的边会自然沉下去，而不是永久占位。
 */
export function linkedPreviewFor(
  db: Database,
  ids: string[],
  exclude: Set<string>,
  limit = 10,
): SearchResult["linkedPreview"] {
  if (!ids.length || limit <= 0) return [];
  const ph = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT l.from_id, l.to_id, l.relation, m.content
    FROM memory_links_eff l JOIN memories m ON m.id = CASE WHEN l.from_id IN (${ph}) THEN l.to_id ELSE l.from_id END
    WHERE (l.from_id IN (${ph}) OR l.to_id IN (${ph})) AND l.eff > ${LINK_VISIBLE_MIN}
    ORDER BY l.eff DESC
    LIMIT ${limit}
  `).all(...ids, ...ids, ...ids) as Array<{ from_id: string; to_id: string; relation: string; content: string }>;

  const idSet = new Set(ids);
  const out: SearchResult["linkedPreview"] = [];
  for (const r of rows) {
    // 对面那条：边至少有一端在 ids 里（见上面 WHERE），取另一端。
    // ⚠️ 2026-11-08 修：这里原来写的是
    //     if (hits.some((h) => h.id === r.from_id || h.id === r.to_id)) continue;
    //   而这个条件与 WHERE 的 `from_id IN (…) OR to_id IN (…)` 完全等价 ⇒ 恒为真，
    //   每一行都被跳过，linkedPreview **永远是空数组**。功能从上线起就没生效过，
    //   而 search_memory 的工具描述还一直对 AI 承诺 "linkedPreview neighbors" ——
    //   AI 读到空数组会认定「没有关联」，于是不再往下去找，比缺功能更糟。
    //   没有任何测试断言过 linkedPreview，所以它安静地空了很久。现在的判据是
    //   「**另一端**是否已在结果里」：在，就不必再占一份预览 token；不在，才推。
    const other = idSet.has(r.from_id) ? r.to_id : r.from_id;
    if (exclude.has(other)) continue;
    exclude.add(other); // 同一邻居被多条命中共享时只推一次
    out.push({
      id: other,
      relation: r.relation,
      preview: maskSecrets(r.content.length > 30 ? r.content.slice(0, 30) + "…" : r.content),
    });
  }
  return out;
}

export function searchMemory(db: Database, params: SearchParams): SearchResult {
  const t0 = performance.now();
  const limit = Math.min(params.limit ?? 5, 10);
  const budget = params.budget ?? 2000;
  const terms = params.terms.map((t) => t.trim()).filter(Boolean);

  // ── 路径 A：FTS trigram（>=3 字的词）──
  // 一次 JOIN 取回 UUID：FTS 的 rowid 与 memories 的 TEXT 主键是两套编号，必须换一次。
  // 原写法在 200 条命中上逐条 `SELECT id FROM memories WHERE rowid = ?`（每个词 200 次），
  // 三个词就是 600 次独立查询、600 次 prepare —— 实测 2.47ms，改成 JOIN 后 0.32ms。
  const ftsScores = new Map<string, { terms: Set<string> }>();
  const qFts = db.prepare(
    `SELECT m.id AS id FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
      WHERE memories_fts MATCH ? LIMIT 200`,
  );
  for (const t of terms) {
    if ([...t].length < 3) continue;
    try {
      const rows = qFts.all(`"${t.replace(/"/g, '""')}"`) as Array<{ id: string }>;
      for (const row of rows) {
        let e = ftsScores.get(row.id);
        if (!e) {
          e = { terms: new Set() };
          ftsScores.set(row.id, e);
        }
        e.terms.add(t);
      }
    } catch { /* 非法 MATCH 表达式跳过 */ }
  }

  // ── 路径 B：memory_terms 倒排（全部词，含 1-2 字短词；高频词截断）──
  const termScores = new Map<string, { terms: Set<string> }>();
  const qTerm = db.prepare("SELECT memory_id AS id FROM memory_terms WHERE term = ? LIMIT 500");
  for (const t of terms) {
    const rows = qTerm.all(t) as Array<{ id: string }>;
    for (const row of rows) {
      let e = termScores.get(row.id);
      if (!e) {
        e = { terms: new Set() };
        termScores.set(row.id, e);
      }
      e.terms.add(t);
    }
  }

  // ── 路径 C：实体精确命中（别名 LIKE 反向扫，语料小可接受）──
  const placeholders = terms.map(() => "?").join(",");
  const entityScores = new Map<string, Set<string>>();
  if (terms.length) {
    const rows = db.prepare(`
      SELECT me.memory_id AS id, e.name AS name
      FROM entities e
      LEFT JOIN memory_entity me ON me.entity_id = e.id
      WHERE e.name IN (${placeholders}) OR (e.aliases IS NOT NULL AND ${terms.map(() => "e.aliases LIKE ?").join(" OR ")})
    `).all(...terms, ...terms.map((t) => `%${t}%`)) as Array<{ id: string | null; name: string }>;
    for (const row of rows) {
      if (row.id == null) continue;
      if (!entityScores.has(row.id)) entityScores.set(row.id, new Set());
      entityScores.get(row.id)!.add(row.name);
    }
  }

  // ── 路径 D：长词降级（中文 2-gram 回退）──
  // 只在 A/B/C 三路**全空**时启用 —— 有任一命中就说明词对上了，再拆词只会把噪音掺进
  // 本来干净的结果里。这是纯粹的兜底路径，不参与正常排序。
  // 命中项在 matched 里带 `~` 前缀，打分时半权（见下方融合），回包时经 lexNote 明说。
  // 倒排通道的命中数必须在 n-gram **之前**取：拆出来的 gram 会塞进同一个
  // `termScores`，之后取就只能拿到「倒排 + 拆词」的合计，而这两路正好是
  // 「正常命中」与「词没对上硬凑」的分界，正是最需要分开的两个数。
  const invN = termScores.size;
  let ngGrams: string[] = [];
  if (!ftsScores.size && !termScores.size && !entityScores.size) {
    ngGrams = [...new Set(terms.flatMap(bigramsOf))];
    if (ngGrams.length) {
      const qGram = db.prepare("SELECT memory_id AS id, term FROM memory_terms WHERE term = ? LIMIT 500");
      for (const g of ngGrams) {
        const rows = qGram.all(g) as Array<{ id: string; term: string }>;
        for (const row of rows) {
          let e = termScores.get(row.id);
          if (!e) {
            e = { terms: new Set() };
            termScores.set(row.id, e);
          }
          e.terms.add("~" + g);
        }
      }
      // 一条都没捞到就别拿空的 gram 列表去算 df（白跑 5 次 SQL）
      if (!termScores.size) ngGrams = [];
    }
  }

  // ── IDF 归一化融合 ──
  // 四个通道的权重只表达「信号有多可靠」，稀有度全部交给归一化后的 df：
  //   FTS 精确短语 2.0 ∥ 实体名精确等值 2.0 ∥ 倒排 term 等值 1.0 ∥ n-gram 拆词 0.5
  // 这样加一个通道、改一次库规模，都不需要重新标定任何常数。
  const total = (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE deleted_at IS NULL AND status != 'forgotten'").get() as { c: number }).c || 1;
  // df 必须把回退用的 gram 一并算进来：gram 若查不到 df 就会落到 `?? 1`（=最稀有的词），
  // 半权之后仍可能压过真正的词群命中 —— 兜底路径不该赢过正路。
  const dfTerms = ngGrams.length ? [...new Set([...terms, ...ngGrams])] : terms;
  const dfPh = dfTerms.map(() => "?").join(",");
  const dfRows = dfTerms.length
    ? db.prepare("SELECT term, COUNT(*) AS c FROM memory_terms WHERE term IN (" + dfPh + ") GROUP BY term").all(...dfTerms) as Array<{ term: string; c: number }>
    : [];
  const df = new Map<string, number>();
  for (const r of dfRows) df.set(r.term, r.c);

  /**
   * 归一化分母。**这一步修的是 bug，不是调参。**
   *
   * `log(1 + total/df)` 没有上界，所以它会随库规模单调增长：df=1 的词在 576 条库里
   * 得 12.72 分，在 10 万条库里得 23.03 分。而下面的权重（FTS 2.0 / 倒排 1.0）是常数
   * ⇒ 同一个查询，**库长大之后排序会自己变**，而且是悄悄变，没有任何一处会报错。
   *
   * 除上 log(1+total) 之后：idf(1) ≈ 1、idf(total) ≈ 0，落在 (0,1] 且与 N 无关。
   * total ≥ 1 ⇒ 分母 ≥ log(2) ≈ 0.69，不存在除零。
   */
  const idfDenom = Math.log(1 + total);
  const idfOf = (dfN: number) => Math.log(1 + total / Math.max(1, dfN)) / idfDenom;

  /**
   * 实体的 df —— 实体命中也要按稀有度计权。
   *
   * 原来是 `score += 3.0`，对所有实体一视同仁。但 `小本本` 一个实体挂着 191 条记忆
   * （占全库 33%），`硼酸结晶` 只挂 1 条；给它们同一个分数，等于让那 191 条凭一个
   * 人人共有的词并列第一，真正稀缺的精确锚点反而被淹没。实体命中也是命中，就该参与 IDF。
   *
   * （顺带说明那 3.0 的来历：initial commit 里直接写的估值，无注释、未标定 ——
   *   作者当时大概率以为 log 值在 1~3 量级，实际 df=1 时是 12.72。所以这里修的是
   *   意图，不是行为：实体是精确锚点，本该强于字面共现。）
   */
  const entityDf = new Map<string, number>();
  if (entityScores.size) {
    const names = [...new Set([...entityScores.values()].flatMap((s) => [...s]))];
    if (names.length) {
      const ePh = names.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT e.name AS name, COUNT(me.memory_id) AS c
         FROM entities e LEFT JOIN memory_entity me ON me.entity_id = e.id
         WHERE e.name IN (${ePh})
         GROUP BY e.name`,
      ).all(...names) as Array<{ name: string; c: number }>;
      for (const r of rows) entityDf.set(r.name, r.c);
    }
  }

  const candidates = new Set<string>([...ftsScores.keys(), ...termScores.keys(), ...entityScores.keys()]);
  const scored: { id: string; score: number; matched: Set<string> }[] = [];
  for (const id of candidates) {
    let score = 0;
    const matched = new Set<string>();
    const fts = ftsScores.get(id);
    if (fts) for (const t of fts.terms) {
      // 权重只表达**信号可靠度**，稀有度一律交给 df：FTS 是精确短语，2.0。
      score += 2.0 * idfOf(df.get(t) ?? 1);
      matched.add(t);
    }
    const ts = termScores.get(id);
    if (ts) for (const t of ts.terms) {
      if (!matched.has(t)) {
        // 倒排是 term 精确等值，1.0；n-gram 拆出来的只是字面巧合，再打半折。
        const ng = t.startsWith("~");
        score += (ng ? 0.5 : 1.0) * idfOf(df.get(ng ? t.slice(1) : t) ?? 1);
        matched.add(t);
      }
    }
    // 实体名精确等值比 trigram 更严格（结构化锚点而非字面共现），取其与 FTS 同档 2.0，
    // 但同样按该实体自己的 df 降权 —— 命中一个挂了 191 条的实体不该跟命中孤例一个分量。
    const es = entityScores.get(id);
    if (es) for (const n of es) {
      score += 2.0 * idfOf(entityDf.get(n) ?? 1);
      matched.add(n);
    }
    if (score > 0) scored.push({ id, score, matched });
  }
  scored.sort((a, b) => b.score - a.score);

  // ── 时间过滤 + 延续链重定向 + 预算封顶 + 组装 ──
  const hits: SearchHit[] = [];
  const hitIds = new Set<string>();
  // related_tags 要用 tags/entities，顺手在取正文时带回来 —— 否则同一批 id 要在
  // 末尾再逐条 SELECT 一遍（每条命中一次，纯重复读）。
  const metaById = new Map<string, { tags: string | null; entities: string | null }>();
  let tokensUsed = 0;
  const loadMem = db.prepare(`
    SELECT m.id, m.content, m.type, m.occurred_at, m.created_at, m.session_id, m.device_id, m.source_ref, m.superseded_by, m.tags, m.entities, d.name AS device_name
    FROM memories m LEFT JOIN devices d ON d.id = m.device_id
    WHERE m.id = ? AND m.deleted_at IS NULL
  `);
  const qSuperseded = db.prepare("SELECT id, superseded_by FROM memories WHERE id = ? AND deleted_at IS NULL");
  const win = timeWindow(params.occurredFrom, params.occurredTo);
  const hasWindow = win.lo != null || win.hi != null;
  for (const s of scored) {
    if (hits.length >= limit) break;
    let m = loadMem.get(s.id) as {
      id: string; content: string; type: string; occurred_at: string | null; created_at: string; session_id: string | null;
      device_id: string | null; source_ref: string | null; superseded_by: string | null; device_name: string | null;
      tags: string | null; entities: string | null;
    } | undefined;
    if (!m) continue;
    if (m.superseded_by) {
      // 走到**真链头**，不是走 10 跳。见 walkToHead 的说明：链超过 10 层时，
      // 旧写法会把中途的中间节点当成现状返回，而且看起来完全正常。
      const head = walkToHead(db, m.superseded_by, qSuperseded);
      if (hitIds.has(head)) continue;
      const hm = loadMem.get(head) as typeof m | undefined;
      if (!hm) continue;
      m = hm;
    }
    /**
     * 时间闸必须**回落 created_at**。
     *
     * 旧写法是 `if (from && (!m.occurred_at || …)) continue` —— 没有 `occurred_at` 就直接
     * 丢弃。而 occurred_at 实测只覆盖 469/576（81.4%），缺的 107 条以 fact / procedure /
     * decision 为主，恰恰是最该被时间范围捞出来的那类。后果是**传了时间范围反而比不传搜到
     * 的更少**：用户问「上个月我们定了什么」，拿到的是一份被悄悄裁掉五分之一的结果集，
     * 而且没有任何信号说明裁掉了什么。
     *
     * 没有事件时间不等于不在这段时间里 —— 录入时间就是它最诚实的下界。
     * 两个时间戳格式还不一样（occurred_at 本地格式 / created_at ISO UTC），
     * 直接字符串比较会错序，所以统一过 normTime。
     */
    if (hasWindow && !withinWindow(effTime(m), win.lo, win.hi)) continue;
    if (hitIds.has(m.id)) continue;
    const tk = estTokens(m.content);
    if (tokensUsed + tk > budget && hits.length > 0) break;
    tokensUsed += tk;
    hitIds.add(m.id);
    metaById.set(m.id, { tags: m.tags, entities: m.entities });
    hits.push({
      id: m.id, content: maskSecrets(m.content), type: m.type,
      occurredAt: m.occurred_at, deviceId: m.device_name ?? m.device_id,
      sessionId: m.session_id ?? null,
      sourceRef: m.source_ref,
      score: Math.round(s.score * 100) / 100,
      matchedTerms: [...s.matched],
      onThisDevice: true,
    });
  }

  // ── 链共现：为每条命中挂延续链（轻量附注，跨命中去重，token 计入预算）──
  const chainShown = new Set<string>(hitIds);
  for (const h of hits) {
    // 附注只取最近的一段（默认 50 条封顶），不截断链本身；管理页/取单条走完整链。
    const links = resolveChain(db, h.id).links;
    const others = links.filter((l) => !chainShown.has(l.id));
    for (const l of others) chainShown.add(l.id);
    if (others.length) {
      h.chain = others.map((l) => ({ id: l.id, content: maskSecrets(l.content), occurredAt: l.occurredAt, createdAt: l.createdAt, superseded: !l.current }));
      tokensUsed += others.reduce((t, l) => t + estTokens(l.content), 0);
    }
  }

  // ── 1-hop 链接扩展（折叠为单行预览，~25 token）──
  // 预览也吃预算：以前是「先算满预算的 hits，再无条件追加预览」，tokensUsed 必然超支
  // （实测 2295 / 2575 对着 2000 的默认预算）。预算是对上层的硬承诺，不能只对 hits 生效。
  const linkedPreview = hits.length
    ? linkedPreviewFor(
        db,
        hits.map((h) => h.id),
        new Set(hits.map((h) => h.id)),
        Math.max(0, Math.floor((budget - tokensUsed) / PREVIEW_TOKEN_COST)),
      )
    : [];
  tokensUsed += linkedPreview.length * PREVIEW_TOKEN_COST;

  // ── related_tags：命中项的标签/实体，引导 AI 下一轮换词 ──
  // 数据在上面的 loadMem 里已经读回来了（metaById），这里不再逐条回查。
  const tagSet = new Set<string>();
  const termSet = new Set(terms);
  for (const h of hits) {
    const meta = metaById.get(h.id);
    if (!meta) continue;
    for (const k of ["tags", "entities"] as const) {
      const raw = meta[k];
      if (!raw) continue;
      try { for (const t of JSON.parse(raw) as string[]) if (!termSet.has(t)) tagSet.add(t); } catch { /* 损坏行跳过 */ }
    }
  }

  // ── 反馈记账（放最后）──
  // 本次检索读到的强度必须是「上一次为止」的积累，不能自己给自己打分：
  // 若先强化再取预览，同一批刚共现的边会立刻插到预览头部，排序就变成了自证。
  onRecalled(db, hits.map((h) => h.id));

  return {
    hits,
    linkedPreview,
    relatedTags: [...tagSet].slice(0, 10),
    tokensUsed,
    // 拆词兜底必须说出来：不说的话，AI 会把「字面相近」当成「答案」，这比返回空更难纠。
    lexNote: ngGrams.length
      ? `词群原样一条都没命中（复合词在倒排里是精确等值），已自动拆成 2 字片段重搜（${ngGrams.slice(0, 6).join("/")}${ngGrams.length > 6 ? "…" : ""}）——结果偏字面相近，未必对题；不准就换更短的词再搜一次，或直接换 recall_topic / recall_timeline`
      : undefined,
    stats: {
      termsN: terms.length,
      ftsN: ftsScores.size,
      invN,
      entN: entityScores.size,
      // 只在 ABC 全空时 n-gram 才会跑，所以这里的差值就是从拆词里捞到的条数。
      ngN: termScores.size - invN,
      candN: candidates.size,
      hitN: hits.length,
      tokens: tokensUsed,
      msLex: Math.round((performance.now() - t0) * 100) / 100,
      msAll: Math.round((performance.now() - t0) * 100) / 100,
      // 纯词法管线里所有命中都来自词法榜；混合检索会把它重算成 L/V 串。
      srcTop: "L".repeat(hits.length),
      hasWindow,
      budget,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 混合检索（四通道：FTS ∥ 着陆垫 ∥ 实体 ∥ 向量，RRF k=60 合并）
// 2026-10-04 定稿：个人版直上向量。向量失败自动降级纯词法（双降级红线）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 暴力向量扫描（个人库量级全扫）。
 *
 * 为什么要缓存：原来每次检索都 `SELECT id, embedding` 把整表向量从 SQLite 搬进
 * JS（1 万条 = 20MB BLOB + 逐行建 Float32Array 视图），实测 **28ms**，占混合检索
 * 八成以上。而向量只在「写入/重算」时变，绝大多数检索面对的是一模一样的数据。
 * 现在把解码结果留在进程内，命中时只剩纯算术：**7~8ms**，且摊到每次只剩算术。
 *
 * 失效判据用两个便宜的量拼起来（各约 0.02ms，走索引尾部与 pragma）：
 *  - `PRAGMA data_version`：**其他连接**提交过就变（采集子进程、另一个客户端）。
 *  - `MAX(rowid)`：本连接自己插入新记忆时只会动这个。
 * 本连接**更新**已有行的向量时两者都不变，所以 memory-write 写完向量要显式调
 * `invalidateVecCache()` —— 这是唯一需要人工维护的失效点，加新写入路径别忘了。
 *
 * 缓存里存的是原始向量，相似度仍是 `cosine()` 那套点积（写入侧已归一化），
 * 因此排序结果与不缓存时逐位一致，不存在「快了但分数变了」。
 */
interface VecCache {
  db: Database;
  key: string;
  ids: string[];
  flat: Float32Array;
  dims: number;
  /** 超过上限时只本次用，不驻留 */
  ephemeral?: boolean;
}

let vecCache: VecCache | null = null;

/**
 * 缓存行数上限。
 *
 * 缓存省的是「每次重读 20MB + 解码」，代价是这部分内存要一直占着。512 维 f32 每条
 * 2KB，3 万条约 60MB —— 与 SQLite 的 64MB 页缓存同量级，对桌面端可接受。
 * 再大就不缓存了，退回逐次扫描：宁可慢，也不让一个十年期的记忆库把内存吃穿。
 */
const MAX_CACHE_ROWS = 30_000;

/** 写完向量后必须调一次：本连接的写入不会改变 data_version */
export function invalidateVecCache(): void {
  vecCache = null;
}

function vecCacheKey(db: Database): string {
  const dv = (db.query("PRAGMA data_version").get() as { data_version: number } | null)?.data_version ?? 0;
  const mx = (db.query("SELECT MAX(rowid) AS m FROM memories").get() as { m: number | null } | null)?.m ?? 0;
  return `${dv}:${mx}`;
}

function vecTopK(
  db: Database,
  queryVec: Float32Array,
  k = 100,
): Array<{ id: string; score: number }> {
  const key = vecCacheKey(db);
  let c = vecCache;
  if (!c || c.db !== db || c.key !== key) {
    const rows = db.query(
      "SELECT id, embedding FROM memories WHERE status = 'active' AND deleted_at IS NULL AND embedding IS NOT NULL AND vec_model = ?",
    ).all(VEC_MODEL_REF) as Array<{ id: string; embedding: Uint8Array }>;
    const dims = rows.length ? rows[0]!.embedding.byteLength / 4 : queryVec.length;
    const flat = new Float32Array(rows.length * dims);
    const ids: string[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      ids[i] = r.id;
      const n = r.embedding.byteLength / 4;
      flat.set(new Float32Array(r.embedding.buffer, r.embedding.byteOffset, Math.min(n, dims)), i * dims);
    }
    c = { db, key, ids, flat, dims };
    if (rows.length > MAX_CACHE_ROWS) c.ephemeral = true;
    else vecCache = c;
  }

  const n = c.ids.length;
  if (!n || queryVec.length !== c.dims) return [];
  const scores = new Float32Array(n);
  const flat = c.flat;
  const dims = c.dims;
  for (let i = 0; i < n; i++) {
    let s = 0;
    const off = i * dims;
    for (let d = 0; d < dims; d++) s += queryVec[d]! * flat[off + d]!;
    scores[i] = s;
  }
  // 只排出前 k：1 万条全排序比取 top-k 慢一倍，而调用方只用 k 条
  const arr: number[] = new Array(n);
  for (let i = 0; i < n; i++) arr[i] = i;
  arr.sort((a, b) => scores[b]! - scores[a]!);
  const top = Math.min(k, n);
  const out: Array<{ id: string; score: number }> = new Array(top);
  for (let i = 0; i < top; i++) {
    const idx = arr[i]!;
    out[i] = { id: c.ids[idx]!, score: scores[idx]! };
  }
  return out;
}

// 避免循环 import：VEC_MODEL 从 embedder 动态取
const VEC_MODEL_REF = "bge-small-zh-v1.5/int8";

/**
 * 低于这个余弦相似度，就算"没真的像"。
 *
 * **实测标定，不是拍的**（2026-11-24，老板真实库 605 条记忆 / bge-small-zh-v1.5-int8）：
 *
 * | 查询类型 | top1 相似度区间 | 样本 |
 * |---|---|---|
 * | 与库内容相关 | 0.548 ~ 0.723 | 6 条 |
 * | 无关但正常的中文（"今天中午吃什么"）| 0.409 ~ 0.509 | 4 条 |
 * | 乱码（"zzkqxjv mwqpz"）| 0.459 ~ 0.566 | 5 条 |
 *
 * ⚠️ **两组在 0.548~0.566 是重叠的**，这是 bge-small-zh 的固有局限（中文句向量基线偏高、
 * 区分度不够），不是实现问题。取 0.57 是这条重叠带的上沿：
 * 非相关 9 条全被判弱，相关 6 条里误伤 1 条（0.548 那条）。
 *
 * 之所以敢取上沿：这个判据**还要叠加"词法三路一条硬命中都没有"**才生效，
 * 误伤面已经很小；反过来，阈值取得松一点，乱码就照样被当答案——那正是要修的问题。
 *
 * 样本只有 15 条，换向量模型、或库的领域变了都必须重新标定。
 */
const VEC_WEAK_SIM = 0.57;

/**
 * 给向量路补时间闸。
 *
 * 词法管线在组装 hits 时逐条判 occurredFrom/occurredTo，向量路却是把 top-100 **无条件**
 * 塞进 RRF —— 于是「传了时间范围」在混合检索下形同虚设：范围外的语义邻居照样排进来，
 * 甚至因为向量排名靠前而挤掉范围内的词法命中。两条路的闸门必须同高：只对一半结果生效的
 * 过滤，比完全不过滤更欺骗 —— 它让人以为过滤是真的。
 *
 * 一次 IN 查询（≤100 个 id）约 0.2ms，不值得为此往向量缓存里再塞一列时间。
 */
function vecHitsWithin(
  db: Database,
  hits: Array<{ id: string; score: number }>,
  from?: string,
  to?: string,
): Array<{ id: string; score: number }> {
  const { lo, hi } = timeWindow(from, to);
  if ((lo == null && hi == null) || !hits.length) return hits;
  const ph = hits.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id, occurred_at, created_at FROM memories WHERE id IN (${ph}) AND deleted_at IS NULL`)
    .all(...hits.map((h) => h.id)) as Array<{ id: string; occurred_at: string | null; created_at: string }>;
  const tById = new Map(rows.map((r) => [r.id, effTime(r)]));
  return hits.filter((h) => withinWindow(tById.get(h.id) ?? null, lo, hi));
}

/**
 * 混合检索入口（MCP search_memory 本地路径）：
 * 词法三路（searchMemory）∪ 向量路 → RRF 合并 → 链重定向/预算封顶（词法管线内已完成的部分保留）。
 * query embed 失败/模型未就绪 = 直接返回词法结果（自动降级）。
 */
export async function searchHybrid(
  db: Database,
  embedQuery: () => Promise<Float32Array | null>,
  params: SearchParams,
): Promise<SearchResult & { vecHits?: number }> {
  const t0 = performance.now();
  const lexical = searchMemory(db, params);
  /**
   * 三个降级分支共用。**必须共用** —— 以前它们各自写一遍「展开 lexical」，
   * 加统计时漏掉任何一条，那条分支就会带着 `msAll = 词法耗时` 落库，
   * 读起来像「向量没花时间」，而降级恰恰是最需要看清耗时去向的场景。
   */
  const degraded = (vecStatus: NonNullable<SearchResult["vecStatus"]>, vecNote: string, vecN?: number) => ({
    ...lexical,
    vecStatus,
    vecNote,
    stats: lexical.stats
      ? { ...lexical.stats, vecStatus, vecN, msAll: Math.round((performance.now() - t0) * 100) / 100 }
      : undefined,
  });
  try {
    const qv = await embedQuery();
    if (!qv) {
      return degraded(
        "not-ready",
        "语义通道未就绪（向量模型还没加载完/加载失败），本次只有词法检索结果 —— 用词不同但意思相近的记忆可能漏掉，稍后重试一次能补上",
      );
    }
    const rawVec = vecTopK(db, qv, 100);
    // 向量路走同一道时间闸（见 vecHitsWithin）。原实现完全不过滤。
    const vecHits = vecHitsWithin(db, rawVec, params.occurredFrom, params.occurredTo);
    if (vecHits.length === 0) {
      return degraded(
        rawVec.length ? "ok" : "empty-index",
        rawVec.length
          ? "时间窗内没有语义相近的记忆（语义通道也按同一个时间范围过滤过了），本次结果全部来自词法检索"
          : "语义索引还是空的（本地还没有可检索的向量），本次只有词法检索结果",
        0,
      );
    }

    // ── 证据强度 ──
    /**
     * 两个条件同时成立才算"弱"：
     *  ① 词法三路**一条硬命中都没有** —— 注意 n-gram 拆词命中的（`ngN`）不算：
     *     那是"词没对上、硬拆成 2 字片段凑出来的"，正好是弱证据本身。
     *  ② 语义最高相似度够不上门槛。
     * 只要有一路硬命中，这条结果就有确定的字面依据，不该被标成"弱"——
     * 文件里已经有过一次教训：多加一个含糊的判据，正常结果会被误伤，比不加更糟。
     */
    const top1 = vecHits[0]?.score ?? 0;
    const hardHits =
      (lexical.stats?.ftsN ?? 0) + (lexical.stats?.invN ?? 0) + (lexical.stats?.entN ?? 0);
    const weak = hardHits === 0 && top1 < VEC_WEAK_SIM;

    // RRF k=60：词法榜与向量榜各按名次贡献 1/(60+rank)
    const K = 60;
    const rrf = new Map<string, number>();
    lexical.hits.forEach((h, i) => rrf.set(h.id, (rrf.get(h.id) ?? 0) + 1 / (K + i + 1)));
    vecHits.forEach((v, i) => rrf.set(v.id, (rrf.get(v.id) ?? 0) + 1 / (K + i + 1)));

    // 词法命中的元数据保留；纯向量命中的补取内容（过链重定向+预算闸）
    const byId = new Map(lexical.hits.map((h) => [h.id, h]));
    const merged: SearchHit[] = [];
    const budget = params.budget ?? 2000;
    const limit = params.limit ?? 5;
    /**
     * 预算必须按「最终留下什么」重算，不能拿 `lexical.tokensUsed` 当起点。
     *
     * 词法管线为了自己那几条已经把这笔账记满了（含链附注与预览），而 RRF 合并后
     * 榜上第 2 名很可能是一个纯向量命中 —— 起点即满额 ⇒ 第一次判就越界 ⇒ 立刻 break，
     * 词法第 2~5 名（账早付过）连「已在结果里」那条分支都进不去。
     * 实测默认预算 2000 / limit 5：纯词法 5 条、混合只剩 1 条 —— **开了向量比不开向量
     * 少四条**，而返回里还写着 vecStatus=ok。这条伤害是方向性的：省预算省掉的是
     * 本来已经算出来的答案，用户看到的是「小本本记不住了」。
     */
    const chainTokens = (h: SearchHit) => (h.chain ? h.chain.reduce((t, l) => t + estTokens(l.content), 0) : 0);
    let tokens = 0;
    for (const id of [...rrf.keys()].sort((a, b) => (rrf.get(b) ?? 0) - (rrf.get(a) ?? 0))) {
      // 上限必须放在最前面：以前只在「向量补取」那条分支里查，而词法已命中的走
      // `exist` 分支直接 push —— RRF 排序下向量榜第 1 名会插到词法第 2 名之前，
      // 于是「词法#1 → 向量#1 → 词法#2」把 limit 顶穿（实测 limit 2 返回 3、5 返回 6）。
      if (merged.length >= limit) break;
      const exist = byId.get(id);
      if (exist) {
        // 词法命中也要过闸：重算之后它不再是"已付费"，而是候选之一。
        // 第一条无条件放行（和词法管线一致 —— 有命中就绝不返回空）。
        const tk = estTokens(exist.content) + chainTokens(exist);
        if (tokens + tk > budget && merged.length > 0) break;
        tokens += tk;
        merged.push(exist);
        continue;
      }
      const m = db.prepare(
        "SELECT id, content, type, occurred_at, session_id, device_id, source_ref FROM memories WHERE id = ? AND deleted_at IS NULL AND status = 'active'",
      ).get(id) as { id: string; content: string; type: string; occurred_at: string | null; session_id: string | null; device_id: string | null; source_ref: string | null } | undefined;
      if (!m) continue;
      const tk = estTokens(m.content);
      // 与词法管线同一条规矩：第一条无条件放行，别让"预算不够"变成"什么都没搜到"。
      if (tokens + tk > budget && merged.length > 0) break;
      tokens += tk;
      merged.push({
        id: m.id, content: maskSecrets(m.content), type: m.type,
        occurredAt: m.occurred_at, deviceId: m.device_id, sessionId: m.session_id,
        sourceRef: m.source_ref, score: Math.round((rrf.get(id) ?? 0) * 1000) / 1000,
        matchedTerms: ["vector"], onThisDevice: true,
      });
    }
    // 纯向量命中的条目不在 lexical.hits 里，它们的出边不会被词法管线算到——
    // 而「说法完全不同、语义相近」正是向量通道存在的理由（9 月说"吃饭的锅"、
    // 7 月记的是"电饭煲"）。漏在这里，等于多跳链在最需要它的那条路径上断掉。
    const lexIds = new Set(lexical.hits.map((h) => h.id));
    let linkedPreview = lexical.linkedPreview;
    // 词法那批预览是它自己按预算挑出来的，重算后这笔账要补回来 ——
    // 否则 tokensUsed 少报一整块，上层按它分配后续预算时会被反噬。
    // 顺带按剩余额度裁一次：合并后条目可能变多，原来够用的预览现在未必够。
    const lexPreviewRoom = Math.max(0, Math.floor((budget - tokens) / PREVIEW_TOKEN_COST));
    if (linkedPreview.length > lexPreviewRoom) linkedPreview = linkedPreview.slice(0, lexPreviewRoom);
    tokens += linkedPreview.length * PREVIEW_TOKEN_COST;
    const extraIds = merged.filter((h) => !lexIds.has(h.id)).map((h) => h.id);
    if (extraIds.length) {
      const seen = new Set(merged.map((h) => h.id));
      for (const p of linkedPreview) seen.add(p.id);
      // 预览同样吃预算：以前 `tokens += extra.length * 25` 写在闸门之后，等于先花再记，
      // 报出去的 tokensUsed 可以超出预算 15%~30%，而调用方以为它守住了。
      const room = Math.max(0, Math.floor((budget - tokens) / PREVIEW_TOKEN_COST));
      const extra = linkedPreviewFor(db, extraIds, seen, Math.min(room, Math.max(0, 10 - linkedPreview.length)));
      linkedPreview = linkedPreview.concat(extra);
      tokens += extra.length * PREVIEW_TOKEN_COST;
    }
    return {
      hits: merged,
      linkedPreview,
      relatedTags: lexical.relatedTags,
      tokensUsed: tokens,
      vecHits: vecHits.length,
      vecStatus: "ok",
      // 最高相似度原样带出去：这是"这批像不像"的唯一硬指标，
      // 而它此前被 RRF 的名次彻底掩盖（第 1 名得分 1/61，跟它有多像毫无关系）。
      vecTop1: Math.round(top1 * 1000) / 1000,
      ...(weak
        ? {
            lowConfidence: true,
            confidenceNote:
              `这批结果证据很弱：词法三路没有一条精确命中（全文/倒排/实体全 0），而语义最像的那条也只有 ${top1.toFixed(2)}（够不上 ${VEC_WEAK_SIM}）—— 它们大概率只是字面或语义上的邻居，不是用户要找的那件事。` +
              `回答时不要把其中任何一条当事实陈述；要么如实说没找到，要么换更具体的词再搜一次。`,
          }
        : {}),
      stats: lexical.stats
        ? {
            ...lexical.stats,
            // 合并后条数与 token 都重算过，不能再沿用词法侧的旧值 ——
            // 预算重算正是这个函数里最容易出错的一段，报出去的数必须是被返回的那一份。
            hitN: merged.length,
            tokens,
            vecStatus: "ok",
            vecN: vecHits.length,
            msAll: Math.round((performance.now() - t0) * 100) / 100,
            // 纯向量命中 = 词法三路一条都没捞到、只靠语义进来的那些。
            srcTop: merged.map((h) => (lexIds.has(h.id) ? "L" : "V")).join(""),
          }
        : undefined,
    };
  } catch (e) {
    // 永不因向量故障挂 —— 但**必须说出来**。以前这里是裸 catch，返回一份和正常结果
    // 长得一模一样的词法结果，于是「语义通道崩了」和「真没这段记忆」在 AI 眼里没区别。
    const msg = e instanceof Error ? e.message : String(e);
    return degraded("error", `语义通道出错（${msg.slice(0, 80)}），本次已退回词法检索 —— 结果可能不全`);
  }
}
