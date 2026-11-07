// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 桌面通知编排（后半段：收到事件 → 决定弹什么 → 弹）。
 *
 * ## 为什么中间要夹一层"回拉 + 差分"
 *
 * 因为 SSE 通道**只发唤醒信号，不带 id 也不带内容**（见 `events.ts` 与 server `sse.ts` 的纪律）。
 * 于是"组织里发生了一件事"到"这件事跟我有关、该跟用户说什么"之间，必然要一次**按权限收窄的回拉**：
 *
 *   唤醒信号          → 回拉                → 差分                     → 气泡
 *   memory.deliver    → /v1/me/inbox        → 我还没提醒过的 →        「张三 发来一条待签收记忆」
 *   memory.ack        → /v1/me/outbox       → 某人从"未签"变"已签" →   「小红 已确认：…」
 *   memory.arrive     → 同上                → 某人从"未读"变"已读" →   「小红 已查看：…」
 *
 * 差分状态落盘（`XBB_HOME/notify-state.json`），因为 exe 会重启——不落盘就会"每次重启把
 * 所有历史重新弹一遍"。
 *
 * ## 四条纪律
 *
 *  1. **首次运行只播种、不弹。** 否则一个用了半年的组织，装上新 exe 的瞬间会炸出几十个气泡。
 *     存量信息本来就有 L1/L2（AI 会话 / 收件箱页）覆盖，不走桌面通知。
 *  2. **去抖。** 一次群发会连着产生 N 个事件；防抖 800ms 合并成一次回拉，避免 N 次请求与 N 组气泡。
 *  3. **有上限。** 单次最多弹 `MAX_PER_SYNC` 条——宁可少弹（收件箱/出件箱里都在），不要糊满屏幕。
 *  4. **绝不 throw。** 云端不可达、状态文件损坏，都只影响"这次没弹"。
 */
import { programDir } from "./home";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startEvents, type EventsHandle } from "./events";
import { showToast } from "./notify";

// ---------- 状态 ----------

export interface OutboxSeen {
  /** 已签收的目标 memberId */
  acked: string[];
  /** 已查看（arrive）的目标 memberId */
  arrived: string[];
}

export interface NotifyState {
  /** 首次回拉是否已完成（未完成 = 只播种不弹） */
  seeded: boolean;
  /** 收件箱里我**已经提醒过**的 memoryId（有界：每次同步后等于当前 pending 集合） */
  seenInbox: string[];
  /** 我投递出去的：memoryId → 已签/已读目标快照 */
  outbox: Record<string, OutboxSeen>;
  /** SSE 游标（org_seq）；下次启动据此续传，不必重放全部历史 */
  lastSeq: number;
}

export const emptyState = (): NotifyState => ({ seeded: false, seenInbox: [], outbox: {}, lastSeq: 0 });

export function statePath(): string {
  return join(programDir(), "notify-state.json");
}

/** 读状态。损坏/缺失一律回落到空状态——**绝不因为一个 json 坏了就停掉通知**。 */
export function loadState(p = statePath()): NotifyState {
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as Partial<NotifyState>;
    return {
      seeded: s.seeded === true,
      seenInbox: Array.isArray(s.seenInbox) ? s.seenInbox.filter((x) => typeof x === "string") : [],
      outbox: s.outbox && typeof s.outbox === "object" ? (s.outbox as Record<string, OutboxSeen>) : {},
      lastSeq: typeof s.lastSeq === "number" && Number.isFinite(s.lastSeq) ? s.lastSeq : 0,
    };
  } catch {
    return emptyState();
  }
}

export function saveState(s: NotifyState, p = statePath()): void {
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(s, null, 2));
  } catch {
    /* 写不进去只影响"下次重启会不会重弹"，不值得打断任何事 */
  }
}

// ---------- 差分（纯函数：唯一出口 → 可单测） ----------

export interface InboxItem {
  id: string;
  content: string;
  /** 投递人显示名（服务端 P3 归属标注）；缺失时回落 actor 字符串 */
  ownerName?: string | null;
  actor?: string;
}

export interface OutboxTarget {
  memberId: string;
  displayName: string;
  ackedAt: string | null;
  arrivedAt: string | null;
}

export interface OutboxItem {
  memoryId: string;
  content: string;
  targets: OutboxTarget[];
}

export interface NotifyItem {
  kind: "delivered" | "acked" | "arrived";
  title: string;
  body: string;
  /** 点击跳转地址（null = 不可点，如实降级） */
  url: string | null;
}

/** 单次同步最多弹几条（多出来的不弹——收件箱/出件箱里都还在） */
export const MAX_PER_SYNC = 5;

/** 正文截断：气泡只有两行，长正文既显示不下也没意义（要看细节点进去） */
export function truncate(s: string, n = 60): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * 纯函数：拿"上次快照 + 本次回拉结果"，产出**要弹的气泡**与**要落盘的新快照**。
 *
 * 两者必须由同一个函数产出——分成两处就会漂移成"弹了但没记"（下次重复弹）
 * 或"记了但没弹"（该提醒的永远不提醒）。
 */
export function planNotifications(
  prev: NotifyState,
  inbox: InboxItem[],
  outbox: OutboxItem[],
  consoleUrl: string | null,
  max = MAX_PER_SYNC,
): { items: NotifyItem[]; next: NotifyState } {
  const items: NotifyItem[] = [];
  const seenBefore = new Set(prev.seenInbox);
  const nextOutbox: Record<string, OutboxSeen> = {};

  for (const m of inbox) {
    if (!seenBefore.has(m.id)) {
      items.push({
        kind: "delivered",
        title: `${m.ownerName || m.actor || "同事"} 发来一条待签收记忆`,
        body: truncate(m.content),
        url: consoleUrl ? `${consoleUrl}/me-inbox` : null,
      });
    }
  }

  for (const o of outbox) {
    const before = prev.outbox[o.memoryId] ?? { acked: [], arrived: [] };
    const ackedNow = o.targets.filter((t) => t.ackedAt).map((t) => t.memberId);
    const arrivedNow = o.targets.filter((t) => t.arrivedAt).map((t) => t.memberId);
    const nameOf = (id: string) => o.targets.find((t) => t.memberId === id)?.displayName ?? id.slice(0, 8);
    const url = consoleUrl ? `${consoleUrl}/me-space` : null;
    for (const id of arrivedNow) {
      if (before.arrived.includes(id)) continue;
      // 同一轮里"看过并直接签了"只弹签收那条——两句话说的是同一件事，弹两条是噪音
      if (!before.acked.includes(id) && ackedNow.includes(id)) continue;
      items.push({ kind: "arrived", title: `${nameOf(id)} 已查看`, body: truncate(o.content), url });
    }
    for (const id of ackedNow) {
      if (before.acked.includes(id)) continue;
      items.push({ kind: "acked", title: `${nameOf(id)} 已确认`, body: truncate(o.content), url });
    }
    nextOutbox[o.memoryId] = { acked: ackedNow, arrived: arrivedNow };
  }

  const next: NotifyState = {
    seeded: true,
    // 有界：等于当前 pending 集合。已签收的条目本就离开了 pending，留着只会让文件无限长。
    seenInbox: inbox.map((m) => m.id),
    outbox: nextOutbox,
    lastSeq: prev.lastSeq,
  };
  // 首次运行：快照记好，但**一条都不弹**（纪律①）
  return { items: prev.seeded ? items.slice(0, max) : [], next };
}

// ---------- 守候循环 ----------

export interface NotifyWatchOptions {
  apiBase: string;
  key: string;
  consoleBase: string | null;
  /** 便于单测/自检替换投递方式；默认走系统气泡 */
  toast?: (i: NotifyItem) => void;
  /** 便于单测断言；默认 console.log */
  log?: (msg: string) => void;
}

export interface NotifyWatchHandle {
  stop(): void;
  /** 立即同步一次（自检/排障用） */
  syncNow(): Promise<void>;
}

const DEBOUNCE_MS = 800;

/** 通知总开关（`XBB_DESKTOP_NOTIFY=off` 关闭）。headless 由调用方另行跳过。 */
export function desktopNotifyEnabled(): boolean {
  const v = (process.env.XBB_DESKTOP_NOTIFY ?? "").trim().toLowerCase();
  return v !== "off" && v !== "0" && v !== "false";
}

export function startNotifyWatch(o: NotifyWatchOptions): NotifyWatchHandle {
  const log = o.log ?? ((m: string) => console.log(m));
  const toast = o.toast ?? ((i: NotifyItem) => {
    const ok = showToast({ title: i.title, body: i.body, url: i.url });
    if (!ok) log(`[xbb] 桌面通知不可用，已跳过：${i.title}`);
  });

  let state = loadState();
  let stopped = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let inflight = false;

  const get = async <T>(path: string): Promise<T | null> => {
    try {
      const res = await fetch(`${o.apiBase}${path}`, {
        headers: { authorization: `Bearer ${o.key}` },
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { ok?: boolean; data?: T };
      return j.ok ? (j.data ?? null) : null;
    } catch {
      return null; // 断网/超时：这一轮不弹，下次唤醒再来
    }
  };

  const sync = async (): Promise<void> => {
    if (stopped || inflight) return;
    inflight = true;
    try {
      const [inbox, outbox] = await Promise.all([
        get<InboxItem[]>("/v1/me/inbox?status=pending&limit=50"),
        get<OutboxItem[]>("/v1/me/outbox?limit=50"),
      ]);
      // 任何一边拉失败都不更新状态——半个快照比旧快照危险（会把"没拉到"记成"没有"，
      // 于是下次真的拉到时就永远不弹了）。
      if (!inbox || !outbox) return;
      const { items, next } = planNotifications(state, inbox, outbox, o.consoleBase);
      state = { ...next, lastSeq: lastSeq() };
      saveState(state);
      for (const i of items) toast(i);
    } finally {
      inflight = false;
    }
  };

  // SSE：游标从落盘状态续传（不带则服务端只推未来事件）
  // 用 `let` 持有是刻意的：sync/schedule/lastSeq 互相引用，先占位再赋值，
  // 避免"函数体里引用了还没声明的 const"这类只有运行时才炸的写法。
  let events: EventsHandle | null = null;
  const lastSeq = () => events?.lastSeq() ?? state.lastSeq;

  const schedule = () => {
    if (stopped || debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      void sync();
    }, DEBOUNCE_MS);
    debounce.unref?.();
  };

  events = startEvents({
    apiBase: o.apiBase,
    key: o.key,
    sinceSeq: state.lastSeq,
    // 收到任何组织事件都只是"叫醒"——拉什么、弹什么交给 sync 决定
    onEvent: () => schedule(),
    // 连接建立/重连：断线期间可能漏了事件，补一次全量（首次运行则只播种）
    onReady: () => schedule(),
  });

  // 兜底轮询：SSE 被中间设备彻底掐掉时（企业代理常见），至少不掉队太久。
  const pollMin = Number(process.env.XBB_NOTIFY_POLL_MIN ?? "5");
  const poll = setInterval(
    () => void sync(),
    (Number.isFinite(pollMin) && pollMin > 0 ? pollMin : 5) * 60_000,
  );
  poll.unref?.();

  return {
    stop() {
      stopped = true;
      if (debounce) clearTimeout(debounce);
      clearInterval(poll);
      events?.stop();
    },
    syncNow: sync,
  };
}
