// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 冒烟脚本的语言锚点 —— **必须在其他 import 之前引它**。
 *
 * 为什么需要这个文件（2026-11-22 的教训）：
 * CLI 与管理页多语言化之后，这些脚本断言的仍然是**中文**措辞（它们守的是行为，
 * 而中文是默认语言、也是逐字节基准）。可语言判定链的第三层是「系统 locale」——
 * 同一个脚本在中文 Windows 上绿、在英文 CI runner 上红，而代码是对的。
 * 那不是测试在守行为，是在守机器。
 *
 * 为什么不用 `||=`: 环境里恰好有 `XBB_LANG=en`（例如做英文回归时）就会让脚本
 * 悄悄改判据，红得很莫名其妙。冒烟脚本只认一个结论：中文。
 * 要验英文，请用 `bun test src/i18n.test.ts` 与 `tools/admin-ui-check.ts` 那两条路。
 *
 * 为什么是「先引」：`src/i18n` 的判定带缓存，第一次 `dict()` 就把语言定死了。
 * ESM 的求值顺序跟着 import 列表走，所以放在第一行就能保证在任何人取词之前生效。
 * （`bunfig.toml` 里给 `bun test` 准备的 `test-preload.ts` 干的是同一件事，
 * 但 `bun run tools/x.ts` 不走 preload，所以脚本得自己来。）
 */

process.env.XBB_LANG = "zh";
