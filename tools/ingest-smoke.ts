// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 客户端会话采集（V8）真机冒烟：全部用**合成夹具**，不读真实客户端库、不碰个人库。
 *
 * 覆盖「应采尽采」的四条硬要求：
 *   ① 各源格式都能抽出正文（opencode 的 part/message、Cursor 的 composer/bubble、JSONL 的多种壳）
 *   ② **幂等**：同一批源跑两遍，第二遍新增必须是 0（去重键 + 唯一索引）
 *   ③ **游标**：只读新增；半行不消费（写到一半的行留到下次）；文件截断能自愈
 *   ④ dry-run 不写库、不推进游标
 *
 * 另覆盖三个已踩过的坑：Cursor 的空会话（value 为字面量 null）、同毫秒多行（时间戳游标会丢行）、
 * WorkBuddy 的 <system-reminder> 包裹（原样入库等于把同一份用户档案重复存几千遍）。
 *
 * 用法：bun run tools/ingest-smoke.ts
 */
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectClientSessions, cleanUserText, cleanTurn, ingestStatus, layerBalance, looksLikeFullReingest } from "../src/ingest";
import { recallTranscript } from "../src/episodes";
import { initSchemaV2 } from "../src/schema";

const root = mkdtempSync(join(tmpdir(), "xbb-ingest-smoke-"));
const home = join(root, "home");
const fx = join(root, "fixtures");
mkdirSync(home, { recursive: true });
mkdirSync(fx, { recursive: true });

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`);
  }
}

// ── 夹具 1：opencode（message + part，part 里有非正文类型、有同毫秒两行）──
const ocPath = join(fx, "opencode.db");
{
  const db = new Database(ocPath, { create: true });
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)`);
  db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)`);
  const insM = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)");
  const insP = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)");
  insM.run("msg_1", "ses_A", 1000, JSON.stringify({ role: "user" }));
  insP.run("prt_1", "msg_1", "ses_A", 1000, JSON.stringify({ type: "text", text: "opencode 的用户第一句" }));
  insP.run("prt_2", "msg_1", "ses_A", 1000, JSON.stringify({ type: "step-start" })); // 元信息，不该入库
  insM.run("msg_2", "ses_A", 1001, JSON.stringify({ role: "assistant" }));
  insP.run("prt_3", "msg_2", "ses_A", 1001, JSON.stringify({ type: "text", text: "opencode 的助手回复" }));
  insP.run("prt_4", "msg_2", "ses_A", 1001, JSON.stringify({ type: "reasoning", text: "内心独白不该入库" }));
  // 同毫秒的第二句（时间戳游标会在这里丢行）
  insM.run("msg_3", "ses_A", 1001, JSON.stringify({ role: "user" }));
  insP.run("prt_5", "msg_3", "ses_A", 1001, JSON.stringify({ type: "text", text: "同毫秒的第三句" }));
  // 宿主注入：整条就是后台任务通知，没有一个字是人说的 —— 必须丢弃，不能当"用户原话"存
  insM.run("msg_4", "ses_A", 1002, JSON.stringify({ role: "user" }));
  insP.run(
    "prt_6",
    "msg_4",
    "ses_A",
    1002,
    JSON.stringify({ type: "text", text: "<system-reminder>[BACKGROUND TASK COMPLETED] bg_1</system-reminder>" }),
  );
  // 人和系统注入混在一条里 —— 剥掉壳后剩下的人话要留
  insM.run("msg_5", "ses_A", 1003, JSON.stringify({ role: "user" }));
  insP.run(
    "prt_7",
    "msg_5",
    "ses_A",
    1003,
    JSON.stringify({ type: "text", text: "<system-reminder>[BACKGROUND TASK COMPLETED] bg_2</system-reminder>继续改采集器" }),
  );
  db.close();
}

// ── 夹具 2：Cursor（composerData + bubbleId，含一条空会话 null）──
const cuPath = join(fx, "cursor.vscdb");
{
  const db = new Database(cuPath, { create: true });
  db.exec(`CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)`);
  const ins = db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)");
  const composer = {
    composerId: "c1",
    name: "夹具会话",
    createdAt: 1_700_000_000_000,
    fullConversationHeadersOnly: [
      { bubbleId: "b1", type: 1 },
      { bubbleId: "b2", type: 2 },
    ],
  };
  ins.run("composerData:c1", JSON.stringify(composer));
  ins.run(
    "bubbleId:c1:b1",
    JSON.stringify({ type: 1, text: "Cursor 的用户提问", createdAt: "2026-10-20T10:00:00.000Z" }),
  );
  ins.run(
    "bubbleId:c1:b2",
    JSON.stringify({ type: 2, text: "Cursor 的助手回答", createdAt: "2026-10-20T10:00:05.000Z" }),
  );
  // 空会话在真库里就是字面量 null —— 曾经让整源采集直接抛错
  ins.run("composerData:c2", "null");
  db.close();
}

// ── 夹具 3：WorkBuddy（message 壳 + system-reminder 包裹）──
const wbDir = join(fx, "workbuddy");
mkdirSync(wbDir, { recursive: true });
const wbFile = join(wbDir, "sess-wb.jsonl");
{
  const lines = [
    { type: "session-meta", sessionId: "wb1", timestamp: 1 },
    {
      id: "w1",
      type: "message",
      role: "user",
      timestamp: 1_760_000_000_000,
      sessionId: "wb1",
      content: [
        {
          type: "input_text",
          text: '<system-reminder data-role="user-context"><user_info>OS 版本等一大堆</user_info></system-reminder>\n<user_query>真正要记的这句话</user_query>',
        },
      ],
    },
    {
      id: "w2",
      type: "message",
      role: "assistant",
      timestamp: 1_760_000_001_000,
      sessionId: "wb1",
      content: [{ type: "output_text", text: "WorkBuddy 的助手回复" }],
    },
    {
      // 整条都是系统注入，清洗后为空 —— 不该产生一条空记忆
      id: "w3",
      type: "message",
      role: "user",
      timestamp: 1_760_000_002_000,
      sessionId: "wb1",
      content: [{ type: "input_text", text: "<system-reminder>只有系统注入</system-reminder>" }],
    },
  ];
  writeFileSync(wbFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

// ── 夹具 4：Claude Code 两种壳（projects 带 message，transcripts 直接挂 content）──
const clDir = join(fx, "claude");
mkdirSync(join(clDir, "projects"), { recursive: true });
mkdirSync(join(clDir, "transcripts"), { recursive: true });
writeFileSync(
  join(clDir, "projects", "p1.jsonl"),
  [
    JSON.stringify({
      type: "user",
      uuid: "u-1",
      timestamp: "2026-10-21T08:00:00.000Z",
      sessionId: "cl-p1",
      message: { role: "user", content: [{ type: "text", text: "Claude 新格式的提问" }] },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "a-1",
      timestamp: "2026-10-21T08:00:03.000Z",
      sessionId: "cl-p1",
      message: { role: "assistant", content: [{ type: "text", text: "Claude 新格式的回答" }] },
    }),
    JSON.stringify({ type: "tool_use", timestamp: "2026-10-21T08:00:04.000Z", tool_name: "bash", tool_input: {} }),
  ].join("\n") + "\n",
);
writeFileSync(
  join(clDir, "transcripts", "t1.jsonl"),
  JSON.stringify({ type: "user", timestamp: "2026-10-21T09:00:00.000Z", content: "旧格式只有用户原话" }) + "\n",
);

// ── 夹具 5：Codex rollout（本机无此目录，按公开结构合成；专门用来验外部 id 稳定性）──
const cxDir = join(fx, "codex");
mkdirSync(cxDir, { recursive: true });
const cxFile = join(cxDir, "rollout-cx1.jsonl");
{
  const lines = [
    { timestamp: "2026-10-22T10:00:00.000Z", sessionId: "cx1", payload: { type: "user_message", message: "Codex 的提问" } },
    { timestamp: "2026-10-22T10:00:01.000Z", sessionId: "cx1", payload: { type: "agent_message", message: "Codex 的回答" } },
  ];
  writeFileSync(cxFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

// ── 夹具 6：一个「从没见过的客户端」（字段名 author/body/session_id/ts）──
// 没有任何专用 extract 认识它 —— 只能靠通用嗅探兜底。这正是 MinaMax / Qoder 那类
// 未来客户端的处境：不加一行代码也得能采。
const uqDir = join(fx, "unknown-client");
mkdirSync(uqDir, { recursive: true });
const uqFile = join(uqDir, "c1.jsonl");
{
  const lines = [
    { session_id: "uq1", ts: 1_760_100_000_000, author: "human", body: "没见过的客户端的第一句" },
    { session_id: "uq1", ts: 1_760_100_001_000, author: "ai", body: "没见过的客户端的第一答" },
  ];
  writeFileSync(uqFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

// ── 夹具 7：结构漂移（同一文件先写成 A 格式，覆盖成 B 格式；含一条解析不出的坏行）──
const driftDir = join(fx, "drift");
mkdirSync(driftDir, { recursive: true });
const driftFile = join(driftDir, "d1.jsonl");
{
  const lines = [
    { role: "user", content: "漂移前格式的用户话" },
    { role: "assistant", content: "漂移前格式的助手话" },
  ];
  writeFileSync(driftFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

// ── 夹具 8：分块读取（够多行，能在 maxTurns 处被截断，验证续读不重不漏）──
const chunkDir = join(fx, "chunk");
mkdirSync(chunkDir, { recursive: true });
const chunkFile = join(chunkDir, "many.jsonl");
const CHUNK_N = 120;
{
  const lines = Array.from({ length: CHUNK_N }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `分块测试第 ${i} 句`,
    sessionId: "sess-chunk",
  }));
  writeFileSync(chunkFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

// ── 夹具 9：单行超长（> READ_CHUNK_BYTES），尾部再挂一行没写完的半行 ──
const bigDir = join(fx, "bigline");
mkdirSync(bigDir, { recursive: true });
const bigFile = join(bigDir, "big.jsonl");
{
  const huge = { role: "user", content: "A".repeat(4_200_000), sessionId: "sess-big" };
  writeFileSync(bigFile, JSON.stringify(huge) + "\n" + '{"role":"user","content":"这行还没写完');
}

// ── 目标库 ──
const db = new Database(join(home, "memory.db"), { create: true });
initSchemaV2(db);

const paths = {
  opencode: ocPath,
  cursor: cuPath,
  workbuddy: wbDir,
  claude: clDir,
  codex: cxDir,
} as const;

console.log("① 四个源各抽各的格式");
{
  const r = collectClientSessions(db, { paths });
  const by = Object.fromEntries(r.results.map((x) => [x.source, x]));
  check("opencode 抽到 4 条正文（宿主注入的那条被丢弃）", by.opencode.inserted === 4, by.opencode);
  check("opencode 跳过 step-start / reasoning", by.opencode.scanned === 7, by.opencode.scanned);
  check("Cursor 抽到 2 条（空会话 null 不炸）", by.cursor.inserted === 2, by.cursor);
  check("WorkBuddy 抽到 2 条（系统注入那条被清空丢弃）", by.workbuddy.inserted === 2, by.workbuddy);
  check("Claude 抽到 3 条（新旧两种壳 + 跳过 tool_use）", by.claude.inserted === 3, by.claude);
  check("Codex 抽到 2 条（payload 壳）", by.codex.inserted === 2, by.codex);

  // 源目录不存在时必须如实报不可用，不能报成「新增 0」蒙混过去
  const gone = collectClientSessions(db, { paths: { ...paths, codex: join(fx, "no-such-codex") }, sources: ["codex"] });
  check("Codex 目录不存在时如实报不可用", gone.results[0].available === false, gone.results[0]);

  const wbUser = db
    .query("SELECT content FROM episodes WHERE source='workbuddy' AND role='user'")
    .get() as { content: string };
  check("WorkBuddy 用户原话剥掉了 system-reminder", wbUser.content === "真正要记的这句话", wbUser.content);

  const ocRows = db.query("SELECT session_id, role, recorded_at FROM episodes WHERE source='opencode' ORDER BY id").all() as Array<{
    session_id: string;
    role: string;
    recorded_at: string;
  }>;
  check("opencode 入库 4 条（同毫秒两句都在 + 混装那条只剩人话）", ocRows.length === 4, ocRows.length);
  check("用的是客户端原始时间，不是采集时刻", !ocRows[0].recorded_at.startsWith("2026-10"), ocRows[0]);

  const dup = db.query("SELECT count(*) t, count(DISTINCT dedupe_key) d, sum(dedupe_key IS NULL) n FROM episodes").get() as {
    t: number;
    d: number;
    n: number;
  };
  check("去重键全非空且唯一", dup.t === dup.d && dup.n === 0, dup);
}

console.log("② 幂等：再跑一遍必须 0 新增");
{
  const before = (db.query("SELECT count(*) c FROM episodes").get() as { c: number }).c;
  const r = collectClientSessions(db, { paths });
  const after = (db.query("SELECT count(*) c FROM episodes").get() as { c: number }).c;
  check("第二遍新增 0 条", r.inserted === 0, r.results);
  check("总数没变", before === after, { before, after });
}

console.log("③ 增量：追加一条只进一条");
{
  const extra = {
    id: "w4",
    type: "message",
    role: "assistant",
    timestamp: 1_760_000_009_000,
    sessionId: "wb1",
    content: [{ type: "output_text", text: "事后追加的一条回复" }],
  };
  writeFileSync(wbFile, JSON.stringify(extra) + "\n", { flag: "a" });
  const r = collectClientSessions(db, { paths, sources: ["workbuddy"] });
  check("只新增 1 条", r.inserted === 1, r.results);
}

console.log("④ 半行不消费：写到一半的行留到下次");
{
  const half = JSON.stringify({
    id: "w5",
    type: "message",
    role: "user",
    timestamp: 1_760_000_010_000,
    sessionId: "wb1",
    content: [{ type: "input_text", text: "这一行还没写完" }],
  });
  writeFileSync(wbFile, half.slice(0, 40), { flag: "a" }); // 故意不写换行、只写半截
  const r1 = collectClientSessions(db, { paths, sources: ["workbuddy"] });
  check("半行不被消费（新增 0）", r1.inserted === 0, r1.results);
  writeFileSync(wbFile, half.slice(40) + "\n", { flag: "a" }); // 补完剩余部分
  const r2 = collectClientSessions(db, { paths, sources: ["workbuddy"] });
  check("补完后正常入档 1 条", r2.inserted === 1, r2.results);
}

console.log("⑤ dry-run：只数不写，不推进游标");
{
  const extra = {
    id: "w6",
    type: "message",
    role: "user",
    timestamp: 1_760_000_011_000,
    sessionId: "wb1",
    content: [{ type: "input_text", text: "预演时不该落库的一句话" }],
  };
  writeFileSync(wbFile, JSON.stringify(extra) + "\n", { flag: "a" });
  const before = (db.query("SELECT count(*) c FROM episodes").get() as { c: number }).c;
  const dry = collectClientSessions(db, { paths, sources: ["workbuddy"], dryRun: true });
  const after = (db.query("SELECT count(*) c FROM episodes").get() as { c: number }).c;
  check("预演报出待采 1 条", dry.inserted === 1, dry.results);
  check("预演没写库", before === after, { before, after });
  const real = collectClientSessions(db, { paths, sources: ["workbuddy"] });
  check("预演之后正式跑仍能采到这条（游标没被预演推进）", real.inserted === 1, real.results);
}

console.log("⑥ 采集进来的原话能被翻页追溯读到");
{
  const p = recallTranscript(db, { scope: "session", sessionId: "c1", limit: 10 });
  check("Cursor 会话可按 session 翻页", p.totalTurns === 2, p.totalTurns);
  check("正文是客户端原文", (p.turns?.[0]?.content ?? "").includes("Cursor 的用户提问"), p.turns?.[0]);
  const outline = recallTranscript(db, { scope: "day", date: "2026-10-21", mode: "outline" });
  check("按天目录能聚合到 Claude 那场", (outline.outline ?? []).some((o) => o.sessionId === "cl-p1"), outline.outline);
  const fts = db.query("SELECT count(*) c FROM episode_chunks WHERE episode_chunks MATCH ?").get('"Cursor 的用户提问"') as { c: number };
  check("FTS 分块索引可检索", fts.c > 0, fts.c);
}

console.log("⑦ 状态汇总");
{
  const st = ingestStatus(db);
  const total = (db.query("SELECT count(*) c FROM episodes").get() as { c: number }).c;
  const four = ["opencode", "cursor", "workbuddy", "claude"];
  check(
    "四个可采源都有运行记录且都有条目",
    four.every((k) => st.some((s) => s.source === k && s.lastRun && s.episodes > 0)),
    st.map((s) => [s.source, s.episodes]),
  );
  check(`episodes 总数与分源之和一致（${total}）`, st.reduce((a, s) => a + s.episodes, 0) === total, st);
  check("清洗函数对空包裹返回空串", cleanUserText("<system-reminder>x</system-reminder>") === "");
}

console.log("⑦-b 宿主注入不能变成「用户说过的话」");
{
  const dirty = db.query("SELECT count(*) c FROM episodes WHERE content LIKE '%<system-reminder>%'").get() as { c: number };
  check("全库没有一条正文带 system-reminder 壳", dirty.c === 0, dirty.c);
  const mixed = db.query("SELECT content FROM episodes WHERE session_id='ses_A' AND content LIKE '%继续改采集器%'").get() as
    | { content: string }
    | null;
  check("人话与系统注入同在一条时，只留人话", mixed?.content === "继续改采集器", mixed);
  const bgOnly = db.query("SELECT count(*) c FROM episodes WHERE session_id='ses_A' AND content LIKE '%BACKGROUND%'").get() as {
    c: number;
  };
  check("纯系统通知整条不入档", bgOnly.c === 0, bgOnly.c);
  // 完整性红线：用户回复「对」「改」「要」这种单字必须留着，不能被当成空消息清掉
  check("单字回复不会被误清", cleanTurn({ role: "user", content: "对" })?.content === "对");
  check("assistant 的正文永不被剥", cleanTurn({ role: "assistant", content: "<system-reminder>x</system-reminder>" }) !== null);
}

console.log("⑧ 从没见过的客户端：零适配代码也要能采");
{
  const r = collectClientSessions(db, { paths: { ...paths, workbuddy: uqDir }, sources: ["workbuddy"] });
  check("author/body 这套字段名靠嗅探采到 2 条", r.inserted === 2, r.results);
  const rows = db
    .query("SELECT session_id, role, content, recorded_at FROM episodes WHERE session_id='uq1' ORDER BY id")
    .all() as Array<{ session_id: string; role: string; content: string; recorded_at: string }>;
  check("session 从 session_id 取出", rows.every((x) => x.session_id === "uq1"), rows.map((x) => x.session_id));
  check("角色 human→user / ai→assistant", rows.map((x) => x.role).join(",") === "user,assistant", rows.map((x) => x.role));
  check("正文原样入档", (rows[0]?.content ?? "").includes("没见过的客户端的第一句"), rows[0]);
  check("时间是客户端给的，不是采集时刻", !!rows[0]?.recorded_at, rows[0]);
}

console.log("⑨ Codex 增量：外部 id 必须按字节偏移，不能按「本次读到的第几行」");
{
  const extra = {
    timestamp: "2026-10-22T10:00:02.000Z",
    sessionId: "cx1",
    payload: { type: "user_message", message: "Codex 事后追加的一条" },
  };
  writeFileSync(cxFile, JSON.stringify(extra) + "\n", { flag: "a" });
  const r = collectClientSessions(db, { paths, sources: ["codex"] });
  // 用行号做 id 时，追加行的行号是 0，会和首行的 `<file>:0` 撞，被去重键静默吞掉 → 新增 0
  check("追加一行确实新增 1 条（不是被去重吞掉）", r.inserted === 1, r.results);
  const n = (db.query("SELECT count(*) c FROM episodes WHERE session_id='cx1'").get() as { c: number }).c;
  check("Codex 累计 3 条", n === 3, n);
}

console.log("⑩ 结构漂移：改字段名要既告警、又不丢数据");
{
  // 清掉该源的历史状态，模拟「这个客户端第一次被接入」
  db.exec("DELETE FROM ingest_sources WHERE source='claude'");
  db.exec("DELETE FROM ingest_files WHERE source='claude'");

  const r1 = collectClientSessions(db, { paths: { ...paths, claude: driftDir }, sources: ["claude"] });
  const fp1 = r1.results[0].fingerprint;
  check("首次采集产出结构指纹", fp1.length === 16, fp1);
  check("首次不算变更（没有旧指纹可比）", r1.results[0].fingerprintChanged === false, r1.results[0]);

  const r2 = collectClientSessions(db, { paths: { ...paths, claude: driftDir }, sources: ["claude"] });
  check("同格式重采：指纹不变、不告警", r2.results[0].fingerprint === fp1 && !r2.results[0].fingerprintChanged);

  // 上游改版：content → body（真实世界最常见的改动），并且刻意写成更长的文件
  // —— 只比 size 的游标会以为"只是追加"，头部指纹才能识破这是原地重写。
  writeFileSync(
    driftFile,
    [
      { role: "user", body: "漂移后格式的用户话" },
      { role: "assistant", body: "漂移后格式的助手话" },
      { role: "user", content: 12345 }, // 疑似消息但正文不是文本 —— 该计为解析不出
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
  const r3 = collectClientSessions(db, { paths: { ...paths, claude: driftDir }, sources: ["claude"] });
  const a = r3.results[0];
  check("字段名改了 → 指纹变化被标记", a.fingerprintChanged === true, a);
  check("改版后仍能采到（嗅探兜底，不是全废）", a.inserted === 2, a);
  check("原地重写被识破（头部指纹，不是只看 size）", a.scanned === 3, a);
  check("解析不出的行被计入 unparsed", a.unparsed === 1, { unparsed: a.unparsed, suspects: a.suspects });

  const st = ingestStatus(db).find((s) => s.source === "claude");
  check("状态里能算出解析率", st?.parseRate !== null && st?.parseRate !== undefined, st);
  check("落库的未解析行数可查", st?.unparsed === 1 && st?.totalLines === 3, st);
}

console.log("⑪ dry-run 不污染结构指纹");
{
  const before = ingestStatus(db).find((s) => s.source === "opencode")?.fingerprint;
  collectClientSessions(db, { paths, sources: ["opencode"], dryRun: true });
  const after = ingestStatus(db).find((s) => s.source === "opencode")?.fingerprint;
  check("预演不改写已存指纹", before === after, { before, after });
}

console.log("⑫ 全量重入哨兵：id 算法变了必须喊出来");
{
  // 真实事故的形状：Claude 存量 1,847 条，改 id 算法后重扫，1,847 条全部"新增"
  check("存量 1847、新增 1847 → 判定为全量重入", looksLikeFullReingest(1847, 1847) === true);
  check("存量 6349、新增 3 → 正常增量不告警", looksLikeFullReingest(3, 6349) === false);
  check("首次采集（无存量）不告警", looksLikeFullReingest(20000, 0) === false);
  check("存量太小（<200）不告警，避免误吵", looksLikeFullReingest(50, 60) === false);
  check("刚过半也告警", looksLikeFullReingest(301, 600) === true);
}

console.log("⑬ 分层配比：发现 AI 把对话复述成摘要");
{
  // 干净库：只有原话、没有摘要 —— 还没开始写，比值无意义/或极高
  const epCount = (db.query("SELECT count(*) c FROM episodes").get() as any).c;
  db.exec("DELETE FROM memories");
  const idle = layerBalance(db);
  if (epCount === 0) {
    check("原话层为空时比值报 null（不假装健康）", idle.perMemory === null && idle.level === "idle", idle);
  } else {
    check("摘要为 0 时不除零、判健康", idle.memories === 0 && idle.level === "healthy", idle);
  }

  // 正常形态：1 条结论 + 大量原话（这里用 1000 条原话模拟）
  const insEp = db.prepare("INSERT INTO episodes (session_id, role, content, recorded_at, source) VALUES (?,?,?,?,?)");
  const need = Math.max(0, 1000 - epCount);
  for (let i = 0; i < need; i++) insEp.run(`ratio-s-${i}`, "user", `填充原话 ${i}`, "2026-01-01 00:00:00", "workbuddy");
  const insMem = db.prepare(
    "INSERT INTO memories (org_id, space_id, actor, content, content_hash, created_at, updated_at, occurred_at, status) VALUES ('o','s','u',?,?,datetime('now'),datetime('now'),datetime('now'),'active')",
  );
  insMem.run("定案：采集层零客户端逻辑，加工全在服务端", "h-ratio-1");
  const healthy = layerBalance(db);
  check("1 条摘要 + 1000 条原话 → 健康（≥1:50）", healthy.level === "healthy", healthy);

  // 灌水形态：摘要跟着对话涨 —— 200 条摘要对 1000 条原话
  for (let i = 0; i < 199; i++) insMem.run(`流水账第 ${i} 条：用户问了X，我答了Y`, `h-ratio-w-${i}`);
  const watery = layerBalance(db);
  check("200 条摘要 + 1000 条原话 → 判为灌水（<1:20）", watery.level === "watery", watery);
  check("比值算得对（1000/200 = 5）", Math.round(watery.perMemory ?? 0) === 5, watery.perMemory);

  // 已删除/已遗忘的摘要不该计入分母对侧
  db.exec("UPDATE memories SET deleted_at = datetime('now'), status = 'forgotten'");
  const afterForget = layerBalance(db);
  check("已遗忘的摘要不计入", afterForget.memories === 0, afterForget);
}

console.log("⑭ 分块续读：被 maxTurns 截断后接着读，不重不漏");
{
  const p = { ...paths, workbuddy: chunkDir };
  let rounds = 0;
  let added = 0;
  let overLimit = false;
  for (;;) {
    const r = collectClientSessions(db, { paths: p, sources: ["workbuddy"], maxTurns: 7 });
    const n = r.results[0].inserted;
    if (n > 7) overLimit = true;
    added += n;
    rounds++;
    if (n === 0 || rounds > 40) break;
  }
  check("每轮都不超过 maxTurns", !overLimit);
  const rows = db
    .query("SELECT content FROM episodes WHERE source='workbuddy' AND session_id='sess-chunk'")
    .all() as Array<{ content: string }>;
  check(`分 ${rounds} 轮把 ${CHUNK_N} 句全读完`, rows.length === CHUNK_N, { rows: rows.length, rounds, added });
  check("行内一条不重（游标停在行边界，没有重叠）", new Set(rows.map((r) => r.content)).size === CHUNK_N, rows.length);
  check("分轮累计等于总数（没有重复插入）", added === CHUNK_N, added);
  const cur = db.query("SELECT offset FROM ingest_files WHERE source='workbuddy' AND path=?").get(chunkFile) as
    | { offset: number }
    | null;
  check("游标推进到文件末尾", !!cur && cur.offset === statSync(chunkFile).size, { cur, size: statSync(chunkFile).size });
}

console.log("⑮ 单行超过读取块大小：整行拿到才解析，尾部半行不吃");
{
  collectClientSessions(db, { paths: { ...paths, workbuddy: bigDir }, sources: ["workbuddy"] });
  const rows = db
    .query("SELECT length(content) L FROM episodes WHERE source='workbuddy' AND session_id='sess-big'")
    .all() as Array<{ L: number }>;
  check("超长单行被完整采到（没有因为分块而丢）", rows.length === 1, rows.length);
  check("正文按单条上限截断（约 100k，带截断标记）", !!rows[0] && rows[0].L >= 100_000 && rows[0].L < 100_200, rows[0]?.L);
  const cur = db.query("SELECT offset FROM ingest_files WHERE source='workbuddy' AND path=?").get(bigFile) as
    | { offset: number }
    | null;
  check("游标没吃掉尾部那半行", !!cur && cur.offset < statSync(bigFile).size, {
    offset: cur?.offset,
    size: statSync(bigFile).size,
  });
  // 半行补全后应当能正常采进来
  appendFileSync(bigFile, '","sessionId":"sess-big"}\n');
  collectClientSessions(db, { paths: { ...paths, workbuddy: bigDir }, sources: ["workbuddy"] });
  const after = db.query("SELECT count(*) c FROM episodes WHERE source='workbuddy' AND session_id='sess-big'").get() as {
    c: number;
  };
  check("半行补全后被补采（不永久丢）", after.c === 2, after.c);
}

console.log("⑯ opencode v2：part 内联进 session_message 后仍然采得到");
{
  // 真实世界的样子（2026-11-10 23:11 cutover 之后）：
  //   · part / message 冻结，不再写；session_part 建了但一行不写
  //   · 正文内联进 session_message：user/system 在 data.text，assistant 在 data.content[]
  //   · 迁移时把历史消息整体搬进新表，所以新表里既有老内容也有新内容
  //   · 消息是流式写的，time_created 之后几十秒正文还在长
  const T = Date.now();
  const oc2Path = join(fx, "opencode-v2.db");
  {
    const d = new Database(oc2Path, { create: true });
    d.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)`);
    d.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)`);
    d.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, time_created INTEGER)`);
    d.exec(
      `CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
        time_created INTEGER, time_updated INTEGER, data TEXT)`,
    );
    d.exec(
      `CREATE TABLE session_part (message_id TEXT, session_id TEXT, ordinal INTEGER, type TEXT,
        time_created INTEGER, time_updated INTEGER, data TEXT)`, // 真空表：v2 就是不走这张
    );
    const insM = d.prepare("INSERT INTO message VALUES (?,?,?,?)");
    const insP = d.prepare("INSERT INTO part VALUES (?,?,?,?,?)");
    const insS = d.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)");
    d.prepare("INSERT INTO session_v2 VALUES (?,?)").run("ses_V", T - 900_000);

    // v1 时代的老话（正在 v1 表里）
    insM.run("msg_old", "ses_V", T - 900_000, JSON.stringify({ role: "user" }));
    insP.run("prt_old", "msg_old", "ses_V", T - 900_000, JSON.stringify({ type: "text", text: "v1 时代的老话" }));
    // 同一条被迁移进 v2 —— 起点锚在 v1 冻结点，不该再采一遍
    insS.run("msg_old", "ses_V", "user", 1, T - 900_000, T - 900_000, JSON.stringify({ text: "v1 时代的老话" }));

    // cutover 之后的新内容（5 分钟前，已过稳定水位）
    insS.run("msg_new1", "ses_V", "user", 2, T - 300_000, T - 300_000, JSON.stringify({ text: "v2 里的用户提问" }));
    insS.run(
      "msg_new2",
      "ses_V",
      "assistant",
      3,
      T - 299_000,
      T - 240_000,
      JSON.stringify({
        content: [
          { type: "reasoning", text: "内心独白不该入库" },
          { type: "text", text: "v2 里的助手回答·上半段" },
          { type: "tool", callID: "c1" },
          { type: "text", text: "v2 里的助手回答·下半段" },
        ],
      }),
    );
    // 只调了工具、一句话没说 —— 这是常态，不能计成解析失败
    insS.run("msg_tool", "ses_V", "assistant", 4, T - 200_000, T - 200_000, JSON.stringify({ content: [{ type: "tool", callID: "c2" }] }));
    // 宿主动静不算人话
    insS.run("msg_syn", "ses_V", "synthetic", 5, T - 190_000, T - 190_000, JSON.stringify({ text: "宿主注入" }));
    // 10 秒前刚开始写，正文还在长 —— 水位内不采
    insS.run("msg_live", "ses_V", "user", 6, T - 10_000, T - 10_000, JSON.stringify({ text: "还在写的那句" }));
    d.close();
  }

  // 换库要重置游标，否则会拿上一个夹具的进度来切
  db.exec("UPDATE ingest_sources SET cursor = NULL WHERE source = 'opencode'");
  db.exec("DELETE FROM episodes WHERE source = 'opencode'");

  const p2 = { ...paths, opencode: oc2Path };
  const r1 = collectClientSessions(db, { paths: p2, sources: ["opencode"] });
  const bodies = (db.query("SELECT content FROM episodes WHERE source='opencode' ORDER BY id").all() as Array<{ content: string }>).map(
    (x) => x.content,
  );
  check("v1 时代的老话照采（part 表那条路没坏）", bodies.includes("v1 时代的老话"), bodies);
  check("v2 新内容采得到（换表不再断流）", bodies.includes("v2 里的用户提问"), bodies);
  check(
    "assistant 的多个 text 元素按序拼成一条正文",
    bodies.some((b) => b.includes("上半段") && b.includes("下半段") && b.indexOf("上半段") < b.indexOf("下半段")),
    bodies,
  );
  check("迁移进 v2 的老消息没有重采（起点锚在 v1 冻结点）", bodies.filter((b) => b === "v1 时代的老话").length === 1, bodies);
  check("只有工具调用的 assistant 不算解析失败", r1.results[0].unparsed === 0, r1.results[0]);
  check("解析率 100%（不制造假告警）", r1.results[0].suspects > 0 && r1.results[0].unparsed === 0, r1.results[0]);
  check("水位内那条不采，且在说明里报到", !bodies.includes("还在写的那句") && /水位内 1 条待定/.test(r1.results[0].note), r1.results[0].note);
  check("reasoning / synthetic 都没进库", !bodies.some((b) => b.includes("内心独白") || b.includes("宿主注入")), bodies);

  const r2 = collectClientSessions(db, { paths: p2, sources: ["opencode"] });
  check("第二遍新增 0 条（游标 + 去重键都正确）", r2.inserted === 0, r2.results);

  // 时间流逝后水位放开：刚才那条应当补上，而且不多不少
  {
    const d = new Database(oc2Path);
    d.prepare("UPDATE session_message SET time_created = ?, time_updated = ? WHERE id = 'msg_live'").run(T - 130_000, T - 130_000);
    d.close();
  }
  const r3 = collectClientSessions(db, { paths: p2, sources: ["opencode"] });
  const after3 = db.query("SELECT content FROM episodes WHERE source='opencode'").all() as Array<{ content: string }>;
  check("水位放开后补上那条", after3.some((x) => x.content === "还在写的那句") && r3.inserted === 1, {
    inserted: r3.inserted,
    note: r3.results[0].note,
  });
}

db.close();
try {
  rmSync(root, { recursive: true, force: true });
} catch {
  // Windows 下 SQLite 句柄释放有延迟，清理失败不影响结论
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
