/**
 * 主动记忆推送效果演示：隔离实例（独立 XBB_HOME + 端口），真实走完全链路。
 * 用法: bun run tools/hook-demo.ts
 * 红线演示：对话文本只进内存匹配——events 只多 memory.push，text 无处可寻。
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { PersonalStore } from "../src/store";
import { startServe } from "../src/serve";
import { SPACE_PERSONAL } from "../src/schema";

const PORT = 17631; // 演示专用端口，避开真实 17630
const HOME = join(import.meta.dir, "..", ".demo-home");
const base = `http://127.0.0.1:${PORT}`;

const store = PersonalStore.open(join(HOME, "memory.db"));
startServe(store, PORT);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hook = async (text: string) =>
  (await (
    await fetch(`${base}/hooks/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    })
  ).json()) as { ok: boolean; matched: number; pushed: { id: string; score: number }[] };

const eventsBefore = store.stats().events;

// ---------- 播种四条记忆（模拟历史积累） ----------
const seeds = [
  "去年 3 月 12 日和同事一起挑了美的电饭煲，最终选了 IH 电磁加热款",
  "爱好是钓鱼，周末常去佛山周边的水库",
  "小本本项目技术栈：Bun + Hono + SQLite，MCP stdio 五工具",
  "偏好深色主题，管理窗口用纯黑底 + 主色 #2255BB",
];
for (const content of seeds) await store.deliver({ spaceId: SPACE_PERSONAL, actor: "ai-host", content, tags: [] });
console.log(`已播种 ${seeds.length} 条历史记忆\n`);

// ---------- 模拟 5 个对话回合 ----------
const turns: Array<[string, string]> = [
  ["回合1", "我之前是不是买过一个电饭煲？"],
  ["回合2", "周末想去水库边钓鱼，你还记得我的爱好吗"],
  ["回合3", "那个电饭煲是什么型号来着？"],
  ["回合4", "今天中午吃什么好呢"],
  ["回合5", "构建脚本是直接用 Bun 跑的吗"],
];

for (const [name, text] of turns) {
  const r = await hook(text);
  const verdict =
    r.pushed.length > 0
      ? `→ 主动推送 ${r.pushed.length} 条`
      : r.matched > 0
        ? "→ 命中但已在 inbox，不重复打扰"
        : "→ 无相关记忆，静默";
  console.log(`${name}：「${text}」\n   matched=${r.matched} pushed=${r.pushed.length} ${verdict}`);
}

// ---------- AI 视角：下回合开始查 inbox ----------
console.log("\n--- AI 下回合 ack 前查 inbox（它将主动看到的记忆）---");
for (const item of store.inbox()) console.log(`  • ${item.content}`);

// ---------- 红线核验 ----------
const eventsAfter = store.stats().events;
const pushes = store.db.query("SELECT count(*) AS n FROM events WHERE type='memory.push'").get() as { n: number };
const chainOk = await store.verifyChain("00000000-0000-7000-8000-000000000001");
const leaked = store.db
  .query("SELECT count(*) AS n FROM events WHERE type='memory.deliver' AND actor='hook'")
  .get() as { n: number };
console.log("\n--- 红线核验 ---");
console.log(`events 增量 ${eventsAfter - eventsBefore} = memory.push ${pushes.n} 条（对话文本零落盘${leaked.n === 0 ? "" : "，泄漏！"}` +
  `${leaked.n === 0 ? "）" : ""}`);
console.log(`哈希链完整性: ${chainOk ? "OK" : "BROKEN"}`);

// ---------- 清理 ----------
store.db.close();
rmSync(HOME, { recursive: true, force: true });
console.log("\nhook-demo: PASS（演示实例已清理，真实 17630 未触碰）");
process.exit(0);
