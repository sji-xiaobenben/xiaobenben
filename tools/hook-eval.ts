// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * searchProactive 评测：标注用例（应命中/应静默/已知边界）+ 360 条规模压力 + 计时。
 * 纯查询评测（不触发 push），隔离实例，跑完即清。
 * 用法: bun run tools/hook-eval.ts
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { PersonalStore } from "../src/store";
import { SPACE_PERSONAL } from "../src/schema";

const HOME = join(import.meta.dir, "..", ".eval-home");
const store = PersonalStore.open(join(HOME, "memory.db"));

// ---------- 记忆集（含通用词陷阱条目） ----------
const seeds = [
  "去年和同事一起挑了美的电饭煲，最终选了 IH 电磁加热款",
  "爱好是钓鱼，周末常去佛山周边的水库",
  "小本本技术栈：Bun + Hono + SQLite，MCP stdio 五工具",
  "偏好深色主题，管理窗口用纯黑底",
  "每周一上午十点开团队例会",
  "女儿叫朵朵，今年五岁，喜欢画画",
  "手机尾号 8848",
  "项目 deadline 是 10 月 30 日",
  "老家在湖南长沙，爸妈都在那边",
  "上次体检尿酸偏高，医生说少吃海鲜少喝啤酒",
  "电动车牌粤A DD120，公司楼下 B2 层",
  "今天天气不错，适合出门走走",
];

// 随机噪声记忆（规模压力用）：词表随机拼句，不含用例关键词
const vocab = ["会议纪要", "季度复盘", "增长曲线", "用户访谈", "供应链", "优化方案", "评审通过", "灰度发布", "数据看板", "报销流程", "周末加班", "版本发布"];
let seedState = 42;
const rand = () => (seedState = (seedState * 1103515245 + 12345) % 2147483648) / 2147483648;
const noise = () => Array.from({ length: 6 }, () => vocab[Math.floor(rand() * vocab.length)]).join("，一起推进") + "。";

for (const s of seeds) await store.deliver({ spaceId: SPACE_PERSONAL, actor: "eval", content: s, tags: [] });

// ---------- 用例集 ----------
const cases: Array<{ q: string; want: "hit" | "silent"; note?: string }> = [
  { q: "想买个电饭煲送人，有推荐吗", want: "hit" },
  { q: "明天去水库边钓鱼怎么样", want: "hit" },
  { q: "咱们本地数据库用的是 sqlite 吧", want: "hit" },
  { q: "朵朵最近还在学画画吗", want: "hit" },
  { q: "我爸妈那边最近降温了吧", want: "hit" },
  { q: "体检报告说尿酸的事，海鲜还能吃吗", want: "hit" },
  { q: "我的车牌尾号是多少来着", want: "hit" },
  { q: "记得我手机尾号和老家的地址吗", want: "hit", note: "多记忆竞争" },
  { q: "周一上午的例会几点开始", want: "hit" },
  { q: "今天中午吃什么好呢", want: "silent" },
  { q: "帮我写一个冒泡排序", want: "silent" },
  { q: "明天天气怎么样", want: "silent" },
  { q: "现在几点了", want: "silent" },
  { q: "把这段代码加个注释", want: "silent" },
  { q: "谢谢你啊老师", want: "silent", note: "高频称呼词" },
  { q: "开个玩笑而已", want: "silent" },
  { q: "最近这个项目进度有点赶啊", want: "silent" },
  { q: "帮我订个闹钟明早七点", want: "silent" },
];

// ---------- 规模压力：348 条随机噪声（总 360） ----------
const t0 = performance.now();
for (let i = 0; i < 348; i++) await store.deliver({ spaceId: SPACE_PERSONAL, actor: "eval", content: noise() + i, tags: [] });
const seedMs = Math.round(performance.now() - t0);

// ---------- 跑评测 ----------
let hits = 0, miss = 0, fp = 0;
const fails: string[] = [];
const t1 = performance.now();
for (const c of cases) {
  const r = store.searchProactive(c.q, { limit: 3 });
  const got = r.length > 0 ? "hit" : "silent";
  const ok = got === c.want;
  if (c.want === "hit" && ok) hits++;
  if (c.want === "hit" && !ok) { miss++; fails.push(`漏推: 「${c.q}」`); }
  if (c.want === "silent" && !ok) { fp++; fails.push(`误推: 「${c.q}」→ ${r.map((x) => x.content.slice(0, 24)).join(" | ")}`); }
  console.log(`${ok ? "✓" : "✗"} [${c.want}${c.note ? "·" + c.note : ""}] 「${c.q}」→ ${got}${r.length ? `(${r.map((x) => x.content.slice(0, 16)).join("/")})` : ""}`);
}
const evalMs = Math.round(performance.now() - t1);

const wantHit = cases.filter((c) => c.want === "hit").length;
const wantSilent = cases.length - wantHit;
console.log(`\n--- 结果（库 ${store.stats().memories} 条）---`);
console.log(`召回 ${hits}/${wantHit}，漏推 ${miss}，误推 ${fp}/${wantSilent}`);
console.log(`精确率 ${(hits / (hits + fp) * 100).toFixed(0)}% · 召回率 ${(hits / wantHit * 100).toFixed(0)}%`);
console.log(`规模播种 ${seedMs}ms，18 用例检索总耗时 ${evalMs}ms（均 ${(evalMs / cases.length).toFixed(1)}ms/次）`);
if (fails.length) { console.log("\n失败明细:"); for (const f of fails) console.log("  " + f); }

store.db.close();
rmSync(HOME, { recursive: true, force: true });
process.exit(0);
