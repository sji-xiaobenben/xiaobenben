#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * `npx xiaobenben` 的入口：定位已安装的单文件二进制并原样转交参数。
 *
 * ⚠️ **stdout 是 MCP 的 JSON-RPC 通道。** 这个文件以及它调用的所有模块，诊断信息
 * 一律只能写 stderr。一句 console.log 就足以让客户端解析失败，而现象是「服务器连不上」，
 * 排查方向会被完全带偏 —— 所以这里连成功提示都不打。
 *
 * 为什么要有这一层而不是直接把二进制当 bin：
 *   · npm 包里塞不下 100MB 二进制（registry 单文件上限、安装耗时都扛不住）；
 *   · 二进制要按平台分发，而 npm 包是「一份代码装所有平台」；
 *   · 二进制自身带自更新（换 process.execPath），放在包装器后面才不受 npm 目录结构影响。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { findInstalled, platformKey, packageVersion } from "../scripts/lib/binary.mjs";
import { ensureBinary, explainError } from "../scripts/lib/install.mjs";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const say = (msg) => process.stderr.write(`[xiaobenben] ${msg}\n`);

async function resolveExe() {
  const ready = findInstalled(pkgRoot);
  if (ready) return ready;

  // 首次运行（或 `npm install --ignore-scripts` 装进来的）—— 就地补装。
  // 放这里而不是只靠 postinstall：`--ignore-scripts` 太常见了，只靠 postinstall
  // 会得到一堆「装好了但跑不起来」的 issue。
  const version = packageVersion(pkgRoot);
  say(`首次运行，正在准备 ${platformKey()} 的运行时（约 100MB，只需一次）…`);
  let lastPct = -1;
  const { path } = await ensureBinary({
    pkgVersion: version,
    log: (m) => say(m),
    onProgress: ({ got, total }) => {
      if (!total) return;
      const pct = Math.floor((got / total) * 100);
      if (pct !== lastPct && pct % 10 === 0) {
        lastPct = pct;
        say(`${pct}%  ${(got / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)}MB`);
      }
    },
  });
  if (!existsSync(path)) throw new Error(`安装完成但文件不存在：${path}`);
  say("就绪");
  return path;
}

let exe;
try {
  exe = await resolveExe();
} catch (e) {
  say(`启动失败：${explainError(e)}`);
  process.exit(1);
}

const child = spawn(exe, process.argv.slice(2), {
  stdio: "inherit",
  // Windows 上不额外开控制台窗口；二进制自己决定托盘/服务形态
  windowsHide: true,
});

child.on("error", (e) => {
  say(`无法执行 ${exe}：${e.message}`);
  process.exit(1);
});

// 转发终止信号。POSIX 上前台进程组本来就都会收到，重复投递是幂等的；
// Windows 没有进程组语义，必须靠这一层，否则 Ctrl-C / 客户端断开后子进程会留成孤儿。
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* 子进程已退出 */
    }
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    // 被信号杀死时 shell 惯例是 128+n；直接 exit(1) 会让上层脚本误判为「程序自己报错」
    const n = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }[signal] ?? 0;
    process.exit(128 + n);
  }
  process.exit(code ?? 1);
});
