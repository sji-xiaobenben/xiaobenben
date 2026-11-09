// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 开始菜单快捷方式冒烟。
 *
 * 三条纪律：
 *  - **绝不碰真实的开始菜单**：`startMenuDir` 一律注入 `mkdtemp()` 出来的临时目录，
 *    真正的 `%APPDATA%\…\Start Menu\Programs` 一个字节都不写。
 *  - **真跑一次 PowerShell，不靠"我看了文档所以它对"**：`WScript.Shell` 在部分环境里
 *    被组策略挡掉，只有真跑才知道。跑完再用 COM **读回**目标/参数/图标/备注 —— 文件存在
 *    不等于内容对（这正是本模块第 3 条纪律的由来）。
 *  - **幂等要单验**：第二次调用必须是 `exists` 且**不刷新** mtime。每次重写会把「最近添加」
 *    刷成广告位，而这件事从代码上看不出来。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  LINUX_DESKTOP_FILE,
  NO_SHORTCUT_ENV,
  SHORTCUT_ARGS,
  WIN_SHORTCUT_FILE,
  ensureStartMenuShortcut,
  linuxDesktopEntry,
  shortcutPath,
  windowsShortcutScript,
} from "../src/shortcut";
import { encodePsCommand, psLiteral } from "../src/notify";

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

// `tmpdir()` 在 Windows 上常给 8.3 短名（`C:\Users\RUNNER~1\…`），而 COM 读回 `.lnk`
// 时会给长名 —— 同一路径两种写法，逐字符比较必然不等。这里先展开成规范长名。
const ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), "xbb-shortcut-smoke-")));

// 图标释放会写 `XBB_HOME/icons`：整个冒烟都把 XBB_HOME 指向临时目录，收尾恢复。
const PROGHOME = join(ROOT, "proghome");
const PREV_XBB_HOME = process.env.XBB_HOME;
process.env.XBB_HOME = PROGHOME;

/** 用 COM 读回一个 .lnk 的真实内容（Windows only）。 */
function readBack(lnk: string): Record<string, string> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psLiteral(lnk)})`,
    "'TARGET=' + $s.TargetPath",
    "'ARGS=' + $s.Arguments",
    "'ICON=' + $s.IconLocation",
    "'DESC=' + $s.Description",
    "'WORKDIR=' + $s.WorkingDirectory",
  ].join("\n");
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePsCommand(script)],
    { encoding: "utf8", windowsHide: true, timeout: 30_000 },
  );
  const out: Record<string, string> = {};
  for (const line of (r.stdout ?? "").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

async function main() {
  // ── 1. 纯函数 ────────────────────────────────────────────────
  ok(shortcutPath("win32", { startMenuDir: ROOT }) === join(ROOT, WIN_SHORTCUT_FILE), "Windows 落点：Programs/小本本.lnk");
  ok(shortcutPath("linux", { xdgDataHome: ROOT }) === join(ROOT, "applications", LINUX_DESKTOP_FILE), "Linux 落点：applications/xbb.desktop");
  ok(shortcutPath("darwin") === null, "macOS 无对应机制（明确不做，而不是糊一个假图标）");

  const script = windowsShortcutScript({
    lnkPath: join(ROOT, "O'Brien", WIN_SHORTCUT_FILE),
    target: "C:\\Users\\O'Brien\\xbb.exe",
    args: SHORTCUT_ARGS,
    icon: "C:\\Users\\O'Brien\\xbb.exe,0",
    description: "d",
  });
  ok(script.includes("'C:\\Users\\O''Brien\\xbb.exe'"), "路径里的单引号被转义（否则脚本被撕开）");
  ok(script.includes("$s.Save()"), "最后一步是 Save()");

  // ── 2. Linux：真写一个 .desktop 并读回 ───────────────────────
  const xdg = join(ROOT, "xdg");
  {
    const lr = await ensureStartMenuShortcut({
      platform: "linux",
      compiled: true,
      exePath: "/opt/my apps/xbb",
      xdgDataHome: xdg,
      home: join(ROOT, "home"),
      env: {},
    });
    ok(lr.status === "created", `Linux .desktop 已创建（${lr.status}）`);
    const body = readFileSync(join(xdg, "applications", LINUX_DESKTOP_FILE), "utf8");
    ok(body.includes('Exec="/opt/my apps/xbb" start --open'), "Exec 带空格时加引号且参数完整");
    ok(body.includes("Terminal=true"), "Terminal=true（服务起没起来那句话要打出来）");
    ok(linuxDesktopEntry({ exec: "/usr/bin/xbb" }).includes("Name=小本本"), "Name=小本本");
    const again = await ensureStartMenuShortcut({
      platform: "linux",
      compiled: true,
      exePath: "/opt/my apps/xbb",
      xdgDataHome: xdg,
      home: join(ROOT, "home"),
      env: {},
    });
    ok(again.status === "exists", "Linux 第二次是 exists（幂等）");
    // 注意：图标字节由 `tray-assets.ts` 按**宿主**平台分叉（Windows 取 .ico），
    // 所以在本机模拟 Linux 时释放出来的是 xbb.ico —— 真实 Linux 上才是 .png。
    // 这里只断言"有 Icon= 且落在 XBB_HOME/icons"，不硬编码扩展名。
    ok(/^Icon=.*icons/m.test(body), "Linux .desktop 带 Icon= 且指向 <XBB_HOME>/icons");
  }

  // ── 3. 门槛 ─────────────────────────────────────────────────
  const dev = await ensureStartMenuShortcut({ platform: "win32", compiled: false, startMenuDir: join(ROOT, "dev") });
  ok(dev.status === "skipped" && !existsSync(join(ROOT, "dev")), "开发态跳过，且没有留下半成品文件");
  const off = await ensureStartMenuShortcut({
    platform: "win32",
    compiled: true,
    startMenuDir: join(ROOT, "off"),
    env: { [NO_SHORTCUT_ENV]: "1" },
  });
  ok(off.status === "skipped", `${NO_SHORTCUT_ENV} 能关掉`);

  // ── 4. Windows：真跑 PowerShell + COM 读回 ───────────────────
  if (process.platform !== "win32") {
    console.log("· 非 Windows 宿主：跳过 PowerShell 往返（纯函数部分已覆盖）");
    console.log(`shortcut smoke: ${pass}/${total} PASS`);
    cleanup();
    return;
  }
  const probe = spawnSync("powershell", ["-NoProfile", "-Command", "exit 0"], { windowsHide: true, timeout: 20_000 });
  if (probe.status !== 0) {
    console.log("· 本机没有可用的 powershell：跳过往返");
    console.log(`shortcut smoke: ${pass}/${total} PASS`);
    cleanup();
    return;
  }

  const sm = join(ROOT, "Start Menu", "Programs");
  // target 必须是**真实存在**的文件。原来写死 `C:\Users\O'Brien\...`（只为一个单引号，
  // 验注入面），在 Win11 桌面版上 `Save()` 容忍 target 不存在，在 Windows Server（CI）
  // 上直接抛 FileNotFoundException —— `Unable to save shortcut`，且错误里路径的中文被
  // 控制台代码页显示成 ???，一度被误导去查编码。这是未定义行为，不能当契约测：
  // 目录建在临时区里，单引号照样保留。
  const exeDir = join(ROOT, "O'Brien", ".xiaobenben", "bin");
  mkdirSync(exeDir, { recursive: true });
  const exe = join(exeDir, "xbb.exe");
  writeFileSync(exe, ""); // 内容无所谓，`Save()` 只要求路径存在
  const r1 = await ensureStartMenuShortcut({ platform: "win32", compiled: true, exePath: exe, startMenuDir: sm });
  const lnk = join(sm, WIN_SHORTCUT_FILE);
  // 诊断：CI（Windows Server）上 `Save()` 抛 FileNotFoundException，本地 Win11 桌面版
  // 从不复现，且日志里文件名被显示成 ???（是显示还是真被替换，光看日志分不出）。
  // 所以失败时用逐个字段递增的四组最小脚本定位到底是哪一步让 Save 挂掉。
  // 只在失败时跑，本地绿的时候一条都不执行。
  if (r1.status !== "created") {
    const icoDir = join(PROGHOME, "icons");
    const lines: string[] = [
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      `$t = ${psLiteral(exe)}`,
      `$w = ${psLiteral(exeDir)}`,
      `$d = ${psLiteral(icoDir)}`,
      `[Console]::Out.Write("LEN_JS_OK;ICODIR=" + [System.IO.Directory]::Exists($d) + ";ICO=" + [System.IO.File]::Exists(($d + '\\xbb.ico')) + ";")`,
    ];
    const combos: Array<[string, string[]]> = [
      ["A", []],
      ["B", ["$s.Arguments = 'start --open'", "$s.WorkingDirectory = $w"]],
      ["C", ["$s.Arguments = 'start --open'", "$s.WorkingDirectory = $w", "$s.IconLocation = ($d + '\\xbb.ico,0')"]],
      [
        "D",
        [
          "$s.Arguments = 'start --open'",
          "$s.WorkingDirectory = $w",
          "$s.IconLocation = ($d + '\\xbb.ico,0')",
          `$s.Description = ${psLiteral("小本本 · 面向 AI 的个人记忆库")}`,
        ],
      ],
    ];
    for (const [tag, extra] of combos) {
      const p = join(ROOT, `diag-${tag}.lnk`);
      lines.push(
        "try {",
        `$p = ${psLiteral(p)}`,
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($p)",
        "$s.TargetPath = $t",
        ...extra,
        "$s.Save()",
        `[Console]::Out.Write("${tag}=OK;")`,
        `} catch { [Console]::Out.Write("${tag}=FAIL:" + $_.Exception.GetType().Name + ";") }`,
      );
    }
    // E：与产品调用完全同构 —— 同一个 Programs 目录、同一个中文文件名、同一组字段
    // （含 WindowStyle）。A–D 全 ASCII 都过了，所以唯一剩下的变量就是中文文件名本身。
    // CNLEN 用「非 ASCII 码点数」判定路径到底被替换成 ??? 了没：长度判不出来，? 也占一位。
    lines.push(
      "try {",
      `$p = ${psLiteral(join(sm, "conf-小本本.lnk"))}`,
      `[Console]::Out.Write("CNLEN=" + ($p.ToCharArray() | Where-Object { [int]$_ -gt 127 }).Count + ";")`,
      "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($p)",
      "$s.TargetPath = $t",
      "$s.Arguments = 'start --open'",
      "$s.WorkingDirectory = $w",
      "$s.IconLocation = ($d + '\\xbb.ico,0')",
      `$s.Description = ${psLiteral("小本本 · 面向 AI 的个人记忆库")}`,
      "$s.WindowStyle = 1",
      "$s.Save()",
      `[Console]::Out.Write("E=OK;")`,
      `} catch { [Console]::Out.Write("E=FAIL:" + $_.Exception.GetType().Name + ";") }`,
    );
    const diag = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePsCommand(lines.join("\n"))],
      { encoding: "utf8", windowsHide: true },
    );
    console.log(`· 诊断（JS 侧路径长度 ${[...lnk].length}）｜${diag.stdout}｜stderr=${(diag.stderr ?? "").slice(0, 200)}`);
    console.log(`· 诊断：icons 目录内容 = ${existsSync(icoDir) ? (readdirSync(icoDir).join(",") || "空") : "目录不存在"}`);
    console.log(`· 诊断：SHORTCUT_ARGS=${SHORTCUT_ARGS}`);
  }
  ok(r1.status === "created", `真机 .lnk 已创建（${r1.status}${r1.message ? ` · ${r1.message}` : ""}）`);
  ok(existsSync(lnk), `.lnk 落在注入的 Programs 目录：${lnk}`);
  ok(readFileSync(lnk).readUInt32LE(0) === 0x4c, "文件头是 0x4C（真正的 Shell Link，不是随便改后缀的文件）");

  const back = readBack(lnk);
  ok(back.TARGET === exe, `COM 读回的目标一致：${back.TARGET}`);
  ok(back.ARGS === SHORTCUT_ARGS, `COM 读回的参数一致：${back.ARGS}`);
  // 图标口径：用托盘那一枚（裸书签），不是 exe 内嵌的红底板那枚。
  // 32px 下白书签压红底板，每条边都要做红→白过渡，底部 V 形缺口会糊成白斑（真机对比过）。
  const icoPath = join(PROGHOME, "icons", "xbb.ico");
  ok(back.ICON === `${icoPath},0`, `图标取自已释放的托盘 ico：${back.ICON}`);
  ok(readFileSync(icoPath).equals(readFileSync(join("assets", "tray.ico"))), "释放的字节 == assets/tray.ico（裸书签）");
  ok(!readFileSync(icoPath).equals(readFileSync(join("assets", "app.ico"))), "确实不是 exe 内嵌的那一枚（红底板）");
  ok(back.WORKDIR === exeDir, `工作目录＝程序目录：${back.WORKDIR}`);

  // 幂等：第二次必须是 exists，且**不刷新** mtime
  const before = statSync(lnk).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  const r2 = await ensureStartMenuShortcut({ platform: "win32", compiled: true, exePath: exe, startMenuDir: sm });
  ok(r2.status === "exists", "第二次调用是 exists");
  ok(statSync(lnk).mtimeMs === before, "已存在时不重写（否则「最近添加」会被天天刷新）");

  // 失败路径：注入一个必然报错的运行器，确认失败被吞掉且带回原因
  const bad = await ensureStartMenuShortcut({
    platform: "win32",
    compiled: true,
    startMenuDir: join(ROOT, "bad"),
    run: async () => ({ code: 1, out: "Access is denied" }),
  });
  ok(bad.status === "failed" && (bad.message ?? "").includes("Access is denied"), "PowerShell 失败 ⇒ failed，不抛异常");

  // 人为造一个"PowerShell 说成功但文件没写"的局面
  mkdirSync(join(ROOT, "silent"), { recursive: true });
  const silent = await ensureStartMenuShortcut({
    platform: "win32",
    compiled: true,
    startMenuDir: join(ROOT, "silent"),
    run: async () => ({ code: 0, out: "" }),
  });
  ok(silent.status === "failed", "返回成功但文件不在 ⇒ failed（不谎报创建成功）");

  console.log(`shortcut smoke: ${pass}/${total} PASS`);
  cleanup();
}

function cleanup(): void {
  if (PREV_XBB_HOME === undefined) delete process.env.XBB_HOME;
  else process.env.XBB_HOME = PREV_XBB_HOME;
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发占用，不该让冒烟失败 */
  }
}

main().catch((e) => {
  cleanup();
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
