/**
 * 组织事件长连接（前半段：`xbb.exe 常驻服务经 SSE 长连接收事件`）。
 *
 * 服务端侧早已实现（心跳 25s + `Last-Event-ID` 断点续传 + 跨实例扇出，所有事件都经它出去），
 * 这里补的是**消费端**——
 * 本轮补上。所以这里刻意不发明任何新协议：帧格式、`id:` 语义、心跳全是服务端已定义的。
 *
 * ## 通道里有什么、没有什么（服务端纪律，消费端必须照此假设）
 *
 * 帧只带 `{seq, type, actor, at}` —— **没有记忆 id、没有正文**。
 * 服务端注释写得很明确："通道只发唤醒信号，内容永不过通知通道；内容走 RLS 管线由客户端拉取"。
 * 所以本模块**只做唤醒**：收到事件 → 告诉调用方"组织里发生了一件事" →
 * 调用方自己去按权限拉（收件箱/出件箱）再决定弹不弹。**不要**试图从帧里读出"是哪条记忆"。
 *
 * 这也解释了为什么通道可以按组织扇出而不必按人过滤：它泄漏的上限是
 * "某人在某时刻做了某类动作"，拿不到对象身份，也就拿不到任何内容。
 *
 * ## 三条纪律
 *
 *  1. **绝不 throw、绝不阻断 serve。** 断网、服务端 5xx、代理掐连接，都只是"这段时间收不到
 *     实时通知"。退避重连，静默进行——通知是增强不是必需。
 *  2. **按 seq 去重。** 断点续传会**回放**缺失段，回放窗口与实时 NOTIFY 有重叠是设计内的
 *     （sse.ts：「先注册后回放：回放期间的并发写入由 NOTIFY 补上」）。单调 seq 是唯一的去重依据。
 *  3. **脏帧不炸链。** 单帧 JSON 坏了只丢那一帧；一帧解析失败不该让整条长连接重来。
 */
import { parseSseChunk } from "./events-parse";

export interface OrgEvent {
  seq: number;
  type: string;
  actor: string;
  at: string;
}

export interface EventsOptions {
  /** 形如 `https://api.xiaobenben.net`（不带尾斜杠） */
  apiBase: string;
  /** 组织 key（`xbb_live_…`）——与 CloudBackend 同一条鉴权通道 */
  key: string;
  /** 收到**去重后**的新事件。**不要在这里做重活**（拉网络、弹气泡）——调用方自己防抖。 */
  onEvent: (e: OrgEvent) => void;
  /** 连接建立（收到 ready 帧）。用途：断线期间可能漏了事件，重连后补一次全量同步。 */
  onReady?: () => void;
  /** 起始游标（上次进程退出前记下的 seq）；0 = 不续传，只听未来的事件 */
  sinceSeq?: number;
}

export interface EventsHandle {
  /** 主动断开（进程退出 / 解绑云端时调用） */
  stop(): void;
  /** 当前游标——调用方可持久化它，下次启动接着续传 */
  lastSeq(): number;
}

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/**
 * 建立并维持一条到 `/v1/events` 的长连接。**同步返回句柄**（连接在后台自己重建），
 * 因为调用方（serve 启动流程）不该为了"能不能收到通知"而等待网络。
 */
export function startEvents(o: EventsOptions): EventsHandle {
  let stopped = false;
  let lastSeq = o.sinceSeq ?? 0;
  let retry = RETRY_MIN_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ctrl: AbortController | null = null;

  const loop = async (): Promise<void> => {
    if (stopped) return;
    ctrl = new AbortController();
    try {
      const headers: Record<string, string> = {
        accept: "text/event-stream",
        authorization: `Bearer ${o.key}`,
      };
      // 只在有游标时才带 -ID：不带 = 首次连接，服务端只推未来事件（不刷屏），
      // 这与 sse.ts「无头=首次连接，只推未来事件——默认态保守」一致。
      if (lastSeq > 0) headers["Last-Event-ID"] = String(lastSeq);

      const res = await fetch(`${o.apiBase}/v1/events`, { headers, signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
      retry = RETRY_MIN_MS; // 连上了就重置退避，避免"偶发断线"越攒越长

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const { frames, rest } = parseSseChunk(buf);
        buf = rest;
        for (const f of frames) {
          if (f.event === "ready") { o.onReady?.(); continue; }
          if (f.event === "ping") continue; // 心跳：只用来保活，不产生任何业务动作
          if (f.event !== "org_event") continue; // 未知事件类型：忽略（服务端将来加类型不炸旧客户端）
          let e: OrgEvent;
          try {
            e = JSON.parse(f.data) as OrgEvent;
          } catch {
            continue; // 脏帧只丢自己
          }
          if (typeof e?.seq !== "number") continue;
          if (e.seq <= lastSeq) continue; // 回放与实时重叠段：按 seq 去重
          lastSeq = e.seq;
          try {
            o.onEvent(e);
          } catch {
            /* 回调自己炸了不该拖垮连接（调用方 bug 与通道无关） */
          }
        }
      }
      throw new Error("SSE 流已结束"); // 走到这儿说明连接被对端/代理掐了：按断线处理
    } catch {
      /* 断线/网络错误：静默，下面退避重连 */
    } finally {
      ctrl = null;
    }
    if (stopped) return;
    timer = setTimeout(() => void loop(), retry);
    timer.unref?.();
    retry = Math.min(retry * 2, RETRY_MAX_MS);
  };

  void loop();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      ctrl?.abort();
    },
    lastSeq: () => lastSeq,
  };
}
