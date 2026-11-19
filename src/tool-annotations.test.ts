// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 工具标注（readOnly / destructive / idempotent / openWorld 四件套）的结构守卫。
 *
 * 这一组的价值不在"新代码上绿"，而在于**能抓住三种真实的错**：
 *  ① 加了工具却忘了标注 —— 宿主按规范取 destructive=true 默认值，用户的每个读操作
 *     都会变成"需要批准的危险操作"（0.4.5x 收到过同类反馈：每次搜记忆都要点一下）。
 *  ② 标注写错位 —— `server.tool("recall_timeline", …, TOOL_ANNOTATIONS.recall_topic, cb)`
 *     这种复制粘贴错误**类型完全合法**，tsc 查不出来，只有比对名字才能发现。
 *  ③ 图省事整表同一个值 —— 全是 readOnly=true 等于给写工具开后门；全是 false 等于噪音。
 *     所以另有两条反向判据把"破坏型只该有两个""只读该是 17 个"钉住。
 *
 * 端到端那一条（annotations 真的随 tools/list 下发）在 `tools/mcp-smoke.ts` 里，
 * 这里只管源码层的配对关系 —— 两边缺一不可：源码对但没接进注册等于没标，
 * 接进去了但源码错位等于标错对象。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TOOL_ANNOTATIONS, type ToolName } from "./tool-annotations";

const mpSrc = readFileSync(new URL("./mcp.ts", import.meta.url), "utf8");
const lines = mpSrc.split(/\r?\n/);

/** 从 mcp.ts 里抽出「注册了哪些工具、各自挂的是哪一行标注」。 */
function registrations(): { name: string; key: string | null; line: number }[] {
  const out: { name: string; key: string | null; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "  server.tool(") continue;
    const name = /^    "(\w+)",$/.exec(lines[i + 1] ?? "")?.[1];
    if (!name) continue;
    let key: string | null = null;
    for (let j = i + 2; j < lines.length && j < i + 300; j++) {
      const m = /^\s+TOOL_ANNOTATIONS\.(\w+),$/.exec(lines[j]);
      if (m) { key = m[1]; break; }
      if (/^    async /.test(lines[j])) break; // 到回调还没见到标注 ⇒ 漏标
      if (lines[j] === "  );") break;
    }
    out.push({ name, key, line: i + 1 });
  }
  return out;
}

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;
const regs = registrations();
const keys = Object.keys(TOOL_ANNOTATIONS);

describe("工具标注表本身", () => {
  test("四个提示在全部工具上都是布尔值（不是 undefined、不是字符串）", () => {
    const bad: string[] = [];
    for (const [name, a] of Object.entries(TOOL_ANNOTATIONS)) {
      for (const h of HINTS) if (typeof (a as never as Record<string, unknown>)[h] !== "boolean") bad.push(`${name}.${h}`);
    }
    expect(bad).toEqual([]);
  });

  test("没有工具同时是只读和破坏型（规范上互斥，同时为真说明标反了）", () => {
    const both = Object.entries(TOOL_ANNOTATIONS)
      .filter(([, a]) => a.readOnlyHint && a.destructiveHint)
      .map(([n]) => n);
    expect(both).toEqual([]);
  });

  test("破坏型只有 forget / set_memory_audience —— 第三个出现时必须是一次显式决定", () => {
    const destructive = Object.entries(TOOL_ANNOTATIONS)
      .filter(([, a]) => a.destructiveHint)
      .map(([n]) => n)
      .sort();
    expect(destructive).toEqual(["forget", "set_memory_audience"]);
  });

  test("只读 17 个 / 会写 6 个 —— 整表被改成同一个值时会红", () => {
    const ro = keys.filter((k) => TOOL_ANNOTATIONS[k as ToolName].readOnlyHint);
    expect(ro.length).toBe(17);
    expect(keys.length - ro.length).toBe(6);
  });

  test("openWorld 全 false：工具面只碰用户自己的库与本机文件", () => {
    expect(keys.filter((k) => TOOL_ANNOTATIONS[k as ToolName].openWorldHint)).toEqual([]);
  });
});

describe("标注表与注册点必须一一对应", () => {
  test("mcp.ts 里注册了 23 个工具", () => {
    expect(regs.length).toBe(23);
  });

  test("注册的工具名集合 === 标注表的键集合（双向，改名/删工具都会红）", () => {
    expect(regs.map((r) => r.name).sort()).toEqual([...keys].sort());
  });

  test("每个注册点都挂了标注（漏挂 = 宿主按 destructive 默认值处理）", () => {
    expect(regs.filter((r) => !r.key)).toEqual([]);
  });

  test("挂的必须是它自己那一行（复制粘贴错位类型合法，只有这里能抓）", () => {
    const wrong = regs.filter((r) => r.key !== r.name).map((r) => `line ${r.line}: ${r.name} 挂了 ${r.key}`);
    expect(wrong).toEqual([]);
  });

  test("标注表里没有注册点之外的孤儿键（删了工具却留着标注）", () => {
    const regNames = new Set(regs.map((r) => r.name));
    expect(keys.filter((k) => !regNames.has(k))).toEqual([]);
  });
});
