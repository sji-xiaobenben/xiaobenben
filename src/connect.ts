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

import { detectRunningHosts, resolveHosts, type ProcNode, type RunningHost } from "./connect-proc";
import { parseJsonc } from "./jsonc";

export type { ClientId } from "./connect-proc";
import type { ClientId } from "./connect-proc";

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
  /**
   * 结论是怎么来的。**这个字段是为了不再撒谎**：
   * `config` = 在配置里读到了条目；`process` = 配置没定位到，但有它的 MCP 子进程在跑；
   * null = 两者都没有 ⇒ 只能说「未检测到」，不能说「没接入」。
   */
  detectedBy: "config" | "process" | null;
  /** 有 `xbb mcp` 子进程在跑（即使配置文件没找到） */
  running: boolean;
  /** 进程层看到的祖先进程名（原始大小写，排障用） */
  hostProcess: string | null;
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
  /**
   * 候选配置路径，**全部**都读（不是取第一个存在的就停）。
   * 一个都不存在时，用第一个作为「该往哪写」。
   */
  configPaths: string[];
  kind: "json" | "toml";
  /**
   * JSON 里走到「条目表」的路径，可给多条。`*` 表示这一层是任意键，需要展开
   * （Claude Code 的 `projects.<项目路径>.mcpServers` 就是这样）。
   *
   * 为什么是数组而不是单个字符串：同一个客户端的不同版本、不同作用域层级就不一样 ——
   * opencode 有 `mcp` 与 `mcp.servers` 两代；Claude Code 有顶层与 `projects.*` 两级。
   * 只认一种必然对另一半用户误报。
   */
  containers?: string[][];
  /** opencode 把 command 写成数组且需要 type/enabled */
  opencodeStyle?: boolean;
  /** 项目级配置：从当前工作目录拼出来一起找（Cursor / Claude Code 都支持项目级） */
  projectPath?: string;
}

/**
 * 各客户端的安装痕迹与配置位置。**这些路径是会过期的知识**，不是永恒真理 ——
 * 上游改版时这里就该跟着改，所以集中在一处，并且每一项都注释了判断依据。
 */
function specs(home: string, env: NodeJS.ProcessEnv, cwd: string): Spec[] {
  const xdg = env.XDG_CONFIG_HOME || join(home, ".config");
  const appData = env.APPDATA || join(home, "AppData", "Roaming");
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  return [
    {
      id: "opencode",
      label: "opencode",
      // 本机实测：Windows 上 opencode 也用 ~/.config/opencode（不跟 APPDATA 走）
      installPaths: [join(xdg, "opencode"), join(home, ".opencode")],
      // 官方文档的示例现在一律是 .jsonc；老版本/手写配置是 .json，再老的是 config.json
      configPaths: [
        join(xdg, "opencode", "opencode.json"),
        join(xdg, "opencode", "opencode.jsonc"),
        join(xdg, "opencode", "config.json"),
      ],
      // 两代结构：老版 `mcp.<name>`，新版 `mcp.servers.<name>`（本机 v2.2.7 用老结构仍正常，
      // 说明读取端兼容两代 —— 所以这里两种都要认，只认一种就会误报另一半用户）
      containers: [["mcp"], ["mcp", "servers"]],
      kind: "json",
      opencodeStyle: true,
    },
    {
      id: "cursor",
      label: "Cursor",
      installPaths: [join(home, ".cursor")],
      // 官方两种位置：全局 ~/.cursor/mcp.json 与 项目级 <项目>/.cursor/mcp.json（两者合并）
      configPaths: [join(home, ".cursor", "mcp.json"), join(cwd, ".cursor", "mcp.json")],
      containers: [["mcpServers"]],
      kind: "json",
      projectPath: join(".cursor", "mcp.json"),
    },
    {
      id: "workbuddy",
      label: "WorkBuddy",
      installPaths: [join(home, ".workbuddy")],
      configPaths: [join(home, ".workbuddy", "mcp.json")],
      containers: [["mcpServers"]],
      kind: "json",
    },
    {
      id: "claudecode",
      label: "Claude Code",
      // CLI 的用户级配置在 ~/.claude.json（注意不是目录）；~/.claude 是它跑起来后建的
      installPaths: [join(home, ".claude.json"), join(home, ".claude")],
      // 三种作用域：user（顶层 mcpServers）、local（projects.<路径>.mcpServers，**默认作用域**）、
      // project（项目根 .mcp.json）。只读顶层会漏掉绝大多数人 —— `claude mcp add` 不加 --scope
      // 时写的就是 local。
      configPaths: [join(home, ".claude.json"), join(cwd, ".mcp.json")],
      containers: [["mcpServers"], ["projects", "*", "mcpServers"]],
      kind: "json",
      projectPath: ".mcp.json",
    },
    {
      id: "claudedesktop",
      label: "Claude Desktop",
      installPaths: [join(appData, "Claude"), join(home, "Library", "Application Support", "Claude")],
      configPaths: [
        join(appData, "Claude", "claude_desktop_config.json"),
        join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      ],
      containers: [["mcpServers"]],
      kind: "json",
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

/**
 * 沿一条路径走到「条目表」，再把它展开成 `[名字 → 条目]`。
 *
 * `*` 表示这一层是任意键（Claude Code 的 `projects.<项目路径>.mcpServers`）。
 * 只把**长着条目样子**的对象当条目：必须自带 `command` 或 `url`。
 * 这条判据是为了不把 `mcp.servers` 这层包装当成一个叫 `servers` 的服务器 ——
 * 它没有 command/url，只是容器。
 */
function collectEntries(
  node: unknown,
  path: string[],
  out: Array<{ name: string; obj: Record<string, unknown> }>,
  depth = 0,
): void {
  if (depth > 6) return; // 防御：脏数据里的自引用
  if (path.length === 0) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    for (const [name, v] of Object.entries(node as Record<string, unknown>)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const obj = v as Record<string, unknown>;
      if (!("command" in obj) && !("url" in obj)) continue;
      out.push({ name, obj });
    }
    return;
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  const [head, ...rest] = path;
  if (head === "*") {
    for (const v of Object.values(obj)) collectEntries(v, rest, out, depth + 1);
    return;
  }
  collectEntries(obj[head!], rest, out, depth + 1);
}

function scanJson(
  text: string,
  containers: string[][],
  opencodeStyle?: boolean,
): { entries: Array<{ name: string; obj: Record<string, unknown> }>; problem: string | null } {
  let doc: unknown;
  try {
    // 先按 JSONC 剥一遍：opencode 的官方示例就带注释与尾逗号，纯 JSON.parse 会把
    // 一份完全正常的配置判成「读不了」。（stripJsonc 对纯 JSON 是恒等变换）
    doc = parseJsonc(text);
  } catch (e) {
    return { entries: [], problem: `配置不是合法 JSON（${e instanceof Error ? e.message : String(e)}）` };
  }
  if (!doc || typeof doc !== "object") return { entries: [], problem: "配置顶层不是对象" };
  const entries: Array<{ name: string; obj: Record<string, unknown> }> = [];
  for (const path of containers) collectEntries(doc, path, entries);
  void opencodeStyle;
  return { entries, problem: null };
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

/**
 * 探测所有客户端。**永不抛异常** —— 一个坏掉的配置文件不该让整条命令失败，
 * 那会让用户以为「小本本坏了」而不是「某个客户端配置写错了」。
 *
 * 两条判据缺一不可：
 *   · **配置**：能精确指认「哪个客户端、接的哪种引擎、路径是否还有效」；
 *   · **进程**：不依赖「配置放哪」，能证明「它正在被使用」，还能认出宿主。
 * 只有两条都空时才敢说「未检测到」，而且措辞必须留有余地 —— 见 renderConnect。
 *
 * `procs` 可注入（测试用）：默认会真的去枚举本机进程，那在单测里既有污染又慢。
 */
export function probeClients(
  opts: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    procs?: ProcNode[];
    /**
     * 跳过进程枚举。`xbb --version` 那种「一眼摘要」用它 ——
     * Windows 上一次全表 CIM 查询约 0.5s，为一行摘要付这个代价不值，
     * 而且 `--version` 会被脚本反复调用。
     *
     * 跳过不等于撒谎：摘要文案已经改成「未检测到」并在措辞上注明不等同于没接入，
     * 详细的进程判据留给 `xbb connect`（人主动敲的命令，愿意等那 0.5s）。
     */
    skipProcess?: boolean;
  } = {},
): ClientStatus[] {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  // 进程只枚举一次，按客户端分组。认不出宿主的（终端里手敲的、VS Code 里跑的）
  // 单独留着，由 renderConnect 如实说明「有人在用，但认不出是谁」。
  const hosts: RunningHost[] = opts.skipProcess
    ? []
    : opts.procs
      ? resolveHosts(opts.procs)
      : detectRunningHosts();
  const runningBy = new Map<ClientId, RunningHost>();
  for (const h of hosts) {
    if (h.client && !runningBy.has(h.client)) runningBy.set(h.client, h);
  }

  return specs(home, env, cwd).map((spec) => {
    const running = runningBy.get(spec.id) ?? null;
    const base: ClientStatus = {
      id: spec.id,
      label: spec.label,
      installed: spec.installPaths.some((p) => existsSync(p)) || !!running,
      configPath: spec.configPaths[0] ?? "",
      configExists: false,
      entryName: null,
      via: null,
      commandPath: null,
      broken: null,
      detectedBy: null,
      running: !!running,
      hostProcess: running?.hostName ?? null,
    };

    let hitPath: string | null = null;
    let firstExistingPath: string | null = null;
    let problem: string | null = null;

    try {
      // 逐个读：**不是**"找到第一个存在的文件就停"。同一个人可能在全局配了、
      // 又在项目里配了；也可能 .json 是坏的、.jsonc 才是真正在用的那份。
      for (const p of spec.configPaths) {
        if (!existsSync(p)) continue;
        if (!firstExistingPath) firstExistingPath = p;

        let text: string;
        try {
          text = readFileSync(p, "utf8");
        } catch (e) {
          problem ??= `${p}: ${e instanceof Error ? e.message : String(e)}`;
          continue;
        }

        if (spec.kind === "toml") {
          const { entries, problem: prob } = scanToml(text);
          if (prob) {
            problem ??= prob;
            continue;
          }
          for (const e of entries) {
            const via = classify(e.body);
            if (!via) continue;
            const m = /\bcommand\s*=\s*['"]([^'"]+)['"]/.exec(e.body);
            base.entryName = e.name;
            base.via = via;
            base.commandPath = m?.[1] ?? null;
            hitPath = p;
            break;
          }
        } else {
          const { entries, problem: prob } = scanJson(text, spec.containers ?? [["mcpServers"]], spec.opencodeStyle);
          if (prob) {
            problem ??= prob;
            continue;
          }
          for (const e of entries) {
            const via = classify(flatten(e.obj));
            if (!via) continue;
            base.entryName = e.name;
            base.via = via;
            base.commandPath = pickCommand(e.obj, spec.opencodeStyle);
            hitPath = p;
            break;
          }
        }
        if (hitPath) break;
      }
    } catch (e) {
      problem ??= e instanceof Error ? e.message : String(e);
    }

    base.configExists = !!firstExistingPath;
    base.configPath = hitPath ?? firstExistingPath ?? spec.configPaths[0] ?? "";
    base.detectedBy = hitPath ? "config" : running ? "process" : null;

    // 配了但跑不起来 —— 这是最难自查的故障：客户端里看着有、AI 就是没有记忆。
    if (hitPath) {
      if (looksLikePath(base.commandPath) && !existsSync(base.commandPath)) {
        base.broken = `配置指向的可执行文件已不存在：${base.commandPath}`;
      }
    } else if (problem) {
      // 只有「真配了却读不出来」才算 broken。连文件都没有不是故障，是没配。
      base.broken = problem;
    }
    return base;
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

export function renderConnect(statuses: ClientStatus[], entry: Entry, hosts?: RunningHost[]): string {
  const installed = statuses.filter((s) => s.installed);
  const connected = statuses.filter((s) => s.via && !s.broken);
  const runningOnly = statuses.filter((s) => !s.via && s.running);
  const unknown = (hosts ?? []).filter((h) => !h.client);
  const lines: string[] = [];

  lines.push("小本本 · AI 客户端接入状态");
  lines.push("");
  lines.push(`  ${pad("客户端", 16)}${pad("已安装", 10)}${pad("接入", 12)}引擎`);
  lines.push("  " + "─".repeat(52));
  for (const s of statuses) {
    const inst = s.installed ? "是" : "否";
    // 「使用中」是进程层看到的事实、配置层没定位到。它与「是」的区别对用户很重要：
    // 前者不该再去动配置（很可能已经正确，只是我们没找到那个文件）。
    const conn = s.via
      ? s.broken
        ? "异常"
        : "是"
      : s.running
        ? "使用中"
        : s.installed
          ? "未检测到"
          : "—";
    const via = s.via ? VIA_LABEL[s.via] : "—";
    lines.push(`  ${pad(s.label, 16)}${pad(inst, 10)}${pad(conn, 12)}${via}`);
  }
  lines.push("");
  const bits: string[] = [];
  bits.push(installed.length ? `检测到 ${installed.length} 个客户端` : "没有检测到本机安装任何 AI 客户端");
  if (connected.length) bits.push(`${connected.length} 个已接入`);
  if (runningOnly.length) bits.push(`${runningOnly.length} 个正在使用（配置未定位到）`);
  lines.push("  " + bits.join("，") + "。");

  const broken = statuses.filter((s) => s.broken);
  if (broken.length) {
    lines.push("");
    lines.push("  ⚠ 配置有问题（客户端里看着有，实际连不上）：");
    for (const s of broken) {
      lines.push(`     ${s.label}: ${s.broken}`);
      lines.push(`     配置：${s.configPath}`);
    }
  }

  if (runningOnly.length) {
    lines.push("");
    lines.push("  正在使用、但没在常见位置找到配置的：");
    for (const s of runningOnly) {
      const who = s.hostProcess ? `（宿主进程 ${s.hostProcess}）` : "";
      lines.push(`     ${s.label}${who} —— 有 xbb mcp 子进程在跑，说明它已经能用了。`);
    }
    lines.push("     不要重新配置：这些客户端的配置可能放在项目目录或内部存储里。");
  }

  const pending = installed.filter((s) => !s.via && !s.running);
  if (pending.length) {
    lines.push("");
    lines.push("  未检测到接入的客户端 —— 把下面这段放进它自己的配置文件：");
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
    lines.push("  所有已安装的客户端都能用了，无需操作。");
  }

  if (unknown.length) {
    lines.push("");
    lines.push("  另有 MCP 进程在跑，但认不出是哪个客户端拉起的：");
    for (const h of unknown) {
      const who = h.hostName ? `挂在 ${h.hostName} 下` : "宿主已退出";
      lines.push(`     pid ${h.pid} · ${who}${h.fromShell ? "（像是在终端里手动跑的）" : ""}`);
    }
  }

  // 「未检测到」必须自带这句话。否则用户会拿它当结论去重配一个本来好用的客户端 ——
  // 这正是 2026-11-16 那条反馈里最要紧的一层。
  if (statuses.some((s) => s.installed && !s.via && !s.running)) {
    lines.push("");
    lines.push("  说明：「未检测到」只代表本命令没在常见位置读到配置，不等于没接入。");
    lines.push("        部分客户端把配置存在项目目录或内部数据库里，这里读不到但照样能用。");
    lines.push("        确定自己在用的客户端，别照着上面的片段重配。");
  }

  lines.push("");
  if (entry.via === "npx") {
    lines.push("  注意：npx 那一行必须带 -y。首次运行会问「Ok to proceed?」，");
    lines.push("        而 MCP 下没人能回答，表现是客户端一直连不上而不是报错。");
  }
  lines.push("  改完配置要重启对应客户端才生效（它们只在启动时读一次）。");
  lines.push("  本命令只读配置与进程，不修改任何文件。");
  return lines.join("\n");
}

/** `xbb version` 里的一行摘要 —— 让「接没接入」在任何时刻都能一眼看到 */
export function connectSummary(statuses: ClientStatus[]): string {
  const installed = statuses.filter((s) => s.installed);
  if (!installed.length) return "接入: 未检测到本机 AI 客户端 · 运行 xbb connect 查看详情";
  const connected = installed.filter((s) => s.via && !s.broken);
  const broken = installed.filter((s) => s.broken);
  const runningOnly = installed.filter((s) => !s.via && s.running);
  // 「正在使用但配置没定位到」必须单独说，不能并进「已接入」，更不能并进「未接入」——
  // 前者会让用户以为配置没问题（其实没读到），后者会让他去重配一个能用的客户端。
  const tail = runningOnly.length ? ` · 另 ${runningOnly.length} 个正在使用` : "";
  if (!connected.length) {
    // 「配了但坏了」和「压根没配」是两种处境：前者用户会以为一切正常（客户端里明明有这一条），
    // 后者他至少知道自己没接过。合并成一句会把前者藏起来 —— 而那正是
    // 「AI 突然没有记忆」最难自查的形态。
    if (broken.length) {
      return `接入: 0/${installed.length}（${broken.length} 个配置存在但连不上）${tail} · 运行 xbb connect 查看`;
    }
    // 措辞是刻意的：这里给不出「没接入」这个结论，只说「没检测到」。
    return `接入: 未检测到（${installed.length} 个客户端${tail}）· 运行 xbb connect 查看`;
  }
  const names = connected.map((s) => s.label).join(" / ");
  const warn = broken.length ? ` · ${broken.length} 个配置异常` : "";
  return `接入: ${names}（${connected.length}/${installed.length}）${tail}${warn} · 运行 xbb connect 查看全部`;
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
        /** config=配置里读到的 / process=进程在跑但配置没定位到 / null=两者都没有 */
        detectedBy: s.detectedBy,
        running: s.running,
        hostProcess: s.hostProcess,
        via: s.via,
        entryName: s.entryName,
        configPath: s.configPath,
        configExists: s.configExists,
        broken: s.broken,
        // 只有「真的没发现任何痕迹」才给片段。正在使用的不给 —— 那会诱导用户去重配。
        snippet: s.installed && !s.via && !s.running ? snippet(s.id, entry) : null,
      })),
    },
    null,
    2,
  );
}
