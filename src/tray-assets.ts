// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 托盘的运行时资产。
 *
 * ## 为什么必须"嵌进产物"，而不是按路径读
 *
 * `bun build --compile` **只打包 JS**：`assets/` 与 `node_modules/systray2/traybin/` 里的
 * 文件一律不进 exe。此前 `tray.ts` 按 `join(dirname(import.meta.url), "..", "assets", "tray.png")`
 * 读图标 —— 编译后模块被**摊平到 bunfs 根**（实测 `import.meta.dir` = `B:\~BUN\root`），
 * `..` 一步就**越出了根**，路径算成 `B:\~BUN\assets\tray.png` 并 ENOENT（2026-10-07 真机日志）。
 * 更要命的是 systray2 的 Go 二进制同样不在产物里，而它的查找路径没有注入点。
 * 合起来的后果：**托盘在任何平台的正式版里从未成功过**，只因"失败即静默降级"才一直没被发现。
 * （dev 下 `__dirname` 指向**真实的** node_modules，一切正常 ⇒ 典型"dev 通、exe 挂"。）
 *
 * `with { type: "file" }` 让 Bun 把文件字节**嵌进产物**，运行时给出一个可读路径；dev
 * （`bun run`）下同一写法给出真实磁盘路径 —— **两条路径共用同一份代码**，不再有分叉空间。
 *
 * ## 四条实测约束（别再踩）
 *
 * 1. bunfs 是**虚拟只读**文件系统：`chmodSync` / `copyFileSync` / `spawn` 对它一律 ENOENT，
 *    **只有 `readFileSync` 能取到字节** ⇒ 要落地只能自己 `writeFileSync`。
 * 2. `--target=…` 下 `process.platform` 会被**常量折叠**，于是下面的条件分支在产物里只剩当前
 *    平台那一个 ⇒ 体积只 +3.6MB，而不是三平台合计 +11MB（实测：win 产物里另两个二进制字节不存在）。
 * 3. 释放到真实磁盘后必须 `chmod 0o755` 才 spawn 得起来 —— 与下载器同一条纪律
 *    （`mode:0o755` + rename 前 `chmodSync`）。
 * 4. 释放目标带**大小校验**：大小不符就重写。这样升级换二进制后不会复用旧文件，而
 *    每次启动也不必白读 3.6MB（`statSync` 在 bunfs 上可用，实测过）。
 */
import { programDir } from "./home";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 平台对应的 Go 托盘二进制名（与 systray2 包内命名一致）。
 * `systray2` 这个依赖如今**只作为这两个二进制 + 图标的来源**存在：它的 JS API 因为第 0 节
 * 那个路径问题在产物里不可用（见 `tray.ts` 顶部说明）。
 */
export function trayBinName(platform: NodeJS.Platform = process.platform): string {
  const map: Partial<Record<NodeJS.Platform, string>> = {
    win32: "tray_windows_release.exe",
    linux: "tray_linux_release",
    darwin: "tray_darwin_release",
  };
  return map[platform] ?? "";
}

/**
 * 嵌入的托盘二进制路径。取不到（未知平台）时留空串，由 `ensureTrayBin()` 明确报错，
 * 而不是让整个 CLI 在 import 阶段就崩。
 */
const TRAY_BIN_SOURCE: string = await (async () => {
  if (process.platform === "win32") {
    return (await import("systray2/traybin/tray_windows_release.exe", { with: { type: "file" } })).default;
  }
  if (process.platform === "linux") {
    return (await import("systray2/traybin/tray_linux_release", { with: { type: "file" } })).default;
  }
  if (process.platform === "darwin") {
    return (await import("systray2/traybin/tray_darwin_release", { with: { type: "file" } })).default;
  }
  return "";
})();

/**
 * 图标文件的嵌入副本 —— **格式按平台分叉，这不是可选的美化项**。
 *
 * systray2 官方 README 原话：
 *   "you should use .png icon on macOS/Linux, and .ico format on Windows"
 *
 * 踩过的坑（2026-10-07 反馈「右下角图标像缺图片」）：本文件此前三个平台**一律**读
 * `assets/tray.png`，而 Windows 的 Go 端要的是 ICO ⇒ 图标解析失败，托盘区只剩一个空白占位。
 * 与第 0 节那个"托盘从未起过"是同一类失败：**它不报错、不抛异常、只静默降级**，
 * 所以能一路活到正式版，只有肉眼看托盘才能发现。
 *
 * 与 `TRAY_BIN_SOURCE` 同一手法：动态 import + `--target` 常量折叠 ⇒ 产物里只带当前平台
 * 那一份图标，不会把两平台图标都打进去（实测 win 产物里不存在 darwin/linux 的字节）。
 */
const TRAY_ICON_SOURCE: string = await (async () => {
  if (process.platform === "win32") {
    return (await import("../assets/tray.ico", { with: { type: "file" } })).default;
  }
  return (await import("../assets/tray.png", { with: { type: "file" } })).default;
})();

/** 图标资产名（日志与产物断言用；与上面的分叉保持同一真源）。 */
export function trayIconAssetName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "tray.ico" : "tray.png";
}

/** 图标的原始字节（嵌入副本）。 */
export function trayIconBytes(): Buffer {
  return readFileSync(TRAY_ICON_SOURCE);
}

/** 图标 base64 —— systray2 线协议里 `icon` 字段要的就是裸 base64（Go 侧自己落临时文件再加载）。 */
export function trayIconBase64(): string {
  return trayIconBytes().toString("base64");
}

/**
 * 把嵌入的托盘二进制释放到真实磁盘，返回可直接 `spawn` 的绝对路径。
 *
 * 位置：`XBB_HOME/tray/bin/<平台二进制名>`。放 XBB_HOME 而不是系统临时目录 —— 临时目录会被
 * 清理器按天清掉，而托盘的启动时机是"开机登录后"，隔天再启动就会踩空。
 */
export function ensureTrayBin(): string {
  if (!TRAY_BIN_SOURCE) throw new Error(`当前平台 ${process.platform} 无预编译托盘二进制`);
  const name = trayBinName();
  if (!name) throw new Error(`当前平台 ${process.platform} 的托盘二进制名未知`);

  const dir = join(programDir(), "tray", "bin");
  const target = join(dir, name);

  const want = statSync(TRAY_BIN_SOURCE).size; // bunfs 上 statSync 可用（实测）
  let have = -1;
  try {
    have = statSync(target).size;
  } catch {
    /* 未释放过 */
  }
  if (have !== want) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, readFileSync(TRAY_BIN_SOURCE));
  }
  // POSIX 上可执行位可能因拷贝/备份而丢，大小对不代表能跑 —— 每次都补一次（幂等且廉价）。
  if (process.platform !== "win32") chmodSync(target, 0o755);
  return target;
}
