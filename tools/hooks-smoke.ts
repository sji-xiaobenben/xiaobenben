/**
 * 钩子适配器冒烟（六宿主通用版 xbb-hook.mjs）：
 * 隔离 serve → 种子记忆 → stdin JSON 形态与 argv JSON 形态（Codex）真跑适配器
 * → 验证 inbox 收到推送。CI 三平台真跑，不 mock。
 */
import { spawn } from "node:child_process";
import { PersonalStore } from "../src/store";

const bun = process.execPath;
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const PORT = 17641; // 冒烟专用端口，避开真实 17630 与 serve-smoke 的 17639
const base = `http://127.0.0.1:${PORT}`;
const HOOK = `${root}plugins/hooks/xbb-hook.mjs`;

const child = spawn(bun, [`${root}src/index.ts`, "serve", "--headless"], {
  env: { ...process.env, XBB_HOME: `${root}.smoke-home`, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`, cond ? "" : detail ?? "");
  if (!cond) failures++;
};

function runHook(input: { mode: "stdin" | "argv"; payload: unknown }): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(bun, [HOOK, ...(input.mode === "argv" ? [JSON.stringify(input.payload)] : [])], {
      env: { ...process.env, XBB_HOOK_URL: `${base}/hooks/turn` },
      stdio: input.mode === "stdin" ? ["pipe", "ignore", "ignore"] : ["ignore", "ignore", "ignore"],
    });
    if (input.mode === "stdin") p.stdin!.end(JSON.stringify(input.payload));
    let out = "";
    p.stdout?.on("data", (d) => (out += d));
    p.on("close", (code) => resolve(code === 0 && out === "" ? 0 : -1)); // stdout 恒空是红线
  });
}

async function main() {
  const fail = (msg: string): never => {
    console.error(`✗ ${msg}\n--- serve log ---\n${log}`);
    child.kill();
    process.exit(1);
  };
  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try { if ((await fetch(`${base}/healthz`)).ok) { up = true; break; } } catch { /* not yet */ }
  }
  if (!up) fail("serve 未在 10s 内就绪");

  // 种子记忆（同库另开连接写）
  const RUN = Date.now().toString(36);
  const seedStore = PersonalStore.open(`${root}.smoke-home/memory.db`);
  const seed = await seedStore.deliver(
    { spaceId: "00000000-0000-7000-8000-000000000002", actor: "user", content: `用户的部署日是每周四 hooksmoke${RUN}xyz` },
  );
  const pendingBefore = seedStore.stats().pendingAck;

  // 1. stdin JSON 形态（Claude Code / Cursor / Trae / WorkBuddy）
  const c1 = await runHook({ mode: "stdin", payload: { session_id: "s1", hook_event_name: "UserPromptSubmit", prompt: `部署日是周几？hooksmoke${RUN}` } });
  check("stdin JSON：exit 0 且 stdout 恒空", c1 === 0);
  let inbox = seedStore.inbox().map((i) => i.id);
  check("stdin JSON：种子记忆被推送进 inbox", inbox.includes(seed.id), inbox);

  // 2. 去重：同回合重发不重复打扰
  await runHook({ mode: "stdin", payload: { prompt: `部署日是周几？hooksmoke${RUN}` } });
  check("去重：重复推送不产生第二条", seedStore.stats().pendingAck === pendingBefore + 1);

  // 3. argv JSON 形态（Codex notify：用户消息 + 助手输出）
  const seed2 = await seedStore.deliver(
    { spaceId: "00000000-0000-7000-8000-000000000002", actor: "user", content: `生产数据库端口是 15432 hooksmoke${RUN}db` },
  );
  const c2 = await runHook({ mode: "argv", payload: { type: "agent-turn-complete", "input-messages": [`生产库的端口是多少来着 hooksmoke${RUN}`], "last-assistant-message": "端口是 15432。" } });
  check("argv JSON（Codex）：exit 0 且 stdout 恒空", c2 === 0);
  inbox = seedStore.inbox().map((i) => i.id);
  check("argv JSON（Codex）：种子记忆被推送进 inbox", inbox.includes(seed2.id), inbox);

  // 4. 太短文本：适配器不发起请求（exit 0，零推送）
  const before = seedStore.stats().pendingAck;
  const c3 = await runHook({ mode: "stdin", payload: { prompt: "好的" } });
  check("过短文本：静默跳过", c3 === 0 && seedStore.stats().pendingAck === before);

  // 5. 服务未起：fail-open 静默退出 0
  const p5 = spawn(bun, [HOOK], { env: { ...process.env, XBB_HOOK_URL: "http://127.0.0.1:1/hooks/turn" }, stdio: ["pipe", "ignore", "ignore"] });
  p5.stdin.end(JSON.stringify({ prompt: "服务没起也要 fail-open smoke" }));
  const c5 = await new Promise<number>((res) => p5.on("close", (code) => res(code ?? -1)));
  check("fail-open：服务不可达仍 exit 0", c5 === 0);

  seedStore.db.close();
  child.kill();
  console.log(failures === 0 ? "hooks smoke: ALL PASS" : `hooks smoke FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
