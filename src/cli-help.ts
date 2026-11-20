// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 帮助的分发逻辑。**文案不在这里** —— 全部住在 `i18n/help/{zh,en}.ts`。
 *
 * 为什么把文案搬走：这个文件原来有 20 多个 `const XXX_HELP = \`…\`` 把中文写死在代码里，
 * 想加一种语言就必须把整个文件复制一遍，而复制出来的两份会在第一次改文案时开始漂移。
 * 现在这里只剩「命令 → 哪个键」的映射，语言由 `dict()` 决定 ——
 * 加语种只需要新增一个 help 包，**这个文件一行都不用改**。
 *
 * 什么该多语言、什么不该，判据写在 `i18n/help/types.ts` 顶部。
 */
import { dict } from "./i18n";

/** 参数里出现了 `-h` / `--help`（任意位置）就算要帮助。`-help` 之类不算 —— 只有两个明确写法。 */
export function isHelpRequest(args: string[]): boolean {
  return args.includes("-h") || args.includes("--help");
}

/**
 * 从参数里解析出「要看哪个命令的帮助」。
 *
 * 两件必须做对的事：
 *   1. `--help` 出现在**任意位置**都要生效（`xbb home move --help`）。
 *   2. `xbb home move --help` 要解析成 cmd=home / sub=move，而不是把 `--help` 当子命令 ——
 *      否则会去查一个不存在的 `home --help` 子命令，落到总览去。
 */
export function helpTopic(args: string[]): { cmd: string; sub?: string } {
  const bare = args.filter((a) => !a.startsWith("-"));
  // `xbb help home move` 与 `xbb home move --help` 归一
  if (bare[0] === "help") bare.shift();
  if (!bare.length) return { cmd: "help" };
  return { cmd: bare[0]!, sub: bare[1] };
}

/** 命令 → 帮助文本。`cmd` 为空或未知一律给总览（查帮助不该报错）。 */
export function helpText(cmd: string, sub?: string): string {
  const h = dict().help;
  switch (cmd) {
    case "serve":
      return h.serve;
    case "start":
      return h.start;
    case "mcp":
      return h.mcp;
    case "connect":
      return h.connect;
    case "stop":
      return h.stop;
    case "cloud":
      return h.cloud;
    case "bind":
      return h.bind;
    case "bind-key":
      return h.bindKey;
    case "unbind":
      return h.unbind;
    case "autostart":
      return h.autostart;
    case "ingest":
      return h.ingest;
    case "update":
      return h.update;
    case "update-status":
      return h.updateStatus;
    case "verify":
      return h.verify;
    case "stats":
      return h.stats;
    case "lang":
      return h.lang;
    case "register-protocol":
      return h.registerProtocol;
    case "version":
    case "--version":
    case "-v":
      return h.version;
    case "home":
      return homeHelp(sub);
    default:
      return h.overview;
  }
}

function homeHelp(sub?: string): string {
  const h = dict().help;
  switch (sub) {
    case "show":
      return h.homeShow;
    case "move":
      return h.homeMove;
    case "set":
      return h.homeSet;
    case "find":
      return h.homeFind;
    case "init":
      return h.homeInit;
    case "reset":
      return h.homeReset;
    default:
      return h.home;
  }
}

/** 无参数 / `xbb help` 时的总览（index.ts 的兜底分支与 --help 共用同一份） */
export function overviewHelp(): string {
  return dict().help.overview;
}
