/**
 * 系统托盘。Go 二进制由 `tray-assets.ts` 从产物内释放，本文件只讲协议。
 *
 * ## 三条纪律
 *
 *  1. **失败绝不阻断 serve。** 无显示环境、CI、资产异常、对端不起 —— 一律只让托盘不出现，
 *     常驻服务必须照常收发记忆（同 `notify.ts` 第 1 条）。
 *
 *  2. **超时即降级。** 等"就绪"必须带硬预算：systray2 的 JS API 在此处是**永久 await**，
 *     一个不吐 ready 的坏二进制会把 serve 卡在启动阶段 —— 通知/托盘都是增强，不能有这个权力。
 *
 *  3. **不猜协议，也不复制它的路径解析。** 线协议极简（见下）；systray2 的
 *     `getTrayBinPath()` 只认 `./traybin/<bin>`（相对 CWD）与 `__dirname/traybin/<bin>`，
 *     **没有注入点**，两个路径在编译产物里都不存在 ⇒ 它的 JS API 在正式版里不可用。
 *     自研这几十行，比 `process.chdir()` 那种全局副作用干净得多：chdir 会让常驻服务后续所有
 *     相对路径都漂移，且连被 spawn 的子进程一起漂 —— 用"改全局状态"来绕"路径写死"，
 *     等于把一类偶发 bug 换成另一类更难查的偶发 bug。
 *
 * ## 线协议（systray2 Go 二进制的约定，逐字段不可改）
 *
 * ```
 * spawn(bin)
 *   ← {"type":"ready"}                              就绪，可以上菜单了
 *   → {icon,title,tooltip,items:[{title,tooltip,checked,enabled,__id}]}   一行 JSON
 *   ← {"type":"clicked","__id":N}                   用户点了第 N 项
 *   → {"type":"exit"}                               请它自退（会摘掉图标）
 * ```
 * `__id` 由我方按菜单顺序 1..N 指定，点击回包靠它对应回调。
 *
 * 三个被这个极简协议"意外支持"、但很有用的开关（都在 `title`/`enabled` 里表达）：
 *   · **分隔线** = `title` 取字面量 `<SEPARATOR>`（Go 端见它即画一条横线）；
 *   · **信息行** = `enabled:false`（Windows 画成灰项，点不动 —— 用来显示当前模式）；
 *   · **图标** = 裸 base64，且**格式必须按平台分叉**（见 `tray-assets.ts`：
 *     Windows 要 .ico，macOS/Linux 要 .png，喂错格式 Go 端会报 `Unable to set icon`
 *     然后托盘区只剩一个空白占位）。
 *
 * ⚠️ 菜单只在 spawn 后下发**一次**：想改菜单（比如模式切换后更新状态行）只能重启子进程。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { ensureTrayBin, trayIconBase64 } from "./tray-assets";

export interface TrayHandle {
  onOpenWindow(cb: () => void): void;
  onVerify(cb: () => void): void;
  onExportDiag(cb: () => void): void;
  onCheckUpdate(cb: () => void): void;
  /** 切到云端模式（软启用：保留密钥）。无配置时由调用方引导去「填写云端密钥」。 */
  onSwitchCloud(cb: () => void): void;
  /** 切到本地模式（**软关**：只置 enabled=false，密钥留在盘上随时切回）。 */
  onSwitchLocal(cb: () => void): void;
  /** 打开管理窗口的「云端密钥」填写处（托盘无法输入文本，只能把人送过去）。 */
  onBindKey(cb: () => void): void;
  onExit(cb: () => void): void;
  /**
   * 收尾：请对端自退（摘图标）再兜底 kill。**幂等**。
   *
   * 必须显式调用 —— 对端是**独立进程**，父进程 `process.exit()` 不会带走它：
   * 不调就会在托盘区留一个点之不理的幽灵图标 + 一个孤儿进程（systray2 时代同样如此）。
   * 调用点：托盘菜单「退出」、以及 serve 进程退出时的 `process.on("exit")`。
   */
  dispose(): void;
}

/** 菜单动作名。点击回包只带 `__id`，由 `trayActionIds()` 反查回这些名字。 */
export type TrayAction = "open" | "verify" | "report" | "update" | "exit" | "to-cloud" | "to-local" | "bind-key";

/** 分隔线：systray 的约定是**标题字面量** `<SEPARATOR>`（Go 端据此画成一条横线）。 */
export const TRAY_SEPARATOR = "<SEPARATOR>";

/**
 * 菜单所需的运行态。**全部由调用方从 cloud.ts 取**，托盘自己不读盘、不猜
 * —— 否则"菜单显示的模式"与"实际生效的模式"就有两个真源。
 */
export interface TrayState {
  /** 本机是否已有云端配置（软关也算"有"——密钥还在） */
  cloudConfigured: boolean;
  /** 当前是否**生效**云端模式（配置存在且未被软关） */
  cloudEnabled: boolean;
  /** 组织显示名（云端模式下的展示；本地模式忽略） */
  orgLabel: string;
}

/** 未绑定的默认态（也用作纯函数单测的入参） */
export const TRAY_STATE_LOCAL: TrayState = { cloudConfigured: false, cloudEnabled: false, orgLabel: "" };

/**
 * 菜单项定义 —— **顺序 = 界面顺序 = `__id` 1..N**，`trayMenu()` 与 `trayActionIds()`
 * 都从这一份派生，杜绝"两份手工顺序表错位"（错位 = 点「退出」变成了切模式）。
 *
 * 三种 kind：
 *  · `separator` = 分隔线（标题必须是 `<SEPARATOR>` 字面量）；
 *  · `label`     = 不可点的信息行（`enabled:false` 时 Windows 会画成灰色）；
 *  · 其余        = 动作名，点击回包按 `__id` 派发给 `TrayHandle` 上的回调。
 */
interface TrayEntry {
  kind: TrayAction | "separator" | "label";
  title: (s: TrayState) => string;
  enabled: (s: TrayState) => boolean;
}

/** 模式行的措辞（三态各不相同，别混成一句"已绑定"） */
function modeLine(s: TrayState): string {
  if (s.cloudEnabled) return `模式：云端 · ${s.orgLabel || "已绑定"}`;
  return s.cloudConfigured ? "模式：本地（已关云端，密钥保留）" : "模式：本地（仅本机）";
}

const TRAY_ENTRIES: TrayEntry[] = [
  { kind: "open", title: () => "打开管理窗口", enabled: () => true },
  { kind: "separator", title: () => TRAY_SEPARATOR, enabled: () => true },
  { kind: "label", title: modeLine, enabled: () => false },
  { kind: "label", title: () => "切换后需重启 AI 客户端才生效", enabled: () => false },
  {
    kind: "to-cloud",
    title: (s) => (s.cloudConfigured ? `切换到云端模式 · ${s.orgLabel || "已绑定"}` : "切换到云端模式…"),
    enabled: (s) => !s.cloudEnabled,
  },
  { kind: "to-local", title: () => "切换到本地模式（保留密钥）", enabled: (s) => s.cloudEnabled },
  { kind: "bind-key", title: () => "填写云端密钥…", enabled: () => true },
  { kind: "separator", title: () => TRAY_SEPARATOR, enabled: () => true },
  { kind: "verify", title: () => "校验哈希链", enabled: () => true },
  { kind: "report", title: () => "导出诊断报告", enabled: () => true },
  { kind: "update", title: () => "检查更新", enabled: () => true },
  { kind: "separator", title: () => TRAY_SEPARATOR, enabled: () => true },
  { kind: "exit", title: () => "退出", enabled: () => true },
];

/** 全部动作名（冒烟据此断言"每个动作都有落点"，不依赖标题文案） */
export const TRAY_ACTIONS: TrayAction[] = TRAY_ENTRIES.filter(
  (e) => e.kind !== "separator" && e.kind !== "label",
).map((e) => e.kind as TrayAction);

export interface TrayMenuItem {
  title: string;
  tooltip: string;
  checked: boolean;
  enabled: boolean;
  __id: number;
}

export interface TrayMenu {
  icon: string;
  title: string;
  tooltip: string;
  items: TrayMenuItem[];
}

/** 就绪等待上限：超时即当作不可用降级（纪律 2）。 */
export const TRAY_READY_TIMEOUT_MS = 5000;

/** 纯函数：面板菜单（字段名与 `__id` 约定照抄线协议，可单测）。 */
export function trayMenu(iconBase64: string, state: TrayState = TRAY_STATE_LOCAL, tooltip?: string): TrayMenu {
  return {
    icon: iconBase64,
    title: "小本本",
    tooltip:
      tooltip ??
      (state.cloudEnabled
        ? `小本本 · 云端模式 · ${state.orgLabel || "已绑定"}`
        : "小本本 · 本地模式 (127.0.0.1:17630)"),
    items: TRAY_ENTRIES.map((e, i) => ({
      title: e.title(state),
      tooltip: "",
      checked: false,
      enabled: e.enabled(state),
      __id: i + 1,
    })),
  };
}

/** action → `__id`。与 `trayMenu()` 同源于 `TRAY_ENTRIES`，所以永远不会错位。 */
export function trayActionIds(): Map<TrayAction, number> {
  const m = new Map<TrayAction, number>();
  TRAY_ENTRIES.forEach((e, i) => {
    if (e.kind !== "separator" && e.kind !== "label") m.set(e.kind, i + 1);
  });
  return m;
}

/**
 * 起托盘。
 *
 * ⚠️ **菜单是"起进程时一次性下发"的**（线协议只在 spawn 后收一行 menu）⇒
 * 模式切换后要让菜单里的状态行跟着变，调用方必须 `dispose()` 旧的再起一个新的。
 * 这是刻意选的路：动态更新需要 `update-menu` 指令，而那个方向的协议行为只能靠**猜**
 * （systray2 的 JS 层有它，但 Go 端怎么处理没有任何文档，也没有源码可查）——
 * 重启一个几十毫秒的子进程，比赌一个揣不明白的协议便宜得多。
 */
export async function startTray(state: TrayState = TRAY_STATE_LOCAL): Promise<TrayHandle | null> {
  let proc: ChildProcessWithoutNullStreams | null = null;
  try {
    const bin = ensureTrayBin();
    const menu = trayMenu(trayIconBase64(), state);
    proc = spawn(bin, [], { windowsHide: true });
    const child = proc;

    // 回调表：startTray 返回后调用方才注册，所以这里只存表、点击时再查。
    const handlers = new Map<number, () => void>();

    const ready = new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (v: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => done(false), TRAY_READY_TIMEOUT_MS);
      child.once("error", () => done(false));
      child.once("exit", () => done(false));
      createInterface({ input: child.stdout }).on("line", (line) => {
        const msg = parseTrayLine(line);
        if (!msg) return; // 脏行不能让托盘挂掉
        if (msg.type === "ready") return done(true);
        if (msg.type === "clicked" && typeof msg.__id === "number") handlers.get(msg.__id)?.();
      });
    });

    if (!(await ready)) {
      throw new Error(`${TRAY_READY_TIMEOUT_MS}ms 内未就绪`);
    }
    child.stdin.on("error", () => {
      /* 对端先死时的 EPIPE：静默，托盘不参与业务 */
    });
    child.stdin.write(`${JSON.stringify(menu)}\n`);

    // `__id` 从 TRAY_ENTRIES 派生（不是手写常量）——菜单顺序将来再调也不会点到别处去
    const ids = trayActionIds();
    const bind = (a: TrayAction, cb: () => void) => {
      const id = ids.get(a);
      if (id !== undefined) handlers.set(id, cb);
    };
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      handlers.clear();
      try {
        // 先请对端自退（它会摘掉图标），再兜底 kill —— 直接 kill 会留下"幽灵图标"，
        // 要等鼠标划过托盘区才消失。
        child.stdin.write(`${JSON.stringify({ type: "exit" })}\n`);
      } catch {
        /* 对端已死 */
      }
      const hard = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
      }, 500);
      child.once("exit", () => clearTimeout(hard));
    };

    return {
      onOpenWindow: (cb) => bind("open", cb),
      onVerify: (cb) => bind("verify", cb),
      onExportDiag: (cb) => bind("report", cb),
      onCheckUpdate: (cb) => bind("update", cb),
      onSwitchCloud: (cb) => bind("to-cloud", cb),
      onSwitchLocal: (cb) => bind("to-local", cb),
      onBindKey: (cb) => bind("bind-key", cb),
      onExit: (cb) =>
        bind("exit", () => {
          dispose();
          cb();
        }),
      dispose,
    };
  } catch (e) {
    try {
      proc?.kill();
    } catch {
      /* 未能起 */
    }
    console.warn("[xbb] 托盘不可用，降级为无托盘模式:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** 纯函数：解析对端一行。非 JSON 或非对象一律返回 null（对端日志混进 stdout 也不致命）。 */
export function parseTrayLine(line: string): { type?: string; __id?: number } | null {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === "object" && v !== null ? (v as { type?: string; __id?: number }) : null;
  } catch {
    return null;
  }
}
