// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * `openInBrowser` 的**无 shell 语义**契约。
 *
 * 守的是一句话：**Windows 分支永不经过 cmd.exe。**
 *
 * 为什么值得专门锁：老写法 `spawn("cmd", ["/c", "start", "", target])` 读起来
 * 完全正常 —— 数组参数、没有 shell: true，任何代码审查都会放过。但 cmd 会对
 * 参数再做一次元字符解释，`target` 里的 `&` 就变成命令分隔符。这类 bug 的特征是
 * "静态看着没问题、只有知道 cmd 语义的人能看出来"，所以必须用测试把结论固定住，
 * 而不是靠注释提醒后来者。
 *
 * 另外 `target` 真会带 `&`：程序目录 `C:\tools\a & b\` 是合法路径，XBB_HOME 也是
 * 用户随便设的。修之前那不只是安全问题，是打开文件夹直接失效。
 */
import { describe, expect, test } from "bun:test";
import { openInBrowser, resolveOpenCommand } from "./open";

/** Windows 上被明确禁用的解释器 —— 出现任何一个都意味着元字符会被重新解释 */
const FORBIDDEN = ["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "sh", "bash"];

describe("resolveOpenCommand：Windows 不经过 cmd", () => {
  test("URL → rundll32 的协议处理器", () => {
    const p = resolveOpenCommand("http://127.0.0.1:17630/", "win32");
    expect(p).toEqual({
      cmd: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", "http://127.0.0.1:17630/"],
    });
  });

  test("目录 → explorer.exe，且路径整体是一个 argv 元素", () => {
    const dir = "C:\\tools\\a & b\\.xiaobenben";
    const p = resolveOpenCommand(dir, "win32");
    expect(p).toEqual({ cmd: "explorer.exe", args: [dir] });
    // 关键：没有被按 & 拆成两段
    expect(p!.args).toHaveLength(1);
    expect(p!.args[0]).toBe(dir);
  });

  test("盘符路径与 UNC 路径都走 explorer，不被误判成 URL", () => {
    for (const p of ["C:\\x", "D:\\数据\\库", "\\\\server\\share\\dir"]) {
      expect(resolveOpenCommand(p, "win32")!.cmd).toBe("explorer.exe");
    }
  });

  test("只认 scheme://，`file:` 之类不带 // 的当路径处理", () => {
    expect(resolveOpenCommand("https://example.com/a", "win32")!.cmd).toBe("rundll32.exe");
    expect(resolveOpenCommand("file:C:\\x", "win32")!.cmd).toBe("explorer.exe");
  });

  test("空/纯空白返回 null（不 spawn，静默跳过）", () => {
    expect(resolveOpenCommand("", "win32")).toBeNull();
    expect(resolveOpenCommand("   ", "win32")).toBeNull();
  });
});

describe("resolveOpenCommand：其余平台保持原有行为", () => {
  test("darwin 用 open", () => {
    expect(resolveOpenCommand("/Users/x/Library", "darwin")).toEqual({
      cmd: "open",
      args: ["/Users/x/Library"],
    });
  });

  test("linux 用 xdg-open", () => {
    expect(resolveOpenCommand("/home/x/.xiaobenben", "linux")).toEqual({
      cmd: "xdg-open",
      args: ["/home/x/.xiaobenben"],
    });
  });
});

describe("回归闸：任何输入都不许把解释器请回来", () => {
  // 覆盖三类真实来源 + 攻击载荷，逐个扫一遍
  const targets = [
    "http://127.0.0.1:17630/",
    "https://www.xiaobenben.net/#/cloud",
    "C:\\Users\\x\\.xiaobenben",
    "C:\\tools\\a & b\\.xiaobenben",
    "C:\\x&calc.exe",
    "C:\\x | whoami",
    "C:\\x ^& echo pwned",
    "%COMSPEC% & calc",
    "\\\\server\\share\\dir",
    "/home/x/.xiaobenben",
    "",
    "   ",
  ];
  const platforms: NodeJS.Platform[] = ["win32", "darwin", "linux"];

  test("cmd / powershell / sh 一次都不出现", () => {
    for (const platform of platforms) {
      for (const t of targets) {
        const p = resolveOpenCommand(t, platform);
        if (!p) continue;
        expect(FORBIDDEN).not.toContain(p.cmd.toLowerCase());
        // `start` 是 cmd 内建命令，出现即说明又走回 shell 了
        expect(p.args.map((a) => a.toLowerCase())).not.toContain("start");
        expect(p.args).not.toContain("/c");
      }
    }
  });

  test("载荷原样透传，不被拆解或转义", () => {
    for (const t of ["C:\\x&calc.exe", "C:\\x | whoami", "C:\\tools\\a & b"]) {
      const p = resolveOpenCommand(t, "win32")!;
      expect(p.args[0]).toBe(t);
    }
  });
});

describe("openInBrowser 的失败面：永不打扰调用方", () => {
  test("空目标不抛异常", () => {
    expect(() => openInBrowser("")).not.toThrow();
  });
});
