// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 路径基元 —— 「程序目录在哪」这个问题的唯一答案。
 *
 * 为什么从 `home.ts` 拆出来（2026-11-20）：
 *   `home.ts` 是整个数据层，顶部引了 `bun:sqlite` 与 `node:child_process`。而 i18n 需要读
 *   `config.json` 里的语言偏好 —— 若 i18n 直接引 `home.ts`、`home.ts` 又要引 i18n 去翻译
 *   报错话术，就构成模块级循环。ESM 的活绑定能让它在**只运行时调用**的情况下侥幸跑通，
 *   但"侥幸"不是可以写进架构的东西：任何一方将来在顶层求值一次就会变成 undefined。
 *
 * 所以把这两个零依赖的路径函数下沉到这里，`home.ts` 原样 re-export 保持向后兼容。
 * 依赖方向从此是单向的：`i18n → paths`、`home → paths`，永远不闭环。
 */
import { join } from "node:path";
import { homedir } from "node:os";

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
