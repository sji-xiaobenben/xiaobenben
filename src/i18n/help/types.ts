// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 帮助文案的语言包契约。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 什么该多语言，什么不该 —— 判据只有一条：**谁读它**
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 产品是国际化的，但**不是所有字符串都要双语**。按读者划线：
 *
 * 【该多语言】终端用户可能看不懂中文的地方
 *   · 各命令的帮助与用法（`xbb --help`、`xbb serve --help`…）—— 这是用户手册
 *   · 命令的结果、解释、报错（`xbb stats`、`xbb connect`、开库判定闸的话术）
 *   · 管理界面、系统通知
 *   · 官网文档
 *
 * 【不翻，中文就中文】只有我们自己看的东西
 *   · 代码注释 —— 开发团队是中国人；翻译注释等于给维护者制造阅读障碍
 *   · 运行日志（`[serve] …`、`[update] …`）、日志文件内容 —— 排障时看的是我们
 *   · `tools/` 下的脚本输出、测试断言里的措辞
 *   · CHANGELOG / commit message / 内部文档
 *
 * 【本来就该英文，不需要"翻译"】
 *   · MCP 工具的 description —— 读者是模型，英文 token 更省、跨模型更稳
 *   · 命令名、参数名、错误码、JSON 字段名、文件路径、品牌名 `xiaobenben`
 *
 * 【刻意保持中文：`MCP_INSTRUCTIONS`】
 *   整段握手指令不翻。理由不是"懒得翻"：① 读者是模型，中文指令它照样读得懂，与用户语言无关；
 *   ② 这段文字已经在 `mcp.ts` 与 `ingest-status.ts` **两处逐字重复**（后者靠逐字副本做定位替换），
 *   再翻一份等于把"必须成对替换"的雷从两颗变成四颗；③ 模型最常读的面是工具 description，
 *   那一面已经是英文。
 *
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 判定口诀：**这句话出现在用户的终端/屏幕上吗？** 是 → 双语；否 → 中文。
 * 拿不准时看它被 `console.log` 打出来给谁看 —— 带 `[tag]` 前缀的是日志，不是界面。
 */
export interface HelpDict {
  /** 无参数 / `xbb help` 的总览 —— 外国用户装完敲的第一个命令 */
  overview: string;
  /** 总览里「数据位置」那一段（也是 `xbb home` 的缩略版） */
  dataLocation: string;

  serve: string;
  start: string;
  mcp: string;
  connect: string;
  stop: string;

  home: string;
  homeShow: string;
  homeMove: string;
  homeSet: string;
  homeFind: string;
  homeReset: string;
  homeInit: string;

  cloud: string;
  bind: string;
  bindKey: string;
  unbind: string;

  autostart: string;
  ingest: string;
  stats: string;
  lang: string;
  verify: string;
  registerProtocol: string;
  version: string;

  update: string;
  updateStatus: string;
}
