// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * onnxruntime 依赖树的**打包入口**（PoC 定案：单文件 CJS + `*.node` external）。
 *
 * 它不是运行时被 import 的模块，只在构建期被 `bun build --format=cjs` 当入口用：
 *   · CI：`.github/workflows/release.yml`（Build onnxruntime bundle 步骤）
 *   · 本地应急通道：`tools/publish-local.sh`
 *   · 手动：`bun run bundle:ort`
 * 产物落到 `node_modules/onnxruntime-node/dist/ort-bundle.cjs`，随后被 `src/index.ts` 的
 * 单文件产物 `--compile` 打包进去 —— 所以**改这个文件会改变交付产物**。
 *
 * ⚠️ 正因为是构建输入，它**不能待在 `tools/` 下**：`release.yml` 的 `paths-ignore` 里
 * `tools/**` 是「确定不影响产物」的目录（见该文件顶部注释），放进去会造成**静默漏发**
 * （2026-10-04 事故类型：已推送、CI 全绿、线上仍跑旧版）。2026-10-16 从
 * `tools/poc/bundle-entry.ts` 移到 `src/`。
 */
module.exports = require("onnxruntime-node");
