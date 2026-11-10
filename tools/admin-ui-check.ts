// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 管理页「无头浏览器实开」闸（可选，不进 test:ci —— CI 三平台未必有 Chrome）。
 *
 * ## 为什么必须有这一道
 *
 * `ADMIN_HTML` 是**整段模板字面量**，内联 JS 只有真在浏览器里跑一遍才知道好坏：
 * typecheck 绿、build 绿、`check-admin-html.ts` 绿，而浏览器打开是**白屏**
 * （反斜杠被模板吃掉 → 内联函数 `is not defined`）—— 这类事故已有三前科。
 * 静态分析闸只能证明"语法像对的"，证明不了"真的跑起来了"。
 *
 * ## 本轮新增的第三态
 *
 * 云端区块有**三**态而非两态：未绑定 / 已绑定·软关（密钥保留）/ 已绑定·云端。
 * 若塌成两态，"切到本地"之后页面与"从未绑定"长得一模一样，用户会以为密钥没了，
 * 于是回控制台重新绑一遍 —— 正是本轮要消灭的体验。这里逐态断言渲染文案。
 *
 * ## ⚠️ 断言必须只看 cloudbar 的渲染结果
 *
 * `chrome --dump-dom` 会把内联 `<script>` 的**源码**一并吐出，而源码里含有全部三态
 * 文案字面量 —— 对整页做 `includes` 判断必然**假绿**（第一版就这么写错了，
 * 三态全部"通过"，其实一个都没验证）。故一律先切出 cloudbar 区段再断言。
 *
 * 用法：`bun run tools/admin-ui-check.ts`（设 `CHROME` 环境变量可指定浏览器路径）
 */
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const bun = process.execPath;
const root = fileURLToPath(new URL("..", import.meta.url));
const HOME = `${root}.uicheck-home`;
const PORT = 17641;
const base = "http://127.0.0.1:" + PORT;

const CHROME_CANDIDATES = [
  process.env.CHROME ?? "",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

// 显式定为 string：模块级 if 守卫的窄化不会穿透进下面那几个函数体（闭包里的窄化会被重置）
const chrome: string = CHROME_CANDIDATES.find((p) => existsSync(p)) ?? "";
if (!chrome) {
  console.log("admin-ui-check: 未找到 Chrome/Chromium，跳过（设 CHROME=<路径> 可指定）");
  process.exit(0);
}

rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });

const child = spawn(bun, [`${root}src/index.ts`, "serve", "--headless", "--no-open"], {
  env: { ...process.env, XBB_HOME: HOME, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function dumpDom(): Promise<string> {
  const p = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      `--user-data-dir=${HOME}/chrome-profile`,
      "--virtual-time-budget=8000",
      "--dump-dom",
      `${base}/ui`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let out = "";
  p.stdout.on("data", (d: Buffer) => (out += d));
  return new Promise((res) => p.on("close", () => res(out)));
}

/** 只取 cloudbar 的**渲染结果**（见文件头 ⚠️：整页 includes 会假绿）。 */
function cloudbarOf(dom: string): string {
  const a = dom.indexOf('id="cloudbar"');
  const b = dom.indexOf('class="updatebar"');
  return a < 0 || b <= a ? "" : dom.slice(a, b);
}

function cloudFixture(enabled?: boolean) {
  writeFileSync(
    `${HOME}/cloud.json`,
    JSON.stringify(
      {
        apiBase: "https://api.example.invalid",
        key: "xbb_live_uicheck_fixture",
        orgId: "01a11693-0000-7000-8000-000000000000",
        orgName: "冒烟组织",
        orgKind: "company",
        spaceId: null,
        deviceName: "uicheck",
        boundAt: new Date().toISOString(),
        ...(enabled === undefined ? {} : { enabled }),
      },
      null,
      2,
    ),
  );
}

const fail = (msg: string): never => {
  console.error(`✗ ${msg}\n--- serve log ---\n${log}`);
  child.kill();
  process.exit(1);
};

async function main() {
  // 就绪窗口放到 20s：本机若同时在跑编译，serve 冷启动会被 CPU 饥饿拖到 10s 之外
  // （实测过一次：与 `build:win` 并行 ⇒ 10s 判"未就绪"，而日志明明已 listening）
  let up = false;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try {
      if ((await fetch(`${base}/healthz`)).ok) {
        up = true;
        break;
      }
    } catch {
      /* 未就绪 */
    }
  }
  if (!up) fail("serve 未在 20s 内就绪");

  // ① 未绑定态
  rmSync(`${HOME}/cloud.json`, { force: true });
  let dom = await dumpDom();
  let bar = cloudbarOf(dom);
  if (!bar) fail("cloudbar 未渲染（内联 JS 没跑起来 = 白屏）");
  if (dom.includes("is not defined")) fail("内联函数未定义（白屏前兆）");
  if (!bar.includes("本地模式") || !bar.includes("未绑定云端组织")) fail(`① 未绑定态文案缺失: ${bar.slice(0, 200)}`);
  if (!bar.includes("手动填写云端密钥")) fail("① 填密钥入口缺失");
  if (!bar.includes('class="dot local"')) fail("① 本地态指示灯缺失");
  console.log("✓ ① 未绑定态：本地模式 + 填密钥入口 + 无 JS 报错");

  // ② 已绑定·云端态（老配置无 enabled 字段 ⇒ 必须视为云端模式，否则升级即静默降级）
  cloudFixture();
  dom = await dumpDom();
  bar = cloudbarOf(dom);
  if (!bar.includes("云端模式")) fail(`② 云端态文案缺失: ${bar.slice(0, 200)}`);
  if (!bar.includes("冒烟组织")) fail("② 组织名未渲染");
  if (!bar.includes("切到本地（保留密钥）")) fail("② 软切按钮缺失");
  if (!bar.includes("解除绑定")) fail("② 解绑按钮缺失");
  if (bar.includes("未绑定云端组织")) fail("② 云端态却渲染了未绑定文案");
  console.log("✓ ② 云端态：模式 + 组织名 +「切到本地（保留密钥）」+「解除绑定」");

  // ③ 已绑定·软关态 —— 与 ① 必须可区分（这正是"两态塌陷"回归）
  cloudFixture(false);
  dom = await dumpDom();
  bar = cloudbarOf(dom);
  if (!bar.includes("云端密钥仍保留")) fail(`③ 软关态未说明密钥保留: ${bar.slice(0, 200)}`);
  if (!bar.includes("切换到云端")) fail("③ 缺「切换到云端」");
  if (bar.includes("未绑定云端组织")) fail("③ 软关态与未绑定态塌成一态");
  if (!bar.includes('class="dot local"')) fail("③ 软关态指示灯应仍为本地色");
  console.log("✓ ③ 软关态：本地模式但明示密钥保留，与①可区分");

  child.kill();
  rmSync(HOME, { recursive: true, force: true });
  console.log("\nadmin-ui-check: 3/3 PASS（三态渲染正确，无白屏）");
  process.exit(0);
}

main();
