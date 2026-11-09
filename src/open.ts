// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 用系统默认浏览器/文件管理器打开目标（三平台）。
 * 为什么是浏览器而非原生窗口：exe 壳一期不引 WebView 依赖，管理页自带于 serve 零打包成本；
 * 将来换 WebView2/wkwebview 壳时只需替换此文件。
 *
 * ── Windows 上绝不可经过 cmd.exe ──────────────────────────────────────────
 * 曾经的写法是 `spawn("cmd", ["/c", "start", "", target])`。数组参数只保证
 * CreateProcess 的 argv 正确，**cmd 仍会对参数做一次元字符解释**（CWE-78）：
 * `target` 里一个 `&` 或 `|` 就会变成命令分隔符。
 *
 * 这不是理论推演，`target` 的来源都可控：
 *   · `resolveDataDir()` ← config.json 的 dataDir / XBB_DATA_DIR
 *   · `programDir()`     ← XBB_HOME ?? ~/.xiaobenben
 * 后者尤其要命：用户把程序装在 `C:\tools\a & b\` 这种目录**天然带 `&`**，
 * 那不只是被注入，是"点一下打开文件夹"直接失效。
 *
 * 现在的分工是绕开 shell 语义层：
 *   · URL  → `rundll32.exe url.dll,FileProtocolHandler <url>`（微软文档给"按默认协议打开"的入口）
 *   · 路径 → `explorer.exe <path>`
 * 两者都直接收 argv，`&` `|` `^` 只是文件名里的普通字符。
 */
import { spawn } from "node:child_process";

/** 只认带 scheme 的 URL。盘符路径 `C:\x` 与 UNC `\\srv\share` 都落到路径分支。 */
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

export interface OpenCommand {
  cmd: string;
  args: string[];
}

/**
 * 决定"用什么命令打开什么"—— 纯函数，单独导出是为了让测试能锁住
 * "Windows 分支永不出现 cmd.exe"这条契约，而不必真的弹窗。
 */
export function resolveOpenCommand(
  target: string,
  platform: NodeJS.Platform = process.platform,
): OpenCommand | null {
  const t = target.trim();
  if (!t) return null;
  if (platform === "win32") {
    return URL_LIKE.test(t)
      ? { cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", t] }
      : { cmd: "explorer.exe", args: [t] };
  }
  if (platform === "darwin") return { cmd: "open", args: [t] };
  return { cmd: "xdg-open", args: [t] };
}

function launch(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  // error 必须有人接：spawn 失败是**异步 event**，没人监听会冒成 uncaughtException，
  // 把 serve 一起带走 —— 与下面"打不开不阻断服务"的承诺正好相反。
  child.on("error", () => {
    /* 打不开不阻断服务，用户手动访问 127.0.0.1:17630 即可 */
  });
  child.unref();
}

export function openInBrowser(target: string): void {
  try {
    const plan = resolveOpenCommand(target);
    if (plan) launch(plan.cmd, plan.args);
  } catch {
    // 打不开不阻断服务，用户手动访问 127.0.0.1:17630 即可
  }
}
