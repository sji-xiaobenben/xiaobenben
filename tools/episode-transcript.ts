// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 情景层「翻页追溯」真机冒烟（V7，2026-10-24）：走完整 MCP 协议，隔离 XBB_HOME，不碰真实个人库。
 *
 * 验收原话层的需求：
 *   ① 每一轮都落原话（user + assistant 双双入档），能回读，带 topic
 *   ② log_episodes 回带水位线（sessionTurns / lastLine）与 knownTopics（防话题标签漂移）—— 写了就回落
 *   ③ 按会话追溯：outline 给目录，turns 给正文，**时间正序**
 *   ④ 按话题追溯：跨会话聚合（同一 topic 分散在两个 session 里要能一起捞出来）
 *   ⑤ 按天追溯：只捞当天，不串到别的日子
 *   ⑥ 游标分页：limit 切三页读完，id 集合与全量**恰好相等**（不重不漏）
 *   ⑦ 反向翻：backward 从最新往最早
 *   ⑧ 双预算：maxChars 触顶即截断并标 truncated，但**绝不返回半条**（不留死循环）
 *   ⑨ 缺参数给 note 而不是崩
 *   ⑩ 没有任何原话时给空目录 + note
 *
 * 用法：bun run tools/episode-transcript.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const home = mkdtempSync(join(tmpdir(), "xbb-ep-transcript-"));

const proc = Bun.spawn(["bun", "run", "src/index.ts", "mcp"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, XBB_HOME: home, XBB_SEED: "0" },
});

const enc = new TextEncoder();
const send = (obj: unknown) => proc.stdin.write(enc.encode(JSON.stringify(obj) + "\n"));

const reader = proc.stdout.getReader() as ReadableStreamDefaultReader<Uint8Array>;
let buf = "";
const pending = new Map<number, (v: unknown) => void>();
let nextId = 1;

void (async () => {
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number };
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch {
        /* stderr 才是日志通道 */
      }
    }
  }
})();

function request(method: string, params?: unknown): Promise<never> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve as (v: unknown) => void);
    const timer = setTimeout(() => reject(new Error(`timeout waiting ${method}`)), 20000);
    timer.unref?.();
    send({ jsonrpc: "2.0", id, method, params });
  });
}

async function callTool(name: string, args: unknown) {
  const r = (await request("tools/call", { name, arguments: args })) as unknown as {
    result?: { content?: Array<{ type: string; text?: string; isError?: boolean }> };
  };
  const blocks = r?.result?.content ?? [];
  const textBlock = blocks.find((c) => c.type === "text");
  let data: Record<string, never> | null = null;
  try {
    data = textBlock?.text ? JSON.parse(textBlock.text) : null;
  } catch {
    data = null;
  }
  return { blocks, data: data as never as Record<string, unknown> & { hits?: unknown }, raw: textBlock?.text ?? "" };
}

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 600) : "");
  } else {
    console.log(`PASS ${name}`);
  }
}

type Turn = { id: number; role: string; content: string; at: string; topic: string | null };
type Page = {
  scope: string;
  mode: string;
  anchor: Record<string, string | null>;
  outline?: Array<{ key: string; sessionId: string; turns: number; from: string; to: string; chars: number; opening: string; topics: string[] }>;
  turns?: Turn[];
  page?: { count: number; chars: number; truncated: boolean };
  next?: { cursor: number; direction: string } | null;
  prev?: { cursor: number; direction: string } | null;
  hasMore: { older: boolean; newer: boolean };
  totalTurns: number;
  note?: string;
};

try {
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "episode-transcript", version: "0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = (await request("tools/list")) as unknown as { result?: { tools?: Array<{ name: string; description?: string }> } };
  const tools = (list?.result?.tools ?? []).map((t) => t.name);
  check("tools/list 含 recall_transcript", tools.includes("recall_transcript"), tools.length);
  check("tools/list 含 log_episodes", tools.includes("log_episodes"));
  const rt = (list?.result?.tools ?? []).find((t) => t.name === "recall_transcript");
  check("recall_transcript 描述里写明「必须翻页」语义", /PAGING IS MANDATORY/i.test(rt?.description ?? ""), (rt?.description ?? "").slice(0, 80));
  const le = (list?.result?.tools ?? []).find((t) => t.name === "log_episodes");
  check("log_episodes 描述里写明「每轮无条件调用」", /EVERY TURN, UNCONDITIONALLY/i.test(le?.description ?? ""), (le?.description ?? "").slice(0, 80));

  // ── ① 写两个会话的原话：sA 12 句（6 轮），sB 4 句（2 轮），同 topic '附件描述' ──
  const SA = "2026-10-24-xbb-demo-a";
  const SB = "2026-10-24-xbb-demo-b";
  const SC = "2026-10-24-xbb-demo-c";

  const turnsA: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (let i = 1; i <= 6; i++) {
    turnsA.push({
      role: "user",
      content: `第${i}轮用户提问：附件描述到底进不进索引这件事我们反复确认过好几遍，结论是 memories_fts 里只有 content 一列，描述文本根本没有被收进任何一个检索通道，这是A会话的第${i}句原话。`,
    });
    turnsA.push({
      role: "assistant",
      content: `第${i}轮回答：实测确实不进，payloads 表没有 embedding 列，terms 表里也没有描述词，所以描述写得再细也影响不到排序，这是A会话的第${i}句答复。`,
    });
  }
  const w1 = await callTool("log_episodes", { sessionId: SA, topic: "附件描述", items: turnsA });
  check("① sA 落库 12 句", ((w1.data as never as { ids?: number[] }).ids ?? []).length === 12, w1.data);
  check("① 回带 sessionTurns=12（水位线）", (w1.data as never as { sessionTurns?: number }).sessionTurns === 12, w1.data);
  check(
    "① 回带 lastLine 且是最后一条 assistant",
    /^\[assistant\] 第6轮回答/.test((w1.data as never as { lastLine?: string }).lastLine ?? ""),
    (w1.data as never as { lastLine?: string }).lastLine,
  );
  check(
    "① 首次写入后 knownTopics 含 '附件描述'（供下一轮复用，防标签漂移）",
    ((w1.data as never as { knownTopics?: string[] }).knownTopics ?? []).includes("附件描述"),
    (w1.data as never as { knownTopics?: string[] }).knownTopics,
  );

  const w2 = await callTool("log_episodes", {
    sessionId: SB,
    topic: "附件描述",
    items: [
      { role: "user", content: "B会话：同一个话题，换了个窗口继续聊。" },
      { role: "assistant", content: "B会话：好的，话题标签沿用附件描述。" },
      { role: "user", content: "B会话：那分页怎么翻？" },
      { role: "assistant", content: "B会话：用游标翻，一次一页。" },
    ],
  });
  check("① sB 落库 4 句（独立会话计数）", (w2.data as never as { sessionTurns?: number }).sessionTurns === 4, w2.data);

  await callTool("log_episodes", {
    sessionId: SC,
    topic: "埋点",
    items: [
      { role: "user", content: "C会话：复制埋点上线了吗？" },
      { role: "assistant", content: "C会话：上了，server e895ad9。" },
    ],
  });

  // ── ② 换会话后 topic 复用：knownTopics 应能同时看到两个标签 ──
  const w3 = await callTool("log_episodes", {
    sessionId: SA,
    topic: "附件描述",
    items: [{ role: "user", content: "A会话追加：再补一句，验证累计计数。" }],
  });
  const kt = (w3.data as never as { knownTopics?: string[] }).knownTopics ?? [];
  check("② knownTopics 同时含两个话题（可复用）", kt.includes("附件描述") && kt.includes("埋点"), kt);
  check("② sA 累计句数递增到 13", (w3.data as never as { sessionTurns?: number }).sessionTurns === 13, w3.data);

  // ── ③ 按会话：outline 先给目录 ──
  const o1 = (await callTool("recall_transcript", { scope: "session", sessionId: SA, mode: "outline" })).data as unknown as Page;
  check("③ session outline 有目录", (o1.outline ?? []).length === 1, o1.outline);
  check("③ outline 报 13 句", o1.outline?.[0]?.turns === 13, o1.outline?.[0]);
  check("③ outline 带首句原话（人/机认得出是哪段）", /第1轮用户提问/.test(o1.outline?.[0]?.opening ?? ""), o1.outline?.[0]?.opening);
  check("③ outline 带话题集合", (o1.outline?.[0]?.topics ?? []).includes("附件描述"), o1.outline?.[0]?.topics);
  check("③ outline 不返回正文（不灌上下文）", o1.turns === undefined, o1.turns);

  // ── ④ 按会话：turns 时间正序，limit 分三页读完，id 不重不漏 ──
  const allIds: number[] = [];
  let cursor: number | undefined;
  let pages = 0;
  let orderOk = true;
  let lastId = -1;
  for (;;) {
    const q: Record<string, unknown> = { scope: "session", sessionId: SA, mode: "turns", limit: 5 };
    if (cursor !== undefined) {
      q.cursor = cursor;
      q.direction = "forward";
    }
    const p = (await callTool("recall_transcript", q)).data as unknown as Page;
    pages++;
    for (const t of p.turns ?? []) {
      if (t.id <= lastId) orderOk = false;
      lastId = t.id;
      allIds.push(t.id);
    }
    if (!p.next) break;
    cursor = p.next.cursor;
    if (pages > 10) break;
  }
  check("④ limit=5 分三页读完 13 句", pages === 3, { pages, got: allIds.length });
  check("④ 三页合计 13 句，id 无重复", new Set(allIds).size === 13 && allIds.length === 13, { uniq: new Set(allIds).size, len: allIds.length });
  check("④ 全程时间正序（id 严格递增）", orderOk);

  const p1 = (await callTool("recall_transcript", { scope: "session", sessionId: SA, limit: 5 })).data as unknown as Page;
  check("④ 首页 hasMore.newer=true / older=false", p1.hasMore.newer === true && p1.hasMore.older === false, p1.hasMore);
  check("④ totalTurns 报全量 13（AI 知道还剩多少）", p1.totalTurns === 13, p1.totalTurns);
  check("④ 首页第一条是用户原话", p1.turns?.[0]?.role === "user" && /第1轮用户提问/.test(p1.turns?.[0]?.content ?? ""), p1.turns?.[0]);
  check("④ turns 带 topic", p1.turns?.[0]?.topic === "附件描述", p1.turns?.[0]?.topic);

  // ── ⑤ 反向翻：backward 从最新往最早 ──
  const b1 = (await callTool("recall_transcript", { scope: "session", sessionId: SA, direction: "backward", limit: 3 })).data as unknown as Page;
  check("⑤ backward 首页拿到的是最新 3 句", (b1.turns ?? []).length === 3 && /追加/.test(b1.turns?.[b1.turns.length - 1]?.content ?? ""), (b1.turns ?? []).map((t) => t.content.slice(0, 12)));
  check("⑤ backward 返回仍是时间正序（人读起来顺）", (b1.turns ?? []).every((t, i, arr) => i === 0 || arr[i - 1].id < t.id), (b1.turns ?? []).map((t) => t.id));
  check("⑤ backward 首页 hasMore.older=true（还有更早的）", b1.hasMore.older === true, b1.hasMore);

  // ── ⑥ 按话题：跨会话聚合 ──
  const o2 = (await callTool("recall_transcript", { scope: "topic", topic: "附件描述", mode: "outline" })).data as unknown as Page;
  check("⑥ topic outline 聚合到 2 个会话（sA + sB）", (o2.outline ?? []).length === 2, (o2.outline ?? []).map((x) => x.key));
  check("⑥ topic totalTurns=17（13 + 4）", o2.totalTurns === 17, o2.totalTurns);
  const t2 = (await callTool("recall_transcript", { scope: "topic", topic: "附件描述", limit: 50 })).data as unknown as Page;
  check("⑥ topic turns 拿到 17 句且跨两个会话", (t2.turns ?? []).length === 17, (t2.turns ?? []).length);
  check("⑥ topic turns 里含 B 会话原话（真的跨会话了）", (t2.turns ?? []).some((t) => /B会话/.test(t.content)), null);
  check("⑥ 另一个 topic '埋点' 只有 2 句（不串话题）", ((await callTool("recall_transcript", { scope: "topic", topic: "埋点" })).data as unknown as Page).totalTurns === 2);

  // ── ⑦ 按天：直接改库造「昨天」，验证不串日 ──
  const db = new Database(join(home, "memory.db"));
  const yesterday = "2026-10-20";
  db.run(`UPDATE episodes SET recorded_at = '${yesterday} 10:00:00' WHERE id IN (SELECT id FROM episodes WHERE session_id = '${SB}')`);
  db.close();
  const o3 = (await callTool("recall_transcript", { scope: "day", date: yesterday, mode: "outline" })).data as unknown as Page;
  check("⑦ 按天 outline 只捞到 sB 那段", (o3.outline ?? []).length === 1 && o3.outline?.[0]?.sessionId === SB, o3.outline?.map((x) => x.key));
  check("⑦ 按天 totalTurns=4（不含今天那 15 句）", o3.totalTurns === 4, o3.totalTurns);
  const dTurn = (await callTool("recall_transcript", { scope: "day", date: yesterday })).data as unknown as Page;
  check("⑦ 按天 turns 全部落在该日", (dTurn.turns ?? []).every((t) => t.at.startsWith(yesterday)), (dTurn.turns ?? []).map((t) => t.at));

  // ── ⑧ 双预算：maxChars 触顶截断，但不给半条 ──
  const tight = (await callTool("recall_transcript", { scope: "session", sessionId: SA, limit: 100, maxChars: 500 })).data as unknown as Page;
  check("⑧ maxChars=500 触发 truncated", tight.page?.truncated === true, tight.page);
  check("⑧ 截断后每条都是完整的（无半条）", (tight.turns ?? []).every((t) => /。$/.test(t.content)), (tight.turns ?? []).map((t) => t.content.slice(-6)));
  check("⑧ 截断后仍给 next（能继续翻，不死循环）", !!tight.next, tight.next);
  check("⑧ 截断后的 next.cursor 严格大于本页末条 id（前进而非重读）", (tight.next?.cursor ?? 0) >= (tight.turns?.[(tight.turns?.length ?? 1) - 1]?.id ?? 0), {
    next: tight.next,
    lastId: tight.turns?.[(tight.turns?.length ?? 1) - 1]?.id,
  });
  check("⑧ 截断给 note 说明原因", /字符预算/.test(tight.note ?? ""), tight.note);

  // ── ⑨ 缺参数：给 note 不崩 ──
  const noDate = (await callTool("recall_transcript", { scope: "day" })).data as unknown as Page;
  check("⑨ scope=day 缺 date → note 提示格式", /YYYY-MM-DD/.test(noDate.note ?? ""), noDate.note);
  const noSession = (await callTool("recall_transcript", { scope: "session" })).data as unknown as Page;
  check("⑨ scope=session 缺 sessionId → note", /sessionId/.test(noSession.note ?? ""), noSession.note);

  // ── ⑩ 空范围：空目录 + note ──
  const empty = (await callTool("recall_transcript", { scope: "topic", topic: "根本没这个话题", mode: "outline" })).data as unknown as Page;
  check("⑩ 无命中 → 空目录 + note", (empty.outline ?? []).length === 0 && !!empty.note && empty.totalTurns === 0, empty);

  // ── ⑪ 翻到尽头：两端都没内容时不给空游标 ──
  const tail = (await callTool("recall_transcript", { scope: "topic", topic: "埋点", limit: 50 })).data as unknown as Page;
  check("⑪ 一整页读完时 hasMore 两端皆 false", tail.hasMore.older === false && tail.hasMore.newer === false, tail.hasMore);
  check("⑪ 两端皆空时 next/prev 都是 null（不诱使 AI 多打空请求）", tail.next === null && tail.prev === null, { next: tail.next, prev: tail.prev });
} finally {
  try {
    proc.kill();
  } catch {
    /* 已退出 */
  }
  // Windows 上 sqlite 句柄要等进程真正退出才释放，否则 rm 抛 EBUSY；删不掉就交给临时目录自己清
  await Bun.sleep(300);
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* 句柄仍占用，忽略 */
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
