/**
 * SSE 消费冒烟（客户端前半段）。
 *
 * 打的是**自带的一个小 SSE 服务端**，不是真云端。理由：这一层的风险全在
 * **流式解析与重连状态机**，与远端是谁无关；而"故意把帧切两半""故意发脏帧"
 * "故意掐断流"这些场景，真服务端根本制造不出来。
 *
 * 断言矩阵：
 *   ① ready 帧被识别（调用方据此在重连后补一次全量同步）
 *   ② 注释心跳（服务端 25s keepalive）不产生业务事件
 *   ③ **半帧拼接**：帧被拆成两次 enqueue，仍解析出完整事件
 *   ④ **脏帧只丢自己**：前面一帧 JSON 坏掉，后面的帧照样送达
 *   ⑤ **断线自动重连**（服务端主动断流）
 *   ⑥ **续传游标**：重连时带 `Last-Event-ID` = 最后收到的 seq
 *   ⑦ **回放重叠按 seq 去重**（断点续传与实时 NOTIFY 重叠是设计内的）
 *   ⑧ stop() 之后不再重连
 *
 * 跑法：bun tools/events-smoke.ts
 */
import { startEvents, type OrgEvent } from "../src/events";

const PORT = 17642; // 冒烟专用端口
let connections = 0;
let lastEventIdSeen: string | null = null;

const enc = new TextEncoder();

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname !== "/v1/events") return new Response("nope", { status: 404 });
    connections += 1;
    const n = connections;
    lastEventIdSeen = req.headers.get("last-event-id");

    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const send = (s: string) => c.enqueue(enc.encode(s));
        const frame = (seq: number, type: string, data?: string) =>
          send(`event: org_event\nid: ${seq}\ndata: ${data ?? JSON.stringify({ seq, type, actor: "x", at: "2026-10-07T00:00:00Z" })}\n\n`);

        send(`event: ready\ndata: {"ok":true}\n\n`);

        if (n === 1) {
          // ② 注释心跳：绝不能变成业务事件
          send(`: keepalive\n\n`);
          // ③ 半帧：先发半截，稍后补完
          send(`event: org_event\nid: 1\ndata: {"seq":1,"type":"memory.deliver","actor":"a","at":"t"}`);
          setTimeout(() => {
            send(`\n\n`);
            frame(2, "memory.ack");
            // ④ 脏帧：坏 JSON 必须只丢自己，不能炸掉整条链
            frame(3, "memory.arrive", "{ this is not json }");
            frame(4, "memory.arrive");
            // ⑤ 主动断流 → 客户端必须自己重连
            c.close();
          }, 30);
        } else {
          // ⑥⑦ 第二连接：应带上游标 4；推一条新的 + 一条**已在游标之前**的回放（必须去重）
          frame(5, "memory.arrive");
          frame(3, "memory.ack");
        }
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  },
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`, cond ? "" : (detail ?? ""));
  if (!cond) failures++;
};

const seen: number[] = [];
const types = new Map<number, string>();
let ready = 0;

const handle = startEvents({
  apiBase: `http://127.0.0.1:${PORT}`,
  key: "dev_sse_smoke",
  onEvent: (e: OrgEvent) => {
    seen.push(e.seq);
    types.set(e.seq, e.type);
  },
  onReady: () => { ready += 1; },
});

// 等 seq=5 到达（含一次重连 + 1s 退避），上限 10s
for (let i = 0; i < 100 && !seen.includes(5); i++) await wait(100);

try {
  check("① ready 帧被识别（且重连后再次识别）", ready >= 2, `ready=${ready}`);
  check("② 注释心跳不产生业务事件", !seen.includes(0), seen);
  check("③ 半帧被正确拼接（seq=1 送达）", seen.includes(1), seen);
  check("④ 脏帧只丢自己（seq=3 未达，但 seq=4 照样送达）", !seen.includes(3) && seen.includes(4), seen);
  check("⑤ 断线自动重连（建立了第二条连接）", connections >= 2, `connections=${connections}`);
  check("⑥ 重连带上续传游标 Last-Event-ID=4", lastEventIdSeen === "4", lastEventIdSeen);
  check("⑦ 回放重叠按 seq 去重（seq=5 送达；回放的 seq=3 不再补）", seen.includes(5) && seen.filter((s) => s === 3).length === 0, seen);
  check("事件类型解析正确（seq=2 → memory.ack）", types.get(2) === "memory.ack", types.get(2));

  const connBefore = connections;
  handle.stop();
  await wait(1600); // 超过一次退避窗口
  check("⑧ stop() 之后不再重连", connections === connBefore, `${connBefore} → ${connections}`);

  console.log(`\n${failures === 0 ? "全部 8 项断言通过 ✅" : `${failures} 项失败 ❌`}`);
} finally {
  handle.stop();
  server.stop(true);
}

process.exit(failures === 0 ? 0 : 1);
