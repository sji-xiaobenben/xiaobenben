// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 中文文案 —— **产品默认语言，也是所有既有输出的逐字节基准**。
 *
 * 铁律：这里的字符串必须与改造前散落在 `index.ts` / `connect.ts` 里的字面量完全一致。
 * 既有的 366 个测试大量用 `toContain` 断言中文措辞，它们是这次重构唯一的回归网 ——
 * 只要中文一字不改，测试全绿就能证明"只是把字搬了个家，没有改行为"。
 */
import type { Dict } from "./types";
import { helpZh } from "./help/zh";

export const zh: Dict = {
  langNames: { zh: "中文", en: "English" },

  help: helpZh,

  banner: { built: "构建", fingerprint: "指纹", site: "官方站点" },

  langCmd: {
    current: "当前语言",
    choices: "可选",
    switchHint: "切换",
    storedAt: (path) => `语言偏好记在 ${path}（跟着程序目录走，换库不影响）`,
    envOverride: "环境变量 XBB_LANG 优先级最高，会盖过这个设置",
    envActive: (value) => `⚠️ 环境变量 XBB_LANG=${value} 正在生效，它的优先级高于这里的设置`,
    switched: (tag) => `已切换到 ${tag}：下一条命令起生效（已开着的管理窗口需重启）`,
    switchedButEnvWins: (tag, env) =>
      `已把 ${tag} 记进配置文件，但环境变量 XBB_LANG=${env} 仍压着它 —— 当前实际生效的是 ${env}。要让它听配置的，先把这个环境变量去掉。`,
    unknown: (input) =>
      `认不出语言「${input}」。可选：zh（中文）/ en（English）。换个说法也行，比如 zh-CN、en-US —— 只取前面的语言码。`,
  },

  stats: {
    labels: {
      file: "库文件",
      memories: "记忆",
      recalled: "召回",
      links: "关联",
      transcripts: "原话",
    },
    meta: (sizeMb, when) => `${sizeMb} MB · 最后写入 ${when}`,
    memories: (n) => `${n} 条（含被取代 / 已遗忘的，它们只标记不删除）`,
    recalled: (used, hits) => `被用过 ${used} 条 · 累计 ${hits} 次`,
    links: (n) => `${n} 条边`,
    transcripts: (episodes, sessions) => `${episodes} 条 / ${sessions} 场（自动采集，永不上云）`,
    adminHint: (url) => `管理窗口 ${url}  有同一组数和趋势。`,
    unreadable: "读不到",
  },

  missingDb: {
    notFound: (path) => `\n❌ 找不到记忆库：${path}\n`,
    noAutoCreate: "小本本不会在空目录里自动建库：空库比没有库更容易让人误以为「记忆丢了」。",
    howToFind: "查它在哪：xbb home     扫盘找现成的库：xbb home find",
  },

  connect: {
    noneAtAll: "接入: 未检测到本机 AI 客户端 · 运行 xbb connect 查看详情",
    noneConfigured: (total, tail) => `接入: 未检测到（${total} 个客户端${tail}）· 运行 xbb connect 查看`,
    allBroken: (total, broken, tail) =>
      `接入: 0/${total}（${broken} 个配置存在但连不上）${tail} · 运行 xbb connect 查看`,
    connected: (names, n, total, tail, warn) =>
      `接入: ${names}（${n}/${total}）${tail}${warn} · 运行 xbb connect 查看全部`,
    tailInUse: (n) => ` · 另 ${n} 个正在使用`,
    warnBroken: (n) => ` · ${n} 个配置异常`,
  },
};
