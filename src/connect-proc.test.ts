// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 进程层判据：从「有没有 xbb mcp 在跑」反推「是哪个客户端在用它」。
 *
 * 为什么值得单独测：这是唯一不依赖「配置文件放哪」的判据，而配置文件的位置恰恰是
 * 每家客户端自己定的、会变的东西。2026-11-16 的用户反馈就是因为只信配置文件，
 * 把两个正在工作的客户端报成「未接入」。
 *
 * 全部用注入的进程表，不碰本机真实进程 —— 否则测试结果取决于跑测的人开着什么。
 */
import { describe, expect, test } from "bun:test";

import { isMcpProc, normalizeName, resolveHosts, type ProcNode } from "./connect-proc";

const p = (pid: number, ppid: number, name: string, cmd: string): ProcNode => ({ pid, ppid, name, cmd });

describe("normalizeName", () => {
  test("去路径、去 .exe、去引号", () => {
    expect(normalizeName("C:\\Users\\x\\AppData\\Local\\Programs\\cursor\\Cursor.exe")).toBe("Cursor");
    expect(normalizeName('"/usr/local/bin/opencode"')).toBe("opencode");
  });
});

describe("isMcpProc", () => {
  test("xbb mcp 算，xbb serve 不算", () => {
    expect(isMcpProc(p(1, 0, "xbb.exe", "C:\\x\\xbb.exe mcp"))).toBe(true);
    expect(isMcpProc(p(2, 0, "xbb.exe", "C:\\x\\xbb.exe serve --detach"))).toBe(false);
  });

  test("dev 形态 `bun src/index.ts mcp` 也算", () => {
    expect(isMcpProc(p(3, 0, "bun", "bun run src/index.ts mcp"))).toBe(true);
  });

  test("只是命令行里出现过 mcp 的进程不算（编辑器打开文件这类）", () => {
    expect(isMcpProc(p(4, 0, "code.exe", "code.exe C:\\x\\mcp.json"))).toBe(false);
  });
});

describe("resolveHosts", () => {
  test("直接父进程就是宿主", () => {
    const hosts = resolveHosts([
      p(100, 50, "xbb.exe", "C:\\x\\xbb.exe mcp"),
      p(50, 1, "Cursor.exe", "Cursor.exe"),
    ]);
    expect(hosts).toEqual([{ pid: 100, client: "cursor", hostName: "Cursor.exe", fromShell: false }]);
  });

  test("隔一层 node（npx 启动器）仍能认出宿主", () => {
    const hosts = resolveHosts([
      p(100, 90, "xbb.exe", "C:\\x\\xbb.exe mcp"),
      p(90, 50, "node.exe", "node C:\\npm\\_npx\\abc\\bin\\xbb.mjs mcp"),
      p(50, 1, "opencode.exe", "opencode.exe"),
    ]);
    expect(hosts[0]!.client).toBe("opencode");
    expect(hosts[0]!.hostName).toBe("opencode.exe");
  });

  test("祖先是 shell ⇒ 认不出客户端，但标明是手动跑的", () => {
    const hosts = resolveHosts([
      p(100, 90, "xbb.exe", "C:\\x\\xbb.exe mcp"),
      p(90, 80, "bash.exe", "bash.exe"),
      p(80, 1, "WindowsTerminal.exe", "WindowsTerminal.exe"),
    ]);
    expect(hosts[0]!.client).toBeNull();
    expect(hosts[0]!.fromShell).toBe(true);
  });

  test("宿主认不出（VS Code 等）⇒ client 为 null，但仍报出挂在谁下面", () => {
    const hosts = resolveHosts([
      p(100, 90, "xbb.exe", "C:\\x\\xbb.exe mcp"),
      p(90, 1, "Code.exe", "Code.exe"),
    ]);
    expect(hosts[0]!.client).toBeNull();
    expect(hosts[0]!.fromShell).toBe(false);
    expect(hosts[0]!.hostName).toBe("Code.exe");
  });

  test("WorkBuddy 能被认出来（本机实测的那条链）", () => {
    const hosts = resolveHosts([
      p(12388, 777, "xbb.exe", "C:\\Users\\x\\.xiaobenben\\bin\\xbb.exe mcp"),
      p(777, 1, "WorkBuddy.exe", "WorkBuddy.exe"),
    ]);
    expect(hosts[0]!.client).toBe("workbuddy");
  });

  test("serve 进程不参与宿主判定", () => {
    const hosts = resolveHosts([
      p(10, 1, "xbb.exe", "C:\\x\\xbb.exe serve --detach"),
      p(11, 1, "Cursor.exe", "Cursor.exe"),
    ]);
    expect(hosts).toEqual([]);
  });

  test("ppid 成环不死循环", () => {
    const hosts = resolveHosts([
      p(1, 2, "xbb.exe", "xbb.exe mcp"),
      p(2, 1, "node.exe", "node"),
    ]);
    expect(hosts.length).toBe(1);
    expect(hosts[0]!.client).toBeNull();
  });

  test("多个客户端同时在用 ⇒ 各自报出来", () => {
    const hosts = resolveHosts([
      p(100, 50, "xbb.exe", "xbb.exe mcp"),
      p(50, 1, "Cursor.exe", "Cursor.exe"),
      p(200, 60, "xbb.exe", "xbb.exe mcp"),
      p(60, 1, "Claude.exe", "Claude.exe"),
    ]);
    expect(hosts.map((h) => h.client).sort()).toEqual(["claudecode", "cursor"]);
  });
});
