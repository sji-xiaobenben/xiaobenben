/**
 * serve 协议级冒烟：headless 拉起 → healthz/stats/verify/ui 四断言 → 收杀。
 * 原理同 mcp-smoke：CI 三平台真跑，不 mock。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { PersonalStore } from "../src/store";
import { SPACE_PERSONAL } from "../src/schema";
import { appendEpisode, ingestDedupeKey } from "../src/episodes";

const bun = process.execPath;
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const PORT = 17639; // 冒烟专用端口，避开真实 17630
const base = `http://127.0.0.1:${PORT}`;

// 每轮冒烟必须从零残留开始（零残留 = 断言确定）。
// 不清库的话，上一轮那份几乎同文的种子会被 trigram 一并命中，matched 变 2，
// 「首推 1 条」的断言从第二次运行起必然误报。CI 因为 runner 每次全新所以从未暴露，
// 但本地连跑两次必挂——一套会误报的测试比没有测试更糟，会让人开始忽略它。
// 只清库文件，保留 models/（模型缓存，没必要每轮重下）。
// `.initialized` 必须一起清：那是用来区分「全新安装」与「库被删」的锚点，
// 留着它下一轮就会被判定成"库丢了"而拒绝启动 —— 测试环境要模拟的是全新机器。
for (const f of ["memory.db", "memory.db-shm", "memory.db-wal", ".initialized"]) {
  try {
    rmSync(`${root}.smoke-home/${f}`, { force: true });
  } catch {
    /* 不存在即目标状态 */
  }
}

const child = spawn(bun, [`${root}src/index.ts`, "serve", "--headless"], {
  env: { ...process.env, XBB_HOME: `${root}.smoke-home`, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 轮询等待端口就绪（最长 10s）
  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) { up = true; break; }
    } catch { /* not yet */ }
  }
  const fail = (msg: string): never => {
    console.error(`✗ ${msg}\n--- serve log ---\n${log}`);
    child.kill();
    process.exit(1);
  };
  if (!up) fail("serve 未在 10s 内就绪");

  const h = await (await fetch(`${base}/healthz`)).json();
  if (h.service !== "xbb-cli") fail(`healthz 异常: ${JSON.stringify(h)}`);
  console.log("✓ healthz");

  const s = await (await fetch(`${base}/stats`)).json();
  if (typeof s.memories !== "number" || typeof s.events !== "number" || !s.db) {
    fail(`stats 缺字段: ${JSON.stringify(s)}`);
  }
  if (s.db.includes(".xiaobenben") && !s.db.includes("smoke-home")) fail("XBB_HOME 隔离失效");
  console.log(`✓ stats（memories=${s.memories} events=${s.events} db=${s.db}）`);

  const v = await (await fetch(`${base}/verify`)).json();
  if (v.ok !== true) fail(`verify 应通过: ${JSON.stringify(v)}`);
  console.log("✓ verify 哈希链完整");

  const ui = await fetch(`${base}/ui`);
  const html = await ui.text();
  // 管理台（浅色暖调完整管理台，标题「小本本 · 记忆管理」）
  if (!ui.headers.get("content-type")?.includes("text/html") || !html.includes("小本本 · 记忆管理") || !html.includes("data-open")) {
    fail("管理页异常");
  }
  console.log("✓ /ui 管理窗口页（完整管理台）");

  // ---------- /hooks/turn 主动推送 ----------
  // 断言「首推 1 条、重复 0 条」靠的是**每轮全新库**（见文件顶部清库），而不是种子唯一性：
  // searchProactive 走 trigram，两次运行的种子共享了大段相同中文，仅靠 runId 后缀区分不开。
  const RUN = Date.now().toString(36);
  const SEED = `用户爱吃菠萝披萨记住了 hooksmoke${RUN}xyz`;
  const seedStore = PersonalStore.open(`${root}.smoke-home/memory.db`)  // 库名统一 memory.db（原名 personal.db 是改名前残留——种子与 serve 读库分裂致首推 0 命中）;
  await seedStore.deliver({ spaceId: SPACE_PERSONAL, actor: "seed", content: SEED, tags: [] });
  seedStore.db.close();

  const hook = async (payload: unknown) =>
    fetch(`${base}/hooks/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

  const hk1 = await (await hook({ text: SEED })).json();
  if (hk1.ok !== true || hk1.matched !== 1 || hk1.pushed.length !== 1) fail(`首推异常: ${JSON.stringify(hk1)}`);
  console.log(`✓ /hooks/turn 命中推送（id=${hk1.pushed[0].id.slice(0, 8)}…）`);

  const s2 = await (await fetch(`${base}/stats`)).json();
  if (s2.pendingAck < 1) fail(`推送后 pendingAck 应 >=1: ${JSON.stringify(s2)}`);

  const hk2 = await (await hook({ text: SEED })).json();
  if (hk2.ok !== true || hk2.matched !== 1 || hk2.pushed.length !== 0) fail(`重复推送应被去重: ${JSON.stringify(hk2)}`);
  console.log("✓ 重复推送去重（已在 inbox，不打扰）");

  const bad = await hook({ text: "ab" });
  if (bad.status !== 400) fail("非法 text 应 400");
  const nomatch = await (await hook({ text: "完全无关的词组xyz999" })).json();
  if (nomatch.ok !== true || nomatch.pushed.length !== 0) fail(`未命中应 pushed=0: ${JSON.stringify(nomatch)}`);
  console.log("✓ 参数校验 + 未命中零推送");

  const v2 = await (await fetch(`${base}/verify`)).json();
  if (v2.ok !== true) fail(`推送后哈希链应完整: ${JSON.stringify(v2)}`);
  console.log("✓ 推送事件入链，verify 仍通过");

  // ---------- 原话层（episodes）只读翻页（2026-10-24） ----------
  // 这里验的不是"能翻"，而是三条防炸的**形状**：列表不带全文、limit 有硬顶、全文按需单取。
  // 真库里有单条 4.7 万字的记录，任何一条失守都会让页面在一次请求里吐出几十 MB。
  const epStore = PersonalStore.open(`${root}.smoke-home/memory.db`);
  for (let i = 0; i < 5; i++) {
    appendEpisode(epStore.db, {
      sessionId: "smoke-ep-" + RUN,
      role: i % 2 ? "assistant" : "user",
      content: "原话冒烟第" + i + "句" + "甲乙丙丁".repeat(80), // 320 字，必然超过 240 字预览上限
      source: "smoke",
      externalId: "smoke-" + RUN + "-" + i,
      dedupeKey: ingestDedupeKey("smoke", "smoke-ep-" + RUN, "smoke-" + RUN + "-" + i),
      recordedAt: "2026-01-0" + (i + 1) + " 10:00:0" + i,
    });
  }
  epStore.db.close();

  const e1 = await (await fetch(`${base}/api/episodes?limit=2`)).json();
  if (e1.total !== 5 || e1.items.length !== 2) fail(`原话分页异常: total=${e1.total} len=${e1.items.length}`);
  if (e1.items.some((x: any) => "content" in x)) fail("原话列表不得返回全文");
  if (e1.items.some((x: any) => String(x.preview ?? "").length > 240)) fail("预览超 240 字上限");
  console.log(`✓ 原话列表分页 + 只给预览（${e1.total} 条）`);

  const e2 = await (await fetch(`${base}/api/episodes?limit=999`)).json();
  if (e2.limit !== 100 || e2.items.length > 100) fail("limit 未夹到 100");
  const e3 = await (await fetch(`${base}/api/episodes?limit=2&offset=4`)).json();
  if (e3.items.length !== 1) fail("offset 尾页异常");
  console.log("✓ limit 硬顶 100 + offset 尾页不越界");

  const one = await (await fetch(`${base}/api/episode?id=${e1.items[0].id}`)).json();
  if (typeof one.item?.content !== "string" || one.item.content.length < 300) fail("单条全文取不到");
  if ((await fetch(`${base}/api/episode?id=9999999`)).status !== 404) fail("不存在的原话应 404");
  if ((await fetch(`${base}/api/episode?id=abc`)).status !== 400) fail("非法 id 应 400");
  console.log("✓ 全文按需单取 + 404/400");

  const st = await (await fetch(`${base}/api/stats`)).json();
  if (st.episodes?.total !== 5 || st.episodes.sessions !== 1) fail(`stats.episodes 口径异常: ${JSON.stringify(st.episodes)}`);
  if (!(st.episodes.sources ?? []).some((x: any) => x.source === "smoke")) fail("stats.episodes.sources 缺 smoke");
  console.log("✓ stats 同时报记忆层与原话层（不再只有一个「共 N 条」）");

  // ---------- 云端模式开关（2026-10-07）：本地 ⇄ 云端一键切换 ----------
  // 三态是本功能的全部：未绑定 / 已绑定·软关（密钥保留）/ 已绑定·云端。
  // 断言重点不是"能切"，而是**软关不删密钥** —— 那是"便捷切换"成立的前提：
  // 若软关等于 unbind，用户切一次就得回控制台重新生成 60 秒单用的绑定票，"便捷"无从谈起。
  const cloudPath = `${root}.smoke-home/cloud.json`;
  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });

  let c = await (await fetch(`${base}/api/cloud`)).json();
  if (c.hasConfig !== false || c.enabled !== false) {
    fail(`未绑定时 /api/cloud 应 {hasConfig:false,enabled:false}: ${JSON.stringify(c)}`);
  }
  if ((await post("/api/cloud/disable")).status !== 400) fail("无配置时切本地应 400 —— 不能假装切换成功");
  console.log("✓ 未绑定态：如实回答，切换被明确拒绝");

  // 老配置（无 enabled 字段）必须被当成"开"——否则升级后所有人都被静默踢回本地
  writeFileSync(
    cloudPath,
    JSON.stringify(
      {
        apiBase: "https://api.example.invalid",
        key: "xbb_live_smoke_fixture_key",
        orgId: "",
        orgName: "冒烟组织",
        orgKind: "company",
        spaceId: null,
        deviceName: "smoke",
        boundAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  c = await (await fetch(`${base}/api/cloud`)).json();
  if (c.hasConfig !== true || c.enabled !== true || c.label !== "冒烟组织") {
    fail(`已绑定态异常: ${JSON.stringify(c)}`);
  }
  console.log("✓ 已绑定态（老配置无 enabled 字段 ⇒ 视为云端模式）");

  if ((await (await post("/api/cloud/disable")).json()).ok !== true) fail("软关应成功");
  c = await (await fetch(`${base}/api/cloud`)).json();
  if (c.hasConfig !== true || c.enabled !== false) {
    fail(`软关后应 hasConfig:true + enabled:false（两态不可塌成一态）: ${JSON.stringify(c)}`);
  }
  if (JSON.parse(readFileSync(cloudPath, "utf8")).key !== "xbb_live_smoke_fixture_key") {
    fail("软关不应删密钥 —— 这是与 unbind 的唯一分野");
  }
  console.log("✓ 软关：enabled=false，密钥原样保留");

  if ((await (await post("/api/cloud/enable")).json()).ok !== true) fail("切回云端应成功");
  console.log("✓ 一键切回云端（不必回控制台重新绑定）");

  // 填密钥失败必须"一个字节都不落盘"：否则用户拿着一把好 key 试错就把现有配置搞坏了
  const badKey = await (await post("/api/cloud/bind-key", { key: "xbb_live_bogus", apiBase: "http://127.0.0.1:9" })).json();
  if (!badKey.error || !/连不上|校验失败/.test(badKey.error)) fail(`填密钥失败应给可读原因: ${JSON.stringify(badKey)}`);
  const after = JSON.parse(readFileSync(cloudPath, "utf8"));
  if (after.key !== "xbb_live_smoke_fixture_key" || after.enabled !== true) fail("绑定失败不应改动现有配置");
  console.log(`✓ 填密钥失败：不改动本机配置（${String(badKey.error).slice(0, 20)}…）`);

  if ((await post("/api/cloud/bind-key", { key: "   " })).status !== 400) fail("空密钥应 400");
  console.log("✓ 空密钥被拒");

  const ub = await (await fetch(`${base}/api/cloud/unbind`, { method: "POST" })).json();
  if (ub.ok !== true || existsSync(cloudPath)) fail(`解绑应真删文件: ${JSON.stringify(ub)}`);
  if ((await (await fetch(`${base}/api/cloud`)).json()).hasConfig !== false) fail("解绑后应回到未绑定态");
  console.log("✓ 解绑：真删密钥文件，回到未绑定态");

  child.kill();
  console.log("serve smoke: 19/19 PASS");
  process.exit(0);
}

main();
