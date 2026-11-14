// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * `xbb connect` —— 回答一个目前没有任何地方能回答的问题：**它装到哪个 AI 客户端里了？**
 *
 * 背景：`npx xiaobenben mcp` 不会、也不该往任何客户端写配置。接入是**反向**的 ——
 * 由用户在客户端配置里加一条 command，客户端每次启动再把它拉起来。于是：
 *   · 用户过几天就忘了自己当初改的是哪个文件；
 *   · 多客户端并存时（opencode + WorkBuddy 很常见）完全分不清谁在用；
 *   · 配了但 exe 路径早已失效时，现象是「AI 突然没记忆了」，而不是任何一条能看懂的报错。
 * 这个命令把这三种情况都变成一次可读的输出。
 *
 * **只读，绝不写任何文件。** 改别人的配置文件是高危动作（格式各异、可能有注释、
 * 可能正被编辑器占用），需要独立的备份/确认/幂等设计，不能塞在一个「查状态」的命令里。
 *
 * 与 `ingest.ts` 里那套探测的关系：刻意不复用。那边找的是**会话数据**（opencode.db、
 * state.vscdb、jsonl），判断的是「有没有历史可供采集」；这里找的是**配置文件**，
 * 判断的是「有没有被接入」。两者路径不同、语义不同，合并会让任一边改动都牵动另一边
 * 的误判。宁可两份路径常量，也不让 `xbb ingest` 的解析器为 `xbb connect` 的错误负责。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ClientId = "opencode" | "cursor" | "workbuddy" | "claudecode" | "claudedesktop" | "codex";

/** 配置里那条目实际连的是哪种形态的引擎 —— 决定「要不要建议换成别的」 */
export type EngineVia = "npx" | "desktop" | "pkg" | "other";

export interface ClientStatus {
  id: ClientId;
  label: string;
  /** 客户端看起来装在这台机器上（配置目录/程序目录存在） */
  installed: boolean;
  /** 配置文件本该在哪（不存在也给路径，用户要按它去找） */
  configPath: string;
  configExists: boolean;
  /** 命中的条目名（通常是 xiaobenben，但用户可能自己改过名） */
  entryName: string | null;
  via: EngineVia | null;
  /** 条目里写死的可执行文件路径（npx 形态为 null） */
  commandPath: string | null;
  /** 配了但不可用：JSON 坏了、或指向的 exe 已经不在了 */
  broken: string | null;
}

export interface Entry {
  command: string;
  args: string[];
  via: EngineVia;
}

interface Spec {
  id: ClientId;
  label: string;
  /** 任一存在 ⇒ 视为已安装 */
  installPaths: string[];
  /** 候选配置路径，取第一个存在的；一个都不存在时用第一个作为「该往哪写」 */
  configPaths: string[];
  kind: "json" | "toml";
  /** JSON 里装条目表的顶层键 */
  container?: string;
  /** opencode 把 command 写成数组且需要 type/enabled */
  opencodeStyle?: boolean;
}

/**
 * 各客户端的安装痕迹与配置位置。**这些路径是会过期的知识**，不是永恒真理 ——
 * 上游改版时这里就该跟着改，所以集中在一处，并且每一项都注释了判断依据。
 */
function specs(home: string, env: NodeJS.ProcessEnv): Spec[] {
  const xdg = env.XDG_CONFIG_HOME || join(home, ".config");
  const appData = env.APPDATA || join(home, "AppData", "Roaming");
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  return [
    {
      id: "opencode",
      label: "opencode",
      // 本机实测：Windows 上 opencode 也用 ~/.config/opencode（不跟 APPDATA 走）
      installPaths: [join(xdg, "opencode"), join(home, ".opencode")],
      configPaths: [join(xdg, "opencode", "opencode.json"), join(xdg, "opencode", "config.json")],
      kind: "json",
      container: "mcp",
      opencodeStyle: true,
    },
    {
      id: "cursor",
      label: "Cursor",
      installPaths: [join(home, ".cursor")],
      configPaths: [join(home, ".cursor", "mcp.json")],
      kind: "json",
      container: "mcpServers",
    },
    {
      id: "workbuddy",
      label: "WorkBuddy",
      installPaths: [join(home, ".workbuddy")],
      configPaths: [join(home, ".workbuddy", "mcp.json")],
      kind: "json",
      container: "mcpServers",
    },
    {
      id: "claudecode",
      label: "Claude Code",
      // CLI 的用户级配置在 ~/.claude.json（注意不是目录）；~/.claude 是它跑起来后建的
      installPaths: [join(home, ".claude.json"), join(home, ".claude")],
      configPaths: [join(home, ".claude.json")],
      kind: "json",
      container: "mcpServers",
    },
    {
      id: "claudedesktop",
      label: "Claude Desktop",
      installPaths: [join(appData, "Claude"), join(home, "Library", "Application Support", "Claude")],
      configPaths: [
        join(appData, "Claude", "claude_desktop_config.json"),
        join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      ],
      kind: "json",
      container: "mcpServers",
    },
    {
      id: "codex",
      label: "Codex",
      installPaths: [codexHome],
      configPaths: [join(codexHome, "config.toml")],
      kind: "toml",
    },
  ];
}

/** 判断一条配置是不是在连小本本。三种写法都认：npx 包名、xbb.exe、.xiaobenben/bin/xbb */
const MARK = /xiaobenben|\bxbb\b|xbb\.exe/i;

function classify(hay: string): EngineVia | null {
  if (!MARK.test(hay)) return null;
  // 顺序有意义：pkg 缓存路径里也含 xiaobenben，但它是「按版本定过的绝对路径」，
  // 与桌面版的稳定路径要分开报 —— 前者在升级后会指向一个已删除的目录。
  if (/\bnpx(\.cmd)?\b/i.test(hay)) return "npx";
  if (/\.xiaobenben[\\/]+bin[\\/]+xbb/i.test(hay)) return "desktop";
  if (/[\\/]xiaobenben[\\/]+pkg[\\/]/i.test(hay)) return "pkg";
  return "other";
}

/** 把一个条目的 command/args/url 摊平成一段文本，供 MARK 判断 */
function flatten(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(flatten).join(" ");
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).map(flatten).join(" ");
  return "";
}

function looksLikePath(s: string | null): s is string {
  return !!s && /[\\/]/.test(s) && !/^(npx|node|bun|cmd|uvx)(\.cmd|\.exe)?$/i.test(s);
}

/** 从条目里取「要执行的程序」；opencode 是数组首元素，其余是 command 字段 */
function pickCommand(entry: Record<string, unknown>, opencodeStyle?: boolean): string | null {
  const c = entry.command;
  if (typeof c === "string") return c;
  if (Array.isArray(c) && typeof c[0] === "string") return c[0];
  if (opencodeStyle && Array.isArray(c) && typeof c[0] === "string") return c[0];
  return null;
}

function scanJson(
  text: string,
  container: string,
  opencodeStyle?: boolean,
): { entries: Array<{ name: string; obj: Record<string, unknown> }>; problem: string | null } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { entries: [], problem: `配置不是合法 JSON（${e instanceof Error ? e.message : String(e)}）` };
  }
  if (!doc || typeof doc !== "object") return { entries: [], problem: "配置顶层不是对象" };
  const box = (doc as Record<string, unknown>)[container];
  if (!box || typeof box !== "object") return { entries: [], problem: null };
  return {
    entries: Object.entries(box as Record<string, unknown>)
      .filter(([, v]) => v && typeof v === "object")
      .map(([name, v]) => ({ name, obj: v as Record<string, unknown> })),
    problem: null,
  };
}

/**
 * 极简 TOML 扫描：只认 `[mcp_servers.<name>]` 段，不引解析器。
 * 理由：这里只做「读」，且只需要知道某段里有没有出现 xbb —— 为此引一个 TOML 库
 * 是给一个只读命令增加一份攻击面（与 install.mjs 的取舍一致）。
 * 已知取舍：注释里的 `# [mcp_servers.x]` 会被误认，但它同时也会因为没有 command 行
 * 而落到 via="other"+broken 分支，不会谎报「已接入 npx」。
 */
function scanToml(text: string): { entries: Array<{ name: string; body: string }>; problem: string | null } {
  const out = new Map<string, string[]>();
  let cur: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const sec = /^\s*\[mcp_servers\.([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)?\]\s*$/.exec(line);
    if (sec) {
      cur = sec[1]!;
      if (!out.has(cur)) out.set(cur, []);
      continue;
    }
    if (/^\s*\[/.test(line)) {
      cur = null;
      continue;
    }
    if (cur) out.get(cur)!.push(line);
  }
  return {
    entries: [...out.entries()].map(([name, lines]) => ({ name, body: lines.join("\n") })),
    problem: null,
  };
}

function firstExisting(paths: string[]): { path: string; exists: boolean } {
  for (const p of paths) if (existsSync(p)) return { path: p, exists: true };
  return { path: paths[0] ?? "", exists: false };
}

/**
 * 探测所有客户端。**永不抛异常** —— 一个坏掉的配置文件不该让整条命令失败，
 * 那会让用户以为「小本本坏了」而不是「某个客户端配置写错了」。
 */
export function probeClients(opts: { home?: string; env?: NodeJS.ProcessEnv } = {}): ClientStatus[] {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  return specs(home, env).map((spec) => {
    const base: ClientStatus = {
      id: spec.id,
      label: spec.label,
      installed: spec.installPaths.some((p) => existsSync(p)),
      configPath: spec.configPaths[0] ?? "",
      configExists: false,
      entryName: null,
      via: null,
      commandPath: null,
      broken: null,
    };
    try {
      const cfg = firstExisting(spec.configPaths);
      base.configPath = cfg.path;
      base.configExists = cfg.exists;
      if (!cfg.exists) return base;

      const text = readFileSync(cfg.path, "utf8");
      if (spec.kind === "toml") {
        const { entries, problem } = scanToml(text);
        if (problem) base.broken = problem;
        for (const e of entries) {
          const via = classify(e.body);
          if (!via) continue;
          const m = /\bcommand\s*=\s*['"]([^'"]+)['"]/.exec(e.body);
          base.entryName = e.name;
          base.via = via;
          base.commandPath = m?.[1] ?? null;
          break;
        }
      } else {
        const { entries, problem } = scanJson(text, spec.container ?? "mcpServers", spec.opencodeStyle);
        if (problem) base.broken = problem;
        for (const e of entries) {
          const via = classify(flatten(e.obj));
          if (!via) continue;
          base.entryName = e.name;
          base.via = via;
          base.commandPath = pickCommand(e.obj, spec.opencodeStyle);
          break;
        }
      }

      // 配了但跑不起来 —— 这是最难自查的故障：客户端里看着有、AI 就是没有记忆。
      if (looksLikePath(base.commandPath) && !existsSync(base.commandPath)) {
        base.broken = `配置指向的可执行文件已不存在：${base.commandPath}`;
      }
      return base;
    } catch (e) {
      base.broken = e instanceof Error ? e.message : String(e);
      return base;
    }
  });
}

/**
 * 推荐的接入条目。
 *
 * 优先用桌面版的**稳定路径**（`~/.xiaobenben/bin/xbb`）而不是 npx：
 *   · 不依赖 node/npm/PATH，启动更快；
 *   · 桌面版本来就在做自更新，不需要两套更新通道；
 *   · 用户装了桌面版再用 npx 会多下一份 100MB，那是最没必要的浪费。
 * 只有找不到稳定路径时才退回 npx。
 *
 * ⚠️ 绝不推荐「当前进程自己的路径」：走 npm 时那是
 * `...\xiaobenben\pkg\v0.4.53\win32-x64.exe`，版本号写死在路径里，
 * 下次升级就变成一条指向已删除文件的死配置。所以下面用它之前先过路径形态这道闸。
 */
export function recommendedEntry(opts: { home?: string; env?: NodeJS.ProcessEnv } = {}): Entry {
  const home = opts.home ?? homedir();
  const exe = process.platform === "win32" ? "xbb.exe" : "xbb";
  const candidates = [join(home, ".xiaobenben", "bin", exe), process.execPath];
  for (const c of candidates) {
    if (/[\\/]\.xiaobenben[\\/]+bin[\\/]/i.test(c) && existsSync(c)) {
      return { command: c, args: ["mcp"], via: "desktop" };
    }
  }
  // `-y` 不是可选项：首次 npx 会问「Ok to proceed?」，而 MCP stdio 下没有任何人能回答它，
  // 表现是客户端一直等 initialize —— 用户看到的是「服务器连不上」，而不是一条提示。
  return { command: "npx", args: ["-y", "xiaobenben", "mcp"], via: "npx" };
}

/** 生成可直接粘贴的片段（各客户端容器键与条目的形状不同） */
export function snippet(id: ClientId, entry: Entry): string {
  if (id === "codex") {
    // TOML 单引号字面量：Windows 路径的反斜杠不能被当转义处理
    const q = (s: string) => `'${s.replace(/'/g, "")}'`;
    return [
      "[mcp_servers.xiaobenben]",
      `command = ${q(entry.command)}`,
      `args = [${entry.args.map(q).join(", ")}]`,
    ].join("\n");
  }
  if (id === "opencode") {
    return JSON.stringify(
      { mcp: { xiaobenben: { type: "local", command: [entry.command, ...entry.args], enabled: true } } },
      null,
      2,
    );
  }
  return JSON.stringify({ mcpServers: { xiaobenben: { command: entry.command, args: entry.args } } }, null, 2);
}

const VIA_LABEL: Record<EngineVia, string> = {
  npx: "npx 包",
  desktop: "桌面版",
  pkg: "npm 缓存二进制",
  other: "其他",
};

function pad(s: string, n: number): string {
  // 中文按显示宽度算：一个汉字占两列，否则表格会歪
  let w = 0;
  for (const ch of s) w += /[\u4e00-\u9fff]/.test(ch) ? 2 : 1;
  return s + " ".repeat(Math.max(0, n - w));
}

export function renderConnect(statuses: ClientStatus[], entry: Entry): string {
  const installed = statuses.filter((s) => s.installed);
  const connected = statuses.filter((s) => s.via && !s.broken);
  const lines: string[] = [];

  lines.push("小本本 · AI 客户端接入状态");
  lines.push("");
  lines.push(`  ${pad("客户端", 16)}${pad("已安装", 10)}${pad("已接入", 10)}引擎`);
  lines.push("  " + "─".repeat(50));
  for (const s of statuses) {
    const inst = s.installed ? "是" : "否";
    const conn = s.via ? (s.broken ? "异常" : "是") : s.installed ? "否" : "—";
    const via = s.via ? VIA_LABEL[s.via] : "—";
    lines.push(`  ${pad(s.label, 16)}${pad(inst, 10)}${pad(conn, 10)}${via}`);
  }
  lines.push("");
  lines.push(
    installed.length
      ? `  检测到 ${installed.length} 个客户端，其中 ${connected.length} 个已接入。`
      : "  没有检测到本机安装任何 AI 客户端。",
  );

  const broken = statuses.filter((s) => s.broken);
  if (broken.length) {
    lines.push("");
    lines.push("  ⚠ 配置有问题（客户端里看着有，实际连不上）：");
    for (const s of broken) {
      lines.push(`     ${s.label}: ${s.broken}`);
      lines.push(`     配置：${s.configPath}`);
    }
  }

  const pending = installed.filter((s) => !s.via);
  if (pending.length) {
    lines.push("");
    lines.push("  还没接入的客户端 —— 把下面这段放进它自己的配置文件：");
    for (const s of pending) {
      lines.push("");
      lines.push(`  ── ${s.label} ──  ${s.configPath}`);
      lines.push(
        snippet(s.id, entry)
          .split("\n")
          .map((l) => "     " + l)
          .join("\n"),
      );
    }
  } else if (installed.length) {
    lines.push("");
    lines.push("  所有已安装的客户端都接入了，无需操作。");
  }

  lines.push("");
  if (entry.via === "npx") {
    lines.push("  注意：npx 那一行必须带 -y。首次运行会问「Ok to proceed?」，");
    lines.push("        而 MCP 下没人能回答，表现是客户端一直连不上而不是报错。");
  }
  lines.push("  改完配置要重启对应客户端才生效（它们只在启动时读一次）。");
  lines.push("  本命令只读配置，不修改任何文件。");
  return lines.join("\n");
}

/** `xbb version` 里的一行摘要 —— 让「接没接入」在任何时刻都能一眼看到 */
export function connectSummary(statuses: ClientStatus[]): string {
  const installed = statuses.filter((s) => s.installed);
  if (!installed.length) return "接入: 未检测到本机 AI 客户端 · 运行 xbb connect 查看详情";
  const connected = installed.filter((s) => s.via && !s.broken);
  const broken = installed.filter((s) => s.broken);
  if (!connected.length) {
    // 「配了但坏了」和「压根没配」是两种处境：前者用户会以为一切正常（客户端里明明有这一条），
    // 后者他至少知道自己没接过。合并成一句「均未接入」会把前者藏起来 —— 而那正是
    // 「AI 突然没有记忆」最难自查的形态。
    if (broken.length) {
      return `接入: 0/${installed.length}（${broken.length} 个配置存在但连不上）· 运行 xbb connect 查看`;
    }
    return `接入: 0/${installed.length}（已安装 ${installed.map((s) => s.label).join(" / ")} 均未接入）· 运行 xbb connect`;
  }
  const names = connected.map((s) => s.label).join(" / ");
  const warn = broken.length ? ` · ${broken.length} 个配置异常` : "";
  return `接入: ${names}（${connected.length}/${installed.length}）${warn} · 运行 xbb connect 查看全部`;
}

/** 给 `--json` 用：不含内部实现细节，字段名即语义 */
export function toJson(statuses: ClientStatus[], entry: Entry): string {
  return JSON.stringify(
    {
      recommended: entry,
      clients: statuses.map((s) => ({
        id: s.id,
        label: s.label,
        installed: s.installed,
        connected: !!s.via && !s.broken,
        via: s.via,
        entryName: s.entryName,
        configPath: s.configPath,
        configExists: s.configExists,
        broken: s.broken,
        snippet: s.installed && !s.via ? snippet(s.id, entry) : null,
      })),
    },
    null,
    2,
  );
}
