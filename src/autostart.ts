// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 开机自启 + 后台常驻（常驻服务要活过重启）。
 *
 * ## 补的是什么缺口
 *
 * 此前只能**手写** `HKCU\…\Run` 指向 `"xbb.exe" serve`，代价有两个，都是登录那一刻的噪音：
 *  ① **带一个常驻控制台窗口**（控制台子系统程序由 Explorer 拉起就会分配控制台）；
 *  ② serve 启动时无条件 `openInBrowser()`，于是每次登录都**顺带弹一个管理页**。
 * 更糟的是这条手写项对用户完全不可见：没人知道它在哪、怎么关、关不关得掉。
 *
 * 本模块把它产品化：`on` 写一条指向 `serve --detach` 的启动项；`--detach`（见
 * `launchDetachedServe`）把真正的服务以 `CREATE_NO_WINDOW` 拉起 ⇒ **登录后没有任何窗口**；
 * `off` 清掉；不带参数回读现状。
 *
 * ## 平台口径
 *
 * Windows 走 HKCU Run（免管理员，与 `xubb://` 协议注册同一路子）。
 * macOS / Linux **暂未实现，且刻意不"猜着写"** —— 与其发一个没在真机上验过的 launchd plist /
 * XDG desktop 文件，不如明确报"未支持"并给出可粘贴的手工配置
 * （同 `notify.ts` 第 3 条：不做假的能力）。
 */
import { programDir } from "./home";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isCompiledExe } from "./updater";

/** HKCU 启动项：免管理员，且是"当前用户登录即启"的既有机制。 */
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/**
 * 启动项名。**刻意沿用既有安装里已存在的那一条**（同名即覆盖），所以 `autostart on` 会顺手
 * 把那条裸 `serve` 的手写项升级成 `serve --detach`，不留两条互相打架的记录。
 */
export const AUTOSTART_VALUE = "小本本服务";

/** 单实例探测用：服务端 healthz。 */
const HEALTHZ = "http://127.0.0.1:17630/healthz";

interface RegResult {
  code: number;
  out: string;
}
type RegRunner = (args: string[]) => RegResult;

function regRun(args: string[]): RegResult {
  const r = spawnSync("reg", args, { encoding: "utf8", windowsHide: true });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** 可注入依赖（`valueName` + `run` 让冒烟在真注册表上用一个临时键名跑，不碰真实那一条）。 */
export interface AutostartOpts {
  platform?: NodeJS.Platform;
  valueName?: string;
  run?: RegRunner;
  exePath?: string;
}

/** 纯函数：启动项要写的命令行。用引号包住路径 —— 用户名带空格时裸路径会被拆成两段。 */
export function autostartCommand(exePath: string): string {
  return `"${exePath}" serve --detach`;
}

export interface AutostartStatus {
  supported: boolean;
  present: boolean;
  command: string | null;
}

/** 读现状（回读注册表，不猜）。 */
export function readAutostart(o: AutostartOpts = {}): AutostartStatus {
  const platform = o.platform ?? process.platform;
  if (platform !== "win32") return { supported: false, present: false, command: null };
  const r = (o.run ?? regRun)(["query", RUN_KEY, "/v", o.valueName ?? AUTOSTART_VALUE]);
  if (r.code !== 0) return { supported: true, present: false, command: null };
  // 形如：`    小本本服务    REG_SZ    "C:\…\xbb.exe" serve --detach`
  const m = /REG_SZ\s+([\s\S]*?)\s*$/m.exec(r.out);
  return { supported: true, present: true, command: (m?.[1] ?? "").trim() };
}

export interface AutostartResult {
  ok: boolean;
  message: string;
}

/**
 * 底层写入（**不含**形态校验）：写启动项并回读验证。抽出来单测，让冒烟能在真注册表上用
 * 一个临时键名跑完整往返，而不必先把 `process.execPath` 变成编译产物。
 */
export function writeAutostartEntry(command: string, o: AutostartOpts = {}): AutostartResult {
  if ((o.platform ?? process.platform) !== "win32") {
    return { ok: false, message: autostartUnsupportedMessage() };
  }
  const valueName = o.valueName ?? AUTOSTART_VALUE;
  const r = (o.run ?? regRun)(["add", RUN_KEY, "/v", valueName, "/t", "REG_SZ", "/d", command, "/f"]);
  if (r.code !== 0) return { ok: false, message: `写入失败（reg 退出码 ${r.code}）：${r.out.trim()}` };

  const back = readAutostart({ ...o, valueName });
  if (!back.present || back.command !== command) {
    return { ok: false, message: `回读不一致 —— 期望 ${command}，实际 ${back.command ?? "(无)"}` };
  }
  return { ok: true, message: `${valueName} = ${command}` };
}

/** 底层删除（**不含**形态校验）。已经不存在也算成功（幂等），但会如实说明。 */
export function removeAutostartEntry(o: AutostartOpts = {}): AutostartResult {
  if ((o.platform ?? process.platform) !== "win32") {
    return { ok: false, message: autostartUnsupportedMessage() };
  }
  const valueName = o.valueName ?? AUTOSTART_VALUE;
  const before = readAutostart({ ...o, valueName });
  if (!before.present) return { ok: true, message: `本就没有「${valueName}」，无需处理` };

  const r = (o.run ?? regRun)(["delete", RUN_KEY, "/v", valueName, "/f"]);
  if (r.code !== 0) return { ok: false, message: `删除失败（reg 退出码 ${r.code}）：${r.out.trim()}` };
  const after = readAutostart({ ...o, valueName });
  if (after.present) return { ok: false, message: "删除后回读仍存在（可能被组策略重新写回）" };
  return { ok: true, message: `已移除「${valueName}」（原值 ${before.command ?? "-"}）` };
}

/** 产品级开：先过形态闸，再写启动项。 */
export function enableAutostart(o: AutostartOpts = {}): AutostartResult {
  if ((o.platform ?? process.platform) !== "win32") {
    return { ok: false, message: autostartUnsupportedMessage() };
  }
  const exe = o.exePath ?? process.execPath;

  // 开发形态下 `process.execPath` 是 **bun 本体**：写进启动项等于让开机跑一个"bun serve"，
  // 而 bun 在别处没有 tsconfig/paths 与 node_modules ⇒ 起不来（更别提 `bun run` 形态下
  // 连 `import.meta.dir` 都不指向仓库）。宁可拒绝，也不能写一条开机即败的坏项。
  // 用的就是自更新那道同源保命闸：**只有编译产物才允许改"以后怎么启动自己"**。
  if (!isCompiledExe() || !exe.toLowerCase().endsWith(".exe")) {
    return {
      ok: false,
      message: `拒绝写入：当前不是编译产物（${exe}）。请用安装后的 xbb.exe 执行本命令。`,
    };
  }
  return writeAutostartEntry(autostartCommand(exe), o);
}

/** 产品级关。 */
export function disableAutostart(o: AutostartOpts = {}): AutostartResult {
  return removeAutostartEntry(o);
}

export function autostartUnsupportedMessage(): string {
  return (
    `${process.platform} 暂不支持自动配置开机自启（当前只在 Windows 落地并验证过）。\n` +
    "  macOS：把 ~/Library/LaunchAgents/net.xiaobenben.xbb.plist 指向 `xbb serve --detach`\n" +
    "  Linux：把 ~/.config/autostart/xbb.desktop 指向 `xbb serve --detach`\n" +
    "  （这两条尚未真机验证，所以不代写 —— 需要的话我按你的发行版实测后再补）"
  );
}

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
