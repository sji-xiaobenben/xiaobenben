// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 测试进程预加载 —— 只影响 `bun test`，不进产品构建。
 *
 * 为什么需要：366 个既有测试里有大量 `toContain("未检测到")` 这类**中文措辞**断言。
 * 界面语言一旦按宿主机 locale 自动判定，这些断言在英文 Windows / macOS 上会集体变红 ——
 * 而代码完全正确。测试结果不能取决于跑测试的人用的是什么语言的操作系统。
 *
 * 钉成 zh 而不是"随便一个"：中文输出是这次重构的**逐字节基准**，
 * 中文一字不改 ⇒ 全绿 ⇒ 证明"只是把字搬了个家"。
 * 想测英文的用例自己 unset XBB_LANG（见 i18n.test.ts）。
 */
process.env.XBB_LANG ||= "zh";
