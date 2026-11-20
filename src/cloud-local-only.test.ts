/**
 * 云端「真·不可用」工具清单的**单一真源校验**。
 *
 * 背景是一个已经发生的线上错报：`recall_transcript` 注册时没给 cloudFn（云端确实不支持），
 * 但同一份"哪几件不可用"的名单散在三处 —— 注册处 / 握手指令里那句「仅三类不可用」/ 官网文档。
 * 加了新工具后只有注册处是对的，另两处还写着"三类"，于是**云端模式的 AI 被告知一个必然失败的工具可用**：
 * 它会去调、拿到 unsupported、再换个入口、最后告诉用户"没记到"。
 *
 * 三处里有两处没法写单元测试（握手指令是模板字符串，官网是另一个仓库），
 * 所以这里钉住能钉的那条：**`gen1(...)` 没带 cloudFn 的工具集合，必须与 GEN1_LOCAL_ONLY 的键完全相等**。
 * 双向都查 —— 漏登记会让报错退化成"仅本地提供"的泛泛之词，多登记则会声称某个能用的工具不可用。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GEN1_LOCAL_ONLY } from "./cloud";

/** 从 `src/mcp.ts` 里抽出所有 gen1( ... ) 调用块（括号配对，跳过反引号模板串） */
function gen1Blocks(): string[] {
  const src = readFileSync(join(import.meta.dir, "mcp.ts"), "utf8");
  const out: string[] = [];
  let i = 0;
  while ((i = src.indexOf("gen1(", i)) >= 0) {
    let depth = 0;
    let j = i + "gen1".length;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === "`") {
        // 模板串里可能有括号和 "gen1(" 字样，整段跳过
        j++;
        while (j < src.length && src[j] !== "`") {
          if (src[j] === "\\") j++;
          j++;
        }
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) break;
    }
    out.push(src.slice(i, j + 1));
    i = j;
  }
  return out;
}

/** 该调用块是否提供了 cloudFn（第三个参数）——用箭头函数个数判定，注释里的箭头不影响 */
function hasCloudFn(block: string): boolean {
  const arrows = block.match(/=>/g)?.length ?? 0;
  return arrows >= 2;
}

function toolName(block: string): string | null {
  return block.match(/"([a-z_]+)"/)?.[1] ?? null;
}

describe("云端不可用清单必须与注册处一致", () => {
  const pairs = gen1Blocks()
    .map((b) => ({ name: toolName(b), cloud: hasCloudFn(b) }))
    .filter((x): x is { name: string; cloud: boolean } => !!x.name);

  test("能扫到足够多的 gen1 调用（扫描器本身没坏）", () => {
    // 工具面 23 个里绝大多数走 gen1；低于 10 说明括号配对或模板串处理写错了，
    // 那样下面的断言会无条件通过 —— 必须让扫描器自己先被验证。
    expect(pairs.length).toBeGreaterThanOrEqual(10);
  });

  test("没有 cloudFn 的工具集合 == GEN1_LOCAL_ONLY 的键", () => {
    const noCloud = pairs.filter((p) => !p.cloud).map((p) => p.name).sort();
    const declared = Object.keys(GEN1_LOCAL_ONLY).sort();
    expect(noCloud).toEqual(declared);
  });

  test("有 cloudFn 的工具不许登记进不可用清单", () => {
    const withCloud = new Set(pairs.filter((p) => p.cloud).map((p) => p.name));
    const wrong = Object.keys(GEN1_LOCAL_ONLY).filter((t) => withCloud.has(t));
    expect(wrong).toEqual([]);
  });

  test("情景层三件都在清单里（它们是最容易被漏掉的一类）", () => {
    for (const t of ["log_episodes", "recall_episodes", "recall_transcript"]) {
      expect(GEN1_LOCAL_ONLY[t]).toBeTruthy();
    }
  });
});
