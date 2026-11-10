// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 内嵌向量运行时清单 —— **构建期生成物**，由 `tools/build.ts` 在编译前覆盖、编译后还原。
 *
 * 工作区里这个文件永远是空壳（`EMBEDDED_ORT = null`），这是刻意的：
 *   · 开发模式下 ORT 直接从 `node_modules` import，内嵌没有意义，白白让 typecheck 依赖
 *     一堆构建期才存在的 `.gz` 文件；
 *   · 空壳能让 `tsc --noEmit` 在没有 node_modules/onnxruntime-node 的机器上也过；
 *   · 发行产物里它会被替换成真实清单（若干 `import … with { type: "file" }`），
 *     那些 import 由 Bun 在 `--compile` 时内嵌进 exe，运行时由 `ort-embedded.ts` 解压。
 *
 * ⚠️ 不要手动编辑。构建脚本会把改动覆盖掉。
 */

export interface EmbeddedOrtBundle {
  /** 内嵌资源身份（平台 + 内容哈希），同时用作释放目录名 */
  key: string;
  /** pkg 内相对路径 → 已 gzip 的内嵌文件句柄（多个 path 可以指向同一个 gz，用于符号链接去重） */
  files: { path: string; gz: string }[];
}

export const EMBEDDED_ORT: EmbeddedOrtBundle | null = null;
