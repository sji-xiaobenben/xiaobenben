// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * recall-bench-cli：个人版检索命中率基准（与 server tools/recall-bench.ts 同一数据集）。
 * 目的：量化「个人版现状 → 若上向量」的增益上限，支撑「要不要上向量」的决策。
 * 跑法：bun tools/recall-bench-cli.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalStore } from "../src/store";

const MEMORIES: Array<[string, string]> = [
  ["m1", "今天天气怎么样适合出去玩吗周末可能有雨"],
  ["m2", "下周三要出差去上海见客户顺便旅游两天"],
  ["m3", "天气预报说明天气温骤降记得添衣"],
  ["m4", "高铁票已经买好了周五早上八点出发"],
  ["m5", "小明的猫昨天在家走丢了花色是橘色"],
  ["m6", "狗粮快吃完了记得下班后去宠物店补货"],
  ["m7", "给猫咪预约了周六上午的疫苗注射"],
  ["m8", "邻居家的小狗最近总是半夜叫很吵"],
  ["m9", "差旅外出审批需要部门主管批准"],
  ["m10", "报销单要附上发票原件月底前提交财务"],
  ["m11", "外出就餐的餐费补贴每天上限一百元"],
  ["m12", "项目采购需要提前一周提交预算申请"],
  ["m13", "TypeScript 类型检查总是报错找不到声明文件"],
  ["m14", "数据库连接池满了导致接口超时要调大上限"],
  ["m15", "前端打包体积太大考虑按路由做代码分割"],
  ["m16", "git 合并冲突太多建议先rebase再提PR"],
  ["m17", "体检报告显示尿酸偏高要少吃海鲜"],
  ["m18", "最近失眠很严重半夜总是醒"],
  ["m19", "牙疼得厉害约了周四下午看牙医"],
  ["m20", "医生说每天要喝够两升水多运动"],
  ["m21", "周五要参加孩子的家长会别忘记请假"],
  ["m22", "老妈生日快到了准备订个蛋糕送花"],
  ["m23", "周末全家去动物园玩小朋友很开心"],
  ["m24", "水电费该交了这个月用得比较多"],
];

const QUERIES: Array<{ key: string; q: string; target: string; group: "A" | "B" | "C" }> = [
  { key: "A1", q: "周末天气预报", target: "m3", group: "A" },
  { key: "A2", q: "狗粮补货", target: "m6", group: "A" },
  { key: "A3", q: "报销单发票", target: "m10", group: "A" },
  { key: "A4", q: "连接池超时", target: "m14", group: "A" },
  { key: "A5", q: "尿酸偏高", target: "m17", group: "A" },
  { key: "A6", q: "家长会请假", target: "m21", group: "A" },
  { key: "B1", q: "出门要不要带伞", target: "m1", group: "B" },
  { key: "B2", q: "家里宠物不见了很着急", target: "m5", group: "B" },
  { key: "B3", q: "出差花费的票据怎么处理", target: "m10", group: "B" },
  { key: "B4", q: "页面加载很慢资源包臃肿怎么优化", target: "m15", group: "B" },
  { key: "B5", q: "晚上翻来覆去难以入眠", target: "m18", group: "B" },
  { key: "B6", q: "娃学校有演出要到场", target: "m21", group: "B" },
  { key: "C1", q: "出差申请怎么走流程", target: "m9", group: "C" },
  { key: "C2", q: "毛孩子不见了", target: "m5", group: "C" },
  { key: "C3", q: "费用申报流程是什么", target: "m10", group: "C" },
  { key: "C4", q: "构建失败怎么解决", target: "m13", group: "C" },
  { key: "C5", q: "总是睡不着怎么办", target: "m18", group: "C" },
  { key: "C6", q: "娃的学校有什么通知", target: "m21", group: "C" },
];

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "xbb-bench-cli-"));
  const store = PersonalStore.open(join(dir, "bench.db"));
  const idMap = new Map<string, string>();
  const lat: number[] = [];
  for (const [key, content] of MEMORIES) {
    const rec = await store.deliver({ spaceId: "sp-bench", actor: "bench", content });
    idMap.set(key, rec.id);
  }
  for (const item of QUERIES) {
    const t0 = performance.now();
    const hits = store.search(item.q);
    lat.push(performance.now() - t0);
    const ids = hits.map((h) => h.memoryId);
    const target = idMap.get(item.target)!;
    const top1 = ids[0] === target ? "✓" : ids.slice(0, 3).includes(target) ? "○" : "✗";
    console.log(`${item.key} 「${item.q}」 ${top1}`);
  }
  const s = [...lat].sort((a, b) => a - b);
  const pct = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  console.log(`延迟: P50=${pct(0.5).toFixed(1)}ms  P95=${pct(0.95).toFixed(1)}ms`);
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
}
main();
