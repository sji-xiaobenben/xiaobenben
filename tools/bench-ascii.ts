// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * bench-ascii：标识符/编号/凭据占位类查询基准（cli 端）。
 * 这类查询是词法通道的核心价值区（随机 token 无语义、向量天然弱），
 * 同时检验 tokenize 对特殊字符（- _ # . : / !）的切分行为。
 * 全部为虚构占位数据。跑法：bun tools/bench-ascii.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalStore } from "../src/store";

// [键, 记忆内容, 查询, 期望]（expect: "hit" 应命中 / "miss" 预期不命中）
const CASES: Array<{ key: string; mem: string; q: string; expect: "hit" | "miss" }> = [
  { key: "完整单号", mem: "订单号 SO-2026-08817 已经发货了", q: "SO-2026-08817", expect: "hit" },
  { key: "单号前段", mem: "订单号 SO-2026-08817 已经发货了", q: "2026-08817", expect: "hit" },
  { key: "单号尾段", mem: "订单号 SO-2026-08817 已经发货了", q: "08817", expect: "hit" },
  { key: "凭据含#", mem: "示例凭据串 admin 占位 Xk9#mP2q 记得轮换", q: "Xk9#mP2q", expect: "hit" },
  { key: "凭据后半", mem: "示例凭据串 admin 占位 Xk9#mP2q 记得轮换", q: "mP2q", expect: "hit" },
  { key: "凭据干扰", mem: "xk9 是我随手打的两个字符", q: "Xk9#mP2q", expect: "miss" }, // 干扰行只含 xk9 不含 mp2q，AND 精度应挡住
  { key: "接入串", mem: "示例接入串占位 Xiaobenben2026 有效期本月", q: "Xiaobenben2026", expect: "hit" },
  { key: "完整IP", mem: "测试服务器 IP 203.0.113.7 端口 17630", q: "203.0.113.7", expect: "hit" },
  { key: "端口", mem: "测试服务器 IP 203.0.113.7 端口 17630", q: "17630", expect: "hit" },
  { key: "错误码", mem: "昨天踩坑 ERR_42P18 空参数绑定", q: "ERR_42P18", expect: "hit" },
  { key: "错误码数字", mem: "昨天踩坑 ERR_42P18 空参数绑定", q: "42P18", expect: "hit" },
  { key: "工牌号", mem: "工牌号 A1024 是张三的", q: "A1024", expect: "hit" },
  { key: "工牌数字", mem: "工牌号 A1024 是张三的", q: "1024", expect: "hit" },
  { key: "报销单号", mem: "报销单 BX20260928-003 金额 350 元", q: "BX20260928-003", expect: "hit" },
  { key: "访问令牌", mem: "示例占位令牌 ghp_16charsExampleToken123 下周轮换", q: "ghp_16charsExampleToken123", expect: "hit" },
  { key: "函数名", mem: "检索函数 buildTsQuery 在 tokenize.ts 里", q: "buildTsQuery", expect: "hit" },
  { key: "卡尾号", mem: "示例尾号 6688 绑定了支付渠道", q: "6688", expect: "hit" },
  { key: "大小写变体", mem: "示例连接串 postgres://xbb:xbb_dev@localhost:15432/xbb_dev", q: "XBB_DEV", expect: "hit" },
];

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "xbb-bench-ascii-"));
  const store = PersonalStore.open(join(dir, "ascii.db"));
  const idMap = new Map<string, string>();
  const seen = new Map<string, string>(); // 查询 → 期望命中的记忆 id
  const lat: number[] = [];
  for (const c of CASES) {
    if (!idMap.has(c.mem)) {
      const rec = await store.deliver({ spaceId: "sp-ascii", actor: "bench", content: c.mem });
      idMap.set(c.mem, rec.id);
    }
    if (c.expect === "hit") seen.set(c.q, idMap.get(c.mem)!);
  }
  let pass = 0;
  for (const c of CASES) {
    const t0 = performance.now();
    const hits = store.search(c.q);
    lat.push(performance.now() - t0);
    const target = c.expect === "hit" ? seen.get(c.q)! : idMap.get(c.mem)!;
    const ids = hits.map((h) => h.memoryId);
    const got = c.expect === "hit" ? ids.slice(0, 3).includes(target) : !ids.slice(0, 3).includes(target);
    if (got) pass++;
    console.log(`${got ? "✓" : "✗"} ${c.key.padEnd(10)} 「${c.q}」 期望${c.expect === "hit" ? "命中" : "不命中"}`);
  }
  const s = [...lat].sort((a, b) => a - b);
  console.log(`\n${pass}/${CASES.length} 符合预期  延迟 P50=${s[Math.floor(s.length * 0.5)].toFixed(1)}ms  P95=${s[Math.floor(s.length * 0.95)].toFixed(1)}ms`);
  store.db.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 锁 */ }
}
main();
