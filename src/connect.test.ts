// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * `xbb connect` 的探测逻辑。
 *
 * 这里测的不是「会不会打印字符串」，而是三件会直接变成用户事故的判断：
 *   1. **装了 ≠ 接入了**。混为一谈会让「0/3 已接入」这种最该出现的提示消失；
 *   2. **配了 ≠ 能用**。配置里指向的 exe 被升级/搬目录干掉之后，客户端里一切正常、
 *      AI 就是没有记忆 —— 这是最难自查的一类故障，必须能被报出来；
 *   3. **片段必须带 -y**。少了它，首次 npx 会等一个没人能回答的确认，
 *      现象是「服务器连不上」。这条要用断言锁死，不能只写在注释里。
 *
 * 全部用临时目录 + 注入 home/env，不读本机真实配置（否则测试结果取决于跑测的人装了什么）。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  connectSummary,
  probeClients,
  recommendedEntry,
  renderConnect,
  snippet,
  toJson,
} from "./connect";

const EXE = process.platform === "win32" ? "xbb.exe" : "xbb";

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "xbb-connect-"));
  return {
    home,
    /** 空 env：否则会继承本机的 APPDATA / XDG_CONFIG_HOME，测试结果依赖跑测的机器 */
    env: {} as NodeJS.ProcessEnv,
    put(rel: string, content: string) {
      const p = join(home, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, "utf8");
      return p;
    },
    touch(rel: string) {
      return this.put(rel, "");
    },
    done() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const byId = (list: ReturnType<typeof probeClients>, id: string) => list.find((c) => c.id === id)!;

describe("probeClients", () => {
  test("空目录 ⇒ 什么都没装，也不谎报已接入", () => {
    const s = sandbox();
    try {
      const list = probeClients({ home: s.home, env: s.env });
      expect(list.length).toBe(6);
      expect(list.every((c) => !c.installed)).toBe(true);
      expect(list.every((c) => c.via === null)).toBe(true);
    } finally {
      s.done();
    }
  });

  test("装了但没接入 —— 这两件事必须分开报", () => {
    const s = sandbox();
    try {
      s.put(".cursor/mcp.json", JSON.stringify({ mcpServers: {} }));
      const c = byId(probeClients({ home: s.home, env: s.env }), "cursor");
      expect(c.installed).toBe(true);
      expect(c.configExists).toBe(true);
      expect(c.via).toBeNull();
      expect(c.broken).toBeNull();
    } finally {
      s.done();
    }
  });

  test("Cursor 里接的是 npx 包", () => {
    const s = sandbox();
    try {
      s.put(
        ".cursor/mcp.json",
        JSON.stringify({ mcpServers: { xiaobenben: { command: "npx", args: ["-y", "xiaobenben", "mcp"] } } }),
      );
      const c = byId(probeClients({ home: s.home, env: s.env }), "cursor");
      expect(c.via).toBe("npx");
      expect(c.entryName).toBe("xiaobenben");
      expect(c.commandPath).toBe("npx");
      expect(c.broken).toBeNull();
    } finally {
      s.done();
    }
  });

  test("opencode 的 command 是数组，且要认出接的是桌面版", () => {
    const s = sandbox();
    try {
      const exe = s.touch(join(".xiaobenben", "bin", EXE));
      s.put(
        ".config/opencode/opencode.json",
        JSON.stringify({ mcp: { xiaobenben: { type: "local", command: [exe, "mcp"], enabled: true } } }),
      );
      const c = byId(probeClients({ home: s.home, env: s.env }), "opencode");
      expect(c.installed).toBe(true);
      expect(c.via).toBe("desktop");
      expect(c.commandPath).toBe(exe);
      expect(c.broken).toBeNull();
    } finally {
      s.done();
    }
  });

  test("Codex 是 TOML 段，不是 JSON", () => {
    const s = sandbox();
    try {
      s.put(
        ".codex/config.toml",
        [
          'model = "x"',
          "",
          "[mcp_servers.other]",
          "command = 'node'",
          "",
          "[mcp_servers.xiaobenben]",
          "command = 'npx'",
          "args = ['-y', 'xiaobenben', 'mcp']",
          "",
          "[desktop]",
          'followUpQueueMode = "steer"',
        ].join("\n"),
      );
      const c = byId(probeClients({ home: s.home, env: s.env }), "codex");
      expect(c.installed).toBe(true);
      expect(c.via).toBe("npx");
      expect(c.entryName).toBe("xiaobenben");
    } finally {
      s.done();
    }
  });

  test("配了但指向的 exe 已不存在 ⇒ 报出来，而不是当成已接入", () => {
    const s = sandbox();
    try {
      s.put(
        ".cursor/mcp.json",
        JSON.stringify({
          mcpServers: { xiaobenben: { command: join(s.home, ".xiaobenben", "bin", EXE), args: ["mcp"] } },
        }),
      );
      const c = byId(probeClients({ home: s.home, env: s.env }), "cursor");
      expect(c.via).toBe("desktop");
      expect(c.broken).toContain("已不存在");
      // 并计入「未接入」——客户端里看着有、实际连不上，不能算接入成功
      const summary = connectSummary(probeClients({ home: s.home, env: s.env }));
      expect(summary).toContain("0/1");
      // 措辞必须区分「坏了」和「没配」：前者用户以为一切正常，最需要被点出来
      expect(summary).toContain("连不上");
    } finally {
      s.done();
    }
  });

  test("坏 JSON 不抛异常，只标记这一项", () => {
    const s = sandbox();
    try {
      s.put(".cursor/mcp.json", "{ 这不是 json");
      s.put(
        ".workbuddy/mcp.json",
        JSON.stringify({ mcpServers: { xiaobenben: { command: "npx", args: ["-y", "xiaobenben", "mcp"] } } }),
      );
      const list = probeClients({ home: s.home, env: s.env });
      expect(byId(list, "cursor").broken).toContain("JSON");
      // 一个坏文件不该影响别的客户端
      expect(byId(list, "workbuddy").via).toBe("npx");
    } finally {
      s.done();
    }
  });
});

describe("snippet", () => {
  const npxEntry = { command: "npx", args: ["-y", "xiaobenben", "mcp"], via: "npx" as const };

  test("所有形态都必须带 -y —— 少了它首次连接会卡死", () => {
    for (const id of ["cursor", "workbuddy", "claudecode", "claudedesktop", "opencode", "codex"] as const) {
      const text = snippet(id, npxEntry);
      expect(text).toContain("xiaobenben");
      expect(text).toContain("-y");
    }
  });

  test("opencode 用 mcp 容器 + type:local + 数组 command", () => {
    const obj = JSON.parse(snippet("opencode", npxEntry)) as Record<string, Record<string, Record<string, unknown>>>;
    const e = obj.mcp!.xiaobenben!;
    expect(e.type).toBe("local");
    expect(e.command).toEqual(["npx", "-y", "xiaobenben", "mcp"]);
    expect(e.enabled).toBe(true);
  });

  test("Codex 片段是 TOML，Windows 路径不能被转义", () => {
    const winPath = "C:\\Users\\x\\.xiaobenben\\bin\\xbb.exe";
    const text = snippet("codex", { command: winPath, args: ["mcp"], via: "desktop" });
    expect(text).toContain("[mcp_servers.xiaobenben]");
    // TOML 用单引号字面量，反斜杠原样保留
    expect(text).toContain(`command = '${winPath}'`);
  });

  test("其余客户端是 mcpServers + command/args 字符串", () => {
    const obj = JSON.parse(snippet("cursor", npxEntry)) as Record<string, Record<string, Record<string, unknown>>>;
    expect(obj.mcpServers!.xiaobenben!.command).toBe("npx");
    expect(obj.mcpServers!.xiaobenben!.args).toEqual(["-y", "xiaobenben", "mcp"]);
  });
});

describe("recommendedEntry", () => {
  test("有桌面版稳定路径就优先用它，不推荐 npx", () => {
    const s = sandbox();
    try {
      const exe = s.touch(join(".xiaobenben", "bin", EXE));
      const e = recommendedEntry({ home: s.home, env: s.env });
      expect(e.via).toBe("desktop");
      expect(e.command).toBe(exe);
    } finally {
      s.done();
    }
  });

  test("没有桌面版则退回 npx，且带上 -y", () => {
    const s = sandbox();
    try {
      const e = recommendedEntry({ home: s.home, env: s.env });
      expect(e.via).toBe("npx");
      expect(e.command).toBe("npx");
      expect(e.args).toEqual(["-y", "xiaobenben", "mcp"]);
      // 绝不能把自己（pkg 缓存里带版本号的路径）写进别人的配置
      expect(existsSync(e.command)).toBe(false);
    } finally {
      s.done();
    }
  });
});

describe("renderConnect", () => {
  test("未接入的客户端给出片段和它自己的配置路径", () => {
    const s = sandbox();
    try {
      s.put(".cursor/mcp.json", JSON.stringify({ mcpServers: {} }));
      const list = probeClients({ home: s.home, env: s.env });
      const text = renderConnect(list, recommendedEntry({ home: s.home, env: s.env }));
      expect(text).toContain("Cursor");
      expect(text).toContain(join(s.home, ".cursor", "mcp.json"));
      expect(text).toContain("mcpServers");
      expect(text).toContain("还没接入的客户端");
      expect(text).toContain("只读配置");
    } finally {
      s.done();
    }
  });

  test("全部接入后不再提示粘贴", () => {
    const s = sandbox();
    try {
      s.put(
        ".cursor/mcp.json",
        JSON.stringify({ mcpServers: { xiaobenben: { command: "npx", args: ["-y", "xiaobenben", "mcp"] } } }),
      );
      const list = probeClients({ home: s.home, env: s.env });
      const text = renderConnect(list, recommendedEntry({ home: s.home, env: s.env }));
      expect(text).toContain("无需操作");
      expect(text).not.toContain("还没接入的客户端");
    } finally {
      s.done();
    }
  });
});

describe("connectSummary", () => {
  test("没装任何客户端时说清楚，而不是报 0/0", () => {
    const s = sandbox();
    try {
      const summary = connectSummary(probeClients({ home: s.home, env: s.env }));
      expect(summary).toContain("未检测到");
      expect(summary).not.toContain("0/0");
    } finally {
      s.done();
    }
  });

  test("已接入的比例与名字", () => {
    const s = sandbox();
    try {
      s.put(
        ".workbuddy/mcp.json",
        JSON.stringify({ mcpServers: { xiaobenben: { command: "npx", args: ["-y", "xiaobenben", "mcp"] } } }),
      );
      s.put(".cursor/mcp.json", JSON.stringify({ mcpServers: {} }));
      const summary = connectSummary(probeClients({ home: s.home, env: s.env }));
      expect(summary).toContain("WorkBuddy");
      expect(summary).toContain("1/2");
    } finally {
      s.done();
    }
  });
});

describe("toJson", () => {
  test("--json 可被解析，未接入项带片段", () => {
    const s = sandbox();
    try {
      s.put(".cursor/mcp.json", JSON.stringify({ mcpServers: {} }));
      const raw = toJson(probeClients({ home: s.home, env: s.env }), recommendedEntry({ home: s.home, env: s.env }));
      const doc = JSON.parse(raw) as {
        recommended: { via: string };
        clients: Array<{ id: string; connected: boolean; snippet: string | null }>;
      };
      expect(doc.recommended.via).toBeTruthy();
      const cursor = doc.clients.find((c) => c.id === "cursor")!;
      expect(cursor.connected).toBe(false);
      expect(cursor.snippet).toContain("xiaobenben");
      // 没装的客户端不给片段（给了也没用，先得装上）
      expect(doc.clients.find((c) => c.id === "claudedesktop")!.snippet).toBeNull();
    } finally {
      s.done();
    }
  });
});
