/**
 * 云端接入层（个人上云 / 协议唤起）：六工具按 profile 路由本地/云端。
 * 设计：MCP 工具语义对 AI 宿主零变化——后端可替换（LocalBackend=本地 SQLite，
 * CloudBackend=api.xiaobenben.net /v1/*，服务端五工具语义与 cli MCP 面逐条对齐）。
 * 凭据：key 明文落 ~/.xiaobenben/cloud.json（与本地库同目录，绑定响应是明文唯一一次出现，
 * 本地文件是唯一副本——与「落库即哈希」的服务端纪律互补）。
 */
import { programDir } from "./home";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { hostname, homedir, platform } from "node:os";
import { join } from "node:path";
import { hashFile, type AdmittedAttachment } from "./payloads";

export const DEFAULT_API = "https://api.xiaobenben.net";

export interface CloudConfig {
  apiBase: string;
  key: string; // xbb_live_… 明文（本地唯一副本）
  orgId: string;
  orgName?: string; // 组织显示名（bind 响应落盘；老配置由 hydrateOrg 从 /v1/me/summary 补齐）
  orgKind?: string; // personal | company —— 客户端据此折算展示名（服务端不出中文，i18n）
  spaceId: string | null; // 个人根空间（bind 时解析缓存；null=首次 deliver 时再解析）
  deviceName: string;
  boundAt: string;
  /**
   * 模式软开关（2026-10-07「本地/云端一键切换」）。
   *
   * `false` = **暂时以本地模式运行，但保留密钥**；缺省/`true` = 云端模式。
   * 与 `xbb unbind` 的分野是本设计的关键：
   *   · 软关（本字段）：文件还在、key 还在 ⇒ 随时切回，**不必回控制台重新生成 ticket**；
   *   · unbind（clearCloudConfig）：真删文件，key 即永久丢失，只能重新绑定。
   * 用户要的"便捷切换"只有在软关存在时才成立 —— 否则切一次就要走一趟控制台。
   *
   * 老配置没有这个字段 ⇒ `undefined` 按 `true` 解释，向后兼容。
   */
  enabled?: boolean;
}

/** 组织展示名：个人空间（orgKind=personal）统一显示为「个人空间」，不暴露内部字面量 personal。
 *  名字缺失时退回 orgId（降级可读，不谎报）。 */
export function orgDisplayName(name?: string | null, kind?: string | null, fallbackId = ""): string {
  if (!name) return fallbackId;
  return kind === "personal" ? "个人空间" : name;
}

const configPath = () =>
  join(programDir(), "cloud.json");

/**
 * 读 cloud.json 的**原始内容**（不过滤软关状态）。
 *
 * 给「管理页 / 托盘 / 模式开关」这类需要如实回答"本机到底有没有云端配置"的地方用；
 * 业务消费方（MCP backend 选型 / serve 的通知挂载 / 自更新）一律走 `loadCloudConfig()`。
 *
 * orgId 允许为空串：手动填 key 绑定（`bindFromKey`）时服务端当前不返回 orgId，
 * 而它只参与**展示与漂移指纹** —— 任何请求路径都只认 Authorization 头，不认这个值。
 */
export function loadCloudConfigRaw(): CloudConfig | null {
  const p = configPath();
  if (!existsSync(p)) return null;
  try {
    const c = JSON.parse(readFileSync(p, "utf8")) as CloudConfig;
    return c.apiBase && c.key ? c : null;
  } catch {
    return null;
  }
}

/**
 * 生效的云端配置 —— **软关（`enabled === false`）时返回 null**。
 *
 * 这是「本地 / 云端」这一个开关的**唯一收口**：MCP 的 backend 选型、桌面通知的挂载判断、
 * 托盘状态行的文案，全部经它得出。收在一处 ⇒ 软关一处生效、处处生效，不会漏掉某个角落
 * （散成多处判断，迟早有一个人忘了改，那就是"以为切了、其实还在写云端"）。
 */
export function loadCloudConfig(): CloudConfig | null {
  const c = loadCloudConfigRaw();
  return c && c.enabled !== false ? c : null;
}

/**
 * 模式软开关（保留密钥）：只改 `enabled` 位，**不动 key、不删文件**。
 *
 * 返回 `false` = 本机压根没有云端配置，无从切换（调用方据此引导用户先绑定，
 * 而不是静默"切换成功"却什么也没发生）。
 */
export function setCloudEnabled(enabled: boolean): boolean {
  const c = loadCloudConfigRaw();
  if (!c) return false;
  c.enabled = enabled;
  saveCloudConfig(c);
  return true;
}

/** cloud.json 的「判定性指纹」（2026-10-06 B 方案·绑定变更检测）。
 *
 *  为什么需要：绑定/解绑由一个**独立进程**完成（console 的 xubb:// 唤起 → xbb bind，
 *  或命令行 xbb bind / xbb unbind），它只写盘。而 MCP 子进程的 backend 是**启动期快照**，
 *  不会自己变——于是磁盘状态与运行状态可以长期不一致，且**完全静默**：
 *  不报错、不异常，记忆照常写，只是写到了旧目标（用户以为在云端，实际还在本地库）。
 *
 *  MCP 进程在启动时抓一次本指纹，此后每次工具调用拿现状比对，不一致即向 AI 挂提示。
 *
 *  sig 走 sha256 摘要：只在进程内存里做相等性比对，不落盘、不出网、不进日志
 *  （明文 key 绝不因此多一个副本）。 */
export interface CloudStamp {
  bound: boolean;
  /** 判定性标识（apiBase|orgId|key 的摘要）；未绑定 = "" */
  sig: string;
  /** 组织展示名（未绑定、或组织名尚未缓存时为空串） */
  orgLabel: string;
  orgId: string;
  apiBase: string;
  mtimeMs: number;
  size: number;
}

export function cloudStamp(): CloudStamp {
  const none: CloudStamp = { bound: false, sig: "", orgLabel: "", orgId: "", apiBase: "", mtimeMs: 0, size: 0 };
  const p = configPath();
  let mtimeMs = 0;
  let size = 0;
  try {
    const st = statSync(p);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    return none; // 文件不存在 = 未绑定
  }
  const cfg = loadCloudConfig();
  // 文件在但解析不出可用配置（半写损坏）＝ 与"未绑定"等价，同样触发变更提示
  if (!cfg) return { ...none, mtimeMs, size };
  const sig = createHash("sha256").update(`${cfg.apiBase}|${cfg.orgId}|${cfg.key}`).digest("hex").slice(0, 16);
  return {
    bound: true,
    sig,
    orgLabel: orgDisplayName(cfg.orgName, cfg.orgKind, cfg.orgId),
    orgId: cfg.orgId,
    apiBase: cfg.apiBase,
    mtimeMs,
    size,
  };
}

/** 绑定变更提示文案（纯函数：快照 vs 现状 → 给 AI 的提示；一致则 null）。
 *
 *  文案刻意写明**当前实际读写落在哪个目标**——因为这条提示的全部价值就是让用户知道
 *  "你以为在云端，其实还在本地"（或反之）。抽成纯函数是为了可测：
 *  这是「静默写错地方」的唯一出口，不能只靠端到端碰运气。 */
export function bindingDriftMessage(boot: CloudStamp, now: CloudStamp): string | null {
  if (now.sig === boot.sig) return null; // 一致（含"启动至今一直未绑定"）
  // orgId 可能为空串（手动填 key 绑定的降级形态）⇒ 不要在提示里印出一对空括号
  const withId = (label: string, id: string) => (id ? `${label}（${id}）` : label);
  const tail =
    "请重启 AI 客户端（opencode / Cursor / WorkBuddy 等）后，新会话才会生效；在重启之前，本客户端的读写仍在旧目标上进行。";
  if (!boot.bound && now.bound)
    return `【绑定状态已变化】本机刚刚绑定了云端组织「${withId(now.orgLabel, now.orgId)}」，但本会话的 MCP 进程仍以【本地模式】运行——记忆会继续写入本地库、不会同步到云端组织。${tail}`;
  if (boot.bound && !now.bound)
    return `【绑定状态已变化】本机已切回本地模式（或解除了云端绑定），但本会话的 MCP 进程仍以【云端模式】运行——记忆会继续写入云端组织「${withId(boot.orgLabel, boot.orgId)}」。${tail}`;
  // 换组织：新旧展示名可能相同（orgKind=personal 会被 orgDisplayName 统一归为「个人空间」，
  // 换账号时尤其如此）——故两个 id 都给出，避免提示里出现「甲 → 甲」这种无法区分的句子。
  return `【绑定状态已变化】本机云端绑定已切换到组织「${withId(now.orgLabel, now.orgId)}」，但本会话的 MCP 进程仍连着旧组织「${withId(boot.orgLabel, boot.orgId)}」——记忆会继续写进旧组织。${tail}`;
}

/** 云端控制台基址推导（confirm_url 用）：api.xiaobenben.net → console.xiaobenben.net。
 *
 *  为什么推导而不是写死：部署形态可能不同（自建 / 预发），写死会把用户引到错误的站点。
 *  推导不出来（自建域名、localhost 联调）时返回 **null**——宁可不给链接，也绝不伪造一个
 *  点不开的地址（同「降级可读、不谎报」纪律）。自建部署用 XBB_CONSOLE_BASE 显式指定。 */
export function consoleBase(apiBase: string): string | null {
  const override = process.env.XBB_CONSOLE_BASE?.trim();
  if (override) return override.replace(/\/+$/, "");
  try {
    const u = new URL(apiBase);
    if (!u.hostname.startsWith("api.")) return null;
    return `${u.protocol}//console.${u.hostname.slice(4)}`;
  } catch {
    return null;
  }
}

/** 收件人解析（纯函数，唯一出口 → 可测）：「名字或 uuid」→ 确定的成员身份。
 *
 *  为什么必须在这里落成 id：服务端只认 uuid，且**非 uuid 一律 400**（名单宁可整笔拒绝，
 *  也不写半份）。名字要落得**可解释**：重名时把候选（含所属空间与 id）全列出来让 AI 自己选，
 *  查无此人时直说——**绝不"猜一个最像的"**（发给错的人比发不出去更糟）。 */
export function resolveRecipients(want: string[], members: MemberInfo[]): { id: string; name: string }[] {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const raw of want) {
    const key = raw.trim();
    if (!key) continue;
    let hit: MemberInfo | undefined;
    if (UUID_RE.test(key)) {
      hit = members.find((m) => m.id === key);
      if (!hit) throw new Error(`收件人 id ${key} 不在本组织在职成员中——请先调 list_members 核对`);
    } else {
      const same = members.filter((m) => m.name === key);
      if (same.length === 0) {
        throw new Error(`本组织没有叫「${key}」的在职成员——请先调 list_members 取准确的名字或 id`);
      }
      if (same.length > 1) {
        throw new Error(
          `「${key}」有 ${same.length} 位同名成员，无法确定发给谁，请改用其中一个 id：` +
            same.map((m) => `${m.name}（${m.space ?? "未知空间"} · ${m.id}）`).join("；"),
        );
      }
      hit = same[0];
    }
    if (!seen.has(hit.id)) {
      seen.add(hit.id);
      out.push({ id: hit.id, name: hit.name });
    }
  }
  return out;
}

export function saveCloudConfig(c: CloudConfig): string {  const p = configPath();
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(c, null, 2));
  try {
    if (platform() !== "win32") chmodSync(p, 0o600);
  } catch {
    /* best-effort：Windows 无 POSIX 权限 */
  }
  return p;
}

export function clearCloudConfig(): boolean {
  const p = configPath();
  if (!existsSync(p)) return false;
  rmSync(p);
  return true;
}

// ---------- 后端接口（六工具语义的最小公共面） ----------

/** 组织成员（成员目录条目，AI 的"寻址对象"）。
 *  **永不出手机号**——与 `/v1/me/members` 的分野一致（那是选择器数据源，最小暴露）。 */
export interface MemberInfo {
  /** member uuid：服务端唯一认的接收人标识（名字只是给人看/给 AI 认的媒介） */
  id: string;
  name: string;
  /** 所属空间名（由 /v1/me/spaces 映射；映射不到时回落 spaceId，不谎报） */
  space: string | null;
  tags: string[];
}

/** 成员目录查询结果（两模式同形：本地恒为空清单 + 说明，不报 unsupported——
 *  本地没有成员不是"能力缺失"，而是"单机库本就没有第二个成员"）。 */
export interface MemberListResult {
  scope: "local" | "cloud";
  members: MemberInfo[];
  note?: string;
}

/** 出件箱查询结果（2026-10-07）：**我投递出去的**记忆 + 逐人签收/已读状态。与 `inbox` 互为反面
 *  ——收件箱答"我要签什么"（收件人视角），出件箱答"我发出去的，对方看了没、认了没"（发起人视角）。
 *  存在的理由：只给 AI 收件箱，它永远答不出"cc 签收了吗"。本地恒为空清单 + 说明（单机库没有
 *  其他成员，也就没有别人来签收），与 `MemberListResult` 同纪律：不报 unsupported。 */
export interface OutboxResult {
  scope: "local" | "cloud";
  /** 云端：`OutboxItem[]`（内容 + `ackTotal`/`ackDone`/`arrivedTotal` + 逐人 `targets`）；本地恒 `[]` */
  items: unknown[];
  note?: string;
}

/** 收件人回执（「界外自由区」的唯一接触点）。
 *  小本本**不发消息、也不感知宿主有没有 IM**；它只把**动作中心深链 + 建议话术**交给 AI——
 *  宿主若恰好有发消息的手（挂了钉钉/企微 MCP），就能顺手把链接转给对方；
 *  没有也不影响 L1（对方 AI 下次拉取）/ L2（收件箱）兜底。**宿主中立 = 不偏袒宿主，也不指望宿主。** */
export interface DeliverNotify {
  recipients: { id: string; name: string }[];
  /** 对方点开即可签收的页面；推不出 console 域名时为 null（**绝不伪造链接**） */
  confirmUrl: string | null;
  /** 建议话术（给 AI 的转述素材，不是必须执行的动作） */
  hint: string;
}

export interface DeliverResult {
  id: string;
  createdAt: string;
  /** 命中内容去重：未新建，返回已有条目（本地与云端同义） */
  deduped?: boolean;
  /** 本次成功延续的旧记忆 id（链头让位给本条） */
  superseded?: string[];
  /** 被拒绝的延续及原因（跨空间/分叉/系统记忆/不存在）——AI 需据此改挂链头 */
  supersedeRejected?: { id: string; reason: string; currentHead?: string }[];
  /** 云端写入侧抹除的凭据标记数（>0 = 提交过密钥，已被拦在库外） */
  redacted?: number;
  /** 本次投递的收件人（云端组织模式且指定了 notify 时才有）——AI 据此知道"到底发给谁了" */
  notify?: DeliverNotify;
  /**
   * 候选链头（B 方案 2026-10-06）：本条**未带 supersedeIds** 时，同空间内词群高度重叠的
   * 旧状态记忆——回传给 AI 自己判断是否该延续（**只递材料，绝不自动挂**）。
   * 这是"忘了挂链"的补救入口：AI 拿到候选后调 `supersede` 补链。
   */
  supersedeCandidates?: SupersedeCandidate[];
  /**
   * 生效后的可见范围（服务端读回）：**未指定 audience 时也会给**（=「仅归属人」默认档）。
   * 沉默的默认值最容易被误解——AI 要在同一轮就告诉用户"这条只有你自己可见"。
   */
  audience?: AudienceState;
}

/** 候选链头（写入响应回传、供 AI 判断是否补链；不自动生效） */
export interface SupersedeCandidate {
  id: string;
  /** 内容预览（截断——判断依据，不是全文） */
  content: string;
  /** 与本条词群的重叠词数（越高越像同一话题的旧状态） */
  overlap: number;
  createdAt: string;
  occurredAt: string | null;
}

/** 补链结果（事后把已存在的记忆结成延续链） */
export interface SupersedeOutcome {
  /** 本次确立的链头 id（当前真相） */
  headId: string;
  /** 成功挂到链头下的旧记忆 id */
  superseded: string[];
  /** 被拒绝的项及原因（不静默吞掉） */
  rejected: { id: string; reason: string; currentHead?: string }[];
}

/**
 * 可见范围（写入形状，2026-10-06 记忆访问权限）：与 MCP `write_memory` 的 `audience` 一一对应。
 * 服务端的规范形状是 `{ org, spaces[] }`——这里刻意**不造业务枚举**（不写"部门可见"之类的别名），
 * 否则"我的所在部门"就有两个真源（服务端解析的 members.space_id vs 客户端自称）。
 */
export interface AudienceInput {
  /** true = 全组织公开（本组织内任何成员可检索）。默认 false = 仅归属人。 */
  org?: boolean;
  /** 空间锚：授权到这些空间；`includeDescendants` = 含其整棵子树。id 从 `list_spaces` 取。 */
  spaces?: { spaceId: string; includeDescendants?: boolean }[];
}

/** 读回的可见范围（服务端总给全字段，不留缺省歧义） */
export interface AudienceState {
  org: boolean;
  spaces: { spaceId: string; includeDescendants: boolean }[];
}

/** 组织空间（`list_spaces` 出参一条）：AI 按名字挑部门、拿 id 去 write_memory 的 audience.spaces */
export interface SpaceInfo {
  id: string;
  parentId: string | null;
  name: string;
  kind: string;
}

export interface SpaceListResult {
  scope: "local" | "cloud";
  spaces: SpaceInfo[];
  /** 目标空间（写入落点，通常=根公司空间）；本地模式为 null */
  defaultSpaceId: string | null;
  /** 本地模式/异常时的说明——让 AI 能如实回答，而不是含糊报错 */
  note?: string;
}

/** 改可见性的结果（`set_memory_audience` 出参） */
export interface SetAudienceResult {
  ok: boolean;
  /** 生效后的档位（服务端读回，不是客户端推断） */
  audience?: AudienceState;
  /** 失败原因（服务端语义），ok=false 时给 */
  reason?: string;
}

/**
 * 写入入参：与 MCP write_memory 的 item 字段一一对应；
 * `spaceId` / `actor` 由各 Backend 自补，调用方不传。
 * 字段语义全部来自本地 `MemoryItem`（cli/src/memory-write.ts），不另造。
 */
export interface DeliverInput {
  content: string;
  type?: string;
  terms?: string[];
  tags?: string[];
  entities?: string[];
  occurredAt?: string;
  occurredPrecision?: string;
  sourceRef?: string;
  kind?: string;
  dscope?: string;
  domain?: string;
  sessionId?: string;
  links?: { toId: string; relation: string }[];
  supersedeIds?: string[];
  needsAck?: boolean;
  /** 收件人：成员**名字**或 **member uuid**（先调 list_members 拿准确名字）。
   *  给出即"通知某位同事"语义——服务端强制要求带签收名单，故此处**隐含 needsAck=true**：
   *  对方会在自己的收件箱里看到这条待签收。**本地模式不支持**（单机库没有第二个成员），
   *  传了会被显式拒绝而不是静默丢弃。 */
  notify?: string[];
  /**
   * 访问范围（可见性，2026-10-06）：不传 = 默认「仅归属人」（保守默认态）。
   * `{ org: true }` = 全组织公开（此档**不需要空间 id**，是 AI 唯一能独立表达的宽范围）；
   * `{ spaces: [{ spaceId, includeDescendants }] }` = 授权到具体空间/子树——id 从 `list_spaces` 取，
   * 且**必须落在归属人自己的子树内**（服务端闸门，越界整笔拒绝）。
   * **只对 kind=memory 有效**：指令三类（directive/habit/constraint）是个人行为纪律，
   * 带 audience 会被服务端整笔拒绝（设计约束：可见性不适用指令面）。
   * 本地模式不支持（单机库没有第二个成员），传了会被显式拒绝而不是静默丢弃。
   */
  audience?: AudienceInput;
  /**
   * 文件载荷 id（云端文件记忆）：由 `uploadPayload` 上传后返回的 payloadId，逐个挂到本条记忆上。
   * 本地模式**不用这个字段** —— 本地的附件走"本机绝对路径引用"（`payloads.ts` 的 admitAttachments），
   * 字节从不离开原位置；这条是云端专属的"字节已经进对象存储"路径。
   */
  payloadIds?: string[];
}
/** 延续链上的一环（服务端在命中项上附注的故事线） */
export interface RecChainLink {
  memoryId: string;
  content: string;
  occurredAt: string | null;
  createdAt: string;
  /** true = 链头（当前真相）；false = 历史环 */
  current: boolean;
}

/** 检索命中（与本地 SearchHit 同形：除分数外还带可解释性与结构字段） */
export interface RecHit {
  memoryId: string;
  content: string;
  score: number;
  createdAt: string;
  actor?: string;
  /** 这条是哪些词捞上来的（AI 据此判断要不要换词重试） */
  matchedTerms?: string[];
  type?: string;
  occurredAt?: string | null;
  sessionId?: string | null;
  sourceRef?: string | null;
  /** 命中项原是历史环、已被服务端重定向到链头（true = 你查的是旧版本） */
  redirected?: boolean;
  chain?: RecChainLink[];
  /**
   * 归属人（2026-10-06 可见性）：可见范围放开后同一条记忆会跨人出现，
   * `owner` 让它能看出"这是谁的"，`mine` 区分"我写的"与"同事公开的"。
   * 历史行（无归属）恒 `owner=null` + `mine=false`——「无归属」不等于「我的」。
   */
  owner?: { memberId: string; name: string } | null;
  mine?: boolean;
}

/** 一次检索的完整产出（tokensUsed 让 AI 宿主感知上下文占用） */
export interface RecallResult {
  hits: RecHit[];
  nearTerms?: string[];
  relatedTags?: string[];
  linkedPreview?: { memoryId: string; relation: string; preview: string }[];
  tokensUsed?: number;
}

/** 服务端在 ok 响应体上平铺的扩展字段（超出 data 的部分） */
interface ResponseExtras {
  nearTerms?: string[];
  relatedTags?: string[];
  linkedPreview?: { memoryId: string; relation: string; preview: string }[];
  tokensUsed?: number;
}

/**
 * 工具出参：形状由两端各自保证——本地=memory-tools 直调，云端=/v1/* 同名端点 data。
 * **刻意不在此重复定义结构**：两端必须同形，重复定义一处改动就会静默漂移；
 * 出参形状的唯一真源是 cli/src/memory-tools.ts（本地语义）。
 */
export type Gen1Result = unknown;

export interface Backend {
  readonly kind: "local" | "cloud";
  deliver(item: DeliverInput): Promise<DeliverResult>;
  /**
   * 上传一个本机文件作为**云端载荷**，返回可挂到记忆上的 payloadId。
   *
   * 与本地模式的根本差别：本地**只记引用**（路径 + sha256，字节留在原位置，见 `payloads.ts`）；
   * 云端必须**把字节搬上去**（对象存储），否则换台设备就没了。
   * 两段式：先 ask（要不要传）再传 —— 同一份文件被反复挂到不同记忆上是常态，
   * 命中就省掉整份字节的往返（去重是常态，不是优化）。
   * 本地模式**不支持**（没有对象存储，也不需要）：调用即抛，由 mcp.ts 在本地分支里绕开。
   */
  uploadPayload(input: { ref: string; mime?: string; description?: string; tags?: string[] }): Promise<AdmittedAttachment>;
  /**
   * 检索。`terms`（可选）= AI 扩展词群：云端把它与 text 一起送服务端，让着陆垫倒排/实体精确
   * 两路能以「同源等值」匹配（AI 写入用的词 = AI 查询用的词），复刻本地的召回质量。
   */
  recall(query: string, limit?: number, terms?: string[]): Promise<RecallResult>;
  inbox(limit?: number): Promise<unknown[]>;
  ack(id: string): Promise<boolean>;
  forget(id: string): Promise<boolean>;
  stats(): Promise<Record<string, unknown>>;
  /**
   * 出件箱（2026-10-07）：**我投递出去的**记忆 + 逐人签收/已读（与同事的收件箱互为反面）。
   * 治的正是"AI 答不出'我发的 cc 签收了没'"——`inbox` 只答"我要签什么"（收件人视角），
   * 回答不了发起人视角的问题。本地恒为空清单 + 说明，与 listMembers/listSpaces 同纪律：
   * **不报 unsupported，让 AI 如实作答**。
   */
  outbox(limit?: number, status?: "pending" | "done" | "all"): Promise<OutboxResult>;
  /** 组织成员目录（AI 要通知/指派同事前的**寻址入口**）。本地恒为空清单 + 说明，不报 unsupported。 */
  listMembers(): Promise<MemberListResult>;
  /**
   * 事后补链（C 方案 2026-10-06）：把**已存在**的记忆结成延续链（headId 成为当前真相、
   * supersededIds 挂其下）。治"AI 写入时忘了带 supersedeIds"。链形铁律与写入侧的 supersede
   * 完全同源（真链头/分叉封死/同空间/幂等），拒绝项不静默吞。**本地/云端同语义。**
   */
  supersede(headId: string, supersededIds: string[]): Promise<SupersedeOutcome>;
  /**
   * 组织空间清单（2026-10-06 可见性）：AI 要"只给市场部看"就必须先知道部门的名字与 id。
   * 本地模式返回空清单 + 说明（单机库只有一个个人空间，没有部门可挑）。
   */
  listSpaces(): Promise<SpaceListResult>;
  /**
   * 改某条已存在记忆的可见范围（2026-10-06 可见性）：治"写入时没设、事后要改"与
   * "用户说'这条公开一下'"。**仅归属人可改**——服务端显式比对 actor_member_id，
   * 非归属人一律 `ok:false, reason:"not_found"`（不泄露"这条是否存在"）。
   * 本地模式不支持（没有第二个成员），返回 ok:false + 说明而不是假装成功。
   */
  setAudience(id: string, audience: AudienceInput): Promise<SetAudienceResult>;
  // ── 工具面：本地直调 memory-tools，云端走 /v1/* 同名端点 ──
  // 这组的存在意义：让「云端付费版的能力不低于本地 exe」落到工具面——绑定云端后 AI 不再被
  // "unsupported" 挡在门外（此前十个工具当场失效，属能力倒挂）。
  recallTopic(entity: string, limit?: number): Promise<Gen1Result>;
  recallTimeline(from: string, to: string, entity?: string, limit?: number): Promise<Gen1Result>;
  recallSession(sessionId: string, limit?: number): Promise<Gen1Result>;
  getMemory(id: string): Promise<Gen1Result | null>;
  getRelated(id: string, limit?: number): Promise<Gen1Result>;
  recallDirectives(sessionId?: string): Promise<Gen1Result>;
  recallConstraints(terms: string[], budget?: number): Promise<Gen1Result>;
}

/** 工具在云端**真·不可用**的原因（仅剩三件——其余已由服务端直供）。
 *  这三件不是"还没做"，是**设计上不做**：情景层永不入云（隐私边界）、云端无保险箱。 */
const GEN1_LOCAL_ONLY: Record<string, string> = {
  log_episodes: "情景层（原话逐字冷存档）是本地独占能力——设计上永不入云（隐私边界），云端无对应存储。",
  recall_episodes: "情景层（原话逐字冷存档）是本地独占能力——设计上永不入云（隐私边界），云端无对应存储。",
  reveal_secret: "云端没有本地那种保险箱（凭据在写入侧已被抹成占位符，库里根本不存在明文）——无密可取。",
};

/** 工具在云端真不可用时的结构化降级提示 */
export type Gen1Unsupported = { ok: false; unsupported: string };
export const gen1Unsupported = (tool: string): Gen1Unsupported => ({
  ok: false,
  unsupported: `${tool} 在云端模式不可用：${GEN1_LOCAL_ONLY[tool] ?? "该能力仅本地模式提供。"}如需使用请 xbb unbind 后重启 AI 宿主。`,
});

export class LocalBackend implements Backend {
  readonly kind = "local" as const;
  // eslint-disable-next-line no-useless-constructor
  constructor(private readonly store: import("./store").PersonalStore) {}
  /** 工具引擎直访；PersonalStore 公共访问（writeMemory 需 appendEvent 落链） */
  get personalStore(): import("./store").PersonalStore {
    return this.store;
  }
  /** db 直访（gen1 分派用） */
  get db(): import("bun:sqlite").Database {
    return this.store.db;
  }
  /**
   * 本地写入：走全量管线 `writeMemory`（去重 → 密钥入箱 → 扩展词/实体/链接 → 延续链 → 指令窗口）。
   * 与云端 `CloudBackend.deliver` **语义对齐**——两端都是"全量元数据"，不再有"云端只存 content+tags"的分野。
   */
  async deliver(item: DeliverInput): Promise<DeliverResult> {
    const { SPACE_PERSONAL } = await import("./schema");
    const { writeMemory } = await import("./memory-write");
    const r = await writeMemory(this.store, item as import("./memory-write").MemoryItem, {
      spaceId: SPACE_PERSONAL,
      actor: "ai-host",
    });
    return {
      id: r.id,
      createdAt: r.now,
      deduped: r.deduped,
      superseded: r.superseded,
      supersedeRejected: r.supersedeRejected,
      supersedeCandidates: r.supersedeCandidates,
    };
  }

  /**
   * 本地模式**没有对象存储，也不需要**：附件走 `admitAttachments`（记本机绝对路径引用，
   * 字节永不离开原位置）。显式抛错而不是返回空壳 —— 静默成功会让调用方以为文件上去了。
   */
  async uploadPayload(): Promise<AdmittedAttachment> {
    throw new Error(
      "本地模式不使用云端载荷：附件以本机绝对路径引用（write_memory 的 attachments 走这条路径）。",
    );
  }
  /** 本地检索：走 hybrid 管线的是 MCP 工具面（mcp.ts 直连引擎），此处是 Backend 面的降级入口。
   *  `terms` 对本地无意义（词群由 mcp.ts 直接交给 searchHybrid），仅为签名一致而保留。 */
  async recall(query: string, limit?: number, _terms?: string[]): Promise<RecallResult> {
    return { hits: this.store.search(query, { limit }) };
  }
  async inbox(limit?: number) {
    return this.store.inbox({ limit });
  }
  async ack(id: string) {
    return this.store.ack(id, "user");
  }
  async forget(id: string) {
    return this.store.forget(id, "user");
  }
  async stats() {
    return { ...this.store.stats() };
  }
  /** 本地是单机个人记忆库：没有其他成员，也就没有"我投递出去、别人签收"这回事——空清单 + 说明。 */
  async outbox(): Promise<OutboxResult> {
    return {
      scope: "local",
      items: [],
      note: "本地模式是单机个人记忆库，没有其他成员，也就没有\"我投递出去、别人签收\"这回事；出件箱在绑定云端组织后才有意义。",
    };
  }
  /** 本地是单机个人记忆库：没有组织、没有第二个成员——空清单 + 说明，
   *  让 AI 能如实回答「这里没有同事可通知」，而不是含糊报错、也不是让它以为工具坏了。 */
  async listMembers(): Promise<MemberListResult> {
    return {
      scope: "local",
      members: [],
      note: "当前是本地模式（单机个人记忆库），没有组织成员可寻址。要通知/指派同事，需先绑定云端组织（xbb cloud bind，并重启 AI 客户端）。",
    };
  }
  /** 本地补链：走 memory-write 的 supersedeMemories（链形铁律与写入侧同源） */
  async supersede(headId: string, supersededIds: string[]): Promise<SupersedeOutcome> {
    const { supersedeMemories } = await import("./memory-write");
    return supersedeMemories(this.store, { headId, supersededIds, actor: "ai-host" });
  }
  /** 本地是单机个人记忆库：只有个人空间，没有部门可挑——空清单 + 说明（不报 unsupported） */
  async listSpaces(): Promise<SpaceListResult> {
    return {
      scope: "local",
      spaces: [],
      defaultSpaceId: null,
      note: "当前是本地模式（单机个人记忆库）：全部记忆都在个人空间，没有部门/子部门可授权。可见范围是云端组织能力，需先绑定云端组织（xbb cloud bind，并重启 AI 客户端）。",
    };
  }
  /** 本地无第二个成员 → 可见范围无意义。**显式拒绝而非假装成功**（假装会让 AI 以为已公开）。 */
  async setAudience(_id: string, _audience: AudienceInput): Promise<SetAudienceResult> {
    return {
      ok: false,
      reason: "可见范围只在云端组织模式下有意义：本地是单机个人记忆库，没有其他成员能看到它。请先 `xbb cloud bind` 并重启 AI 客户端。",
    };
  }

  // ── 工具面：本地直调 memory-tools（本地是真源语义，此处零加工） ──
  async recallTopic(entity: string, limit?: number) {
    const { recallTopic } = await import("./memory-tools");
    return recallTopic(this.store.db, entity, limit);
  }
  async recallTimeline(from: string, to: string, entity?: string, limit?: number) {
    const { recallTimeline } = await import("./memory-tools");
    return recallTimeline(this.store.db, from, to, entity, limit);
  }
  async recallSession(sessionId: string, limit?: number) {
    const { recallSession } = await import("./memory-tools");
    return recallSession(this.store.db, sessionId, limit);
  }
  async getMemory(id: string) {
    const { getMemory } = await import("./memory-tools");
    return getMemory(this.store.db, id);
  }
  async getRelated(id: string, limit?: number) {
    const { getRelated } = await import("./memory-tools");
    return { ok: true, related: getRelated(this.store.db, id, limit) };
  }
  async recallDirectives(sessionId?: string) {
    const { recallDirectives } = await import("./memory-tools");
    return recallDirectives(this.store.db, sessionId);
  }
  async recallConstraints(terms: string[], budget?: number) {
    const { recallConstraints } = await import("./memory-tools");
    return recallConstraints(this.store.db, terms, budget);
  }
}

export class CloudBackend implements Backend {
  readonly kind = "cloud" as const;
  private orgName: string | null;
  private orgKind: string | null;
  /** 自己的成员 id（工作台 v3「强制名单」用）：懒加载自 /v1/me/summary，进程内缓存 */
  private memberId: string | null = null;
  constructor(private readonly cfg: CloudConfig) {
    this.orgName = cfg.orgName ?? null;
    this.orgKind = cfg.orgKind ?? null;
  }

  /** 组织显示名（个人空间归一为「个人空间」）；名字未知时退回 orgId——降级可读，不谎报 */
  get orgLabel(): string {
    return orgDisplayName(this.orgName, this.orgKind, this.cfg.orgId);
  }

  /** 组织上下文：随每个工具响应下发，AI 据此回答「记忆写到哪个组织」（known=false 表示名未解析出） */
  get org(): { id: string; name: string; kind: string | null; known: boolean } {
    return { id: this.cfg.orgId, name: this.orgLabel, kind: this.orgKind, known: this.orgName !== null };
  }

  /** 老配置兜底（2026-10-04）：cloud.json 无 orgName 时从 /v1/me/summary 解析组织名/kind 并回写。
   *  顺带缓存自己的 memberId（工作台 v3 待确认记忆必须点名签收人，见 deliver）。
   *  带超时（默认 3s）——MCP 启动路径上调用，云端不可达时不能挂住握手；失败静默降级为 orgId 展示。 */
  async hydrateOrg(timeoutMs = 3000): Promise<void> {
    if (this.orgName && this.memberId) return;
    try {
      const { data: s } = await Promise.race([
        this.call<{ orgName: string | null; orgKind?: string | null; memberId?: string | null }>("GET", "/v1/me/summary"),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error("hydrateOrg timeout")), timeoutMs);
          (t as unknown as { unref?: () => void }).unref?.();
        }),
      ]);
      if (s.memberId) this.memberId = s.memberId;
      if (s.orgName) {
        this.orgName = s.orgName;
        this.orgKind = s.orgKind ?? null;
        this.cfg.orgName = s.orgName;
        this.cfg.orgKind = this.orgKind ?? undefined;
        saveCloudConfig(this.cfg);
      }
    } catch {
      /* 离线/超时/接口异常：降级为 orgId 展示，不阻断 MCP */
    }
  }

  /** 自己的成员身份：缓存优先，未取到则现拉一次 summary（失败返回 null，由调用方决定是否报错） */
  private async selfMemberId(): Promise<string | null> {
    if (this.memberId) return this.memberId;
    await this.hydrateOrg();
    return this.memberId;
  }

  private async call<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<{ data: T } & ResponseExtras> {
    const res = await fetch(`${this.cfg.apiBase}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.cfg.key}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as
      | ({ ok: true; data: T } & ResponseExtras)
      | { ok: false; error: { code: string; message: string } }
      | null;
    if (!json) throw new Error(`云端响应不可读（HTTP ${res.status}）`);
    if (!json.ok) throw new Error(`云端 ${json.error.code}: ${json.error.message}`);
    // 扩展字段**原样透传**（undefined 就是没有，不补空壳——调用方一眼能看出服务端给没给）
    return {
      data: json.data,
      nearTerms: json.nearTerms,
      relatedTags: json.relatedTags,
      linkedPreview: json.linkedPreview,
      tokensUsed: json.tokensUsed,
    };
  }

  /** 个人根空间解析：bind 时缓存；未缓存时按 /v1/me/spaces 兜底（根空间=parentId null） */
  private async resolveSpaceId(): Promise<string> {
    if (this.cfg.spaceId) return this.cfg.spaceId;
    const { data: spaces } = await this.call<{ id: string; parentId: string | null; name: string; kind: string }[]>(
      "GET",
      "/v1/me/spaces",
    );
    const root = spaces.find((s) => s.parentId === null) ?? spaces[0];
    if (!root) throw new Error("云端组织无任何空间，请先在管理台确认组织状态");
    this.cfg.spaceId = root.id;
    saveCloudConfig(this.cfg);
    return root.id;
  }

  /**
   * 组织空间清单（2026-10-06 可见性）：AI 按**名字**挑部门、拿 **id** 去 write_memory 的
   * `audience.spaces`——没有它，AI 只知道有"市场部"这个说法，却没有任何合法的钉法。
   * 顺带给出写入落点（通常=根公司空间），避免 AI 再猜一次。
   */
  async listSpaces(): Promise<SpaceListResult> {
    const { data } = await this.call<SpaceInfo[]>("GET", "/v1/me/spaces");
    const spaces = (data ?? []).map((s) => ({ id: s.id, parentId: s.parentId ?? null, name: s.name, kind: s.kind }));
    const root = spaces.find((s) => s.parentId === null) ?? spaces[0] ?? null;
    return { scope: "cloud", spaces, defaultSpaceId: root?.id ?? null };
  }

  /**
   * 改可见范围（2026-10-06）：走 key 面 `PATCH /v1/memory/:id/audience`。
   * **非归属人 → 服务端 404**（不泄露"这条是否存在"），此处把 HTTP 错误翻成结构化 `reason`
   * 而不是抛异常——AI 需要能区分"我不是归属人"（该去请同事自己改）与"网络/服务故障"。
   */
  async setAudience(id: string, audience: AudienceInput): Promise<SetAudienceResult> {
    try {
      const { data } = await this.call<{ id: string; audience: AudienceState }>("PATCH", `/v1/memory/${id}/audience`, {
        audience,
        actor: (await this.selfMemberId()) ?? "ai-host",
      });
      return { ok: true, audience: data.audience };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 写入云端组织记忆（**全量元数据透传**）。
   *
   * 签收名单（工作台 v3「群发签收」）服务端**强制要求**——旧的"无目标人 → 谁看到谁确认"
   * 已取消（那种语义下一条只需一人确认，其余人无从追认）。名单有两条来路：
   * ① `notify`（通知同事）：名字 / uuid 经 `resolveRecipients` 落成 id；
   * ② 未点名的 `needsAck`：AI 建议的天然签收人就是**发起这次写入的你本人**，自动带自己 memberId。
   * 拿不到身份（未绑定 / 云端不可达）时明确报错，而不是发一个服务端必拒的请求。
   *
   * ⚠️ `notify` **隐含 needsAck**：指定了收件人却不开 needsAck，服务端不会建签收目标，
   * 对方在收件箱里**什么都看不到**——那是最糟的静默丢失。宁可替调用方补上并如实回传。
   */
  /**
   * 上传本机文件为**云端载荷**：两段式 —— 先 prepare（要不要传），命中就零字节往返，
   * 否则 PUT 字节。服务端会**复核 sha256**（绝不信任这里报的哈希），所以本地算哈希不是"信任"，
   * 而是"先算出来才好问要不要传"。
   *
   * 描述走 `X-Xbb-Description` 请求头（percent-encoded UTF-8）：HTTP 头是 latin-1，
   * 中文必须编码 —— 这一点没得绕，见服务端 payload-routes 的注释。
   */
  async uploadPayload(input: { ref: string; mime?: string; description?: string; tags?: string[] }): Promise<AdmittedAttachment> {
    const { sha256, bytes } = await hashFile(input.ref);

    const prep = await this.call<{ needUpload: boolean; payloadId: string | null; sha256: string; bytes: number }>(
      "POST",
      "/v1/payloads/prepare",
      { sha256, bytes },
    );
    if (!prep.data.needUpload && prep.data.payloadId) {
      // 内容寻址命中：本次**零新增**，只是挂了个引用（与本地 admitAttachments 的 reused 同语义）
      return { ref: input.ref, payloadId: prep.data.payloadId, sha256, bytes, mime: input.mime ?? null, reused: true };
    }

    const buf = await readFile(input.ref);
    const res = await fetch(`${this.cfg.apiBase}/v1/payloads/${sha256}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${this.cfg.key}`,
        "content-type": "application/octet-stream",
        ...(input.mime ? { "x-xbb-mime": input.mime } : {}),
        ...(input.description ? { "x-xbb-description": encodeURIComponent(input.description) } : {}),
        // ⚠️ tags 的编码约定与 description 不同：description 是**整串** percent-encoded，
        //    tags 是**逗号分隔的列表、每个元素各自编码**（逗号是分隔符，不能编码 ——
        //    否则服务端 split 不出，整串会变成一个乱码标签，2026-10-16 实测踩过）。
        ...(input.tags?.length ? { "x-xbb-tags": input.tags.map(encodeURIComponent).join(",") } : {}),
      },
      body: buf,
    });
    const json = (await res.json().catch(() => null)) as
      | { ok: true; data: { payloadId: string; sha256: string; bytes: number; reused: boolean } }
      | { ok: false; error: { code: string; message: string } }
      | null;
    if (!json) throw new Error(`上传响应不可读（HTTP ${res.status}）`);
    if (!json.ok) throw new Error(`上传失败 ${json.error.code}: ${json.error.message}`);
    return {
      ref: input.ref, payloadId: json.data.payloadId, sha256: json.data.sha256,
      bytes: json.data.bytes, mime: input.mime ?? null, reused: json.data.reused,
    };
  }

  async deliver(item: DeliverInput): Promise<DeliverResult> {
    const spaceId = await this.resolveSpaceId();
    let needsAck = item.needsAck === true;
    let ackMemberIds: string[] | undefined;
    let notify: DeliverNotify | undefined;
    if (item.notify?.length) {
      const recipients = resolveRecipients(item.notify, (await this.listMembers()).members);
      if (!recipients.length) throw new Error("notify 里没有任何有效的收件人名字或 id");
      needsAck = true;
      ackMemberIds = recipients.map((r) => r.id);
      notify = this.buildNotify(recipients);
    } else if (needsAck) {
      const me = await this.selfMemberId();
      if (!me) {
        throw new Error(
          "待确认记忆必须点名签收人，但未能取到你的成员身份——请先执行 `xbb cloud bind`，或检查云端连通性后重试",
        );
      }
      ackMemberIds = [me];
    }
    const { data: rec } = await this.call<DeliverResult>("POST", "/v1/deliver", {
      spaceId,
      actor: "ai-host",
      content: item.content,
      tags: item.tags ?? [],
      // —— 结构层：与本地 writeMemory 同字段透传 ——
      type: item.type,
      terms: item.terms ?? [],
      entities: item.entities ?? [],
      occurredAt: item.occurredAt,
      occurredPrecision: item.occurredPrecision,
      sessionId: item.sessionId,
      sourceRef: item.sourceRef,
      kind: item.kind,
      dscope: item.dscope,
      domain: item.domain,
      links: item.links ?? [],
      supersedeIds: item.supersedeIds ?? [],
      needsAck,
      // 可见范围（2026-10-06）：用户意图，可来自 AI。**不填 = 不传**——
      // 服务端把缺省解释为「仅归属人」，与本地默认态一致（保守默认，不宽于用户预期）。
      ...(item.audience ? { audience: item.audience } : {}),
      ...(ackMemberIds ? { ackMemberIds } : {}),
      // 文件载荷：先由 uploadPayload 逐个传上去拿到 payloadId，再随本条一起挂载。
      ...(item.payloadIds?.length ? { payloadIds: item.payloadIds } : {}),
    });
    return {
      id: rec.id,
      createdAt: rec.createdAt,
      deduped: rec.deduped,
      superseded: rec.superseded,
      supersedeRejected: rec.supersedeRejected,
      redacted: rec.redacted,
      supersedeCandidates: rec.supersedeCandidates,
      ...(rec.audience ? { audience: rec.audience } : {}),
      ...(notify ? { notify } : {}),
    };
  }

  /** 收件人回执（界外自由区）：**只给素材**——不代替宿主发消息，
   *  也不假设宿主有 IM 能力。链接推不出 console 域名时给 null（**绝不伪造点不开的地址**）。 */
  private buildNotify(recipients: { id: string; name: string }[]): DeliverNotify {
    const base = consoleBase(this.cfg.apiBase);
    const confirmUrl = base ? `${base}/me-inbox` : null;
    const who = recipients.map((r) => r.name).join("、");
    return {
      recipients,
      confirmUrl,
      hint:
        `已投递给 ${who}，等对方签收。` +
        (confirmUrl
          ? `若你有发消息的能力（例如宿主挂了钉钉/企微 MCP），可顺手把链接转给对方：「我在小本本上给你留了条待确认，点开看看：${confirmUrl}」。`
          : "") +
        "没有发消息的手也不必勉强——对方下次用自己的 AI 时会自动看到这条待确认，也能在动作中心收件箱里签收。",
    };
  }

  /** 云端检索：**词群一并上传**——服务端四路（FTS ∥ 着陆垫倒排 ∥ 实体精确 ∥ 向量）
   *  由此才能全量工作；只传拼接串会让倒排/实体两路退化成从原文派生 token 的兜底质量。 */
  async recall(query: string, limit?: number, terms?: string[]): Promise<RecallResult> {
    const { data: hits, nearTerms, relatedTags, linkedPreview, tokensUsed } = await this.call<RecHit[]>(
      "POST",
      "/v1/recall",
      {
        text: query,
        limit,
        ...(terms && terms.length ? { terms } : {}),
      },
    );
    return { hits, nearTerms, relatedTags, linkedPreview, tokensUsed };
  }

  async inbox(limit?: number): Promise<unknown[]> {
    return this.call<unknown[]>("GET", `/v1/inbox?limit=${limit ?? 50}`).then((r) => r.data);
  }

  /** 出件箱（发起人视角）：走 key 面 `/v1/outbox`（与 `/v1/inbox` 对称）。 */
  async outbox(limit?: number, status?: "pending" | "done" | "all"): Promise<OutboxResult> {
    const q = new URLSearchParams({ limit: String(limit ?? 50) });
    if (status) q.set("status", status);
    const r = await this.call<unknown[]>("GET", `/v1/outbox?${q.toString()}`);
    return { scope: "cloud", items: r.data };
  }

  async ack(id: string): Promise<boolean> {
    return this.call<{ acked: boolean }>("POST", "/v1/ack", { id, actor: "user" }).then((r) => r.data.acked);
  }

  async forget(id: string): Promise<boolean> {
    return this.call<{ forgotten: boolean }>("POST", "/v1/forget", { id, actor: "user" }).then(
      (r) => r.data.forgotten,
    );
  }

  async stats(): Promise<Record<string, unknown>> {
    const { data: s } = await this.call<{
      role: string; memberName: string | null; orgName: string | null;
      orgActive: number; myWrites30d: number; pendingAck: number;
    }>("GET", "/v1/me/summary");
    return {
      memories: s.orgActive,
      pendingAck: s.pendingAck,
      myWrites30d: s.myWrites30d,
      orgName: s.orgName,
      role: s.role,
      scope: "cloud",
      note: "云端组织汇总（机制计数，查询原文永不采集）",
    };
  }

  /** 组织成员目录：`/v1/me/members`（只出 id / 名字 / 空间 / 标签，**无手机号**）
   *  ＋ `/v1/me/spaces` 把 spaceId 映射成空间名（同名同事**必须靠空间名才能区分**，
   *  只给一串 uuid 等于没给）。
   *  **刻意不缓存**：这个入口调用频率极低（只在要通知人时才调），而"刚入职的同事查不到"
   *  是真实失败模式——多一次往返换正确性，值得。 */
  async listMembers(): Promise<MemberListResult> {
    const dir = await this.call<{ id: string; displayName: string; spaceId: string | null; tags: string[] | null }[]>(
      "GET",
      "/v1/me/members",
    );
    let spaces: { id: string; name: string }[] = [];
    try {
      spaces = (await this.call<{ id: string; name: string }[]>("GET", "/v1/me/spaces")).data ?? [];
    } catch {
      /* 空间名只是锦上添花（同区分名用）；拿不到就回落 spaceId，不影响寻址 */
    }
    const spaceName = new Map(spaces.map((s) => [s.id, s.name]));
    return {
      scope: "cloud",
      members: (dir.data ?? []).map((m) => ({
        id: m.id,
        name: m.displayName,
        space: m.spaceId ? (spaceName.get(m.spaceId) ?? m.spaceId) : null,
        tags: m.tags ?? [],
      })),
    };
  }

  /** 云端补链：POST /v1/supersede（服务端做链形铁律校验；真链头/分叉拒绝会以 400 消息回传） */
  async supersede(headId: string, supersededIds: string[]): Promise<SupersedeOutcome> {
    const { data } = await this.call<SupersedeOutcome>("POST", "/v1/supersede", {
      headId,
      supersededIds,
      actor: "ai-host",
    });
    return data;
  }

  // ── 工具面：云端服务端直供（/v1/topic 等）；出参与本地 memory-tools 同形 ──
  async recallTopic(entity: string, limit?: number) {
    const { data } = await this.call<Gen1Result>("POST", "/v1/topic", {
      entity,
      ...(limit !== undefined ? { limit } : {}),
    });
    return data;
  }
  async recallTimeline(from: string, to: string, entity?: string, limit?: number) {
    const { data } = await this.call<Gen1Result>("POST", "/v1/timeline", {
      from,
      to,
      ...(entity ? { entity } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return data;
  }
  async recallSession(sessionId: string, limit?: number) {
    const { data } = await this.call<Gen1Result>("POST", "/v1/session", {
      sessionId,
      ...(limit !== undefined ? { limit } : {}),
    });
    return data;
  }
  /** 单条全景。服务端 404（不存在/已遗忘）→ 返回 null，与本地 getMemory 的"查无此条"同义 */
  async getMemory(id: string): Promise<Gen1Result | null> {
    try {
      const { data } = await this.call<Gen1Result>("GET", `/v1/memory/${encodeURIComponent(id)}`);
      return data;
    } catch (e) {
      if (e instanceof Error && e.message.includes("E_NOT_FOUND")) return null;
      throw e;
    }
  }
  async getRelated(id: string, limit?: number) {
    const { data } = await this.call<Gen1Result>(
      "GET",
      `/v1/memory/${encodeURIComponent(id)}/related${limit !== undefined ? `?limit=${limit}` : ""}`,
    );
    return { ok: true, related: data };
  }
  async recallDirectives(sessionId?: string) {
    const { data } = await this.call<Gen1Result>("POST", "/v1/directives", {
      ...(sessionId ? { sessionId } : {}),
    });
    return data;
  }
  async recallConstraints(terms: string[], budget?: number) {
    const { data } = await this.call<Gen1Result>("POST", "/v1/constraints", {
      terms,
      ...(budget !== undefined ? { budget } : {}),
    });
    return data;
  }
}

// ---------- bind（协议唤起）：xubb://bind?ticket=…&api=… 换 key 落配置 ----------

export class BindError extends Error {}

export async function bindFromTicket(input: string, deviceName?: string): Promise<{ cfg: CloudConfig; configPath: string }> {
  let ticket: string | null = null;
  let api = DEFAULT_API;
  const trimmed = input.trim();
  if (/^xubb:\/\//i.test(trimmed)) {
    let u: URL;
    try {
      u = new URL(trimmed);
    } catch {
      throw new BindError("xubb 链接格式无效");
    }
    ticket = u.searchParams.get("ticket");
    api = u.searchParams.get("api") ?? DEFAULT_API;
  } else {
    ticket = trimmed; // 裸票（手动粘贴）
  }
  if (!ticket || !/^[0-9a-f]{32,128}$/.test(ticket)) {
    throw new BindError("绑定票无效（应为 32-128 位 hex，60 秒单用，过期请回管理台重新生成）");
  }
  const res = await fetch(`${api}/auth/device/bind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket, deviceName: deviceName ?? hostname() }),
  });
  const json = (await res.json().catch(() => null)) as
    | {
        ok: true;
        data: {
          plaintext: string;
          key: { keyPrefix: string; expiresAt?: string | null };
          orgId: string;
          orgName?: string; // 2026-10-04：组织可读名（老服务端可能不带）
          orgKind?: string; // personal | company
        };
      }
    | { ok: false; error: { code: string; message: string } }
    | null;
  if (!json?.ok) {
    const e = json && "error" in json ? json.error : { code: "E_HTTP", message: `HTTP ${res.status}` };
    throw new BindError(`绑定失败 ${e.code}: ${e.message}`);
  }
  const cfg: CloudConfig = {
    apiBase: api,
    key: json.data.plaintext,
    orgId: json.data.orgId,
    orgName: json.data.orgName ?? undefined,
    orgKind: json.data.orgKind ?? undefined,
    spaceId: null,
    deviceName: deviceName ?? hostname(),
    boundAt: new Date().toISOString(),
  };
  // bind 时顺手解析个人根空间并缓存（失败不阻断绑定：首次 deliver 再解析）
  try {
    const r = await fetch(`${api}/v1/me/spaces`, {
      headers: { authorization: `Bearer ${cfg.key}` },
    });
    const j = (await r.json()) as { ok: boolean; data?: { id: string; parentId: string | null }[] };
    const root = j.data?.find((s) => s.parentId === null) ?? j.data?.[0];
    if (root) cfg.spaceId = root.id;
  } catch {
    /* 留 null，运行时兜底 */
  }
  return { cfg, configPath: saveCloudConfig(cfg) };
}

/**
 * 手动填密钥绑定（2026-10-07「本地/云端一键切换」）。
 *
 * ## 与 `bindFromTicket` 的分野
 *
 * ticket 是**窄口**：60 秒单用、一次换出明文 key，必须回控制台现生成。
 * 而这里用户**已经持有**一把长期 key —— 来源通常是三种：
 *   ① bind 那一刻的明文（当时就该抄下来的唯一一份）；
 *   ② 另一台机器上已经绑好的那把（多机共用同一把 key 是常态）；
 *   ③ 误删 / 重装前的备份。
 * 它的价值正是**不必回控制台**：这正是"便捷切换"缺的最后一块。
 *
 * ## 信任路径
 *
 * **不校验 key 的格式，只看服务端认不认** —— 拿它换一次 `/v1/me/summary`：
 * 认证通过即证明有效，并顺带取回组织名 / kind 落盘（省掉首次使用时的补齐往返）。
 * 客户端不臆造 key 的形状规则（服务端将来换前缀就白改一次客户端）。
 *
 * ## ⚠️ orgId 允许为空
 *
 * 服务端 `/v1/me/summary` 目前**不出 orgId**，所以这里拿不到就存空串。
 * 这是刻意的降级而非将就：orgId 只参与展示与漂移指纹，**所有请求路径只认 Authorization**，
 * 缺它不影响任何一次读写。服务端哪天补上这个字段，这里自动用上（见 `typeof d.orgId`）。
 * 反面做法是把"有 orgId"写进 `loadCloudConfig` 的硬校验 —— 那会让手动填 key 直接不可用。
 */
export async function bindFromKey(
  keyInput: string,
  apiBase: string = DEFAULT_API,
): Promise<{ cfg: CloudConfig; configPath: string; orgLabel: string; memberName: string | null }> {
  const key = keyInput.trim();
  if (!key) throw new BindError("密钥不能为空");
  const api = (apiBase.trim() || DEFAULT_API).replace(/\/+$/, "");

  let res: Response;
  try {
    res = await fetch(`${api}/v1/me/summary`, { headers: { authorization: `Bearer ${key}` } });
  } catch (e) {
    // 网络问题必须与"密钥不对"分开报——否则用户会拿着好 key 反复重试
    throw new BindError(`连不上 ${api}（${e instanceof Error ? e.message : String(e)}）——请检查网络或 API 地址`);
  }

  const json = (await res.json().catch(() => null)) as
    | {
        ok: true;
        data: {
          orgId?: string | null;
          orgName?: string | null;
          orgKind?: string | null;
          memberName?: string | null;
          role?: string;
        };
      }
    | { ok: false; error: { code: string; message: string } }
    | null;

  if (res.status === 401 || (json && "error" in json && json.error.code === "E_AUTH")) {
    throw new BindError("密钥无效或已被撤销（服务端拒绝认证）");
  }
  if (!json?.ok) {
    const e = json && "error" in json ? json.error : null;
    throw new BindError(`校验失败 ${e?.code ?? `HTTP ${res.status}`}：${e?.message ?? "响应不可读"}`);
  }

  const d = json.data;
  const cfg: CloudConfig = {
    apiBase: api,
    key,
    orgId: typeof d.orgId === "string" ? d.orgId : "", // 服务端补字段后自动用上；不然留空
    orgName: d.orgName ?? undefined,
    orgKind: d.orgKind ?? undefined,
    spaceId: null,
    deviceName: hostname(),
    boundAt: new Date().toISOString(),
    enabled: true, // 手动绑定 = 明确要云端模式（覆盖此前可能的软关状态）
  };

  // 顺手解析个人根空间并缓存（失败不阻断绑定：与 bindFromTicket 同一纪律，首次 deliver 再解析）
  try {
    const r = await fetch(`${api}/v1/me/spaces`, { headers: { authorization: `Bearer ${key}` } });
    const j = (await r.json()) as { ok: boolean; data?: { id: string; parentId: string | null }[] };
    const root = j.data?.find((s) => s.parentId === null) ?? j.data?.[0];
    if (root) cfg.spaceId = root.id;
  } catch {
    /* 留 null，运行时兜底 */
  }

  return {
    cfg,
    configPath: saveCloudConfig(cfg),
    orgLabel: orgDisplayName(cfg.orgName, cfg.orgKind, cfg.orgId),
    memberName: d.memberName ?? null,
  };
}

// ---------- xubb:// 协议 handler 注册（三平台） ----------

export function registerProtocol(exeOverride?: string): { ok: boolean; message: string } {
  const exe = exeOverride ?? process.execPath;
  if (/bun(\.exe)?$/i.test(exe)) {
    return {
      ok: false,
      message: `当前是 bun 开发运行（${exe}），无法注册为协议处理器。请传编译后的 exe 路径：xbb register-protocol "C:\\path\\to\\xbb.exe"`,
    };
  }
  const os = platform();
  try {
    if (os === "win32") return { ok: true, message: registerWindows(exe) };
    if (os === "darwin") return { ok: true, message: registerMac(exe) };
    if (os === "linux") return { ok: true, message: registerLinux(exe) };
    return { ok: false, message: `不支持的平台: ${os}` };
  } catch (e) {
    return { ok: false, message: `注册失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function registerWindows(exe: string): string {
  // HKCU 无需管理员；URL Protocol 空值键是协议注册的标志位
  const run = (args: string[]) => {
    const r = Bun.spawnSync(["reg", ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`reg ${args[0]} 失败: ${new TextDecoder().decode(r.stderr)}`);
  };
  run(["add", "HKCU\\Software\\Classes\\xubb", "/ve", "/d", "URL:xubb Protocol", "/f"]);
  run(["add", "HKCU\\Software\\Classes\\xubb", "/v", "URL Protocol", "/d", "", "/f"]);
  run([
    "add", "HKCU\\Software\\Classes\\xubb\\shell\\open\\command",
    "/d", `"${exe}" bind "%1"`, "/f",
  ]);
  return `已注册 HKCU\\Software\\Classes\\xubb → "${exe}" bind "%1"（浏览器唤起立即生效，无需重启）`;
}

function registerMac(exe: string): string {
  // 生成最小 .app 包（LSUIElement 无 Dock 图标）+ lsregister 注册 CFBundleURLTypes
  const home = homedir();
  const app = join(home, "Applications", "XiaobenbenBind.app");
  const macos = join(app, "Contents", "MacOS");
  mkdirSync(macos, { recursive: true });
  const shim = join(macos, "xbb");
  writeFileSync(
    shim,
    `#!/bin/sh\nexec "${exe}" bind "$1"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>net.xiaobenben.bind</string>
  <key>CFBundleName</key><string>XiaobenbenBind</string>
  <key>CFBundleExecutable</key><string>xbb</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>net.xiaobenben.xubb</string>
    <key>CFBundleURLSchemes</key><array><string>xubb</string></array>
  </dict></array>
</dict></plist>
`,
  );
  const r = Bun.spawnSync(
    ["/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-f", app],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) throw new Error("lsregister 失败");
  return `已注册 xubb:// → ${app}（若首次唤起无反应，请再点一次「连接我的小本本」）`;
}

function registerLinux(exe: string): string {
  const dir = join(homedir(), ".local", "share", "applications");
  mkdirSync(dir, { recursive: true });
  const desktop = join(dir, "xubb.desktop");
  writeFileSync(
    desktop,
    `[Desktop Entry]\nType=Application\nName=xiaobenben bind\nExec=${exe} bind %u\nTerminal=false\nNoDisplay=true\nMimeType=x-scheme-handler/xubb;\n`,
  );
  const r = Bun.spawnSync(["xdg-mime", "default", "xubb.desktop", "x-scheme-handler/xubb"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error("xdg-mime 失败（GNOME/KDE 之外的桌面可能需手动关联）");
  return `已注册 xubb:// → ${desktop}`;
}
