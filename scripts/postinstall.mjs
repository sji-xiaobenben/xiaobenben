#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * npm install 阶段的二进制下载。
 *
 * 三条原则：
 *   1. **绝不阻断安装。** 任何失败都只告警并 exit 0 —— 把用户的 `npm install` 弄失败
 *      比「晚一点能用」糟得多，而且首次运行 bin 启动器还会重试一次。
 *   2. **在源码仓库里干活时跳过。** 本仓库自己也带 `postinstall`，若不加判断，
 *      每次 `bun install`（CI 每次都会跑）都会重新下 100MB。npm/bun 在跑生命周期
 *      脚本时都会把 `INIT_CWD` 设成「用户是在哪个目录敲的 install」，与包目录相同
 *      即说明「这是项目本身，不是被依赖」—— 实测 bun 1.4 与 npm 10 行为一致。
 *   3. **已装过就一个请求都不发。** ensureBinary 先查缓存目录。
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { platformKey, packageVersion, SUPPORTED } from "./lib/binary.mjs";
import { ensureBinary, explainError, UnsupportedPlatform } from "./lib/install.mjs";

const pkgRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const say = (msg) => process.stderr.write(`[xiaobenben] ${msg}\n`);

function skipReason() {
  if (process.env.XBB_SKIP_DOWNLOAD) return "已设置 XBB_SKIP_DOWNLOAD";
  const initCwd = process.env.INIT_CWD;
  if (initCwd && resolve(initCwd) === pkgRoot) {
    return "这是源码仓库本身（非依赖安装），跳过下载，首次运行时按需获取";
  }
  return null;
}

const reason = skipReason();
if (reason) {
  say(reason);
  process.exit(0);
}

if (!SUPPORTED.includes(platformKey())) {
  // 不当作错误：用户可能只是在暂不支持的机器上装了包（比如 linux-arm64 服务器上
  // 给别的机器准备部署产物）。装不上的原因要说清楚，但不要 fail。
  say(`当前平台 ${platformKey()} 暂无官方构建（支持：${SUPPORTED.join(" / ")}），跳过下载`);
  say("可改用官方安装包 https://xiaobenben.net/download，或从源码构建");
  process.exit(0);
}

let lastPct = -1;
try {
  const { downloaded, version } = await ensureBinary({
    pkgVersion: packageVersion(pkgRoot),
    log: (m) => say(m),
    onProgress: ({ got, total }) => {
      if (!total) return;
      const pct = Math.floor((got / total) * 100);
      if (pct >= lastPct + 10 || pct === 100) {
        lastPct = pct;
        say(`${pct}%  ${(got / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)}MB`);
      }
    },
  });
  if (downloaded) say(`已安装 ${version}`);
} catch (e) {
  if (e instanceof UnsupportedPlatform) {
    say(explainError(e));
    process.exit(0);
  }
  // 失败不阻断安装：首次运行 bin 启动器会再试；断网/镜像不可达不该让 npm install 挂掉
  say(`运行时下载失败，已跳过：${explainError(e)}`);
  say("首次运行 xiaobenben 时会自动重试；也可手动执行 npx xiaobenben --version");
  process.exit(0);
}
