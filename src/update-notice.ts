// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 新会话更新提示（补遗）。
 *
 * 目标：把「有新版本」这件事，从「用户哪天想起来去点一下检查更新」变成
 * 「每次新开会话，AI 主动问一句要不要更新」。
 *
 * 三条硬约束（每条都对应一个会静默出错的地方）：
 *
 *  1. **绝不拖慢会话启动。** MCP stdio 是每次会话新起一个进程，若每次都同步打网络，
 *     CDN 抖一下就会把握手顶后。所以：读本地快照是同步的（微秒级），打网络只在快照
 *     过期时发生，且带**硬预算**（默认 1.5s）——超预算就带着旧快照继续走，下次会话再补。
 *
 *  2. **绝不 throw。** 快照损坏、目录不可写、网络爆炸，都只能影响「提不提示」，
 *     不能让 MCP 起不来。更新检查是附属功能，不得拥有否决主流程的能力。
 *
 *  3. **只提示已验签的版本。** 未过验签的清单连版本号都不该采信（与 updater 同一条安全线）。
 *     否则能改 CDN/DNS 的人可以塞一份假清单，让全量用户同时看到「发现新版本」——
 *     这一步的代价是把一批人诱导去点一个攻击者提供的更新。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION as BUILD_VERSION } from "./build-meta";
import {
  isCompiledExe,
  isNewer,
  probeLatest,
  readBlocklist,
  resolveUpdateUrl,
  updateRoot,
  usesBuiltinUpdateSource,
  type ProbeOutcome,
} from "./updater";

export interface UpdateNoticeState {
  /** 上次**尝试**检查的时刻（失败也记，避免服务不可用时被反复捶打） */
  checkedAt: string;
  /** 写入快照时本机的版本——跨版本读取时用来判断快照是否还对应得上 */
  currentVersion: string;
  /** 已验签的清单版本（当前无更新时为空） */
  latestVersion?: string;
  /** 用户点过「以后再说」的版本 */
  dismissed?: string[];
  /** 新版本已换上磁盘、待重启生效的版本 */
  appliedVersion?: string;
  failedReason?: string;
}

export interface PendingUpdate {
  current: string;
  latest: string;
}

const NOTICE_FILE = "notice.json";
const DEFAULT_TTL_MIN = 60;
const DEFAULT_BUDGET_MS = 1500;

export function currentVersion(): string {
  return process.env.XBB_VERSION ?? BUILD_VERSION;
}

export function noticePath(): string {
  return join(updateRoot(), NOTICE_FILE);
}

/** 读快照。任何异常一律当「没查过」——快照是纯缓存，坏掉不该传播。 */
export function readNoticeState(): UpdateNoticeState | null {
  try {
    const raw = JSON.parse(readFileSync(noticePath(), "utf8")) as UpdateNoticeState;
    return raw && typeof raw.checkedAt === "string" ? raw : null;
  } catch {
    return null;
  }
}

export function writeNoticeState(s: UpdateNoticeState): void {
  try {
    mkdirSync(updateRoot(), { recursive: true });
    writeFileSync(noticePath(), JSON.stringify(s, null, 2));
  } catch {
    /* 写不进只损失提示能力 */
  }
}

/** 检查间隔（分钟）。XBB_UPDATE_TTL_MIN 可调；设 0 = 每次会话都查（自建镜像/调试用）。 */
export function ttlMs(): number {
  const min = Number(process.env.XBB_UPDATE_TTL_MIN);
  return (Number.isFinite(min) && min >= 0 ? min : DEFAULT_TTL_MIN) * 60_000;
}

export function isStale(state: UpdateNoticeState | null, now = Date.now()): boolean {
  if (!state) return true;
  const t = Date.parse(state.checkedAt);
  if (!Number.isFinite(t)) return true;
  return now - t > ttlMs();
}

/**
 * 是否允许提示。
 * 非编译产物（dev / `bun run src/index.ts`）下没有可替换的 exe，提示无意义——
 * 与 updater 的 isCompiledExe 保命闸同源。XBB_UPDATE_NOTICE_FORCE=1 给冒烟测试强制放行，
 * 否则这段逻辑在真机形态之外根本无法被覆盖。
 */
export function noticeEnabled(): boolean {
  if (!resolveUpdateUrl()) return false;
  // 冒烟测试的强制口：它要同时绕过「非编译产物」和「非官方构建」两道闸，
  // 否则这段判定在真机形态之外根本无法被覆盖。
  if (process.env.XBB_UPDATE_NOTICE_FORCE === "1") return true;
  // 身份闸与 updater 同源：fork 出来的产物不该被告知「官方有新版本」——
  // 那条提示对这个用户是误导，他一点确认，定制代码就被官方 exe 顶掉。
  return isCompiledExe() && usesBuiltinUpdateSource();
}

export interface DeriveOpts {
  enabled: boolean;
  blocklisted?: string[];
  isNewerFn?: (a: string, b: string) => boolean;
}

/**
 * 纯函数：从快照推导「该不该提示」。
 * 抽出来单独测，是因为它的三个否决条件（已忽略 / 已拉黑 / 不比当前新）都属于
 * **错了也不会报错、只会默默多打扰或少提醒**的那一类逻辑——只能靠断言守住。
 */
export function derivePending(
  state: UpdateNoticeState | null,
  current: string,
  opts: DeriveOpts,
): PendingUpdate | null {
  const newer = opts.isNewerFn ?? isNewer;
  if (!opts.enabled) return null;
  const latest = state?.latestVersion;
  if (!latest) return null;
  if ((state?.dismissed ?? []).includes(latest)) return null;
  if ((opts.blocklisted ?? []).includes(latest)) return null;
  // 已换上磁盘、只差重启的版本不再问「要不要更新」——该说的话是「重启生效」
  if (state?.appliedVersion === latest) return null;
  if (!newer(current, latest)) return null;
  return { current, latest };
}

/** 当前是否有可提示的新版本（同步、只读快照，无网络） */
export function pendingUpdate(): PendingUpdate | null {
  return derivePending(readNoticeState(), currentVersion(), {
    enabled: noticeEnabled(),
    blocklisted: readBlocklist().map((e) => e.version),
  });
}

/** 用户选择了「以后再说」：该版本不再在 UI 提示（AI 侧仍会在会话说起，由用户自行决定） */
export function dismissUpdate(version: string): void {
  const prev = readNoticeState();
  const dismissed = [...new Set([...(prev?.dismissed ?? []), version])].slice(-20);
  writeNoticeState({
    checkedAt: prev?.checkedAt ?? new Date().toISOString(),
    currentVersion: prev?.currentVersion ?? currentVersion(),
    latestVersion: prev?.latestVersion,
    appliedVersion: prev?.appliedVersion,
    dismissed,
  });
}

/** 新版本已就位（磁盘已换、待重启）：标记它，避免重启前后反复问同一件事 */
export function markApplied(version: string): void {
  const prev = readNoticeState();
  writeNoticeState({
    checkedAt: prev?.checkedAt ?? new Date().toISOString(),
    currentVersion: currentVersion(),
    latestVersion: version,
    appliedVersion: version,
    dismissed: prev?.dismissed,
  });
}

/** 把一次探测结果落成快照。失败也必须写 checkedAt——否则服务不可用时会被每个会话反复捶打。 */
export function recordProbe(p: ProbeOutcome): void {
  const prev = readNoticeState();
  const base = { checkedAt: new Date().toISOString(), currentVersion: currentVersion() };
  if (p.status === "available") {
    writeNoticeState({ ...base, latestVersion: p.version, dismissed: prev?.dismissed });
  } else if (p.status === "up_to_date") {
    // 显式抹掉：JSON.stringify 会丢弃 undefined 键，正好等于「当前无更新」
    writeNoticeState({ ...base, latestVersion: undefined, dismissed: prev?.dismissed });
  } else if (p.status === "failed") {
    // 失败时**保留**上一次的结论：网络抖动不该让一个已知的新版本从视野里消失
    writeNoticeState({
      ...base,
      latestVersion: prev?.latestVersion,
      dismissed: prev?.dismissed,
      failedReason: p.reason,
    });
  } else {
    writeNoticeState({ ...base, latestVersion: undefined, dismissed: prev?.dismissed });
  }
}

let inflight: Promise<ProbeOutcome> | null = null;

/**
 * 会话启动时调用：快照过期才刷新（带硬预算），然后返回可提示的更新。
 *
 * 为什么超预算时**不写快照**：把"没查成"记成"查过了"会让整条通道安静一整个 TTL，
 * 而原因恰恰是网络不好——最需要重试的场景被自己静音了。
 * 并发调用共享同一次请求（同进程内 serve 的定时器与会话可能同时进来）。
 */
export async function prepareNotice(budgetMs = DEFAULT_BUDGET_MS): Promise<PendingUpdate | null> {
  try {
    if (!noticeEnabled()) return null;
    if (isStale(readNoticeState())) {
      const probing = inflight ?? (inflight = probeLatest());
      const raced = await Promise.race([
        probing.catch(() => null),
        new Promise<null>((resolve) => {
          const t = setTimeout(() => resolve(null), budgetMs);
          t.unref?.();
        }),
      ]);
      if (raced) recordProbe(raced);
      void probing.finally(() => {
        if (inflight === probing) inflight = null;
      });
    }
  } catch {
    /* 提示失败绝不影响会话启动 */
  }
  return pendingUpdate();
}
