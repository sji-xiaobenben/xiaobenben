/**
 * 启动失败自动回滚。
 *
 * 机制：updater swap 时写 pending.json 并保留旧 exe 备份。
 *   - 启动时若见 pending.json 存在 → **先判断"本次启动的是谁"**（见 decideBootAction）：
 *       · 正是标记里那个"刚换上、还没确认"的新版 → 放行（记一次尝试），等 healthz 通过后确认；
 *       · 否则 → 上一次装上来的新版没能走到确认点（在确认之前就退了/崩了）→ 把备份换回、
 *         把该版本拉黑、清标记。
 *   - 走到确认点（serve 初始化完成）时调用 confirmStartupSuccess() 删掉标记 = 本次更新健康。
 *
 * 为什么不用「起 30 秒定时器，到点算成功」：
 *   假阳性代价太重。用户或机器在窗口期内重启（很常见）→ 标记残留 → 一个**原本健康**的
 *   版本被判失败并进黑名单 → 用户被钉在旧版，直到有更新版本才能再升级。确认点应选在
 *   「初始化真的完成了」这个有意义的时刻，而不是某个时间猜测。
 *
 * 只挂在 serve 启动路径上，MCP stdio 进程**不得**调用：
 *   MCP 进程是每次调用新起的短命进程，它写下的标记会在退出时残留，反而被误判成崩溃。
 *
 * 纪律：永不 throw（回滚是兜底，不能反过来把服务搞挂）。
 *
 * ── 2026-10-07 修掉的 bug（"首次 serve 启动必回滚"）────────────────────────
 * 原实现只做了「有标记就回滚」，缺了「本次启动的就是那个待确认的新版」这一判据。
 * 后果：新版 exe 换上去后，**它自己的第一次 serve 启动**就会被自己判失败并回退 + 拉黑 ⇒
 * 每次更新都会被静默退回旧版（只有一直不启 serve、只跑 mcp 时才不暴露）。
 * 修法：pending 标记加 `attempts`（swap 时写 0），启动时做三态判定（见 decideBootAction）。
 * 残留边界（已知、接受）：若新版 exe 在**本文件被执行之前**就崩（模块加载期崩溃），
 * attempts 永远停在 0 ⇒ 会一直"首次引导"而不回滚。相对"100% 误回滚"，这个方向更安全
 * （错的版本至少还在，用户看得见报错；而不是被静默降级）。
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { addToBlocklist, CURRENT_VERSION, isCompiledExe, pendingPath } from "./updater";

export type RollbackAction = "none" | "adopted" | "rolled_back";

export interface RollbackResult {
  action: RollbackAction;
  /** 涉及的新版本号（来自 pending 标记） */
  version?: string;
  detail?: string;
}

/** pending 标记的磁盘形态（`XBB_HOME/update/pending.json`） */
export interface PendingMarker {
  version?: string;
  prev?: string;
  at?: string;
  /** 已引导尝试次数。0 / 缺省 = 这个新版一次都还没跑过（2026-10-07 新增） */
  attempts?: number;
}

/** 删除 pending 标记（回滚后 / 启动确认后共用） */
function clearPending(): void {
  try {
    unlinkSync(pendingPath());
  } catch {
    /* 不存在即目标状态 */
  }
}

/**
 * 清掉上一次回滚残留的 `<exe>.failed`。
 * 它当时是「运行中的进程本体」所以删不掉，现在进程已不是它，可以删了。
 */
function cleanupFailedArtifact(): void {
  try {
    const failed = `${process.execPath}.failed`;
    if (existsSync(failed)) unlinkSync(failed);
  } catch {
    /* 删不掉无害 */
  }
}

/**
 * 读 pending 标记。
 *   - 文件不存在 → `null`（= 没有待确认的更新）
 *   - 文件存在但损坏 → `{}`（= "有标记，但拿不到任何信息"）。刻意不返回 null：
 *     损坏的标记若被当成"没有标记"，就会永远留在盘上没人清理；返回空对象则沿用既有
 *     判定（不是本版本 → 走回滚分支 → 清标记），保证用户不会被卡在回滚态。
 */
export function readPendingMarker(): PendingMarker | null {
  const p = pendingPath();
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as PendingMarker) : {};
  } catch {
    return {};
  }
}

export type BootDecision = "none" | "adopt" | "rollback";

/**
 * 纯函数：见到 pending 标记时该做什么（唯一出口 → 可单测）。
 *
 *   none     —— 没有标记，正常启动。
 *   adopt    —— 标记里的版本 == 正在运行的版本，且**一次都没跑过** ⇒ 本次启动就是那个
 *               "刚换上、还没确认"的新版本身。它是来证明自己的，绝不能在这里回滚：
 *               回滚了，就永远没有任何版本能走到确认点，于是**每次更新必被退回**。
 *               调用方应把它记为"已尝试"，待 healthz 通过后确认（删标记）。
 *   rollback —— 其余两种情况：
 *               · 正在跑的不是标记里那个版本（有人拿旧 exe / 另一个 exe 启动）——说明
 *                 新版根本没起来；
 *               · 新版已经尝试过一次仍未确认（attempts ≥ 1）——说明上一次引导没走到
 *                 确认点，判定失败。
 */
export function decideBootAction(pending: PendingMarker | null, currentVersion: string): BootDecision {
  if (!pending) return "none";
  const isPendingVersion = !!pending.version && pending.version === currentVersion;
  const alreadyAttempted = (pending.attempts ?? 0) > 0;
  return isPendingVersion && !alreadyAttempted ? "adopt" : "rollback";
}

/**
 * 记一次引导尝试（把 attempts 置 1，其余字段保留）。
 * 写不进去 = 下次启动会把"已尝试"看成 0 而再放行一次；相比"新版永远确认不了"，
 * 这个方向的失败是安全的，所以只静默吞掉。
 */
export function markPendingAttempted(pending: PendingMarker): void {
  try {
    writeFileSync(pendingPath(), JSON.stringify({ ...pending, attempts: 1 }, null, 2));
  } catch {
    /* 见上：不阻断 */
  }
}

/** 启动自检：判定本次启动该怎么处理 pending 标记（放行 / 回滚） */
export function runStartupRollback(currentVersion: string = CURRENT_VERSION): RollbackResult {
  try {
    // 保命闸（与 updater.ts 的 isCompiledExe 同源）：`bun run src/index.ts serve` 形态下
    // process.execPath 是 bun 运行时本体，回滚会 rename 掉用户/开发者的 bun。
    if (!isCompiledExe()) return { action: "none" };

    cleanupFailedArtifact();

    const pending = readPendingMarker();
    const decision = decideBootAction(pending, currentVersion);

    if (decision === "none") return { action: "none" };
    if (decision === "adopt") {
      markPendingAttempted(pending!);
      return {
        action: "adopted",
        version: pending!.version,
        detail: "本次启动即刚换上的新版（首次引导）—— 待 healthz 通过后确认",
      };
    }

    const info = pending!;
    const exe = process.execPath;
    let detail = "";

    if (info.prev && existsSync(info.prev)) {
      const aside = `${exe}.failed`;
      try {
        unlinkSync(aside);
      } catch {
        /* 可能被占用 */
      }
      try {
        renameSync(exe, aside);
      } catch {
        /* 新 exe 被占用也继续尝试把旧版归位 */
      }
      try {
        renameSync(info.prev, exe);
        detail = "已恢复上一版本";
      } catch (e) {
        try {
          renameSync(aside, exe); // 归位失败：把刚才挪开的还回去，别把 exe 弄丢
        } catch {
          /* 尽力归位 */
        }
        detail = `恢复失败：${e instanceof Error ? e.message : e}`;
      }
      try {
        unlinkSync(aside); // 正在运行的进程本体，Windows 上多半删不掉，留给下次清理
      } catch {
        /* 无害 */
      }
    } else {
      detail = "旧版备份缺失，仅清理标记";
    }

    // 拉黑该版本，避免「回滚 → 下次又自动装回 → 再崩」的死循环
    if (info.version) addToBlocklist(info.version, "startup_failed");
    clearPending();
    return { action: "rolled_back", version: info.version, detail };
  } catch (e) {
    return { action: "none", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** 启动确认：serve 初始化成功即调用，删除标记 = 本次更新被认可 */
export function confirmStartupSuccess(): void {
  clearPending();
}

/** 仅供测试/排障：手动写一个 pending 标记 */
export function __writePendingForTest(version: string, prev: string, attempts = 0): void {
  writeFileSync(
    pendingPath(),
    JSON.stringify({ version, prev, at: new Date().toISOString(), attempts }, null, 2)
  );
}
