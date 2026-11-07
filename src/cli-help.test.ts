// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * `--help` 的零副作用约定（2026-11-04 用户反馈）。
 *
 * 守的是一句话：**`--help` 在任何位置都只打印帮助，绝不执行命令本身。**
 *
 * 为什么值得单独一个文件、还要真起子进程测：这条 bug 的形态是"看起来一切正常"——
 * `xbb stop --help` 会输出一堆字，用户以为看到了帮助，其实服务已经被停了。
 * 纯函数测（断言 helpText 的文案）完全测不出这一层，因为文案本来就对，
 * 错的是"到底有没有走那条分支"。所以这里全部用真实进程跑。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { helpText, helpTopic, isHelpRequest } from "./cli-help";

const CLI_ROOT = join(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "xbb-help-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** 跑一次真实 CLI。带超时强杀：万一 help 没被拦住，`serve --help` 会真的起服务并挂住。 */
async function run(args: string[], timeoutMs = 20_000): Promise<{ code: number | null; out: string; err: string }> {
  const p = Bun.spawn({
    cmd: [process.execPath, "run", "src/index.ts", ...args],
    cwd: CLI_ROOT,
    // 隔离到空目录：即便某条命令真的被执行，也不会碰本机的库
    env: { ...process.env, XBB_HOME: home, XBB_INGEST: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }, timeoutMs);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() };
}

describe("helpTopic：把 --help 归到正确的主题", () => {
  test("xbb home move --help → home/move（不是把 --help 当子命令）", () => {
    expect(helpTopic(["home", "move", "--help"])).toEqual({ cmd: "home", sub: "move" });
  });

  test("xbb home --help → home（不给 sub，才不会去查一个不存在的 home --help）", () => {
    expect(helpTopic(["home", "--help"])).toEqual({ cmd: "home" });
  });

  test("xbb --help / xbb -h → 总览", () => {
    expect(helpTopic(["--help"])).toEqual({ cmd: "help" });
    expect(helpTopic(["-h"])).toEqual({ cmd: "help" });
  });

  test("xbb help home move → home/move（动词式写法归一）", () => {
    expect(helpTopic(["help", "home", "move"])).toEqual({ cmd: "home", sub: "move" });
  });

  test("只有 -h / --help 才算要帮助，-help 之类不算", () => {
    expect(isHelpRequest(["serve", "--help"])).toBe(true);
    expect(isHelpRequest(["home", "move", "-h"])).toBe(true);
    expect(isHelpRequest(["serve"])).toBe(false);
    expect(isHelpRequest(["-help"])).toBe(false);
  });
});

describe("helpText：反馈里点名要出现的选项必须真的在帮助里", () => {
  test("home move 的帮助写明 --force 与 --cleanup", () => {
    const t = helpText("home", "move");
    expect(t).toContain("--force");
    expect(t).toContain("--cleanup");
  });

  test("stop 的帮助写明 --keep-mcp 及其代价", () => {
    const t = helpText("stop");
    expect(t).toContain("--keep-mcp");
    expect(t).toContain("库连接");
  });

  test("未知命令查帮助 → 给总览而不是报错", () => {
    expect(helpText("nonesuch")).toContain("xbb — 小本本个人客户端");
  });
});

describe("真起进程：--help 零副作用", () => {
  test("xbb stop --help 只打印帮助，不停止任何进程", async () => {
    const r = await run(["stop", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("--keep-mcp");
    // 这两句只在**真的执行** stop 时才会出现
    expect(r.out).not.toContain("已停止 PID");
    expect(r.out).not.toContain("发现 ");
  });

  test("xbb serve --help 不启动服务、不挂住终端", async () => {
    const r = await run(["serve", "--help"], 10_000);
    expect(r.code).toBe(0);
    expect(r.out).toContain("--detach");
    expect(r.out).not.toContain("listening on");
  });

  test("xbb home move --help 不开始搬家", async () => {
    const r = await run(["home", "move", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("--cleanup");
    expect(r.out).not.toContain("迁移中");
  });

  test("xbb home --help 是帮助正文，不是「未知子命令」", async () => {
    const r = await run(["home", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("xbb home <子命令>");
    expect(r.out).not.toContain("未知子命令");
  });

  test("未知命令明确失败（exit 1），不再静默当帮助返回 0", async () => {
    const r = await run(["nonesuch-command"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("未知命令");
  });
});
