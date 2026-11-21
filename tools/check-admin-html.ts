// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 源码侧断言：`ADMIN_HTML` 那个**整段模板字面量**没有把内联 JS 吃掉。
 *
 * 用法：`bun run tools/check-admin-html.ts [源文件] [--emit <输出文件>]`
 *      （源文件缺省 = src/web/admin.ts；给定其他路径可用来对历史版本做回归自检）
 *
 * 为什么单独做成一个工具：
 *  - 2026-10-07 事故：`dismissUpdate(\'...)` 写在模板字面量里，`\'` 被模板提前解析成 `'`
 *    ⇒ 页面里变成 `dismissUpdate('' + esc(...)` ⇒ **内联 <script> 整体语法错误、整块报废**
 *    ⇒ 所有内联 onclick 全部 `is not defined`、`loadList()` 不执行 ⇒ 白屏 + 一条记忆都看不到。
 *  - 同一模板里 `\[\[xbb_secret_id:(\d+)\]\]` 被吃成 `[[xbb_secret_id:(d+)]]`，正则静默失真（不报错、更难发现）。
 *  - 这类 bug 的共同特征：**本地 typecheck / build 全绿**（TS 侧语法没问题），只有浏览器打开才发现。
 *
 * 三条断言（前两条查根因、第三条查症状）：
 *  1. 模板里所有反斜杠必须「双写」——单写即被模板吃掉；
 *  2. 模板里的 `${...}` 只能是**裸标识符**或一级成员访问（复杂表达式一律人工确认，防误伤）；
 *  3. 求值出真实 HTML 后：内联 <script> 必须能通过语法检查，且每个 `onclick="fn(...)"`
 *     引用的函数都必须在脚本里有 `function fn(` 声明（本次事故的用户可见症状）。
 */
import "./lib/locale"; // 语言锚点：必须是第一条 import（理由见该文件）
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const SRC = process.argv[2] && !process.argv[2].startsWith("--")
  ? process.argv[2]
  : join(root, "src", "web", "admin.ts");

const emitIdx = process.argv.indexOf("--emit");
const emitPath = emitIdx >= 0 ? process.argv[emitIdx + 1] : null;
if (emitIdx >= 0 && !emitPath) {
  console.error("用法: bun run tools/check-admin-html.ts [源文件] [--emit <输出文件>]");
  process.exit(2);
}

let failures = 0;
function fail(msg: string): void {
  failures++;
  console.error(`✗ ${msg}`);
}

const src = readFileSync(SRC, "utf8");

// ── 抠出模板字面量正文 ────────────────────────────────────────────────
// 锚点只用「反引号 + <!DOCTYPE html>」：模板外面套着哪个函数、变量叫什么名字
// 都不该影响本闸 —— 2026-11-22 把它从 `const ADMIN_HTML =` 改成 `function adminHtml()`
// 时，旧锚点直接找不到起点；用页面自己的第一行当锚点就不会再因为重构而失效。
const MARK = "`<!DOCTYPE html>";
const END = "</html>`;";
const openTick = src.indexOf(MARK);
if (openTick < 0) {
  console.error(`✗ ${SRC} 里找不到模板起点（${MARK}）`);
  process.exit(1);
}
const e = src.indexOf(END, openTick);
if (e < 0) {
  console.error("✗ 找不到 ADMIN_HTML 模板终点 </html>");
  process.exit(1);
}
const body = src.slice(openTick + 1, e + "</html>".length);
const startLine = src.slice(0, openTick + 1).split("\n").length;
const lineOf = (offset: number) => startLine + body.slice(0, offset).split("\n").length - 1;

console.log(`源文件 : ${SRC}`);
console.log(`模板   : 第 ${startLine} 行起，${body.length} 字符`);

// ── 断言 0：模板内不得出现裸反引号（否则模板提前闭合）────────────────
{
  const i = body.indexOf("`");
  if (i >= 0) fail(`模板内第 ${lineOf(i)} 行出现裸反引号 ⇒ 模板提前闭合，页面必然错乱`);
}

// ── 断言 1：反斜杠必须双写 ───────────────────────────────────────────
{
  let i = 0;
  const bad = new Map<number, string>(); // 行号 → 该行内容（同一行只报一次）
  while (i < body.length) {
    if (body[i] === "\\") {
      if (body[i + 1] === "\\") {
        i += 2;
        continue;
      }
      const line = lineOf(i);
      if (!bad.has(line)) {
        bad.set(line, body.split("\n")[line - startLine] ?? "");
      }
      i++;
      continue;
    }
    i++;
  }
  for (const [line, text] of bad) {
    fail(
      `第 ${line} 行有**单写**反斜杠 ⇒ 会被模板字面量吃掉：\n      ${text.trim()}\n` +
        `      ⇒ 双写才能进入页面。`,
    );
  }
  if (bad.size === 0) console.log("✓ 反斜杠全部双写");
}

// ── 断言 2：插值只能是裸标识符或「标识符.标识符」链 ─────────────────
// 文案搬进语言包之后，骨架里出现的插值形如 ${a.html.docTitle}。允许一级成员访问
// 是因为它同样**不可能**藏着反引号、引号或换行；而调用、下标、运算、三元一律不放行
// —— 那些才是真正需要人工过目的东西（本闸认不出来的表达式会被误伤成"模板坏了"）。
const roots: string[] = [];
const IDENT = /^[A-Za-z_$][\w$]*$/;
const MEMBER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
{
  for (const m of body.matchAll(/\$\{([^}]*)\}/g)) {
    const expr = m[1].trim();
    if (IDENT.test(expr) || MEMBER.test(expr)) {
      const root = expr.split(".")[0]!;
      if (!roots.includes(root)) roots.push(root);
    } else {
      fail(`第 ${lineOf(m.index!)} 行插值 \${${expr}} 不是裸标识符 ⇒ 请人工确认（本闸只认裸变量与一级成员访问）`);
    }
  }
  console.log(`✓ 插值共 ${roots.length} 个根标识符：${roots.join(", ") || "（无）"}`);
}

// ── 求值出真实 HTML ─────────────────────────────────────────────────
// 占位值不能给空串：${a.html.docTitle} 在空串上会变成 "".html.docTitle ⇒ 抛 TypeError，
// 闸门会以"模板坏了"的面目红一次。给一个「什么属性都有、转成字符串是 x」的桩，
// 插值就能全部求值出可读的占位文字。
const stub = new Proxy(function () {} as unknown as object, {
  get: (_t, prop) => (prop === "toString" || prop === Symbol.toPrimitive ? () => "x" : stub),
}) as Record<string, unknown>;

let html: string;
try {
  const fn = new Function(...roots, `return \`${body}\`;`);
  html = fn(...roots.map(() => stub));
} catch (err) {
  fail(`模板字面量求值失败：${(err as Error).message}`);
  process.exit(1);
}
if (emitPath) {
  writeFileSync(emitPath, html);
  console.log(`·  已导出生成页面：${emitPath}`);
}

// ── 断言 3a：内联脚本必须通过语法检查 ───────────────────────────────
const scripts: { code: string; line: number }[] = [];
for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  scripts.push({ code: m[1], line: html.slice(0, m.index!).split("\n").length });
}
if (scripts.length === 0) fail("生成页面里没有任何内联 <script> ⇒ 页面不会工作");

for (const sc of scripts) {
  try {
    // new Function 的解析等价于脚本体（本页无顶层 return/await），只用来抓语法错误
    new Function(sc.code);
    console.log(`✓ 内联脚本（页面第 ${sc.line} 行起，${sc.code.split("\n").length} 行）语法通过`);
  } catch (err) {
    const msg = (err as Error).message;
    fail(`内联脚本语法错误（页面第 ${sc.line} 行起）：${msg}`);
    // 定位：V8 的报错里通常带着出错的那个 token（如 ' + esc(...) + '），拿去反查页面行号
    const tok = msg.match(/'(.{3,})'/)?.[1] ?? msg.match(/"(.{3,})"/)?.[1];
    if (tok) {
      const at: number[] = [];
      html.split("\n").forEach((l, i) => {
        if (l.includes(tok)) at.push(i + 1);
      });
      if (at.length) {
        console.error(`      出错 token 出现在页面第 ${at.join(" / ")} 行：`);
        for (const n of at.slice(0, 3)) console.error(`        ${html.split("\n")[n - 1].trim()}`);
      }
    }
  }
}

// ── 断言 3b：onclick 引用的函数必须有声明（本次事故的用户可见症状）────
{
  const declared = new Set<string>();
  for (const sc of scripts) {
    for (const m of sc.code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
    for (const m of sc.code.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*function/g)) {
      declared.add(m[1]);
    }
  }
  const used = new Map<string, number>();
  for (const m of html.matchAll(/\bon(?:click|change|input)\s*=\s*"([A-Za-z_$][\w$]*)\(/g)) {
    const line = html.slice(0, m.index!).split("\n").length;
    if (!used.has(m[1])) used.set(m[1], line);
  }
  const missing = [...used.entries()].filter(([n]) => !declared.has(n));
  if (missing.length === 0) {
    console.log(`✓ ${used.size} 个内联事件处理函数均有声明：${[...used.keys()].join(", ")}`);
  } else {
    for (const [n, line] of missing) {
      fail(`页面第 ${line} 行的 onclick/onchange 引用了 ${n}()，但脚本里没有声明 ⇒ 点击必报 is not defined`);
    }
  }
}

console.log("");
if (failures > 0) {
  console.error(`check-admin-html: FAIL（${failures} 项）`);
  process.exit(1);
}
console.log("check-admin-html: PASS");
