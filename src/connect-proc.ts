// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 进程层判据 —— 「有 `xbb mcp` 在跑吗？是谁拉起来的？」
 *
 * 为什么需要这一层（2026-11-16 用户反馈）：`xbb connect` 原来只读配置文件，
 * 读不到就断言「未接入」。可配置在哪完全由各家客户端自己定：
 *   · opencode 新版用 `opencode.jsonc` + `mcp.servers.<name>`；
 *   · Claude Code 默认把条目写进 `~/.claude.json` 的 `projects.<项目路径>.mcpServers`；
 *   · Cursor 的项目级配置在 `<项目>/.cursor/mcp.json`，项目目录我们事先并不知道。
 * 任何一处漏掉，用户看到的就是一句斩钉截铁的「没接上」—— 于是去重复配置，
 * 甚至把一条正在工作的配置改坏。这比不告诉他更糟。
 *
 * 进程是唯一不依赖「配置放哪」的判据：只要客户端连着，就一定有一个 `xbb mcp`
 * 子进程，它的祖先进程名就是宿主。本机实测：`xbb.exe mcp` 的父进程是 `WorkBuddy.exe`。
 *
 * 两个必须处理的现实：
 *   ① npx 那条路上，直接父进程是 `node.exe`（`bin/xbb.mjs` 启动器），真正的宿主还要往上找；
 *   ② 用户在终端里手敲 `xbb mcp` 时，祖先是 shell —— 那说明「有人在用」，但认不出哪个客户端，
 *      不能硬塞给某一个。
 *
 * 本模块**只读**（枚举进程），不写任何东西；任何环节失败都返回空结果，绝不抛异常 ——
 * 一条查状态的命令不该因为拿不到进程列表而失败。
 */
import { execFileSync } from "node:child_process";

export type ClientId = "opencode" | "cursor" | "workbuddy" | "claudecode" | "claudedesktop" | "codex";

/** 进程表里的一行。`ppid` 缺失（拿不到）时用 0。 */
export interface ProcNode {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
}

/** 一个在跑的 `xbb mcp` 及其宿主判定结果。 */
export interface RunningHost {
  /** xbb mcp 进程的 pid */
  pid: number;
  /** 认出来的宿主；认不出为 null */
  client: ClientId | null;
  /** 判定时停在的那个祖先进程名（原始大小写，排障用） */
  hostName: string;
  /** 祖先停在 shell / 终端 ⇒ 像是人手动跑的，不是某个客户端在后台拉起的 */
  fromShell: boolean;
}

/** 中间层进程名：它们的父进程才是真宿主，必须继续往上找。 */
const LAUNCHER = new Set(["node", "nodejs", "bun", "npx", "npm", "cmd", "sh", "bash", "zsh", "fish"]);

/** 认出「这是人手动开的」：祖先落在终端 / shell 上就停。 */
const SHELL = new Set([
  "powershell",
  "pwsh",
  "windowsterminal",
  "wt",
  "conhost",
  "cmd",
  "bash",
  "sh",
  "zsh",
  "fish",
  "nu",
  "alacritty",
  "wezterm-gui",
  "hyper",
  "iterm2",
  "terminal",
  "warp",
  "kitty",
]);

/**
 * 进程名 → 客户端。**只认确定能对上的**，对不上宁可返回 null：
 * 猜错宿主比不猜更糟（会把「不知道谁在用」说成「Cursor 在用」）。
 */
const HOSTS: Array<{ match: RegExp; client: ClientId }> = [
  { match: /^cursor( - ?insiders)?$/i, client: "cursor" },
  { match: /^opencode$/i, client: "opencode" },
  { match: /^workbuddy$/i, client: "workbuddy" },
  { match: /^claude desktop$/i, client: "claudedesktop" },
  // claude 的 CLI 进程名就是 claude；claude-code 是旧称
  { match: /^claude(-code)?$/i, client: "claudecode" },
  { match: /^codex$/i, client: "codex" },
];

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** 归一化进程名：去路径、去 `.exe`、去首尾引号。 */
export function normalizeName(raw: string): string {
  return baseName(raw.trim().replace(/^"|"$/g, "")).replace(/\.exe$/i, "");
}

/** 这一行是不是 `xbb mcp`（不是 serve、不是用户在编辑器里打开的文件）。 */
export function isMcpProc(p: ProcNode): boolean {
  const name = normalizeName(p.name).toLowerCase();
  const head = normalizeName(p.cmd.trim().split(/\s+/)[0] ?? "").toLowerCase();
  const isXbb = name === "xbb" || head === "xbb";
  // dev 形态：`bun src/index.ts mcp` / `bun run src/index.ts serve`。
  // 判据是「首 token 是 bun/node」+「命令行里有 src/index.ts」—— 不能要求两者相邻，
  // 因为 `bun run src/index.ts` 中间还夹着 run。
  const isRunner = head === "bun" || head === "node";
  const isDev = isRunner && /(^|\s)\S*src[\\/]index\.ts(\s|$)/.test(p.cmd.trim());
  if (!isXbb && !isDev) return false;
  return p.cmd.trim().split(/\s+/).includes("mcp");
}

/**
 * 纯函数：从进程表里挑出在跑的 `xbb mcp`，沿 parent 链往上找宿主。
 *
 * `maxHops` 默认 4 —— 实测够用（Windows 上最常见的链是
 * `xbb.exe ← node.exe ← Cursor.exe`，npx 场景再多一跳）。
 * 设上限是为了防脏数据把 ppid 连成环（曾见过 pid 复用导致的假环）。
 */
export function resolveHosts(procs: ProcNode[], maxHops = 4): RunningHost[] {
  const byPid = new Map<number, ProcNode>();
  for (const p of procs) byPid.set(p.pid, p);

  const out: RunningHost[] = [];
  for (const p of procs) {
    if (!isMcpProc(p)) continue;
    let cur: ProcNode | undefined = byPid.get(p.ppid);
    let client: ClientId | null = null;
    let hostName = "";
    let fromShell = false;
    const seen = new Set<number>([p.pid]);

    for (let hop = 0; hop < maxHops && cur; hop++) {
      if (seen.has(cur.pid)) break;
      seen.add(cur.pid);
      const name = normalizeName(cur.name);

      const hit = HOSTS.find((h) => h.match.test(name));
      if (hit) {
        client = hit.client;
        hostName = cur.name;
        break;
      }
      if (SHELL.has(name.toLowerCase())) {
        hostName = cur.name;
        fromShell = true;
        break;
      }
      // 启动器 / 未知中间层：继续往上。停在第一个"有名字但不是宿主"的进程上，
      // 这样认不出时至少能告诉用户「它是挂在 X 下面的」。
      if (!hostName) hostName = cur.name;
      cur = byPid.get(cur.ppid);
    }

    out.push({ pid: p.pid, client, hostName, fromShell });
  }
  return out;
}

/** Windows：一次 CIM 查询拿全表（含 ppid）。拿不到就返回 []，不降级到 tasklist ——
 *  tasklist 没有 ppid，对「找宿主」这件事毫无用处。 */
function listWindows(): ProcNode[] {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", timeout: 12000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    const raw = out.trim().replace(/^\uFEFF/, "");
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
      ProcessId?: number;
      ParentProcessId?: number;
      Name?: string;
      CommandLine?: string | null;
    }>;
    return rows
      .filter((r) => typeof r.ProcessId === "number")
      .map((r) => ({
        pid: r.ProcessId!,
        ppid: typeof r.ParentProcessId === "number" ? r.ParentProcessId : 0,
        name: r.Name ?? "",
        cmd: r.CommandLine ?? "",
      }));
  } catch {
    return [];
  }
}

/** Unix：`ps -Ao pid=,ppid=,command=` —— BSD 与 procps 都认的最小公共子集。
 *  （`pgrep -af` 在 macOS 上没有 `-a`，2026-11-04 已被这个坑咬过一次。） */
function listUnix(): ProcNode[] {
  try {
    const out = execFileSync("ps", ["-Ao", "pid=,ppid=,command="], { encoding: "utf8", timeout: 12000 });
    const list: ProcNode[] = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      const cmd = m[3]!.trim();
      list.push({ pid: Number(m[1]), ppid: Number(m[2]), name: baseName(cmd.split(/\s+/)[0] ?? ""), cmd });
    }
    return list;
  } catch {
    return [];
  }
}

/** 枚举当前进程表。永不抛。 */
export function listProcesses(): ProcNode[] {
  return process.platform === "win32" ? listWindows() : listUnix();
}

/** 探测正在跑的小本本 MCP 进程及其宿主。永不抛。 */
export function detectRunningHosts(): RunningHost[] {
  try {
    return resolveHosts(listProcesses());
  } catch {
    return [];
  }
}
