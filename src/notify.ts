// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 桌面通知（exe 桌面 toast，2026-10-07 落地）。
 *
 * 设计原文：`xbb.exe 常驻服务经 WebSocket/SSE 长连接收事件 → 系统级通知 → 点击跳动作中心`。
 * 本文件只负责**最后一跳**（把一行文字变成系统气泡）；事件从哪来、该不该弹，由 `notify-watch.ts` 决定。
 *
 * ## 为什么不引 npm 依赖
 *
 * 三平台都有**系统自带**的通知命令，且都只需一次 spawn：
 *  - Windows：PowerShell + WinRT `ToastNotificationManager`（Win10+ 内置）
 *  - macOS：`osascript -e 'display notification …'`
 *  - Linux：`notify-send`（libnotify）
 *
 * 而候选依赖（node-notifier / BurntToast）要么自带一堆二进制加重 exe 体积，
 * 要么要求用户预先 `Install-Module`。exe 的存在意义是"薄"（通知四纪律之一：
 * exe 保持薄 = toast+托盘+跳转），为一条气泡去引依赖不划算。
 *
 * ## 三条纪律（每条都对应一种会静默出错的写法）
 *
 *  1. **绝不 throw、绝不阻断 serve。** 通知是增强不是必需——没有通知功能照样能收发记忆。
 *     平台命令不存在（Linux 没装 libnotify）、PowerShell 被策略禁掉，都只能让气泡不出现，
 *     不能让常驻服务挂掉或反复刷错误日志。
 *
 *  2. **Windows 参数走 `-EncodedCommand`（UTF-16LE base64），不走 `-Command` 拼串。**
 *     记忆正文是中文、还可能带引号/换行/`$`——放进命令行会被 PowerShell 先做一轮变量展开与
 *     分词，转义稍有闪失就是**脚本注入**（正文来自同事，不是可信输入）。编码通道把整段脚本
 *     当成一个不透明字节块，从根上消掉这一整类问题。也顺带绕开 .ps1 临时文件的编码坑。
 *
 *  3. **能点就点，不能点就如实降级。** Windows/macOS 支持点击跳转，Linux 的 notify-send
 *     一期不带动作回调——那就**没有**点击行为，而不是假装有（同"降级可读、不谎报"纪律）。
 */
import { spawn } from "node:child_process";

export interface ToastOptions {
  title: string;
  body: string;
  /** 点击后打开的地址（Windows/macOS 生效）。给 null = 明确不可点，不编造。 */
  url?: string | null;
}

export interface ToastCommand {
  cmd: string;
  args: string[];
}

/**
 * Windows 的 AppUserModelId。Toast 必须归属某个"AUMID"，注册过的才稳定弹得出来
 * （未注册的字符串在部分 Windows 版本上 `CreateToastNotifier` 直接抛"找不到元素"）。
 * 走 HKCU 而非 HKLM：免管理员权限，与已有的 `xubb://` 协议注册同一套路子。
 */
export const TOAST_AUMID = "SJi.XiaoBenBen.Xbb";

/** 纯函数：PowerShell **单引号**字面量转义。单引号串里唯一的特殊字符就是 `'` 本身（写成 `''`）——
 *  这是 PowerShell 里唯一不需要担心 `$`/反引号/换行的字符串形式。抽出来单测，
 *  因为这里错了 = 注入或语法错误，而真机上不一定每台都暴露。 */
export function psLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** UTF-16LE + base64：PowerShell `-EncodedCommand` 要求的编码（不是 UTF-8）。 */
export function encodePsCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** 纯函数：Windows WinRT toast 的脚本正文。 */
export function windowsToastScript(o: ToastOptions, aumid: string = TOAST_AUMID): string {
  // 用官方模板（ToastText02 = 加粗标题 + 正文两行）再往里塞文本，而不是手拼 XML——
  // 手拼 XML 还要自己转义 `&`/`<`，同事的名字里出现 `&` 就会把整棵 XML 弄坏。
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
    "[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]",
    "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$texts = $t.GetElementsByTagName('text')",
    `[void]$texts.Item(0).AppendChild($t.CreateTextNode(${psLiteral(o.title)}))`,
    `[void]$texts.Item(1).AppendChild($t.CreateTextNode(${psLiteral(o.body)}))`,
  ];
  // 点击跳转：activationType=protocol + launch=https://… 会让系统用默认浏览器打开。
  // https 本身是系统已注册的协议处理器，所以**不需要**我们再注册任何东西。
  if (o.url) {
    lines.push("$t.DocumentElement.SetAttribute('activationType', 'protocol')");
    lines.push(`$t.DocumentElement.SetAttribute('launch', ${psLiteral(o.url)})`);
  }
  lines.push("$n = [Windows.UI.Notifications.ToastNotification]::new($t)");
  lines.push(`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psLiteral(aumid)}).Show($n)`);
  return lines.join("\n");
}

/** 纯函数：AppleScript 字符串字面量转义（`\` 与 `"`）。 */
export function asLiteral(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 纯函数：macOS 通知脚本。`with title` 之外不挂点击回调——osascript 的 display notification
 *  没有可用的点击钩子，硬做要引 terminal-notifier，不值当（纪律③：不做假的可点）。 */
export function macToastScript(o: ToastOptions): string {
  return `display notification ${asLiteral(o.body)} with title ${asLiteral(o.title)}`;
}

/**
 * 纯函数：把「平台 + 通知内容」映射成一条待 spawn 的命令。
 * 三平台共用一条出口 → 单测可直接断言三种平台的产出，不必真弹气泡。
 * 返回 `null` = 本平台没有可用的通知手段（调用方据此静默跳过，不报错）。
 */
export function toastCommand(
  platform: NodeJS.Platform,
  o: ToastOptions,
  aumid: string = TOAST_AUMID,
): ToastCommand | null {
  if (!o.title && !o.body) return null; // 空的弹出来只会是噪音
  if (platform === "win32") {
    return {
      cmd: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", encodePsCommand(windowsToastScript(o, aumid)),
      ],
    };
  }
  if (platform === "darwin") {
    return { cmd: "osascript", args: ["-e", macToastScript(o)] };
  }
  if (platform === "linux") {
    // -a 指定应用名：Linux 桌面会把同 -a 的通知归到一组，也决定通知上的来源署名
    return { cmd: "notify-send", args: ["-a", "小本本", o.title, o.body] };
  }
  return null;
}

/**
 * 注册 Windows 的 AUMID（幂等）。只在 `serve` 启动时调一次。
 * 失败**静默**：注册不上最多是气泡弹不出来/署名难看，不能让服务起不来。
 */
export function ensureToastAppId(): void {
  if (process.platform !== "win32") return;
  try {
    const p = spawn(
      "reg",
      ["add", `HKCU\\Software\\Classes\\AppUserModelId\\${TOAST_AUMID}`, "/v", "DisplayName", "/d", "小本本", "/f"],
      { stdio: "ignore", windowsHide: true },
    );
    p.on("error", () => {}); // reg 不存在等边界：不抛
    p.unref();
  } catch {
    /* 同：注册失败不影响任何主流程 */
  }
}

/**
 * 弹一条系统通知。
 *
 * 返回 `true` = **已把命令交给系统**（不代表用户看见了——那要系统回调，本进程不监听）；
 * 返回 `false` = 本平台无可用手段 / 命令根本没能起。调用方据此决定要不要记日志。
 * **绝不 throw**。
 */
export function showToast(o: ToastOptions): boolean {
  const c = toastCommand(process.platform, o);
  if (!c) return false;
  try {
    const p = spawn(c.cmd, c.args, { detached: true, stdio: "ignore", windowsHide: true });
    p.on("error", () => {}); // 命令不存在（如没装 notify-send）：静默降级
    p.unref();
    return true;
  } catch {
    return false;
  }
}
