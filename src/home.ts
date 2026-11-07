// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 数据位置唯一真源：程序装在 C 盘，记忆库允许放别的盘，而**程序永远知道库在哪**。
 *
 * 为什么需要这一层（2026-11-03 定稿）：
 *   原先只有 `XBB_HOME` 一个环境变量，而它**同时是安装目录与数据目录** —— 想「程序留 C 盘、
 *   库放 D 盘」就无解。更要命的是改了它之后旧库不会跟着走：新位置看到空库，而
 *   `PersonalStore.open()` 无条件 `create: true` ⇒ 一声不吭造一个全新空库。用户看到的是
 *   「AI 突然什么都不记得了，但小本本一切正常」。这不是体验问题，是**正确性**问题：
 *   MCP 宿主拉起 `xbb.exe mcp` 时只给 command+args，不传任何路径，exe 认错路没有人能纠正它。
 *
 * 铁律：**锚点必须跟着程序走，绝不能跟着库走。**
 *   配置（config.json）落在**程序目录**：程序目录是稳定的，所以它永远记得库该在哪。
 *   库没了就是「锚点在、货不在」—— 一个**可被检测到的异常**，而不是一个正常状态。
 *   反过来把配置塞进库目录，库一丢配置跟着丢 ⇒ 程序判定"首次运行" ⇒ 必然新建空库。
 *
 * 解析优先级：XBB_DATA_DIR（企业分发/临时排障） > config.json 的 dataDir（用户设定） > 程序目录（默认）。
 * 默认回落保证向后兼容：没设过的老用户解析结果与旧版逐字节一致。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, cpSync, rmSync } from "node:fs";
import { join, resolve as pathResolve, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { Database } from "bun:sqlite";

export const DB_FILENAME = "memory.db";

/** 程序目录 = 安装目录：exe、二进制依赖、托盘资源、更新包、cloud.json、config.json 都住这儿。
 *  **不是**数据目录 —— 混在一起正是这套改造要解开的那个结。 */
export function programDir(): string {
  return process.env.XBB_HOME ?? join(homedir(), ".xiaobenben");
}

/** 锚点：库该在哪，只有这个文件说了算。放程序目录，所以库丢了它也还在。 */
export function homeConfigPath(): string {
  return join(programDir(), "config.json");
}

export interface HomeConfig {
  /** 记忆库/模型等数据资产的所在目录（绝对路径）。缺省 = 程序目录。 */
  dataDir?: string;
  /** 记录这份配置是谁、什么时候写的 —— 排障时"谁改的"比"改成什么"更难查 */
  updatedAt?: string;
  updatedBy?: string;
}

/** 读锚点。损坏/缺失一律返回 null（走默认位置），绝不因为一个坏 JSON 让程序起不来。 */
export function readHomeConfig(): HomeConfig | null {
  const p = homeConfigPath();
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as HomeConfig;
    if (raw && typeof raw === "object") return raw;
    return null;
  } catch {
    return null;
  }
}

/** 写锚点（合并写，不清掉不认识的字段）。目录不存在就建。 */
export function writeHomeConfig(patch: HomeConfig, by = "cli"): HomeConfig {
  const cur = readHomeConfig() ?? {};
  const next: HomeConfig = { ...cur, ...patch, updatedAt: new Date().toISOString(), updatedBy: by };
  const p = homeConfigPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

/** 撤掉指向（回到默认位置）。**不能**用 writeHomeConfig({dataDir: undefined})：
 *  那是"合并写"、undefined 会被 JSON.stringify 丢掉而旧值留在文件里 —— 看起来改了其实没改。 */
export function clearDataDir(by = "cli"): void {
  const p = homeConfigPath();
  if (!existsSync(p)) return;
  const cur = readHomeConfig() ?? {};
  const { dataDir: _dropped, ...rest } = cur;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ ...rest, updatedAt: new Date().toISOString(), updatedBy: by }, null, 2) + "\n", "utf8");
}

export type DataDirSource = "env" | "config" | "default";

/** 数据目录 + 它是怎么被决定的（「为什么是这个路径」必须能回答，否则排障只能猜） */
export function resolveDataDirWithSource(): { dir: string; source: DataDirSource } {
  const envDir = process.env.XBB_DATA_DIR?.trim();
  if (envDir) return { dir: absFrom(programDir(), envDir), source: "env" };
  const cfgDir = readHomeConfig()?.dataDir?.trim();
  if (cfgDir) return { dir: absFrom(programDir(), cfgDir), source: "config" };
  return { dir: programDir(), source: "default" };
}

export function resolveDataDir(): string {
  return resolveDataDirWithSource().dir;
}

/** 库文件绝对路径 —— 全仓唯一出口（原先 defaultDbPath 一处，其余 9 处各自拼，迟早漂移） */
export function resolveDbPath(): string {
  return join(resolveDataDir(), DB_FILENAME);
}

/** 向量模型缓存：属**数据资产**（24MB、重下要等），所以跟着数据目录走，不跟着程序走 */
export function modelsDir(): string {
  return join(resolveDataDir(), "models");
}

function absFrom(base: string, p: string): string {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\") ? pathResolve(p) : pathResolve(base, p);
}

// ─────────────────────────── 判定闸：绝不静默新建 ───────────────────────────

export type DbMissingKind =
  /** 配了位置、那儿没有库，而默认位置也没有 —— 多半是盘没挂载 / 库被移走 */
  | "configured-missing"
  /** 配了位置、那儿没有库，但**默认位置有库** —— 改配置没搬库，最危险的一种 */
  | "configured-missing-but-legacy-exists"
  /** 环境变量指定了位置、那儿没有库 */
  | "env-missing"
  /** 没配任何位置、默认位置没有库，但**这套安装明显用过** —— 库是被移走/误删，不是首次安装 */
  | "default-missing-but-installed";

export interface DbMissingDetail {
  kind: DbMissingKind;
  dbPath: string;
  dataDir: string;
  source: DataDirSource;
  configPath: string;
  configRaw: HomeConfig | null;
  legacyDbPath: string;
  legacyExists: boolean;
}

/**
 * 库不在预期位置时抛这个 —— **不要**捕获它去建空库。
 * message 就是给用户/AI 看的话术：必须能自己说清"为什么、怎么办"。
 */
export class DbMissingError extends Error {
  readonly code = "XBB_DB_MISSING";
  constructor(readonly detail: DbMissingDetail) {
    super(explainMissing(detail));
    this.name = "DbMissingError";
  }
}

function explainMissing(d: DbMissingDetail): string {
  const lines: string[] = [];
  lines.push(`记忆库不在预期位置：${d.dbPath}`);
  if (d.kind === "default-missing-but-installed") {
    lines.push("   这里是默认安装目录，而且**程序痕迹都在**（bin / models / logs / cloud.json 之类）——");
    lines.push("   说明这套安装用过，不是首次运行。库应该是被移动、重命名或误删了。");
    lines.push("   所以这里拒绝启动：新建一个空库会让你以为记忆全丢了。");
  } else if (d.kind === "env-missing") {
    lines.push(`   位置来自环境变量 XBB_DATA_DIR（临时覆盖，不写盘）`);
  } else {
    lines.push(`   位置来自配置：${d.configPath}`);
  }
  if (d.kind === "configured-missing-but-legacy-exists") {
    lines.push("");
    lines.push(`⚠️ 但默认位置**有**库：${d.legacyDbPath}`);
    lines.push("   这不是首次运行 —— 库还在，只是新配置指向的地方没有它。");
    lines.push("   直接新建空库会让你以为记忆全丢了，所以这里拒绝启动。");
  } else if (d.kind === "configured-missing" || d.kind === "env-missing") {
    lines.push("");
    lines.push("可能原因：① 该盘未挂载/已拔出　② 库被移动、重命名或误删　③ 配置指向了错误路径");
  }
  lines.push("");
  lines.push(`排查：xbb home show        看程序与库的实际位置、大小、最后写入时间`);
  lines.push(`      xbb home find        扫各盘找 memory.db（忘了当初放哪时用）`);
  if (d.source === "env") {
    // env 的优先级高于配置文件：这时候 move/set 写进去也没用，说清楚免得白折腾一趟
    lines.push(`      ↳ 位置来自环境变量，它**优先于配置文件** —— 撤掉或改正 XBB_DATA_DIR 才会生效`);
  } else if (d.kind === "configured-missing-but-legacy-exists") {
    lines.push(`      xbb home move "${dirname(d.legacyDbPath)}"   把默认位置的库搬过去并校准配置`);
    lines.push(`      xbb home reset       撤掉配置，回到默认位置（${d.legacyDbPath}）`);
  } else if (d.kind === "default-missing-but-installed") {
    lines.push(`      xbb home set "<某个 memory.db 所在的目录>"   找到它之后指过去`);
  }
  lines.push(`确认要从零开始：xbb home init --force（会新建空库，且必须显式指定 --force）`);
  return lines.join("\n");
}

export interface DbGateResult {
  dbPath: string;
  dataDir: string;
  source: DataDirSource;
  /** 库文件此前是否存在（false ⇒ 本次是首次运行，允许建库） */
  existed: boolean;
  /** 本次是首次运行（只有这种情况才允许 create） */
  firstRun: boolean;
}

/** 「这套安装用过」的痕迹：首次安装的干净目录里一个都不会有。
 *
 *  判据必须选**权威状态**而不是副作用。这里刻意**不把 `bin/`、`models/`、`tray/` 算进来**：
 *  它们在"刚装好、还没跑过"的机器上就已经存在（安装包解压 + 预置模型），
 *  拿它们当"用过"的证据，会把全新的机器误判成"库丢了"——那是最招人烦的一种误报。
 *
 *  `.initialized` 是本机制自己的锚点：首次建库时写一次，之后库被删也还在。
 *  旧版用户没有它（向后兼容），但他们的库通常还在（existed=true 直接放行）；
 *  万一旧库被删，行为与旧版一致（新建），不倒退。
 */
const INSTALL_TRACES = [".initialized", "logs", "cloud.json", "notify-state.json", "update", "memory.db.gen1", "memory.db-wal", "memory.db-shm"];

export const INIT_MARKER = ".initialized";

export function installedTrace(dir = programDir()): string[] {
  return INSTALL_TRACES.filter((n) => existsSync(join(dir, n)));
}

/** 首次建库时落一次：这是"这套安装用过"最可靠的证据，也是库被删后唯一的残影。
 *  幂等——已经存在就不动（保留最初的时间戳，那是"第一次用它"的时刻）。 */
export function markInitialized(dir = programDir(), version?: string): void {
  const p = join(dir, INIT_MARKER);
  if (existsSync(p)) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, JSON.stringify({ firstRunAt: new Date().toISOString(), version: version ?? null }) + "\n", "utf8");
  } catch {
    /* 写不进去不阻断建库：标记是增强判据，不是前置条件 */
  }
}

/**
 * 打开库之前的判定闸 —— **全仓唯一允许决定"要不要建库"的地方**。
 *
 * 判定表：
 *   无配置 + 默认位置有库            → 老用户，正常打开（零感知）
 *   无配置 + 无库 + 无安装痕迹        → 首次安装，允许建库
 *   无配置 + 无库 + **有安装痕迹**    → **抛错**：这不是首次运行，库是被移走/误删了
 *   有配置 + 目标有库                → 正常打开
 *   有配置 + 目标无库                → **抛错**，绝不建
 *
 * 第四行来自 2026-11-03 的真实反馈："更新或装 MCP 时发现 C 盘怎么没小本本的 db，
 * 就又新建一个，对不对？" —— 对，所以这里必须能分辨"干净的新机器"和"库不见了的老机器"。
 *
 * `force` 只由 `xbb home init --force` 传入 —— 那是用户看着报错后显式确认"从零开始"的动作。
 */
export function openGate(opts: { force?: boolean } = {}): DbGateResult {
  const { dir, source } = resolveDataDirWithSource();
  const dbPath = join(dir, DB_FILENAME);
  const legacyDbPath = join(programDir(), DB_FILENAME);
  const existed = existsSync(dbPath);
  if (existed) return { dbPath, dataDir: dir, source, existed: true, firstRun: false };

  if (source === "default") {
    if (opts.force) return { dbPath, dataDir: dir, source, existed: false, firstRun: true };
    // 没有锚点可依，就看**这套安装用过没有**：用过 ⇒ 库丢了，不是首次运行
    const traces = installedTrace(programDir());
    if (!traces.length) return { dbPath, dataDir: dir, source, existed: false, firstRun: true };
    throw new DbMissingError({
      kind: "default-missing-but-installed",
      dbPath,
      dataDir: dir,
      source,
      configPath: homeConfigPath(),
      configRaw: readHomeConfig(),
      legacyDbPath,
      legacyExists: false,
    });
  }

  if (opts.force) return { dbPath, dataDir: dir, source, existed: false, firstRun: true };
  throw new DbMissingError({
    kind: source === "env" ? "env-missing" : existsSync(legacyDbPath) ? "configured-missing-but-legacy-exists" : "configured-missing",
    dbPath,
    dataDir: dir,
    source,
    configPath: homeConfigPath(),
    configRaw: readHomeConfig(),
    legacyDbPath,
    legacyExists: existsSync(legacyDbPath),
  });
}

/** 库在位性的一句话摘要（管理页 / 托盘 / 报错共用同一种说法，避免各处措辞不一） */
export function dbPresence(): {
  dbPath: string;
  dataDir: string;
  source: DataDirSource;
  exists: boolean;
  sizeBytes: number;
  mtime: string | null;
} {
  const { dir, source } = resolveDataDirWithSource();
  const dbPath = join(dir, DB_FILENAME);
  let sizeBytes = 0;
  let mtime: string | null = null;
  try {
    const st = statSync(dbPath);
    sizeBytes = st.size;
    mtime = st.mtime.toISOString();
  } catch {
    /* 不在位 */
  }
  return { dbPath, dataDir: dir, source, exists: existsSync(dbPath), sizeBytes, mtime };
}

// ─────────────────────────── 迁移：复制、校验、再切 ───────────────────────────

/** 迁移白名单：**只有数据资产跟库走**。程序本体、更新包、托盘资源、配置留在程序目录。
 *  漏掉一个会怎样：模型目录没搬 ⇒ 新位置重下 24MB；把 bin/ 搬了 ⇒ 程序路径变了，自更新与
 *  开机自启全部指向旧位置。所以是白名单不是黑名单 —— 新增数据资产必须显式登记。 */
export function dataEntries(dataDir: string): string[] {
  const out: string[] = [];
  try {
    for (const name of readdirSync(dataDir)) {
      if (/^memory\.db/.test(name)) out.push(name); // memory.db / -wal / -shm / .gen1 封存库
      else if (name === "models" || name === "payloads") out.push(name);
    }
  } catch {
    /* 目录不存在 = 没有可搬的 */
  }
  return out;
}

export function dirUsage(p: string): number {
  let total = 0;
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return st.size;
    for (const name of readdirSync(p)) total += dirUsage(join(p, name));
  } catch {
    /* 无权限/已消失的条目按 0 计 */
  }
  return total;
}

/** `xbb home set` 换目录后的模型随行：目标没有 models，就从当前数据目录或程序目录复制一份。
 *
 *  为什么必须做：缺模型**不会报错**，只会静默降级成关键词检索。用户换完目录只觉得
 *  「怎么好像变笨了」，根本不会联想到「我是把库换个盘」。而 models 只有 ~24MB，
 *  复制成本远低于"让人自己发现并重下"。 */
export function copyModelsInto(targetDir: string, sourceDir?: string): { copied: boolean; from?: string; bytes?: number } {
  const dst = join(targetDir, "models");
  if (existsSync(dst)) return { copied: false };
  // ⚠️ sourceDir 必须由调用方在**写配置之前**取好。若在这里现取 resolveDataDir()，
  //    调用方已经 set 完的话它返回的就是新目录（没有 models），于是"从自己复制到自己"、
  //    静默什么都不做——2026-11-04 端到端实测踩到过。
  const candidates = sourceDir
    ? [join(sourceDir, "models")]
    : [join(resolveDataDir(), "models"), join(programDir(), "models")];
  for (const src of candidates) {
    if (!existsSync(src) || pathResolve(src) === pathResolve(dst)) continue;
    const bytes = dirUsage(src);
    if (!bytes) continue;
    cpSync(src, dst, { recursive: true, force: true });
    return { copied: true, from: src, bytes };
  }
  return { copied: false };
}

/** 一个 xbb 进程。`cmd` 是完整命令行 —— 区分 serve / mcp 只能靠它，进程名看不出来。 */
export interface ProcInfo {
  pid: number;
  /** 进程名（Windows 为 xbb.exe；Unix 为命令行首 token 的 basename） */
  name: string;
  /** 完整命令行；Windows 的 tasklist 回退路径拿不到时为空串（见 classifyProcs 的保守处理） */
  cmd: string;
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** 这一行是不是本程序的进程。
 *
 *  判据取**首 token 的 basename 恰好是 xbb**，不是"命令行里出现过 xbb"：
 *  后者会把"用编辑器打开 ~/.xiaobenben/xbb/cli"这类进程也算进来，然后 `xbb stop` 去杀人家编辑器。
 *  dev 形态（`bun src/index.ts serve`）额外放行，但要求首 token 是 bun/node —— 同一条命令在
 *  编辑器里只是被"打开"，不会出现在 argv 首位。
 *
 *  导出只为可测：Unix 那条分支在本机（Windows）跑不到，只能靠纯字符串断言守着。 */
export function isXbbCommand(cmdLine: string): boolean {
  const tokens = cmdLine.trim().split(/\s+/);
  const base = baseName(tokens[0] ?? "").toLowerCase();
  if (base === "xbb" || base === "xbb.exe") return true;
  const runner = base === "bun" || base === "bun.exe" || base === "node" || base === "node.exe";
  return runner && tokens.slice(1).some((t) => /(^|[\\/])src[\\/]index\.ts$/.test(t));
}

/** 命令行里有没有独立的 `mcp` token（argv 形态），用来把 mcp 与 serve/托盘分开。 */
export function isMcpCommand(cmdLine: string): boolean {
  return cmdLine.trim().split(/\s+/).includes("mcp");
}

/** Windows：优先用 CIM 拿到「PID + 命令行」，拿不到再退 tasklist（只有名字）。
 *
 *  为什么要 PowerShell：tasklist 不提供命令行，而 `stop --keep-mcp` 必须区分 mcp 与 serve。
 *  为什么可以接受这 ~0.5s：stop / home move 都是低频人工操作，不值得为省半秒去赌「杀错进程」。 */
function listWindowsProcs(): ProcInfo[] {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='xbb.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", timeout: 8000, windowsHide: true },
    );
    const raw = out.trim();
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      const rows = (Array.isArray(parsed) ? parsed : [parsed]) as { ProcessId?: number; CommandLine?: string }[];
      const list = rows
        .filter((r) => typeof r.ProcessId === "number")
        .map((r) => ({ pid: r.ProcessId!, name: "xbb.exe", cmd: r.CommandLine ?? "" }));
      if (list.length) return list;
    }
    // 解析成功但确实没进程 ⇒ 就是没有，不必再退 tasklist
    if (raw === "" || raw === "null") return [];
  } catch {
    /* PowerShell 不可用（被策略禁用 / 未装）⇒ 退 tasklist，功能降级但不崩 */
  }
  try {
    const out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 8000, windowsHide: true });
    return out
      .split(/\r?\n/)
      .map((l) => l.match(/^"([^"]+)","(\d+)"/))
      .filter((m): m is RegExpMatchArray => !!m && m[1]!.toLowerCase().startsWith("xbb"))
      .map((m) => ({ pid: Number(m[2]), name: m[1]!, cmd: "" }));
  } catch {
    return [];
  }
}

/** Unix（macOS / Linux）：`ps -Ao pid=,command=`。
 *
 *  ⚠️ 2026-11-04 修：原来写的是 `pgrep -af xbb` —— **macOS 的 pgrep 没有 `-a`**（BSD 与 GNU 的
 *  选项不一致），于是它抛错、被 catch 吞成空列表，结果是：macOS 上 `xbb stop` 永远报"没有在跑的
 *  进程"，而 `xbb home move` 的进程检查**形同虚设**（静默跳过保护）。同一个坑在 Windows 侧也不同：
 *  `tasklist` 给不出命令行。
 *
 *  `ps -Ao pid=,command=` 是 BSD 与 procps 都认的最小公共子集，两个平台一条实现，少一套分支。 */
function listUnixProcs(): ProcInfo[] {
  const out = execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8", timeout: 8000 });
  const list: ProcInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!m) continue;
    const cmd = m[2]!.trim();
    if (!isXbbCommand(cmd)) continue;
    list.push({ pid: Number(m[1]), name: baseName(cmd.split(/\s+/)[0] ?? ""), cmd });
  }
  return list;
}

/** 进程占用探测：serve 在跑，或者库被别的 MCP 子进程捏着，迁移都会丢 WAL 里的写入。
 *  两层判据都做：进程名会改名/换壳，**独占锁**不会骗人。 */
export function runningProcs(): ProcInfo[] {
  const self = process.pid;
  try {
    const list = process.platform === "win32" ? listWindowsProcs() : listUnixProcs();
    return list.filter((p) => p.pid !== self);
  } catch {
    return [];
  }
}

/** 哪些该停、哪些该留（纯函数，便于测「--keep-mcp 的边界」而不真去杀进程）。
 *
 *  ⚠️ `cmd` 为空 = **拿不到命令行**（Windows 退到了 tasklist）。这时 keepMcp 下宁可不杀：
 *  杀错 mcp 的代价是当前会话的记忆工具立刻失效且要重启客户端，而少杀一个 serve 只是白跑一趟。 */
export function classifyProcs(
  procs: ProcInfo[],
  opts: { keepMcp?: boolean } = {},
): { kill: ProcInfo[]; keep: ProcInfo[]; undecidable: ProcInfo[] } {
  const kill: ProcInfo[] = [];
  const keep: ProcInfo[] = [];
  const undecidable: ProcInfo[] = [];
  for (const p of procs) {
    if (!opts.keepMcp) {
      kill.push(p);
      continue;
    }
    if (!p.cmd) {
      undecidable.push(p);
      keep.push(p);
      continue;
    }
    if (isMcpCommand(p.cmd)) keep.push(p);
    else kill.push(p);
  }
  return { kill, keep, undecidable };
}

/** 进程还活着吗（signal 0 只做存在性检查，不真发信号）。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 等这些 PID 真的消失，返回**仍然活着**的那些。 */
function waitGone(pids: number[], budgetMs: number): Set<number> {
  const pending = new Set(pids);
  const deadline = Date.now() + budgetMs;
  while (pending.size && Date.now() < deadline) {
    for (const pid of [...pending]) if (!alive(pid)) pending.delete(pid);
    if (pending.size) Bun.sleepSync(50);
  }
  return pending;
}

export interface StopReport {
  stopped: ProcInfo[];
  /** 因为 --keep-mcp 而保留的（含 mcp，以及拿不到命令行因而不敢动的） */
  kept: ProcInfo[];
  /** 拿不到命令行、被保守跳过的 —— 输出里要说清楚，否则用户以为 --keep-mcp 什么都没做 */
  undecidable: ProcInfo[];
  failed: (ProcInfo & { err: string })[];
}

/** 停掉 xbb 进程（`xbb stop`）。
 *
 *  为什么需要它：`serve --detach` 是脱离终端的后台进程，托盘没开的时候命令行没有任何
 *  合法手段能停它；而 `xbb home move` 又要求「全部退出」。以前只能去任务管理器里翻。
 *
 *  边界说清楚（不要包装成"能停一切"）：
 *   · 能停本机所有 xbb 进程，包括 serve 与各客户端拉起的 mcp。
 *   · 但 mcp 是被宿主**托管**的——Cursor / opencode / WorkBuddy 一发现子进程没了就会重新拉起。
 *     所以停完它们还会回来：**要真停干净，得先关客户端**。这一点在输出里如实说。
 *   · 只停本机进程，不碰托盘以外的系统服务，不做开机自启项的增删。
 *   · `--keep-mcp` 保留 mcp（不断当前会话），代价是**库仍被它连着**，搬库照样会被拦。
 *
 *  ⚠️ 停完必须等进程真的消失再返回：SIGTERM 是"请求退出"，进程收尾要几十到几百毫秒。
 *  以前不等就返回，用户紧接着跑 `xbb home move` 会撞上"库仍被占用"——而进程其实马上就没了，
 *  于是他又去关一遍客户端，白折腾一场。 */
export function stopAll(
  opts: { keepMcp?: boolean; procs?: () => ProcInfo[]; waitMs?: number } = {},
): StopReport {
  const all = (opts.procs ?? runningProcs)();
  const { kill, keep, undecidable } = classifyProcs(all, { keepMcp: opts.keepMcp });

  const stopped: ProcInfo[] = [];
  const failed: (ProcInfo & { err: string })[] = [];
  for (const p of kill) {
    try {
      if (process.platform === "win32") {
        // taskkill /T 连带子进程：serve 可能已经拉起了 ingest 之类的伴生进程
        execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore", timeout: 8000, windowsHide: true });
      } else {
        process.kill(p.pid, "SIGTERM");
      }
      stopped.push(p);
    } catch (e) {
      failed.push({ ...p, err: String((e as { message?: string })?.message ?? e) });
    }
  }

  const stuck = waitGone(stopped.map((p) => p.pid), opts.waitMs ?? 3000);
  const stillStopped: ProcInfo[] = [];
  for (const p of stopped) {
    if (stuck.has(p.pid)) failed.push({ ...p, err: "已发出退出信号，但 3 秒内没有退出" });
    else stillStopped.push(p);
  }
  return { stopped: stillStopped, kept: keep, undecidable, failed };
}

/** 库是否被别的连接占着：拿独占写锁试一下。拿不到 = 有人在写（比看进程名可靠）。
 *
 * ⚠️ 2026-11-04 修：原来写的是 `new Database(path, { readonly: false })` 且 `catch { return true }`。
 * Bun 的 sqlite **不接受 `readonly: false` / `create: false`**（传了直接 `SQLITE_MISUSE:
 * bad parameter or other API misuse`），于是「打开」这一步就抛错，被 catch 一口吞成「被占用」——
 * **只要库存在就永远判占用，`xbb home move` 100% 失败**，且拿所有进程都退干净了也无法通过。
 *
 * 两个教训写在这里，别再犯：
 *  ① 打开读写库用 `{ readwrite: true }`（或干脆不传选项）。传 `false` 不是「关掉开关」而是非法值。
 *  ② **判据只能认「锁」这一种失败**。把 API 误用、文件损坏、权限不足统统归成「被占用」，
 *     等于把一个一眼能看出来的编码错误伪装成环境问题——用户按提示去关进程，关到天荒地老也没用。
 */
export function dbLocked(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readwrite: true });
    db.exec("PRAGMA busy_timeout = 400");
    db.exec("BEGIN IMMEDIATE");
    db.exec("COMMIT");
    return false;
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked|table is locked/i.test(msg)) return true;
    throw new Error(
      `无法确认库是否空闲：${dbPath}\n` +
        `  原因：${msg}\n` +
        `  这不是「被占用」，而是这项检查本身失败了——请把上面这行原文发给我们。\n` +
        `  确认没有 xbb 进程在跑时，可以跳过检查：xbb home move "<目录>" --force`,
    );
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

export interface MoveReport {
  from: string;
  to: string;
  entries: string[];
  bytes: number;
  verify: { integrity: string; memories: number; episodes: number; events: number } | null;
  configPath: string;
}

/** 占用探测的注入点（默认走真实实现）。测试注入"空闲"才能验证迁移本身，
 *  而不必为了让测试跑通去关掉那道闸 —— 那等于测试在保护一个被削弱的检查。 */
interface MoveDeps {
  procs?: () => ProcInfo[];
  locked?: (dbPath: string) => boolean;
}

/** `--force`：跳过占用检查。只在用户已自行确认无进程时使用——它不是"忽略错误"，
 *  而是"我接受这次检查不做"。复制后的完整性/行数校验**照样执行**，不因 force 放宽。 */

/**
 * `xbb home move <目标目录>`：**复制 → 校验 → 才切配置**。
 *
 * 三条纪律（照项目既有的"反证+断言"风格）：
 *  ① 复制不移动 —— 中途断电/复制失败时库还在原地，用户最坏只是白等一场；
 *  ② 校验不过就不切 —— `PRAGMA integrity_check` + 关键表行数逐项比对，任何一项不一致立刻抛，
 *     绝不写 config（半截库被当成真库，比没有库更糟）；
 *  ③ 旧数据不删 —— 用户在 `show` 里确认新位置真的在工作之后自己删，或者用 --cleanup。
 */
export function moveDataDir(target: string, opts: { cleanup?: boolean; force?: boolean } & MoveDeps = {}): MoveReport {
  const { dir: from } = resolveDataDirWithSource();
  const to = absFrom(process.cwd(), target);
  if (pathResolve(from) === pathResolve(to)) throw new Error(`目标就是当前位置：${to}`);

  const srcDb = join(from, DB_FILENAME);

  // force 时两道检查都跳过：用户明确表示"我知道现在没进程，别拦我"。
  // 但**校验不跳**——搬完照样比完整性、比行数，那才是"没搬坏"的证据。
  if (!opts.force) {
    const procs = (opts.procs ?? runningProcs)();
    if (procs.length) {
      throw new Error(
        `还有 xbb 进程在跑：${procs.map((p) => `PID ${p.pid} ${p.name}`).join("、")}\n` +
          `  迁移会丢 WAL 里尚未落盘的写入。先停掉：xbb stop\n` +
          `  （托盘菜单退出也可以；Cursor / opencode / WorkBuddy 会各自拉起一个 xbb mcp，` +
          `关掉客户端后它们才会消失，被杀掉会被立刻重新拉起。）\n` +
          `  确认这些进程都不在了，但仍被拦住：xbb home move "<目录>" --force`,
      );
    }
    if ((opts.locked ?? dbLocked)(srcDb)) {
      throw new Error(
        `库被占用，现在搬会丢掉尚未写盘的数据：${srcDb}\n` +
          `  · 先试：xbb stop（停掉后台服务），并关掉开着小本本的 AI 客户端\n` +
          `  · 仍然报这一句：xbb home move "<目录>" --force（跳过这项检查，校验照做）`,
      );
    }
  }

  const dstDb = join(to, DB_FILENAME);
  if (existsSync(dstDb) && statSync(dstDb).size > 0) {
    throw new Error(
      `目标位置已有库：${dstDb}\n` +
        `   为避免覆盖别人的记忆，这里不继续。\n` +
        `   · 想用这份现成的：xbb home set "${to}"（先确认它是你要的那一份）\n` +
        `   · 想换个地方：换一个空目录`,
    );
  }

  const entries = dataEntries(from);
  if (!entries.length) throw new Error(`当前位置没有可搬的数据：${from}`);
  mkdirSync(to, { recursive: true });
  let bytes = 0;
  for (const name of entries) {
    const src = join(from, name);
    const dst = join(to, name);
    const size = dirUsage(src);
    cpSync(src, dst, { recursive: true, force: true });
    bytes += size;
  }

  const verify = verifyCopy(srcDb, dstDb);
  if (!verify) throw new Error(`复制后校验未产生结果：${dstDb}`);
  if (verify.integrity !== "ok") {
    throw new Error(`复制后完整性校验失败（${verify.integrity}）：${dstDb}\n   未切换配置，原库完好：${srcDb}`);
  }

  const cfg = writeHomeConfig({ dataDir: to }, "xbb home move");
  if (opts.cleanup) {
    for (const name of entries) {
      try {
        rmSync(join(from, name), { recursive: true, force: true });
      } catch {
        /* 删不掉就留着，不影响正确性 */
      }
    }
  }
  return { from, to, entries, bytes, verify, configPath: homeConfigPath() };
}

export interface DbCounts {
  integrity: string;
  memories: number;
  episodes: number;
  events: number;
}

/** 只读打开库数三张表 + integrity_check。排障/迁移校验/管理页共用同一份口径。 */
export function readDbCounts(p: string): DbCounts {
  const db = new Database(p, { readonly: true });
  try {
    const integrity = (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    const one = (q: string) => {
      try {
        return (db.query(q).get() as { n: number }).n;
      } catch {
        return -1; // 表不存在（老库/空库）—— 两侧同规则，仍可比较
      }
    };
    return {
      integrity,
      memories: one("SELECT count(*) n FROM memories"),
      episodes: one("SELECT count(*) n FROM episodes"),
      events: one("SELECT count(*) n FROM events"),
    };
  } finally {
    db.close();
  }
}

/** 复制后校验：完整性 + 关键表行数。**行数才是"搬全了没有"的硬证据**，integrity_check 只证明页没错乱。 */
export function verifyCopy(srcDb: string, dstDb: string): MoveReport["verify"] {
  if (!existsSync(dstDb)) throw new Error(`复制后目标库不存在：${dstDb}`);
  const a = readDbCounts(srcDb);
  const b = readDbCounts(dstDb);
  for (const k of ["memories", "episodes", "events"] as const) {
    if (a[k] !== b[k]) throw new Error(`复制后行数不一致（${k}: 源 ${a[k]} / 目标 ${b[k]}）——未切换配置，原库完好：${srcDb}`);
  }
  return b;
}

// ─────────────────────────── 找库：忘了放哪时的救命绳 ───────────────────────────

export interface FoundDb {
  path: string;
  bytes: number;
  mtime: string;
  memories: number | null;
}

/** 跳过这些目录：扫进去纯属浪费时间，还可能一屏噪音 */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "bin", "update", "tray", "windows", "winsxs", "$recycle.bin",
  "system volume information", "appdata", "library", "program files", "program files (x86)",
  "proc", "sys", "dev", "snap", "tmp", "temp",
]);

/**
 * 扫盘找 memory.db。默认只扫**合理范围**（各盘根 + 家目录，深度 4，最多 25000 个目录、15 秒），
 * 因为全盘深扫在 Windows 上能跑十分钟；`deep` 才放开深度与预算。
 * 找到就统计条数 —— 同名空库很常见（`create: true` 的产物），条数能直接分出"哪个是真的"。
 */
export function findDatabases(opts: { deep?: boolean; budgetMs?: number; roots?: string[] } = {}): FoundDb[] {
  const maxDepth = opts.deep ? 10 : 4;
  const deadline = Date.now() + (opts.budgetMs ?? (opts.deep ? 120_000 : 15_000));
  let budget = opts.deep ? 400_000 : 25_000;
  const roots: string[] = [...(opts.roots ?? [])];
  if (!opts.roots) {
    roots.push(programDir(), resolveDataDir(), homedir());
    // 盘符枚举只在 Windows 有意义：Unix 上 `C:\` 只是个奇怪的文件名，列 26 次全是 false
    if (process.platform === "win32") {
      for (const ch of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
        const r = `${ch}:\\`;
        if (existsSync(r)) roots.push(r);
      }
    }
    // Unix 的"别的盘"就是挂载点：macOS 外接盘在 /Volumes，Linux 在 /mnt 与 /media
    if (process.platform === "darwin") roots.push("/Volumes");
    if (process.platform === "linux") roots.push("/mnt", "/media");
  }

  const seen = new Set<string>();
  const out: FoundDb[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || budget-- <= 0 || Date.now() > deadline) return;
    const key = dir.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      const lower = name.toLowerCase();
      if (lower === DB_FILENAME) {
        try {
          const st = statSync(p);
          out.push({ path: p, bytes: st.size, mtime: st.mtime.toISOString(), memories: countMemories(p) });
        } catch {
          /* 读不到就跳过 */
        }
        continue;
      }
      // 跳过规则：已知噪音目录一律不进；隐藏目录只放行 .xiaobenben（数据目录的默认形态）
      if (SKIP_DIRS.has(lower)) continue;
      if (lower.startsWith(".") && lower !== ".xiaobenben") continue;
      try {
        if (statSync(p).isDirectory()) walk(p, depth + 1);
      } catch {
        /* ignore */
      }
    }
  };
  for (const r of roots) walk(r, 0);
  return out.sort((a, b) => (b.memories ?? -1) - (a.memories ?? -1) || b.bytes - a.bytes);
}

function countMemories(dbPath: string): number | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      return (db.query("SELECT count(*) n FROM memories").get() as { n: number }).n;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
