// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 托盘冒烟。
 *
 * ## 为什么必须有这一套
 *
 * 托盘的失败模式是**设计上的静默降级**（`startTray()` 抓一切异常 → 只 console.warn），
 * 所以它坏掉不会体现在任何协议断言里。后果已经发生过一次：2026-10-07 真机日志暴露
 * 「托盘不可用…ENOENT 'B:\~BUN\assets\tray.png'」，查下去才发现 **托盘在任何平台的编译产物里
 * 从未成功过** —— `assets/` 与 `node_modules/systray2/traybin/` 里的文件都不进 exe，而 dev 下
 * `__dirname` 指向**真实** node_modules 所以一切正常（典型"dev 通、exe 挂"）。
 *
 * 分工：本文件覆盖 **dev 侧**（资产可读、菜单形状、释放语义、协议解析）；
 * **产物侧**由 `tools/check-tray-embedded.ts` 在 release 流水线逐平台核对嵌入字节 ——
 * 那一条才是真正拦住本次事故的断言（还能覆盖无法执行的交叉编译 darwin 产物）。
 *
 * 真机起托盘（屏幕上会真的出现一个图标）需显式 `XBB_TRAY_E2E=1`：CI 无显示环境，不能默认跑。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TRAY_ACTIONS,
  TRAY_READY_TIMEOUT_MS,
  TRAY_SEPARATOR,
  TRAY_STATE_LOCAL,
  parseTrayLine,
  trayActionIds,
  trayMenu,
  type TrayState,
} from "../src/tray";

// XBB_HOME 隔离：`ensureTrayBin()` 每次调用时读 env，所以 import 之后再设也有效。
// 必须隔离 —— 否则冒烟会往真实的 ~/.xiaobenben/tray 里写文件。
const home = mkdtempSync(join(tmpdir(), "xbb-tray-smoke-"));
process.env.XBB_HOME = home;

// `..` 相对 tools/ ⇒ 指到 cli/ 本身（与 serve-smoke 的 root 同义）
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const cliRoot = join(root, ".");
let pass = 0;
let total = 0;

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  rmSync(home, { recursive: true, force: true });
  process.exit(1);
}

function ok(cond: boolean, label: string): void {
  total++;
  if (!cond) fail(label);
  pass++;
  console.log(`✓ ${label}`);
}

async function main() {
  // 动态 import：必须在 XBB_HOME 设好之后，语义上更清楚（本模块会在 import 期解析嵌入资产）
  const { ensureTrayBin, trayBinName, trayIconAssetName, trayIconBase64, trayIconBytes } =
    await import("../src/tray-assets");

  // ── 1. 图标资产（格式按平台分叉：Windows 必须 ICO）────────────
  // 2026-10-07 事故：三个平台一律喂 tray.png ⇒ Windows 的 Go 端 SetIcon 直接拒绝
  // （真机 stderr：`Unable to set icon`），托盘区只剩一个空白占位，用户看到的就是
  // 「右下角那个图标像缺图」。它不抛异常、不阻断 serve，所以必须由断言来拦。
  const iconName = trayIconAssetName();
  const iconSrc = readFileSync(join(cliRoot, "assets", iconName));
  ok(iconSrc.length > 0, `图标源可读（assets/${iconName}，${iconSrc.length} 字节）`);
  if (process.platform === "win32") {
    // eslint-disable-next-line no-bitwise
    ok(
      iconSrc[0] === 0x00 && iconSrc[1] === 0x00 && iconSrc[2] === 0x01 && iconSrc[3] === 0x00,
      "Windows 图标源是合法 ICO（ICONDIR 魔数 00 00 01 00）",
    );
  } else {
    ok(iconSrc[0] === 0x89 && iconSrc.subarray(1, 4).toString("latin1") === "PNG", "图标源是合法 PNG");
  }
  const embeddedIcon = trayIconBytes();
  ok(embeddedIcon.equals(iconSrc), `嵌入副本与 assets/${iconName} 逐字节一致`);
  if (process.platform === "win32") {
    ok(
      embeddedIcon.subarray(0, 4).toString("hex") === "00000100",
      "回归闸：Windows 上 trayIconBytes() 必须给出 ICO 字节（喂 PNG 会被 Go 端拒绝，托盘只剩空白）",
    );
  }
  ok(
    Buffer.from(trayIconBase64(), "base64").equals(iconSrc),
    "base64 解回与图标源逐字节一致（systray2 线协议要的就是裸 base64）",
  );

  // 分叉表本身（不依赖当前平台，交叉编译的产物侧由 check-tray-embedded 覆盖）
  ok(trayIconAssetName("win32") === "tray.ico", "win32 → tray.ico");
  ok(trayIconAssetName("darwin") === "tray.png", "darwin → tray.png");
  ok(trayIconAssetName("linux") === "tray.png", "linux → tray.png");

  // ── 2. 菜单形状（纯函数）────────────────────────────────────
  const CLOUD_OFF: TrayState = { cloudConfigured: true, cloudEnabled: false, orgLabel: "个人空间" };
  const CLOUD_ON: TrayState = { cloudConfigured: true, cloudEnabled: true, orgLabel: "个人空间" };

  const ids = trayActionIds();
  const menu = trayMenu("ICON", TRAY_STATE_LOCAL);

  ok(menu.icon === "ICON", "菜单 icon 字段原样透传");
  ok(menu.title === "小本本", "菜单标题");
  ok(
    menu.items.every((it, i) => it.__id === i + 1),
    "__id 严格 1..N 且与数组下标对齐（点击回包靠 __id 派发，错位即点错功能）",
  );
  ok(
    TRAY_ACTIONS.length === 8 && [...ids.keys()].length === 8,
    `8 个动作全部有落点（打开/校验/报告/更新/退出 + 切云端/切本地/填密钥），实际 ${TRAY_ACTIONS.length}`,
  );
  ok(
    TRAY_ACTIONS.every((a) => (ids.get(a) ?? 0) >= 1 && (ids.get(a) ?? 0) <= menu.items.length),
    "每个动作的 __id 都落在菜单项范围里（action 表与菜单表同源，不可能各写一份而错位）",
  );
  ok(
    menu.items.filter((it) => it.title === TRAY_SEPARATOR).length === 3,
    "3 条分隔线（标题须为 <SEPARATOR> 字面量，Go 端据此画横线）",
  );
  ok(ids.get("open") === 1, "「打开管理窗口」是第一项");
  ok(ids.get("exit") === menu.items.length, "「退出」是最后一项（误点代价最大，放最远）");
  ok(
    ids.get("to-local") !== ids.get("to-cloud") && (ids.get("to-local") ?? 0) > 0 && (ids.get("to-cloud") ?? 0) > 0,
    "两个切换动作各占独立 __id（同一个 id 会让「切到本地」变成「切到云端」）",
  );

  // 模式行三态措辞必须能区分 —— 用户看不懂自己在哪，就会以为切换没生效
  const line = (s: TrayState) => trayMenu("I", s).items[2]!.title;
  ok(line(TRAY_STATE_LOCAL) === "模式：本地（仅本机）", "状态行：未绑定");
  ok(line(CLOUD_OFF) === "模式：本地（已关云端，密钥保留）", "状态行：软关（点明密钥还在，才敢切回去）");
  ok(line(CLOUD_ON) === "模式：云端 · 个人空间", "状态行：云端（带组织名）");

  // enabled 随状态走：当前模式那条置灰，另一条可点（radio 语义）
  const at = (s: TrayState, a: Parameters<typeof ids.get>[0]) => trayMenu("I", s).items[(ids.get(a) ?? 1) - 1]!;
  ok(at(TRAY_STATE_LOCAL, "to-local").enabled === false, "本地模式下「切换到本地模式」是灰的");
  ok(at(TRAY_STATE_LOCAL, "to-cloud").enabled === true, "本地模式下「切换到云端模式」可点");
  ok(at(CLOUD_ON, "to-local").enabled === true, "云端模式下「切换到本地模式」可点");
  ok(at(CLOUD_ON, "to-cloud").enabled === false, "云端模式下「切换到云端模式」是灰的");
  ok(at(TRAY_STATE_LOCAL, "bind-key").enabled === true, "未绑定时「填写云端密钥」必须可点（否则用户无路可走）");
  ok(
    menu.items.filter((it) => it.enabled === false).length === 3,
    "不可点项恰好 3 个（2 条信息行 + 当前模式那条切换项），实为 " +
      menu.items.filter((it) => it.enabled === false).length,
  );
  ok(trayMenu("I", CLOUD_ON).tooltip.includes("云端模式"), "悬浮提示随模式走（macOS/Linux 可见）");
  ok(trayMenu("I", TRAY_STATE_LOCAL).tooltip.includes("本地模式"), "本地模式的悬浮提示");

  // ── 3. 平台二进制名（纯函数）────────────────────────────────
  ok(trayBinName("win32") === "tray_windows_release.exe", "win32 二进制名");
  ok(trayBinName("linux") === "tray_linux_release", "linux 二进制名");
  ok(trayBinName("darwin") === "tray_darwin_release", "darwin 二进制名");
  ok(trayBinName("freebsd") === "", "未知平台返回空串（由调用方明确报错，而不是瞎猜文件名）");

  // ── 4. 线协议行解析（纯函数）────────────────────────────────
  ok(parseTrayLine('{"type":"ready"}')?.type === "ready", "解析 ready");
  ok(parseTrayLine('{"type":"clicked","__id":3}')?.__id === 3, "解析 clicked + __id");
  ok(parseTrayLine("不是 JSON") === null, "脏行返回 null（对端日志混进 stdout 不致命）");
  ok(parseTrayLine("123") === null, "非对象返回 null");
  ok(parseTrayLine("null") === null, "null 返回 null");
  ok(TRAY_READY_TIMEOUT_MS > 0 && TRAY_READY_TIMEOUT_MS <= 30_000, "就绪等待有硬预算（不会把 serve 卡在启动阶段）");

  // ── 5. 二进制释放到真实磁盘 ─────────────────────────────────
  const src = join(cliRoot, "node_modules", "systray2", "traybin", trayBinName());
  ok(existsSync(src), `依赖内的托盘二进制存在（${trayBinName()}）`);
  const bin = ensureTrayBin();
  ok(bin.startsWith(home), "释放到 XBB_HOME 内（可随 XBB_HOME 隔离/清理）");
  ok(existsSync(bin), "释放后的文件存在");
  ok(readFileSync(bin).equals(readFileSync(src)), "释放副本与依赖内二进制逐字节一致");
  ok(statSync(bin).size > 1_000_000, `释放产物是完整二进制（${statSync(bin).size} 字节，不是空壳）`);
  if (process.platform !== "win32") {
    // eslint-disable-next-line no-bitwise
    ok((statSync(bin).mode & 0o111) !== 0, "POSIX 上具备可执行位（否则 spawn 必 ENOENT/EACCES）");
  }
  const before = statSync(bin).mtimeMs;
  ensureTrayBin();
  ok(statSync(bin).mtimeMs === before, "重复调用幂等：大小相符则不重写（启动不必白读 3.6MB）");

  // ── 6. 真机起托盘（opt-in）──────────────────────────────────
  if (process.env.XBB_TRAY_E2E === "1") {
    const ready = await new Promise<boolean>((resolve) => {
      const child = spawn(bin, [], { windowsHide: true });
      let out = "";
      const timer = setTimeout(() => {
        child.kill();
        resolve(false);
      }, TRAY_READY_TIMEOUT_MS);
      child.stdout.on("data", (d) => {
        out += d.toString();
        if (out.includes('"ready"')) {
          clearTimeout(timer);
          child.stdin.write(`${JSON.stringify(trayMenu(trayIconBase64()))}\n`);
          setTimeout(() => {
            child.stdin.write('{"type":"exit"}\n');
            setTimeout(() => {
              child.kill();
              resolve(true);
            }, 500);
          }, 500);
        }
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    ok(ready, "真机托盘：spawn → 收到 ready → 接受菜单 → 退出（XBB_TRAY_E2E=1）");
  } else {
    console.log("· 真机托盘用例已跳过（设 XBB_TRAY_E2E=1 开启；CI 无显示环境）");
  }

  rmSync(home, { recursive: true, force: true });
  console.log(`tray smoke: ${pass}/${total} PASS`);
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
