// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 系统里那一格「小本本」—— 开始菜单快捷方式 / 桌面启动器。
 *
 * ## 补的是什么缺口
 *
 * 安装方式是「下载 → 扔进 `~/.xiaobenben/bin/xbb.exe`」，于是系统里**没有它的任何登记**：
 * 没有开始菜单项、没有「已安装的应用」条目、Windows 搜索里敲「小本本」也搜不出东西。
 * 用户判断"我装了它"的唯一依据就只剩右下角那个托盘图标 —— 而 Windows 偏偏会把新图标
 * 默认折叠进 `^` 里。于是"装了但不知道在不在"的一半答案其实不在记忆层，在这里：
 * **程序在跑，但系统里没有它的存在证明。**
 *
 * 本模块只补"证明"，不做安装器、不写卸载项（那是另一件事，见下）。
 *
 * ## 为什么是 .lnk，而不是写注册表或塞 PATH
 *
 * Windows 10 开始菜单的「最近添加」不是"检测到磁盘上多了个 exe"，而是**开始菜单程序目录里
 * 多了一个 `.lnk`**（按快捷方式创建时间排序）。所以想要那一格出现，唯一正规的做法就是
 * 正正经经建一个快捷方式 —— 顺带它还解决了另外三件事：能被 Windows 搜索索引、能右键
 * 「固定到开始屏幕/任务栏」、能在「所有应用」里按名字找到。这三件事**都只有 .lnk 能拿到**，
 * 建一个 60 字节的 lnk 比维护一套自定义索引便宜得多。
 *
 * ## 三平台口径
 *
 * | 平台 | 落点 | 承载 | 本期 |
 * |---|---|---|---|
 * | Windows | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\小本本.lnk` | `WScript.Shell`（COM，免管理员） | ✅ |
 * | Linux | `${XDG_DATA_HOME:-~/.local/share}/applications/xbb.desktop` | Desktop Entry 纯文本 | ✅ |
 * | macOS | — | Launchpad 只认 `.app` bundle | ❌ 明确不做，理由见下 |
 *
 * macOS 不是"漏了"：那套壳要一个 `.icns` 图标（我们只有 `.ico`/`.png`）+ `Info.plist` 的
 * 签名策略，且本机无法验证。半成品比没有更糟 —— 所以这里返回 `unsupported` 并说清原因，
 * 而不是糊一个点了没反应的图标。
 *
 * ## 图标用的是托盘那一枚，不是 exe 那一枚
 *
 * 两枚都是品牌资产，只是落位不同：exe 那枚有红底板（资源管理器大格子里不显空），托盘那枚是
 * 透明底裸书签。快捷方式在开始菜单里按 32px 画 —— 那个尺寸下白书签压红底板会把书签的每条边
 * 都变成一段红白过渡，底部 V 形缺口糊成白斑；裸书签只有外轮廓要抗锯齿，16px 仍认得出。
 * 所以这里释放的是 `tray-assets` 的那份字节（Windows 取 `.ico`、Linux 取 `.png`），
 * 详见 `shortcutIconPath()`。
 *
 * ## 三条不能错的纪律
 *
 * 1. **只在缺失时创建。** 每次启动都重写会刷新创建时间，等于把「最近添加」当成每日广告位
 *    刷 —— 那格子的可信度就是被这么刷没的。
 * 2. **失败一律静默降级。** 组策略、杀软、没装 PowerShell 都可能让这一步失败；它跟"记忆能
 *    不能收发"毫无关系，所以只回一行日志，**绝不 throw、绝不阻断 serve**。
 * 3. **`Save()` 返回成功不等于文件真在。** 被拦时 COM 也可能不报错，所以写完必须
 *    `existsSync` 复核一次 —— 与 `build.ts` 复核图标、"托盘是否真的起来了"同一条纪律：
 *    **静默失败才是这类系统集成的常态**。
 *
 * ## 已知取舍（写在这里，免得下次有人当 bug 修）
 *
 * - **exe 挪位置后快捷方式会指向旧路径。** 要发现这件事得读 .lnk 的目标（只有 COM 能做），
 *   而为了一个几乎不会发生的情况在每次开机多起一个 PowerShell 不划算。自启项那条有同样的
 *   问题，那边靠比对 `reg query` 输出解决（读注册表比读二进制 lnk 便宜得多）。
 * - **双击会闪过一个控制台窗口。** 程序是控制台子系统，而"这次启动成没成"那句话要打在窗口里。
 *   要彻底无窗得改 GUI 子系统，牵动 MCP stdio 的 stdout —— 属独立议题。
 * - **删掉图标后下次启动会重建。** 有意为之：一次误删/清理工具清掉，和"我不想让它出现"
 *   在磁盘上长得一模一样；而重建的代价为零（再删一次就行）。真不想让它出现的人有
 *   `XBB_NO_SHORTCUT=1`。
 */
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { programDir } from "./home";
import { isCompiledExe } from "./updater";
import { encodePsCommand, psLiteral } from "./notify";
import { desktopExecQuote } from "./autostart";

/** 开始菜单里显示的名字 —— 也是 lnk 文件名（Windows 用文件名做显示名）。 */
export const SHORTCUT_NAME = "小本本";

/** Windows 快捷方式文件名。 */
export const WIN_SHORTCUT_FILE = `${SHORTCUT_NAME}.lnk`;

/** Linux 的 Desktop Entry 文件名（与 `autostart.ts` 的 `xbb.desktop` **不是**同一个文件：
 *  那个在 `autostart/` 目录由会话启动读取，这个在 `applications/` 目录由应用菜单读取）。 */
export const LINUX_DESKTOP_FILE = "xbb.desktop";

/**
 * 快捷方式参数：`start` = 确保常驻服务在跑并给一条通知；`--open` = 顺手把管理页打开。
 *
 * 为什么不带参数：裸调用在 `index.ts` 里同样会拉起服务，但它同时**打印整屏帮助** ——
 * 双击图标的人要的是"它起来了"，不是一份命令清单。
 */
export const SHORTCUT_ARGS = "start --open";

/** 快捷方式描述（Windows 的「备注」栏，鼠标悬停可见）。 */
export const SHORTCUT_DESCRIPTION = "小本本 · 面向 AI 的个人记忆库";

/** 环境变量关闭开关：企业分发、纯净安装、CI 用得上（假值即可，如 `0`）。 */
export const NO_SHORTCUT_ENV = "XBB_NO_SHORTCUT";

export type ShortcutStatus = "created" | "exists" | "skipped" | "unsupported" | "failed";

export interface ShortcutResult {
  status: ShortcutStatus;
  /** 目标文件路径（Linux 的 .desktop / Windows 的 .lnk）；不支持时 null。 */
  path: string | null;
  /** 给人看的一句话（失败原因 / 跳过原因）。 */
  message?: string;
}

interface RunResult {
  code: number;
  out: string;
  /** stderr 单收一份：混进 out 会被 CLIXML 噪声淹没，失败原因变得不可读。 */
  err?: string;
}

/** PowerShell 运行器（可注入：单测不许真往用户的开始菜单里写东西）。 */
export type ScriptRunner = (script: string) => Promise<RunResult>;

/**
 * Windows 开始菜单程序目录。
 *
 * `APPDATA` 缺失（服务账户、被清空的环境变量）时按文档口径回落到
 * `~\AppData\Roaming`，而不是返回空串让上层拼出一个相对路径 —— 那会写进 cwd。
 */
export function startMenuProgramsDir(o: { env?: NodeJS.ProcessEnv; home?: string } = {}): string {
  const env = o.env ?? process.env;
  const home = o.home ?? homedir();
  const appData = env.APPDATA?.trim();
  const base = appData && appData.length > 0 ? appData : join(home, "AppData", "Roaming");
  return join(base, "Microsoft", "Windows", "Start Menu", "Programs");
}

/** Linux 应用菜单目录（`applications/`，不是会话自启的 `autostart/`）。 */
export function linuxApplicationsDir(o: { env?: NodeJS.ProcessEnv; home?: string } = {}): string {
  const env = o.env ?? process.env;
  const home = o.home ?? homedir();
  const xdg = env.XDG_DATA_HOME?.trim();
  // 规范只认绝对路径，相对值必须忽略（与 autostart.ts 的判断同源）
  const base = xdg && xdg.startsWith("/") ? xdg : join(home, ".local", "share");
  return join(base, "applications");
}

/**
 * 目标路径。不支持的平台返回 null —— 调用方据此跳过，而不是猜一个位置出来。
 */
export function shortcutPath(
  platform: NodeJS.Platform = process.platform,
  o: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    startMenuDir?: string;
    xdgDataHome?: string;
    /** 覆盖文件名，**只给测试用**（见 `EnsureShortcutOpts.shortcutName`）。 */
    shortcutName?: string;
  } = {},
): string | null {
  if (platform === "win32") return join(o.startMenuDir ?? startMenuProgramsDir(o), o.shortcutName ?? WIN_SHORTCUT_FILE);
  if (platform === "linux") {
    const dir = o.xdgDataHome ? join(o.xdgDataHome, "applications") : linuxApplicationsDir(o);
    return join(dir, o.shortcutName ?? LINUX_DESKTOP_FILE);
  }
  return null;
}

/**
 * 纯函数：建 `.lnk` 的 PowerShell 正文。
 *
 * 所有路径都过 `psLiteral`（单引号字面量，唯一的特殊字符是 `'` 本身）—— 与 `notify.ts`
 * 的 toast 脚本同一条纪律：**拼接路径的地方就是注入点**，用户名里带一个 `'` 就能把脚本
 * 撕成两半。整段再经 `-EncodedCommand`（UTF-16LE）下发，所以中文路径/中文描述不需要额外转义。
 *
 * 为什么用 COM 而不是 `.lnk` 的二进制格式：那格式有 LinkTargetIDList / ExtraData 若干块，
 * 手写等于自己实现一遍 Windows Shell —— `WScript.Shell` 是系统自带的、免管理员的唯一正解。
 */
export function windowsShortcutScript(o: {
  lnkPath: string;
  target: string;
  args?: string;
  workDir?: string;
  icon?: string;
  description?: string;
}): string {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `$p = ${psLiteral(o.lnkPath)}`,
    // CreateDirectory 而不是 New-Item -Force：前者保证**递归**建出中间层，后者在个别版本上
    // 只建最后一级，父目录不在就直接失败。
    "[void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $p))",
    "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($p)",
    `$s.TargetPath = ${psLiteral(o.target)}`,
  ];
  if (o.args) lines.push(`$s.Arguments = ${psLiteral(o.args)}`);
  if (o.workDir) lines.push(`$s.WorkingDirectory = ${psLiteral(o.workDir)}`);
  // `,0` = 用 exe 自己内嵌的第 0 号图标资源（产物保证有，见 build.ts 的逐字节复核）
  if (o.icon) lines.push(`$s.IconLocation = ${psLiteral(o.icon)}`);
  if (o.description) lines.push(`$s.Description = ${psLiteral(o.description)}`);
  lines.push("$s.WindowStyle = 1"); // 1 = 常规窗口：本次启动的结果要打在里面
  lines.push("$s.Save()");
  return lines.join("\n");
}

/** 纯函数：`.desktop` 正文。 */
export function linuxDesktopEntry(o: { exec: string; icon?: string; name?: string; comment?: string }): string {
  const lines = [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    `Name=${o.name ?? SHORTCUT_NAME}`,
    `Comment=${o.comment ?? SHORTCUT_DESCRIPTION}`,
    `Exec=${desktopExecQuote(o.exec)} ${SHORTCUT_ARGS}`,
  ];
  if (o.icon) lines.push(`Icon=${o.icon}`);
  // Terminal=true：程序是命令行形态，"服务起没起来"那句话要打在终端里。
  // 用 Terminal=false 不是无窗，而是**什么都没发生** —— 正是本模块要消灭的那种体验。
  lines.push("Terminal=true");
  lines.push("Categories=Utility;");
  lines.push("StartupNotify=false");
  lines.push("");
  return lines.join("\n");
}

/** 异步跑一段 PowerShell。**不用 spawnSync**：serve 的就绪时间直接决定 AI 客户端等多久。 */
function runPowershell(script: string): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    try {
      const p = spawn(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePsCommand(script)],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      p.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
      p.stderr?.on("data", (d: Buffer) => (err += d.toString("utf8")));
      p.on("error", (e) => resolve({ code: -1, out: out + String(e), err }));
      p.on("close", (code) => resolve({ code: code ?? -1, out, err }));
    } catch (e) {
      resolve({ code: -1, out: out + (e instanceof Error ? e.message : String(e)), err });
    }
  });
}

/**
 * 把 stderr 还原成人话。
 *
 * 非交互的 PowerShell 在 stderr 被管道接走时，会把整条错误流序列化成 XML 并以
 * `#< CLIXML` 开头。里面既有 progress 记录（CI 的干净机器上必然出现一次
 * "Preparing modules for first use."），也有真正的异常，两者长得一样。
 *
 * 直接把这坨 XML 当失败原因塞给用户，等于什么都没说 —— 真机排障时我就在 CI 日志里
 * 盯着一段 `<Obj S="progress">` 猜了半天。异常文本在 `<S S="Error">` 里，且换行被
 * 转义成 `_x000D__x000A_`，抽出来还原即可。
 */
export function readablePsError(stderr: string): string {
  if (!stderr.includes("#< CLIXML")) return stderr.trim();
  // 错误文本挂在 `<S N="Error">`（属性名是 N），个别版本写成 `S="Error"`，两种都认。
  const texts = [...stderr.matchAll(/<S [NS]="Error">([\s\S]*?)<\/S>/g)].map((m) =>
    m[1].replace(/_x000D_/g, "").replace(/_x000A_/g, "\n").trim(),
  );
  return texts.filter(Boolean).join("\n").trim();
}

export interface EnsureShortcutOpts {
  platform?: NodeJS.Platform;
  /** 快捷方式指向的程序，缺省 `process.execPath`（编译产物就是 xbb.exe 自己）。 */
  exePath?: string;
  startMenuDir?: string;
  xdgDataHome?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** 覆盖「是否编译产物」判定，**只给测试用** —— 产品路径一律走 `isCompiledExe()`。 */
  compiled?: boolean;
  /** 覆盖 PowerShell 运行器（测试用）。 */
  run?: ScriptRunner;
  /**
   * 覆盖落盘文件名，**只给测试用**。
   *
   * 起因：CI 的 Windows Server runner 上 `Save()` 存不了文件名含非 ASCII 的 `.lnk`
   * （同目录同字段，文件名换成 ASCII 就成功；脚本里拿到的中文完好——用非 ASCII 码点
   * 数验过），而 Win10/11 桌面版正常。这是 Shell API 在 Server SKU 上的行为差异，
   * 不是产品缺陷，但会让真机往返测试永远红。测试因此可切到 ASCII 名跑同一条产品代码。
   */
  shortcutName?: string;
}

/**
 * 确保系统里有「小本本」这一格。**幂等、绝不 throw**。
 *
 * 开发态（`bun run src/index.ts`）直接跳过：那时 `process.execPath` 是 bun 自己，
 * 建出来的快捷方式只会把你带到 bun 的帮助页。这与 `autostart.ts` 只在编译产物上动手同源。
 */
export async function ensureStartMenuShortcut(o: EnsureShortcutOpts = {}): Promise<ShortcutResult> {
  const platform = o.platform ?? process.platform;
  try {
    if ((o.env ?? process.env)[NO_SHORTCUT_ENV]) {
      return { status: "skipped", path: null, message: `已设置 ${NO_SHORTCUT_ENV}` };
    }
    if (platform === "darwin") {
      return {
        status: "unsupported",
        path: null,
        message: "macOS 的 Launchpad 只认 .app bundle（需 .icns 与签名策略），本期不做",
      };
    }
    const path = shortcutPath(platform, o);
    if (!path) return { status: "unsupported", path: null, message: `平台 ${platform} 没有对应的应用菜单机制` };

    if (!(o.compiled ?? isCompiledExe())) {
      return { status: "skipped", path, message: "开发态（未编译）不写快捷方式" };
    }
    // ① 只在缺失时创建：每次重写会刷新创建时间，把「最近添加」变成每日广告位
    if (existsSync(path)) return { status: "exists", path };

    const exe = o.exePath ?? process.execPath;

    if (platform === "win32") {
      const script = windowsShortcutScript({
        lnkPath: path,
        target: exe,
        args: SHORTCUT_ARGS,
        workDir: dirname(exe),
        icon: `${await shortcutIconPath(exe)},0`,
        description: SHORTCUT_DESCRIPTION,
      });
      const r = await (o.run ?? runPowershell)(script);
      if (r.code !== 0) {
        // 失败原因优先取 stderr 洗完的那一份：out 里正常情况下什么都没有，
        // 而 CI 上第一次跑 PowerShell 时 stderr 一定有一段模块预热噪声。
        const why = readablePsError(r.err ?? "") || r.out.trim() || `PowerShell 退出码 ${r.code}`;
        return { status: "failed", path, message: why.slice(0, 600) };
      }
      // ② 复核：COM 被策略拦下时 Save() 也可能不报错
      return existsSync(path)
        ? { status: "created", path }
        : { status: "failed", path, message: "脚本返回成功但 .lnk 不存在（可能被组策略/杀软拦下）" };
    }

    // Linux：纯文本，直接落盘
    mkdirSync(dirname(path), { recursive: true });
    let icon: string | undefined;
    try {
      icon = await shortcutIconPath(exe);
    } catch {
      /* 图标取不到只影响观感，不影响能不能启动 */
    }
    writeFileSync(path, linuxDesktopEntry({ exec: exe, icon }), "utf8");
    return existsSync(path)
      ? { status: "created", path }
      : { status: "failed", path, message: ".desktop 写入后不存在" };
  } catch (e) {
    // 兜底：本模块的失败**永远**不该冒泡到启动流程
    return { status: "failed", path: null, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 快捷方式用的图标：把**嵌入的托盘图标**释放到 `XBB_HOME/icons/xbb.{ico,png}` 并返回路径。
 *
 * ## 为什么是托盘那一枚，而不是 exe 里的那一枚
 *
 * 两枚图标是同一个品牌、两种落位（见 `gen-app-icon.ts` / `gen-tray-icon.ts` 文件头）：
 * exe 那枚是「红底板 + 白色书签」，托盘那枚是「透明底 + 裸书签」。快捷方式属于**小尺寸列表位**
 * ——开始菜单「最近添加」按 32px 画、`.desktop` 的应用菜单也按 32–48px 画，正是托盘那一枚
 * 被设计出来的场景。
 *
 * 真机对比（32px，8× 放大）给出的理由很硬：白书签压在红底板上时，书签的 **每一条边都要做
 * 红→白过渡**，32px 下那条过渡就占掉 2px，底部那个 V 形缺口直接糊成一团白斑；而裸书签只有
 * **外轮廓**要抗锯齿，缺口在 16px 下都还认得出来。底板在资源管理器的大格子里换来的是"不显空"，
 * 在这个尺寸换来的只有糊。
 *
 * 释放策略与 `ensureTrayBin()` 同一条：**按大小判定**，不符就重写 —— 升级换了图标不会继续
 * 用旧文件，而每次启动也不必白读一遍。
 */
async function shortcutIconPath(exe: string): Promise<string> {
  try {
    // 延迟 import：`tray-assets.ts` 顶层要 await 三平台二进制的嵌入，这份代价只有真要写
    // 快捷方式时才值得付（绝大多数启动走的是 `exists` 提前返回）。
    const { trayIconBytes, trayIconAssetName } = await import("./tray-assets");
    const ext = trayIconAssetName().endsWith(".ico") ? "ico" : "png";
    const dir = join(programDir(), "icons");
    const target = join(dir, `xbb.${ext}`);
    const bytes = trayIconBytes();
    let have = -1;
    try {
      have = statSync(target).size;
    } catch {
      /* 没写过 */
    }
    if (have !== bytes.length) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(target, bytes);
    }
    return target;
  } catch {
    // 取不到嵌入图标（未知平台/产物缺资产）⇒ 退回 exe 自己内嵌的那一枚：
    // 糊一点也比空白壳好，而且这条路不该让快捷方式建不出来。
    return exe;
  }
}
