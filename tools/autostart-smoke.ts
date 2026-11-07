// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 开机自启冒烟。
 *
 * 三条纪律：
 *  - **绝不碰真实的那条**：注册表往返一律用临时键名 `xbb-autostart-smoke-<pid>`，
 *    测完删除（含失败路径的兜底清理）。
 *  - **形态闸必须有**：dev（`bun run`）下 `process.execPath` 是 bun 本体，写进启动项等于给
 *    用户埋一个"开机即失败"。本冒烟正是在 dev 形态下跑，所以这条断言**每次都在真验**。
 *  - 非 Windows 只断言"明确报未支持"，不假装成功（POSIX 口径见 src/autostart.ts）。
 */
import {
  AUTOSTART_VALUE,
  autostartCommand,
  detachedServeArgs,
  disableAutostart,
  enableAutostart,
  readAutostart,
  removeAutostartEntry,
  writeAutostartEntry,
} from "../src/autostart";

let pass = 0;
let total = 0;

function ok(cond: boolean, label: string): void {
  total++;
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  pass++;
  console.log(`✓ ${label}`);
}

const SMOKE_VALUE = `xbb-autostart-smoke-${process.pid}`;

async function main() {
  // ── 1. 纯函数：命令行形态 ────────────────────────────────────
  const cmd = autostartCommand("C:\\Program Files\\x y\\xbb.exe");
  ok(cmd === '"C:\\Program Files\\x y\\xbb.exe" serve --detach', `路径带空格也要加引号：${cmd}`);
  ok(cmd.includes("serve --detach"), "启动项指向 --detach（后台无窗口形态，而不是裸 serve）");

  // ── 1b. 纯函数：detach 子进程 argv（2026-10-16 实测曾拼成 `serve serve`）──
  // 唯一调用点传的是整条 args（首位就是 "serve"），而 spawn 又会补一个 "serve" ⇒ 重复。
  // 当时不出事纯属巧合（serve 分支只读 args[0] 与标志位），但这属于"描述与实现不符"那类
  // 静默漂移：排障时双 `serve` 会把人带偏。这里把它钉住。
  const a1 = detachedServeArgs(["serve", "--detach"]);
  ok(a1.filter((x) => x === "serve").length === 1, `argv 里只有一个 serve（实测曾为两个）：${JSON.stringify(a1)}`);
  ok(JSON.stringify(a1) === JSON.stringify(["serve", "--no-open"]), `剥掉 --detach 并自动补 --no-open：${JSON.stringify(a1)}`);
  const a2 = detachedServeArgs(["serve", "--detach", "--headless"]);
  ok(JSON.stringify(a2) === JSON.stringify(["serve", "--headless"]), `headless 不该再补 --no-open（CI 口径）：${JSON.stringify(a2)}`);
  const a3 = detachedServeArgs(["serve", "--no-open"]);
  ok(JSON.stringify(a3) === JSON.stringify(["serve", "--no-open"]), `已带 --no-open 不重复追加：${JSON.stringify(a3)}`);
  const a4 = detachedServeArgs(["--detach"]);
  ok(JSON.stringify(a4) === JSON.stringify(["serve", "--no-open"]), `容忍不含首位的调用形态：${JSON.stringify(a4)}`);

  // ── 2. 非 Windows：明确报未支持 ──────────────────────────────
  const linux = enableAutostart({ platform: "linux", exePath: "/usr/bin/xbb" });
  ok(!linux.ok && linux.message.includes("暂不支持"), "Linux：明确报未支持，不假装成功");
  ok(readAutostart({ platform: "darwin" }).supported === false, "macOS：status 如实报告 supported=false");

  // ── 3. 回读解析（注入假 reg 输出，三平台都能跑）───────────────
  const fake = (out: string, code = 0) => () => ({ code, out });
  const parsed = readAutostart({
    platform: "win32",
    valueName: "小本本服务",
    run: fake(
      "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n" +
        '    \u5c0f\u672c\u672c\u670d\u52a1    REG_SZ    "C:\\Users\\a b\\.xiaobenben\\bin\\xbb.exe" serve --detach\r\n\r\n',
    ),
  });
  ok(parsed.present && parsed.command === '"C:\\Users\\a b\\.xiaobenben\\bin\\xbb.exe" serve --detach', "解析中文键名的 REG_SZ 回读");
  ok(!readAutostart({ platform: "win32", valueName: "x", run: fake("错误: 系统找不到指定的注册表项或值。", 1) }).present, "reg 非零退出 ⇒ 视为未设置");
  const writeFail = writeAutostartEntry("x", { platform: "win32", valueName: SMOKE_VALUE, run: fake("拒绝访问", 1) });
  ok(!writeFail.ok && writeFail.message.includes("写入失败"), "写入被拒时如实报错（不静默）");

  // ── 4. 真注册表往返（仅 Windows 宿主）────────────────────────
  if (process.platform !== "win32") {
    console.log("· 注册表往返已跳过（非 Windows 宿主）");
  } else {
    try {
      const first = removeAutostartEntry({ valueName: SMOKE_VALUE });
      ok(first.ok, "起始态清理（幂等：没有也算成功）");
      ok(!readAutostart({ valueName: SMOKE_VALUE }).present, "临时键名确实不存在");

      const c1 = `"C:\\tmp\\xbb.exe" serve --detach`;
      const w1 = writeAutostartEntry(c1, { valueName: SMOKE_VALUE });
      ok(w1.ok, `写入成功：${w1.message}`);
      const r1 = readAutostart({ valueName: SMOKE_VALUE });
      ok(r1.present && r1.command === c1, "回读与写入逐字符一致（写了 ≠ 写对）");

      const c2 = `"C:\\tmp2\\xbb.exe" serve --detach --no-open`;
      ok(writeAutostartEntry(c2, { valueName: SMOKE_VALUE }).ok, "覆写已存在的键名");
      ok(readAutostart({ valueName: SMOKE_VALUE }).command === c2, "覆写后回读为新值");

      // 形态闸：dev 形态必须拒绝 —— 否则等于给用户埋一个"开机即失败"
      const gate = enableAutostart({ valueName: SMOKE_VALUE });
      ok(!gate.ok && gate.message.includes("不是编译产物"), `dev 形态拒绝写入（${gate.message.slice(0, 40)}…）`);

      ok(removeAutostartEntry({ valueName: SMOKE_VALUE }).ok, "删除成功");
      ok(!readAutostart({ valueName: SMOKE_VALUE }).present, "删除后回读确实消失");

      // 真实那条：只读，绝不写
      const real = readAutostart();
      ok(real.supported, `真实条目可读（${AUTOSTART_VALUE}：${real.present ? real.command : "当前未设置"}）`);
    } finally {
      removeAutostartEntry({ valueName: SMOKE_VALUE }); // 失败路径兜底
    }
  }

  console.log(`autostart smoke: ${pass}/${total} PASS`);
  process.exit(0);
}

main().catch((e) => {
  removeAutostartEntry({ valueName: SMOKE_VALUE });
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
