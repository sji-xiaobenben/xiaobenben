// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 开机自启冒烟。
 *
 * 四条纪律：
 *  - **绝不碰真实的那条**：注册表往返一律用临时键名 `xbb-autostart-smoke-<pid>`；
 *    macOS/Linux 的文件往返全部落在 `mkdtemp()` 出来的临时 HOME 里，`XBB_HOME` 也临时改掉
 *    （偏好真源 `config.json` 就在那儿）。测完全清。
 *  - **形态闸必须有**：dev（`bun run`）下 `process.execPath` 是 bun 本体，写进启动项等于给
 *    用户埋一个"开机即失败"。本冒烟正是在 dev 形态下跑，所以这条断言**每次都在真验**。
 *  - **三平台都真跑一遍文件往返**，不靠"我读了文档所以它对"。Windows 宿主能验 POSIX 路径，
 *    因为路径全由 `home` 注入，与宿主平台无关。
 *  - **默认开启不能变成关不掉**：`off` 之后 `ensureAutostartDefault` 必须不再写回 —— 这条
 *    单独断言，它比"能开"更重要。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTOSTART_VALUE,
  LAUNCH_AGENT_LABEL,
  XDG_DESKTOP_FILE,
  autostartCommand,
  desktopExecQuote,
  detachedServeArgs,
  disableAutostart,
  enableAutostart,
  ensureAutostartDefault,
  launchAgentPath,
  launchAgentPlist,
  parseDesktopExec,
  parsePlistProgramArguments,
  parseWindowsExe,
  readAutostart,
  removeAutostartEntry,
  setAutostartPref,
  startupArgv,
  writeAutostartEntry,
  xdgAutostartPath,
  xdgDesktopEntry,
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

/** 临时根：既当 HOME（LaunchAgents / .config），也当 XBB_HOME（config.json 偏好）。 */
const ROOT = mkdtempSync(join(tmpdir(), "xbb-autostart-smoke-"));
const HOME = join(ROOT, "home");
const LOGDIR = join(ROOT, "logs");
mkdirSync(HOME, { recursive: true });

const PREV_XBB_HOME = process.env.XBB_HOME;
process.env.XBB_HOME = join(ROOT, "xbbhome"); // 隔离偏好文件，别动用户真实 config.json

// XDG_CONFIG_HOME 必须临时清掉：它是 Linux 上真正生效的那份配置根，
// 一旦继承宿主环境（GitHub 的 ubuntu runner 就设了），`home` 注入会被它盖过 ——
// 断言就会随宿主环境飘（本地绿、CI 红）。下面单独有一条用例把它设回来验优先级。
const PREV_XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
delete process.env.XDG_CONFIG_HOME;

const fakeShell = (code = 0, out = "") => () => ({ code, out });

async function main() {
  // ── 1. 纯函数：命令行与各平台 argv ───────────────────────────
  const cmd = autostartCommand("C:\\Program Files\\x y\\xbb.exe");
  ok(cmd === '"C:\\Program Files\\x y\\xbb.exe" serve --detach', `路径带空格也要加引号：${cmd}`);
  ok(cmd.includes("serve --detach"), "Windows 启动项指向 --detach（否则登录时挂一个黑窗口）");

  // macOS 刻意**不** detach：launchd 要能追踪真实 PID（理由见 src/autostart.ts 文件头）
  ok(
    JSON.stringify(startupArgv("darwin", "/Applications/xbb")) ===
      JSON.stringify(["/Applications/xbb", "serve", "--no-open"]),
    "macOS：launchd 直接托管，不 detach",
  );
  ok(
    JSON.stringify(startupArgv("linux", "/usr/local/bin/xbb")) ===
      JSON.stringify(["/usr/local/bin/xbb", "serve", "--detach"]),
    "Linux：.desktop 收不了日志 ⇒ 走 --detach（自带日志重定向）",
  );
  ok(
    JSON.stringify(startupArgv("win32", "C:\\xbb.exe")) === JSON.stringify(["C:\\xbb.exe", "serve", "--detach"]),
    "Windows：Run 键会被分配控制台窗口 ⇒ 走 --detach",
  );

  // ── 1b. 纯函数：detach 子进程 argv（2026-10-16 实测曾拼成 `serve serve`）──
  const a1 = detachedServeArgs(["serve", "--detach"]);
  ok(a1.filter((x) => x === "serve").length === 1, `argv 里只有一个 serve（实测曾为两个）：${JSON.stringify(a1)}`);
  ok(JSON.stringify(a1) === JSON.stringify(["serve", "--no-open"]), `剥掉 --detach 并自动补 --no-open：${JSON.stringify(a1)}`);
  const a2 = detachedServeArgs(["serve", "--detach", "--headless"]);
  ok(JSON.stringify(a2) === JSON.stringify(["serve", "--headless"]), `headless 不该再补 --no-open（CI 口径）：${JSON.stringify(a2)}`);
  const a3 = detachedServeArgs(["serve", "--no-open"]);
  ok(JSON.stringify(a3) === JSON.stringify(["serve", "--no-open"]), `已带 --no-open 不重复追加：${JSON.stringify(a3)}`);
  const a4 = detachedServeArgs(["--detach"]);
  ok(JSON.stringify(a4) === JSON.stringify(["serve", "--no-open"]), `容忍不含首位的调用形态：${JSON.stringify(a4)}`);

  // ── 1c. 纯函数：desktop Exec 的引号不是 shell 的引号 ──────────
  // 照 shell 直觉写在这里会静默失效（找不到程序，也没有任何报错）
  ok(desktopExecQuote("/usr/bin/xbb") === "/usr/bin/xbb", "无特殊字符不加引号");
  ok(desktopExecQuote("/opt/my apps/xbb") === '"/opt/my apps/xbb"', "含空格加双引号");
  ok(desktopExecQuote('/opt/a"b/xbb') === '"/opt/a\\"b/xbb"', '引号内的 " 必须反斜杠转义');
  ok(desktopExecQuote("/opt/$HOME/xbb") === '"/opt/\\$HOME/xbb"', "引号内的 $ 必须转义（否则被当变量）");
  ok(desktopExecQuote("/opt/a%20b/xbb") === "/opt/a%%20b/xbb", "% 是 field code，字面量写 %%");
  ok(parseDesktopExec('"/opt/my apps/xbb" serve --detach') === "/opt/my apps/xbb", "Exec 反解析：带引号");
  ok(parseDesktopExec("/usr/bin/xbb serve --detach") === "/usr/bin/xbb", "Exec 反解析：裸路径");
  ok(parseDesktopExec(desktopExecQuote("/opt/a b/xbb")) === "/opt/a b/xbb", "引号往返一致");

  ok(parseWindowsExe('"C:\\Users\\a b\\xbb.exe" serve --detach') === "C:\\Users\\a b\\xbb.exe", "Run 值解析：带引号");
  ok(parseWindowsExe("C:\\xbb.exe serve --detach") === "C:\\xbb.exe", "Run 值解析：裸路径 + 参数");
  ok(parseWindowsExe("C:\\Program Files\\xbb.exe serve") === "C:\\Program Files\\xbb.exe", "裸路径含空格时按 serve 切");

  // ── 2. macOS 文件往返（临时 HOME，真读写）────────────────────
  const macExe = "/Applications/小本本.app/Contents/MacOS/xbb";
  const macLog = join(LOGDIR, "serve.log");
  const plist = launchAgentPlist(macExe, macLog);
  ok(plist.includes(`<string>${LAUNCH_AGENT_LABEL}</string>`), "plist 带正确 label");
  ok(parsePlistProgramArguments(plist) === macExe, "plist 的 ProgramArguments[0] 往返一致（含中文路径）");
  ok(!/<key>KeepAlive<\/key>/.test(plist), "刻意不写 KeepAlive（避免端口占用/库损坏变成重启风暴）");
  ok(plist.includes("<key>RunAtLoad</key>"), "RunAtLoad 必须有（否则登录不启动）");
  ok(!/--\s*--/.test(plist.split("<!--").slice(1).join("<!--")), "XML 注释里不出现连续减号（否则 plist 非法）");

  const macOpts = { platform: "darwin" as const, home: HOME, exePath: macExe, logDir: LOGDIR, compiled: true, sh: fakeShell(0) };
  const macWrite = enableAutostart(macOpts);
  ok(macWrite.ok, `macOS 写入成功：${macWrite.message.split("\n")[0]}`);
  ok(existsSync(launchAgentPath(macOpts)), `plist 落在 ${launchAgentPath(macOpts)}`);
  const macBack = readAutostart(macOpts);
  ok(macBack.supported && macBack.present && macBack.enabled, "macOS 回读：存在且启用");
  ok(macBack.exePath === macExe, "macOS 回读出的 exePath 与写入一致");
  ok(readFileSync(launchAgentPath(macOpts), "utf8").includes(macLog), "plist 里带日志路径（无窗口时唯一的证据）");
  ok(disableAutostart(macOpts).ok && !existsSync(launchAgentPath(macOpts)), "macOS 删除后文件确实消失");
  ok(!readAutostart(macOpts).present, "macOS 删除后回读为未设置");

  // launchctl 失败不该让「开」变成失败：文件已就位，下次登录总会加载
  const macBootFail = enableAutostart({ ...macOpts, sh: fakeShell(1, "Bootstrap failed: 5: Input/output error") });
  ok(macBootFail.ok && macBootFail.message.includes("下次登录生效"), "launchctl bootstrap 失败不阻断（如实提示下次登录生效）");
  disableAutostart(macOpts);

  // ── 3. Linux 文件往返（临时 HOME，真读写）───────────────────
  const linExe = "/usr/local/bin/xbb";
  const linOpts = { platform: "linux" as const, home: HOME, exePath: linExe, compiled: true };
  const entry = xdgDesktopEntry(linExe);
  ok(entry.startsWith("[Desktop Entry]"), "desktop 文件有 [Desktop Entry] 段头");
  ok(/^Type=Application$/m.test(entry), "Type=Application");
  ok(/^Terminal=false$/m.test(entry), "Terminal=false（否则登录时开一个终端）");
  ok(/^X-GNOME-Autostart-enabled=true$/m.test(entry), "X-GNOME-Autostart-enabled=true");

  const linWrite = enableAutostart(linOpts);
  ok(linWrite.ok, `Linux 写入成功：${linWrite.message.split("\n")[0]}`);
  ok(xdgAutostartPath(linOpts) === join(HOME, ".config", "autostart", XDG_DESKTOP_FILE), "默认落在 ~/.config/autostart/");
  const linBack = readAutostart(linOpts);
  ok(linBack.present && linBack.enabled && linBack.exePath === linExe, "Linux 回读：存在、启用、路径一致");

  // 路径带空格：Exec 的引号规则是这里唯一容易写错的地方
  const spacedExe = "/opt/My Apps/xbb";
  ok(enableAutostart({ ...linOpts, exePath: spacedExe }).ok, "Linux：含空格的安装路径也能写");
  ok(readAutostart(linOpts).exePath === spacedExe, "Linux：含空格路径回读一致（引号没写错）");

  // 桌面环境把它关掉（Hidden=true）⇒ status 要如实反映"存在但被禁用"
  const p = xdgAutostartPath(linOpts);
  writeFileSync(p, readFileSync(p, "utf8").replace("X-GNOME-Autostart-enabled=true", "X-GNOME-Autostart-enabled=false"));
  const hidden = readAutostart(linOpts);
  ok(hidden.present && !hidden.enabled, "Linux：系统设置里禁用 ⇒ present 但 enabled=false（不谎报已开启）");

  ok(disableAutostart(linOpts).ok && !existsSync(p), "Linux 删除后文件确实消失");

  // XDG_CONFIG_HOME 是相对路径时按规范忽略，不能跟着 cwd 跑；
  // 绝对路径则**优先于** ~/.config —— 这条是 Linux 上真正生效的那份（桌面会话里通常已设）
  ok(
    xdgAutostartPath({ platform: "linux", home: HOME }) === join(HOME, ".config", "autostart", XDG_DESKTOP_FILE),
    "XDG_CONFIG_HOME 未设时回落到 ~/.config",
  );
  process.env.XDG_CONFIG_HOME = "/custom/xdg";
  ok(
    xdgAutostartPath({ platform: "linux", home: HOME }) === join("/custom/xdg", "autostart", XDG_DESKTOP_FILE),
    "XDG_CONFIG_HOME 为绝对路径时优先于 ~/.config（桌面会话的常态）",
  );
  process.env.XDG_CONFIG_HOME = "relative/xdg";
  ok(
    xdgAutostartPath({ platform: "linux", home: HOME }) === join(HOME, ".config", "autostart", XDG_DESKTOP_FILE),
    "XDG_CONFIG_HOME 为相对路径时按规范忽略（否则自启项会跟着 cwd 跑）",
  );
  delete process.env.XDG_CONFIG_HOME;

  // ── 4. 非 Windows：不再"假装不支持"，但要能识别未知平台 ─────
  ok(readAutostart({ platform: "darwin", home: HOME }).supported, "macOS：status 如实报告 supported=true");
  ok(readAutostart({ platform: "linux", home: HOME }).supported, "Linux：status 如实报告 supported=true");
  ok(!readAutostart({ platform: "freebsd", home: HOME }).supported, "未知平台：supported=false（不瞎猜文件位置）");
  ok(
    enableAutostart({ platform: "freebsd", exePath: "/usr/bin/xbb", compiled: true }).message.includes("暂不支持"),
    "未知平台开启时如实报未支持",
  );

  // ── 5. 形态闸：dev 形态拒绝写 ───────────────────────────────
  const gate = enableAutostart({ platform: "linux", home: HOME, exePath: "/usr/bin/xbb" });
  ok(!gate.ok && gate.message.includes("不是编译产物"), `dev 形态拒绝写入（${gate.message.slice(0, 40)}…）`);

  // ── 6. 默认开启（ensureAutostartDefault）─────────────────────
  // 6a. 首次：装好即开
  const ens1 = ensureAutostartDefault({ ...linOpts, exePath: linExe });
  ok(ens1.action === "enabled", `首次运行自动开启：${ens1.action}`);
  ok(readAutostart(linOpts).present, "自动开启后启动项确实存在");

  // 6b. 再跑一次：不该重复写（写操作会改 config.json 的 updatedAt，也会无谓地动系统状态）
  ok(ensureAutostartDefault(linOpts).action === "already", "已指向当前程序 ⇒ already，不重复写");

  // 6c. exe 换了位置（用户把程序挪走）：旧启动项指向一个不存在的路径，开机静默失败 —— 必须改写
  const moved = "/opt/new-place/xbb";
  const ens3 = ensureAutostartDefault({ ...linOpts, exePath: moved });
  ok(ens3.action === "enabled" && ens3.detail.includes("已更新"), `指向已失联的旧路径 ⇒ 改写（${ens3.action}）`);
  ok(readAutostart(linOpts).exePath === moved, "改写后回读指向新位置");

  // 6d. dev 形态不写（否则给 bun 本体塞一条开机项）
  ok(
    ensureAutostartDefault({ platform: "linux", home: HOME, exePath: moved }).action === "skipped",
    "非编译产物 ⇒ skipped（开发形态不碰启动项）",
  );

  // 6e. 用户关了 ⇒ 之后**永远不自动写回**（这条比"能开"重要：关不掉的开关叫偷装）
  setAutostartPref("off");
  const ens5 = ensureAutostartDefault({ ...linOpts, exePath: moved });
  ok(ens5.action === "disabled", `off 之后不再写回，且顺手清残留（${ens5.action}）`);
  ok(!readAutostart(linOpts).present, "off 之后启动项确实被清掉了");
  ok(ensureAutostartDefault(linOpts).action === "skipped", "off 且无残留 ⇒ skipped");

  // 6f. 用户重新打开 ⇒ 恢复默认开启
  setAutostartPref("on");
  ok(ensureAutostartDefault(linOpts).action === "enabled", "显式 on 之后恢复自动开启");
  disableAutostart(linOpts);

  // 6g. 被桌面环境禁用时不越权改回（那是用户的开关）
  enableAutostart(linOpts);
  const lp = xdgAutostartPath(linOpts);
  writeFileSync(lp, readFileSync(lp, "utf8").replace("X-GNOME-Autostart-enabled=true", "X-GNOME-Autostart-enabled=false"));
  const ens7 = ensureAutostartDefault(linOpts);
  ok(ens7.action === "skipped" && ens7.detail.includes("系统设置"), "系统设置里禁用 ⇒ 不擅自改回");
  ok(!readAutostart(linOpts).enabled, "确实保持禁用状态");
  disableAutostart(linOpts);

  // ── 7. Windows 注册表（注入假 reg 输出，三平台宿主都能跑）──
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
  ok(parsed.exePath === "C:\\Users\\a b\\.xiaobenben\\bin\\xbb.exe", "Run 值里解析出 exePath（改写判断要靠它）");
  ok(!readAutostart({ platform: "win32", valueName: "x", run: fake("错误: 系统找不到指定的注册表项或值。", 1) }).present, "reg 非零退出 ⇒ 视为未设置");
  const writeFail = writeAutostartEntry("x", { platform: "win32", valueName: SMOKE_VALUE, run: fake("拒绝访问", 1) });
  ok(!writeFail.ok && writeFail.message.includes("写入失败"), "写入被拒时如实报错（不静默）");

  // ── 8. 真注册表往返（仅 Windows 宿主）────────────────────────
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
      const realGate = enableAutostart({ valueName: SMOKE_VALUE });
      ok(!realGate.ok && realGate.message.includes("不是编译产物"), `dev 形态拒绝写入（${realGate.message.slice(0, 40)}…）`);

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
  cleanup();
  process.exit(0);
}

function cleanup(): void {
  if (PREV_XBB_HOME === undefined) delete process.env.XBB_HOME;
  else process.env.XBB_HOME = PREV_XBB_HOME;
  if (PREV_XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = PREV_XDG_CONFIG_HOME;
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发占用，不该让冒烟失败 */
  }
}

main().catch((e) => {
  removeAutostartEntry({ valueName: SMOKE_VALUE });
  cleanup();
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
