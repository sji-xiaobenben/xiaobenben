// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 二进制落盘位置与平台矩阵 —— postinstall 与 bin 启动器共用。
 *
 * 为什么把二进制放到**用户级缓存**而不是包目录里：
 *   · pnpm 的 node_modules 是硬链接到全局 store 的只读副本，往里写会污染 store；
 *   · npm 的全局安装目录在部分机器上不可写；
 *   · 同一个版本被多个项目依赖时（npx 缓存、monorepo），用户级缓存天然只存一份。
 * 位置按版本分目录，所以升级包版本 = 换一个目录，不会出现「新启动器配旧二进制」。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 官方构建矩阵。**只有这四个**——`channels/stable.json` 里也确实只有这四个平台键。
 * linux-arm64 / win32-arm64 目前没有产物，必须显式列出来以便给出「为什么装不上」，
 * 否则会被当成「网络失败」，用户会反复重试。
 */
export const SUPPORTED = ["win32-x64", "linux-x64", "darwin-x64", "darwin-arm64"];

/** 与 updater.ts 的 platformKey() 保持同一写法：Node 的 platform-arch */
export function platformKey() {
  return `${process.platform}-${process.arch}`;
}

/** 产物文件名后缀：Windows 需要 .exe 才能被 spawn */
function exeSuffix() {
  return process.platform === "win32" ? ".exe" : "";
}

export function binaryName() {
  return `${platformKey()}${exeSuffix()}`;
}

/** 缓存根目录；XBB_PKG_CACHE 可覆盖（内网镜像/离线环境用） */
export function cacheRoot() {
  if (process.env.XBB_PKG_CACHE) return process.env.XBB_PKG_CACHE;
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(base, "xiaobenben", "pkg");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "xiaobenben", "pkg");
  }
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "xiaobenben", "pkg");
}

export function binaryPathFor(version) {
  return join(cacheRoot(), `v${version}`, binaryName());
}

/** 安装记录：把「实际装下的版本」记下来，启动器不必再猜 */
export function pointerPath() {
  return join(cacheRoot(), "install.json");
}

export function readPointer() {
  try {
    const p = JSON.parse(readFileSync(pointerPath(), "utf8"));
    if (!p || typeof p.path !== "string") return null;
    // 记录可能来自另一个平台（缓存目录被同步/拷贝过），路径与当前平台必须是同一个文件
    if (!p.path.endsWith(binaryName())) return null;
    if (!existsSync(p.path)) return null;
    return p;
  } catch {
    return null;
  }
}

/** 包自己的版本号（启动器与安装脚本都用它做兜底猜测） */
export function packageVersion(pkgRoot) {
  try {
    return JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** 当前已就绪的二进制路径，没有则 null */
export function findInstalled(pkgRoot) {
  const override = process.env.XBB_EXE;
  if (override) return existsSync(override) ? override : null;
  const p = readPointer();
  if (p) return p.path;
  const guess = binaryPathFor(packageVersion(pkgRoot));
  return existsSync(guess) ? guess : null;
}
