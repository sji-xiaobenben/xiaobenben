// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 开机自启 + 后台常驻（常驻服务要活过重启）。
 *
 * ## 补的是什么缺口
 *
 * 此前只能**手写**一个启动项指向 `"xbb.exe" serve`，代价有两个，都是登录那一刻的噪音：
 *  ① **带一个常驻控制台窗口**（控制台子系统程序由 Explorer 拉起就会分配控制台）；
 *  ② serve 启动时无条件 `openInBrowser()`，于是每次登录都**顺带弹一个管理页**。
 * 更糟的是这条手写项对用户完全不可见：没人知道它在哪、怎么关、关不关得掉。
 *
 * 本模块把它产品化：`on` 写一条指向后台形态的启动项；后台形态（见 `startupArgv`）
 * 保证**登录后没有任何窗口**；`off` 清掉；不带参数回读现状。
 *
 * ## 三平台口径（逐个都走系统**原生**的自启机制，不自造）
 *
 * | 平台 | 承载 | 位置 | argv |
 * |---|---|---|---|
 * | Windows | HKCU Run（免管理员） | `…\CurrentVersion\Run` → `小本本服务` | `serve --detach` |
 * | macOS | launchd LaunchAgent | `~/Library/LaunchAgents/net.xiaobenben.xbb.plist` | `serve --no-open` |
 * | Linux | XDG autostart | `${XDG_CONFIG_HOME:-~/.config}/autostart/xbb.desktop` | `serve --detach` |
 *
 * 两处**刻意的不对称**，都不是随手写的：
 *
 * - **macOS 不 detach。** launchd 本身就是正牌守护进程管理者：直接托管 `serve --no-open`
 *   才能让 `launchctl list` 看到真实 PID、日志由 plist 的 `StandardOutPath` 接管。若这里再
 *   detach 一跳，launchd 追踪的只是一个瞬间退出的启动器，"服务到底活着没有"反而查不到。
 * - **Windows / Linux 必须 detach。** Run 键由 Explorer 拉起会分配控制台窗口；`.desktop`
 *   的 `Exec` 不是 shell、写不了重定向，日志没地方去。让 xbb 自己 detach：子进程无窗口、
 *   日志进 `serve.log`、启动器闪一下即退。Linux 桌面会话不追踪进程，没有副作用。
 *
 * 三个平台都**不设**"崩了自动重启"（launchd 的 `KeepAlive`）：与 Windows Run 键语义一致
 * ——登录时启动一次，崩了就崩了。带了自动重启，端口被占 / 库损坏这类"每次都失败"会变成
 * 重启风暴，而用户只看到日志在长。
 *
 * ## 真源是有序的，别搞错
 *
 * 「开机要不要启动我」这件事有两个来源：系统里的启动项（**现状**）与本模块的偏好
 * `config.json.autostart`（**用户意图**）。两者不可混：
 *  - 偏好 `off` ⇒ 永不自动写回（否则 `xbb autostart off` 下次启动就被悄悄改回来，等于关不掉）；
 *  - 偏好缺省/`on` ⇒ 启动项缺失、或指向的程序已经不是当前这份（用户把 exe 挪了位置）时，
 *    `ensureAutostartDefault()` 补写/改写。
 */
import { programDir, readHomeConfig, writeHomeConfig } from "./home";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { isCompiledExe } from "./updater";

/** HKCU 启动项：免管理员，且是"当前用户登录即启"的既有机制。 */
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/**
 * Windows 启动项名。**刻意沿用既有安装里已存在的那一条**（同名即覆盖），所以 `autostart on`
 * 会顺手把那条裸 `serve` 的手写项升级成 `serve --detach`，不留两条互相打架的记录。
 */
export const AUTOSTART_VALUE = "小本本服务";

/** macOS 的 launchd label。用反域名：与 `net.xiaobenben.xbb` 协议注册同一命名空间。 */
export const LAUNCH_AGENT_LABEL = "net.xiaobenben.xbb";

/** Linux 的 XDG 自启文件名。 */
export const XDG_DESKTOP_FILE = "xbb.desktop";

/** 单实例探测用：服务端 healthz。 */
const HEALTHZ = "http://127.0.0.1:17630/healthz";

interface RunResult {
  code: number;
  out: string;
}
type RegRunner = (args: string[]) => RunResult;
type ShellRunner = (cmd: string, args: string[]) => RunResult;

function regRun(args: string[]): RunResult {
  const r = spawnSync("reg", args, { encoding: "utf8", windowsHide: true });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function shellRun(cmd: string, args: string[]): RunResult {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/**
 * 可注入依赖。
 *
 * `home` / `xdgConfigHome` / `sh` 让 macOS 与 Linux 的**文件往返**能在任意宿主的临时目录里
 * 真跑一遍（Windows 上也能验 POSIX 路径），不必先找一台 Mac。`compiled` 只给测试用 ——
 * 产品路径一律走 `isCompiledExe()`，否则"能不能写启动项"就变成参数说了算。
 */
export interface AutostartOpts {
  platform?: NodeJS.Platform;
  valueName?: string;
  run?: RegRunner;
  exePath?: string;
  /** 注入 launchctl 运行器（替换真 launchctl）。 */
  sh?: ShellRunner;
  /** 覆盖用户主目录：让 POSIX 路径往返不碰真实登录项。 */
  home?: string;
  /** 覆盖 XDG_CONFIG_HOME（Linux）。按规范只认绝对路径，相对值忽略。 */
  xdgConfigHome?: string;
  /** 覆盖「是否编译产物」判定，**只给测试用**。 */
  compiled?: boolean;
  /** 覆盖日志目录（默认 `<程序目录>/logs`）。 */
  logDir?: string;
}

function platformOf(o: AutostartOpts): NodeJS.Platform {
  return o.platform ?? process.platform;
}

function homeOf(o: AutostartOpts): string {
  return o.home ?? homedir();
}

/** macOS LaunchAgent 的落盘位置。 */
export function launchAgentPath(o: AutostartOpts = {}): string {
  return join(homeOf(o), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

/** Linux XDG 自启项的落盘位置。 */
export function xdgAutostartPath(o: AutostartOpts = {}): string {
  const env = process.env.XDG_CONFIG_HOME;
  // XDG Base Directory 规范：相对路径视为**未设置**（不能让自启项跟着 cwd 跑）
  const base = o.xdgConfigHome ?? (env && env.startsWith("/") ? env : join(homeOf(o), ".config"));
  return join(base, "autostart", XDG_DESKTOP_FILE);
}

/** 纯函数：Windows/Linux 启动项里的命令行。用引号包住路径 —— 用户名带空格时裸路径会被拆成两段。 */
export function autostartCommand(exePath: string): string {
  return `"${exePath}" serve --detach`;
}

/**
 * 纯函数：各平台真正的启动 argv（**形态差异的唯一定义处**，理由见文件头）。
 *
 * Windows 与 Linux 用 `--detach`（登录宿主会给控制台窗口 / 收不了日志），
 * macOS 交给 launchd 直接托管。
 */
export function startupArgv(platform: NodeJS.Platform, exePath: string): string[] {
  return platform === "darwin" ? [exePath, "serve", "--no-open"] : [exePath, "serve", "--detach"];
}

export interface AutostartStatus {
  supported: boolean;
  /** 启动项存在（注册表值 / plist / desktop 文件） */
  present: boolean;
  /** 存在且**未被外部禁用**（Linux 的 `Hidden=true` / `X-GNOME-Autostart-enabled=false`） */
  enabled: boolean;
  /** 完整命令行（status 输出用） */
  command: string | null;
  /** 从启动项里解析出的可执行文件路径 —— 「指向的还是不是我」只能靠它比，不能比整条字符串 */
  exePath: string | null;
  /** 人看的存放位置（三平台各不同，status 直接打印这一行） */
  location: string;
}

function emptyStatus(location: string, supported = true): AutostartStatus {
  return { supported, present: false, enabled: false, command: null, exePath: null, location };
}

/** 路径相等：去尾部分隔符，Windows 大小写不敏感（POSIX 敏感）。 */
function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const strip = (s: string) => s.replace(/[\\/]+$/, "");
  const x = strip(a);
  const y = strip(b);
  return platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// ── Windows：注册表值就是一条命令字符串 ─────────────────────────────

/** 从 Run 值里剥出可执行文件路径（可能带引号，也可能裸写含空格）。 */
export function parseWindowsExe(command: string): string | null {
  const s = command.trim();
  if (!s) return null;
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    return end > 1 ? s.slice(1, end) : null;
  }
  // 裸路径 + 参数：`serve` 是唯一已知的动词，按它切最稳
  const m = /^(.*?)\s+serve(\s|$)/i.exec(s);
  return (m ? m[1] : s).trim() || null;
}

function readRegistry(o: AutostartOpts): AutostartStatus {
  const valueName = o.valueName ?? AUTOSTART_VALUE;
  const location = `${RUN_KEY} → ${valueName}`;
  const r = (o.run ?? regRun)(["query", RUN_KEY, "/v", valueName]);
  if (r.code !== 0) return emptyStatus(location);
  // 形如：`    小本本服务    REG_SZ    "C:\…\xbb.exe" serve --detach`
  const m = /REG_SZ\s+([\s\S]*?)\s*$/m.exec(r.out);
  const command = (m?.[1] ?? "").trim();
  return {
    supported: true,
    present: true,
    enabled: true,
    command,
    exePath: parseWindowsExe(command),
    location,
  };
}

/**
 * 底层写入（Windows 专用，**不含**形态校验）：写启动项并回读验证。抽出来单测，让冒烟能在
 * 真注册表上用一个临时键名跑完整往返，而不必先把 `process.execPath` 变成编译产物。
 *
 * POSIX 上别调它 —— 那边的承载是文件，见 `writeLaunchAgent` / `writeXdgEntry`。
 */
export function writeAutostartEntry(command: string, o: AutostartOpts = {}): AutostartResult {
  if (platformOf(o) !== "win32") {
    return { ok: false, message: `writeAutostartEntry 只用于 Windows 注册表（当前 ${platformOf(o)}）` };
  }
  const valueName = o.valueName ?? AUTOSTART_VALUE;
  const r = (o.run ?? regRun)(["add", RUN_KEY, "/v", valueName, "/t", "REG_SZ", "/d", command, "/f"]);
  if (r.code !== 0) return { ok: false, message: `写入失败（reg 退出码 ${r.code}）：${r.out.trim()}` };

  const back = readRegistry({ ...o, valueName });
  if (!back.present || back.command !== command) {
    return { ok: false, message: `回读不一致 —— 期望 ${command}，实际 ${back.command ?? "(无)"}` };
  }
  return { ok: true, message: `${valueName} = ${command}` };
}

/** 底层删除（Windows 专用）。已经不存在也算成功（幂等），但会如实说明。 */
export function removeAutostartEntry(o: AutostartOpts = {}): AutostartResult {
  if (platformOf(o) !== "win32") {
    return { ok: false, message: `removeAutostartEntry 只用于 Windows 注册表（当前 ${platformOf(o)}）` };
  }
  const valueName = o.valueName ?? AUTOSTART_VALUE;
  const before = readRegistry({ ...o, valueName });
  if (!before.present) return { ok: true, message: `本就没有「${valueName}」，无需处理` };

  const r = (o.run ?? regRun)(["delete", RUN_KEY, "/v", valueName, "/f"]);
  if (r.code !== 0) return { ok: false, message: `删除失败（reg 退出码 ${r.code}）：${r.out.trim()}` };
  const after = readRegistry({ ...o, valueName });
  if (after.present) return { ok: false, message: "删除后回读仍存在（可能被组策略重新写回）" };
  return { ok: true, message: `已移除「${valueName}」（原值 ${before.command ?? "-"}）` };
}

// ── macOS：LaunchAgent plist ──────────────────────────────────────

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlUnescape(s: string): string {
  // `&amp;` 必须最后换，否则 `&amp;lt;` 会被二次解码成 `<`
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * 纯函数：生成 LaunchAgent plist。
 *
 * 刻意不写 `KeepAlive`，理由见文件头（避免重启风暴）。`LimitLoadToSessionType=Aqua` 让它
 * 只在图形登录会话加载 —— 无 GUI 就没有托盘，起服务没有意义。
 */
export function launchAgentPlist(exePath: string, logPath: string): string {
  const argv = startupArgv("darwin", exePath)
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join("\n");
  // plist 是 XML，注释里不能出现连续两个减号；下列注释已刻意避开。
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

/** 纯函数：从 plist 里读 `ProgramArguments` 的第一项（即可执行文件）。 */
export function parsePlistProgramArguments(xml: string): string | null {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
  if (!block) return null;
  const first = /<string>([\s\S]*?)<\/string>/.exec(block[1]);
  return first ? xmlUnescape(first[1]) : null;
}

function readLaunchAgent(o: AutostartOpts): AutostartStatus {
  const p = launchAgentPath(o);
  const location = `${p}（launchd · ${LAUNCH_AGENT_LABEL}）`;
  if (!existsSync(p)) return emptyStatus(location);
  let xml = "";
  try {
    xml = readFileSync(p, "utf8");
  } catch {
    return emptyStatus(location);
  }
  const exe = parsePlistProgramArguments(xml);
  return {
    supported: true,
    present: true,
    enabled: true,
    command: exe ? `${exe} serve --no-open（launchd 托管）` : null,
    exePath: exe,
    location,
  };
}

function launchctlDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  return `gui/${uid}`;
}

function writeLaunchAgent(exePath: string, o: AutostartOpts): AutostartResult {
  const p = launchAgentPath(o);
  const log = join(o.logDir ?? join(programDir(), "logs"), "serve.log");
  try {
    mkdirSync(dirname(p), { recursive: true });
    // 日志目录建不了不该挡住自启：plist 指向一个不存在的路径时 launchd 会自己忽略
    try {
      mkdirSync(dirname(log), { recursive: true });
    } catch {
      /* 忽略 */
    }
    writeFileSync(p, launchAgentPlist(exePath, log), "utf8");
    chmodSync(p, 0o644); // launchd 对 0644 之外的世界可写 plist 会拒收
  } catch (e) {
    return { ok: false, message: `写入失败：${e instanceof Error ? e.message : String(e)}` };
  }

  const back = readLaunchAgent(o);
  if (!back.present || !back.exePath || !samePath(back.exePath, exePath, "darwin")) {
    return { ok: false, message: `回读不一致 —— 期望 ${exePath}，实际 ${back.exePath ?? "(无)"}` };
  }

  // 立刻生效，不必等下次登录。**bootstrap 失败不算失败**：文件已就位、下次登录总会加载，
  // 而 `gui/<uid>` 域在无图形会话的环境（CI、ssh）里压根不存在。
  const run = o.sh ?? shellRun;
  run("launchctl", ["bootout", launchctlDomain(), p]); // 幂等；未加载时非零，忽略
  const boot = run("launchctl", ["bootstrap", launchctlDomain(), p]);
  const note =
    boot.code === 0
      ? ""
      : `\n   （launchctl bootstrap 未即时生效，文件已就位，下次登录生效：${boot.out.trim().slice(0, 200)}）`;
  return { ok: true, message: `${p}\n   命令: ${startupArgv("darwin", exePath).join(" ")}${note}` };
}

function removeLaunchAgent(o: AutostartOpts): AutostartResult {
  const p = launchAgentPath(o);
  if (!existsSync(p)) return { ok: true, message: `本就没有 ${p}，无需处理` };

  // 先卸再删：只删文件不 unload，plist 已登记的作业会一直活到本次登录结束
  const run = o.sh ?? shellRun;
  const out = run("launchctl", ["bootout", launchctlDomain(), p]);
  try {
    rmSync(p);
  } catch (e) {
    return { ok: false, message: `删除失败：${e instanceof Error ? e.message : String(e)}` };
  }
  if (existsSync(p)) return { ok: false, message: "删除后文件仍存在（权限不足？）" };
  const note = out.code === 0 ? "" : `\n   （launchctl bootout 非零退码，可能本就未加载：${out.out.trim().slice(0, 160)}）`;
  return { ok: true, message: `已移除 ${p}${note}` };
}

// ── Linux：XDG autostart ─────────────────────────────────────────

/**
 * 纯函数：XDG 自启项的 `Exec` 字段转义。
 *
 * desktop entry 的 `Exec` **不是 shell**：没有变量展开、没有重定向、引号规则也自成一套
 * （规范：含空格等保留字符时用双引号包裹，引号内 `"` `` ` `` `$` `\` 需反斜杠转义；
 * `%` 是 field code，字面量必须写成 `%%`）。照 shell 的直觉写，路径带空格就静默失效。
 */
export function desktopExecQuote(p: string): string {
  const pct = p.replace(/%/g, "%%");
  if (!/[\s"'\\`$<>~|&;*?#()\[\]{}]/.test(pct)) return pct;
  return `"${pct.replace(/(["`$\\])/g, "\\$1")}"`;
}

/** 纯函数：生成 XDG 自启项。 */
export function xdgDesktopEntry(exePath: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=小本本",
    "Name[en]=Xiaobenben",
    "Comment=本地优先的 AI 记忆库（后台常驻服务）",
    `Exec=${desktopExecQuote(exePath)} serve --detach`,
    "Terminal=false",
    "NoDisplay=false",
    "Categories=Utility;",
    "X-GNOME-Autostart-enabled=true",
    // 登录后等 3s：GNOME/KDE 登录瞬间 session bus 与磁盘都在忙，抢跑只会多一条"端口未就绪"
    "X-GNOME-Autostart-Delay=3",
    "",
  ].join("\n");
}

/** 纯函数：从 `Exec=` 值里取回可执行文件路径（`desktopExecQuote` 的逆）。 */
export function parseDesktopExec(exec: string): string | null {
  const s = exec.trim();
  if (!s) return null;
  let raw: string;
  if (s.startsWith('"')) {
    let out = "";
    let i = 1;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === "\\" && i + 1 < s.length) {
        out += s[++i];
        continue;
      }
      if (c === '"') break;
      out += c;
    }
    raw = out;
  } else {
    const sp = s.indexOf(" ");
    raw = sp < 0 ? s : s.slice(0, sp);
  }
  return raw.replace(/%%/g, "%") || null;
}

function readXdg(o: AutostartOpts): AutostartStatus {
  const p = xdgAutostartPath(o);
  const location = `${p}（XDG 自启项）`;
  if (!existsSync(p)) return emptyStatus(location);
  let txt = "";
  try {
    txt = readFileSync(p, "utf8");
  } catch {
    return emptyStatus(location);
  }
  const exec = /^Exec\s*=\s*(.+)$/m.exec(txt)?.[1] ?? "";
  const exe = parseDesktopExec(exec);
  // 桌面环境的「启动应用程序」里关掉会表现成这两个键 —— 那是**用户的开关**，要如实反映
  const disabled = /^Hidden\s*=\s*true\s*$/im.test(txt) || /^X-GNOME-Autostart-enabled\s*=\s*false\s*$/im.test(txt);
  return {
    supported: true,
    present: true,
    enabled: !disabled,
    command: exe ? `${exe} serve --detach` : null,
    exePath: exe,
    location,
  };
}

function writeXdgEntry(exePath: string, o: AutostartOpts): AutostartResult {
  const p = xdgAutostartPath(o);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, xdgDesktopEntry(exePath), { encoding: "utf8", mode: 0o644 });
    chmodSync(p, 0o644); // 0600 的 desktop 文件部分桌面环境读不到
  } catch (e) {
    return { ok: false, message: `写入失败：${e instanceof Error ? e.message : String(e)}` };
  }
  const back = readXdg(o);
  if (!back.present || !back.enabled || !back.exePath || !samePath(back.exePath, exePath, "linux")) {
    return { ok: false, message: `回读不一致 —— 期望 ${exePath}，实际 ${back.exePath ?? "(无)"}` };
  }
  return { ok: true, message: `${p}\n   命令: ${startupArgv("linux", exePath).join(" ")}` };
}

function removeXdgEntry(o: AutostartOpts): AutostartResult {
  const p = xdgAutostartPath(o);
  if (!existsSync(p)) return { ok: true, message: `本就没有 ${p}，无需处理` };
  try {
    rmSync(p);
  } catch (e) {
    return { ok: false, message: `删除失败：${e instanceof Error ? e.message : String(e)}` };
  }
  if (existsSync(p)) return { ok: false, message: "删除后文件仍存在（权限不足？）" };
  return { ok: true, message: `已移除 ${p}` };
}

// ── 平台分发 ────────────────────────────────────────────────────

/** 读现状（回读真实系统状态，不猜）。 */
export function readAutostart(o: AutostartOpts = {}): AutostartStatus {
  switch (platformOf(o)) {
    case "win32":
      return readRegistry(o);
    case "darwin":
      return readLaunchAgent(o);
    case "linux":
      return readXdg(o);
    default:
      return emptyStatus(`${platformOf(o)} 无已知自启机制`, false);
  }
}

export interface AutostartResult {
  ok: boolean;
  message: string;
}

/** 产品级开：先过形态闸，再写启动项。 */
export function enableAutostart(o: AutostartOpts = {}): AutostartResult {
  const platform = platformOf(o);
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    return { ok: false, message: autostartUnsupportedMessage(platform) };
  }
  const exe = o.exePath ?? process.execPath;

  // 开发形态下 `process.execPath` 是 **bun 本体**：写进启动项等于让开机跑一个"bun serve"，
  // 而 bun 在别处没有 tsconfig/paths 与 node_modules ⇒ 起不来（更别提 `bun run` 形态下
  // 连 `import.meta.dir` 都不指向仓库）。宁可拒绝，也不能写一条开机即败的坏项。
  // 用的就是自更新那道同源保命闸：**只有编译产物才允许改"以后怎么启动自己"**。
  if (!(o.compiled ?? isCompiledExe())) {
    return {
      ok: false,
      message: `拒绝写入：当前不是编译产物（${exe}）。请用安装后的 xbb 执行本命令。`,
    };
  }
  // Windows 的 Run 值必须指向 .exe：写个无后缀路径 Explorer 也不认。
  // POSIX **不能**套这条 —— macOS/Linux 的编译产物本来就叫 `xbb`，加了这个判断会把两个平台
  // 全部拒掉（真事：这条曾让 POSIX 的 enableAutostart 永远返回"不是编译产物"）。
  if (platform === "win32" && !/\.exe$/i.test(exe)) {
    return { ok: false, message: `拒绝写入：Windows 启动项必须指向 .exe（当前 ${exe}）` };
  }

  switch (platform) {
    case "win32":
      return writeAutostartEntry(autostartCommand(exe), o);
    case "darwin":
      return writeLaunchAgent(exe, o);
    default:
      return writeXdgEntry(exe, o);
  }
}

/** 产品级关。 */
export function disableAutostart(o: AutostartOpts = {}): AutostartResult {
  switch (platformOf(o)) {
    case "win32":
      return removeAutostartEntry(o);
    case "darwin":
      return removeLaunchAgent(o);
    case "linux":
      return removeXdgEntry(o);
    default:
      return { ok: false, message: autostartUnsupportedMessage(platformOf(o)) };
  }
}

export function autostartUnsupportedMessage(platform: string = process.platform): string {
  return (
    `${platform} 暂不支持自动配置开机自启（已落地 Windows / macOS / Linux）。\n` +
    "  其它平台：用系统自带的服务管理器指向 `xbb serve --no-open`。"
  );
}

// ── 用户意图（默认开启 / 永久关闭）──────────────────────────────────

/** 用户意图。缺省（未设置）= 按默认开启；`off` = 用户明确关过，别再自动打开。 */
export type AutostartPref = "on" | "off";

export function readAutostartPref(): AutostartPref | undefined {
  return readHomeConfig()?.autostart;
}

/** 记下意图。`off` 是**粘的**：serve 每次启动都会读它，读到 off 就不写启动项。 */
export function setAutostartPref(pref: AutostartPref): void {
  writeHomeConfig({ autostart: pref }, "autostart");
}

export type EnsureAction = "enabled" | "already" | "disabled" | "skipped" | "failed" | "unsupported";

export interface EnsureResult {
  action: EnsureAction;
  detail: string;
}

/**
 * 开机自启的**默认态**：装好就能用，不需要用户先敲一条命令。
 *
 * 三条判断，顺序不能换：
 *  ① 偏好 `off` ⇒ 直接跳过。这是"默认开启"能成立的前提 —— 没有它，`xbb autostart off`
 *     会在下次启动被悄悄写回来，用户会觉得关不掉（那种软件会被骂）。
 *  ② 非编译产物 ⇒ 跳过。开发形态 `process.execPath` 是 bun，写进去是条开机即败的坏项。
 *  ③ 启动项指向的已经不是当前这份 exe ⇒ **改写**。用户把 exe 从下载目录挪到别处后，
 *     旧启动项会指向一个不存在的路径，开机时静默失败，而他从任何界面都看不出来。
 *
 * 绝不因为自启失败而打断 serve：这是增强，不是必需。
 */
export function ensureAutostartDefault(o: AutostartOpts = {}): EnsureResult {
  const platform = platformOf(o);
  try {
    const pref = readAutostartPref();
    if (pref === "off") {
      // 关了就该真的关掉：上次删除失败、或启动项被外部重新加回来时，顺手再清一次。
      // 只读检查一次（几十毫秒），不清就没有第二次机会 —— 用户以为关了，系统里还留着。
      const st = readAutostart(o);
      if (!st.present) {
        return { action: "skipped", detail: "用户已关闭开机自启（xbb autostart on 可重新开启）" };
      }
      const r = disableAutostart(o);
      return r.ok
        ? { action: "disabled", detail: `已按用户意图移除残留启动项：${r.message}` }
        : { action: "failed", detail: `用户已关闭，但残留启动项移除失败：${r.message}` };
    }
    if (!(o.compiled ?? isCompiledExe())) {
      return { action: "skipped", detail: "当前不是编译产物（开发形态），不写启动项" };
    }

    const st = readAutostart(o);
    if (!st.supported) return { action: "unsupported", detail: autostartUnsupportedMessage(platform) };

    const exe = o.exePath ?? process.execPath;
    if (st.present && st.enabled && st.exePath && samePath(st.exePath, exe, platform)) {
      return { action: "already", detail: `已指向当前程序（${st.location}）` };
    }
    // 被桌面环境显式禁用（GNOME「启动应用程序」里关掉）⇒ 那是用户的开关，不越权改回
    if (st.present && !st.enabled) {
      return { action: "skipped", detail: `启动项已被系统设置禁用（${st.location}），不擅自改回` };
    }

    const r = enableAutostart(o);
    return r.ok
      ? { action: "enabled", detail: `${st.present ? "已更新" : "已开启"}：${r.message}` }
      : { action: "failed", detail: r.message };
  } catch (e) {
    return { action: "failed", detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── 后台常驻（`--detach`）────────────────────────────────────────

/**
 * 拼「真正跑服务」那个无窗口子进程的 argv。
 *
 * ⚠️ **踩过的坑（2026-10-16 实测）**：唯一调用点 `index.ts` 传的是**整条 `args`** ——
 * `args = process.argv.slice(2)` 且 `args[0] === "serve"`。早先这里只 `filter` 掉 `--detach`
 * 就又在 spawn 时补了一个 `"serve"`，于是命令行拼成 `xbb.exe serve serve --no-open`
 * （`ps` / 进程表里肉眼可见的重复）。
 *
 * 当时不出事**纯属巧合**：serve 分支只读 `args[0]` 与各标志位，多余的那个 token 没人读。
 * 但它有两个真实代价：① 排障时误导（双 `serve` 看着像参数错传，实际白查）；② 一旦 `serve`
 * 将来接位置参数（如 `serve <port>`）立刻炸。
 *
 * 这里显式剥掉首位的 `serve`，并把 argv 的正确性收进一个**可单测的纯函数**。
 * 之所以要导出：原逻辑藏在一个必定 `process.exit()` 的异步流程里，测试进程调不得
 * （一调就把冒烟自己杀了）—— 这正是它一直没被覆盖的原因。
 */
export function detachedServeArgs(rawArgs: string[]): string[] {
  const rest = (rawArgs[0] === "serve" ? rawArgs.slice(1) : rawArgs).filter((a) => a !== "--detach");
  // 后台启动还弹浏览器是自相矛盾的：没人坐在那里等这个页面。
  if (!rest.includes("--headless") && !rest.includes("--no-open")) rest.push("--no-open");
  return ["serve", ...rest];
}

/**
 * `--detach`：把自己从当前控制台**分离出去**再返回，真正的服务跑在无窗口子进程里。
 *
 * 为什么需要这一跳，而不是让 Run 键直接指 `serve`：
 * Run 项由 Explorer 用 CreateProcess 拉起，**控制台子系统程序必被分配一个窗口** ⇒ 登录后
 * 常驻一个黑窗口。而 `spawn(..., { windowsHide: true })` 是 `CREATE_NO_WINDOW` ——
 * 子进程有控制台对象但**不显示窗口**。于是：启动器闪一下即退，服务全程无窗口。
 *
 * 副作用与对策：看不到窗口 ≠ 没有证据。子进程 stdout/stderr 一律重定向到
 * `XBB_HOME/logs/serve.log`（超 1MB 自动重开），"为什么没起来"随时可查。
 */
export async function launchDetachedServe(rawArgs: string[]): Promise<never> {
  // 已在跑就直接说清，不再起第二个（端口只有一个，第二个必然 bind 失败并污染日志）
  const alive = await isServeAlive();
  if (alive) {
    console.log("[xbb] 常驻服务已在运行，无需重复启动（127.0.0.1:17630）");
    process.exit(0);
  }

  const argv = detachedServeArgs(rawArgs);

  const home = programDir();
  const log = join(home, "logs", "serve.log");
  let stdio: "ignore" | ["ignore", number, number] = "ignore";
  try {
    mkdirSync(dirname(log), { recursive: true });
    try {
      if (statSync(log).size > 1_000_000) rmSync(log); // 常驻日志滚动：不做的话是慢性写满磁盘
    } catch {
      /* 首次运行 */
    }
    const fd = openSync(log, "a");
    stdio = ["ignore", fd, fd];
  } catch {
    /* 拿不到日志文件也不能挡住启动 */
  }

  const child = spawn(process.execPath, argv, {
    detached: true, // 脱离当前进程组：父进程退出不带它走
    stdio,
    windowsHide: true, // CREATE_NO_WINDOW：真正的服务不留任何窗口
  });
  child.unref();
  console.log(`[xbb] 已在后台启动常驻服务（PID ${child.pid ?? "?"}）`);
  console.log(`      日志: ${log}`);
  process.exit(0);
}

async function isServeAlive(): Promise<boolean> {
  try {
    const res = await fetch(HEALTHZ, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}
