// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 自更新冒烟：签名/验签同源性 + 篡改检出 + 版本比较 + 源地址语义。
 *
 * 用临时生成的 ed25519 密钥对，不接触真实私钥（CI 里也不该有）。
 * 这里守的是几条红线：
 *   - 载荷必须确定性（与键序无关）——否则 CI 签的串和客户端验的串会不一致
 *   - 任何字段被改都必须验不过（fail-closed），唯独 url 例外（内容已由 sha256 绑定）
 *   - 版本比较必须是数值语义（0.4.10 > 0.4.9，不是字典序）
 *   - 源地址三态语义：未设=默认开、空串=关、设值=私有镜像
 */
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildUpdatePayload, type ManifestFiles, UPDATE_PAYLOAD_MAGIC } from "../src/update-payload";
import { isCompiledExe, isNewer, pendingPath, resolveUpdateUrl, verifyManifestSignature, type UpdateManifest } from "../src/updater";
import {
  __writePendingForTest,
  decideBootAction,
  markPendingAttempted,
  readPendingMarker,
  runStartupRollback,
} from "../src/update-rollback";
import {
  derivePending,
  dismissUpdate,
  isStale,
  markApplied,
  prepareNotice,
  readNoticeState,
  recordProbe,
  writeNoticeState,
} from "../src/update-notice";

let failures = 0;
function ok(cond: boolean, label: string): void {
  if (cond) console.log(`✓ ${label}`);
  else {
    console.error(`✗ ${label}`);
    failures++;
  }
}

// ── 1. 载荷确定性：键序不同必须产出同一串 ──
const filesA: ManifestFiles = {
  "win32-x64": { url: "u1", sha256: "a".repeat(64), size: 1 },
  "linux-x64": { url: "u2", sha256: "b".repeat(64), size: 2 },
};
const filesB: ManifestFiles = {
  "linux-x64": { url: "u2", sha256: "b".repeat(64), size: 2 },
  "win32-x64": { url: "u1", sha256: "a".repeat(64), size: 1 },
};
const pA = buildUpdatePayload("0.4.1", filesA);
ok(pA === buildUpdatePayload("0.4.1", filesB), "载荷与键序无关（确定性）");
ok(pA.startsWith(`${UPDATE_PAYLOAD_MAGIC}\n0.4.1\n`), "载荷头部 = magic + version");
ok(!pA.endsWith("\n"), "载荷无尾随换行");

// ── 2. 签名/验签往返（临时密钥对）──
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const pubB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

function makeManifest(version: string, files: ManifestFiles): UpdateManifest {
  const m: UpdateManifest = { version, files: JSON.parse(JSON.stringify(files)) as ManifestFiles };
  m.sig = nodeSign(null, Buffer.from(buildUpdatePayload(version, m.files), "utf8"), privateKey).toString("base64");
  return m;
}
const clone = (m: UpdateManifest): UpdateManifest => JSON.parse(JSON.stringify(m)) as UpdateManifest;

const good = makeManifest("0.4.1", filesA);
ok(verifyManifestSignature(good, pubB64), "合法签名通过验签");

// ── 3. 篡改检出（一律 fail-closed）──
ok(!verifyManifestSignature({ ...good, sig: undefined }, pubB64), "缺 sig 被拒");
ok(!verifyManifestSignature({ ...good, version: "9.9.9" }, pubB64), "改 version 被拒");
{
  const t = clone(good);
  t.files["win32-x64"]!.sha256 = "c".repeat(64);
  ok(!verifyManifestSignature(t, pubB64), "改 sha256 被拒");
}
{
  const t = clone(good);
  t.files["win32-x64"]!.size = 999;
  ok(!verifyManifestSignature(t, pubB64), "改 size 被拒");
}
{
  const t = clone(good);
  t.files["darwin-arm64"] = { url: "x", sha256: "d".repeat(64), size: 3 };
  ok(!verifyManifestSignature(t, pubB64), "偷偷新增平台条目被拒");
}
{
  const t = clone(good);
  t.files["win32-x64"]!.url = "https://evil.example/x.exe";
  ok(verifyManifestSignature(t, pubB64), "改 url 不影响验签（内容由 sha256 绑定，符合设计）");
}

// ── 4. 公钥不匹配 / 畸形公钥 ──
const other = generateKeyPairSync("ed25519");
ok(
  !verifyManifestSignature(good, other.publicKey.export({ format: "der", type: "spki" }).toString("base64")),
  "他人公钥验不过"
);
ok(!verifyManifestSignature(good, "bm90LWEta2V5"), "畸形公钥不抛异常，判不过");

// ── 5. 版本比较（数值语义）──
ok(isNewer("0.4.1", "0.4.2"), "0.4.2 > 0.4.1");
ok(isNewer("0.4.9", "0.4.10"), "0.4.10 > 0.4.9（数值比较，非字典序）");
ok(isNewer("0.3.0", "0.4.12"), "0.4.12 > 0.3.0（真源接入后比较才成立）");
ok(!isNewer("0.4.2", "0.4.2"), "同版本不算更新");
ok(!isNewer("0.4.2", "0.4.1"), "旧版本不算更新");

// ── 5b. 编译产物形态识别（保命闸）──
// 判错的两种代价都是灾难性的：Windows 上误判为非编译 → 自更新永远 not_compiled_exe
// （而 probeLatest 不查这道闸，于是"提示有新版本"照弹、点更新必失败）；dev 下误判为编译
// → swap 会把用户的 bun 本体改名，毁掉开发环境。两条路径形态都必须覆盖。
ok(isCompiledExe("/$bunfs/root"), "POSIX 编译产物（/$bunfs）认定为 exe");
ok(isCompiledExe("B:\\~BUN\\root"), "Windows 编译产物（B:\\~BUN\\root）认定为 exe（修复前恒判 false）");
ok(!isCompiledExe("/home/u/xbb/cli/src"), "POSIX 源码目录不被误判为 exe");
ok(!isCompiledExe("C:\\Users\\x\\xbb\\cli\\src"), "Windows 源码目录不被误判为 exe");
ok(!isCompiledExe("D:\\~BUNKER\\x"), "形近目录（~BUNKER）不被误判");

// ── 6. 源地址三态语义 ──
const saved = process.env.XBB_UPDATE_URL;
delete process.env.XBB_UPDATE_URL;
ok(resolveUpdateUrl().startsWith("https://"), "未设 env → 走编译期默认（官方包开箱自更新）");
process.env.XBB_UPDATE_URL = "";
ok(resolveUpdateUrl() === "", "设空串 → 返回空（企业/离线包关闭自更新）");
process.env.XBB_UPDATE_URL = "https://mirror.example/stable.json";
ok(resolveUpdateUrl() === "https://mirror.example/stable.json", "设值 → 用该值（私有镜像）");
if (saved === undefined) delete process.env.XBB_UPDATE_URL;
else process.env.XBB_UPDATE_URL = saved;

// ── 7. 新会话更新提示：快照推导 / 忽略 / 已就位 / TTL ──
// 这一段的断言守的是"错了也不报错"的逻辑：提示条件写错只会默默多打扰或少提醒，
// 没有任何运行时异常会告诉你错了。所以每个否决条件都必须显式覆盖。
const tmpHome = mkdtempSync(join(tmpdir(), "xbb-notice-"));
process.env.XBB_HOME = tmpHome;
process.env.XBB_UPDATE_NOTICE_FORCE = "1"; // 非编译产物下强制放行，否则这段在 CI 形态根本进不去
const CUR = "0.4.10";

writeNoticeState({ checkedAt: new Date().toISOString(), currentVersion: CUR, latestVersion: "0.4.12" });
ok(readNoticeState()?.latestVersion === "0.4.12", "快照读写往返");
ok(derivePending(readNoticeState(), CUR, { enabled: true })?.latest === "0.4.12", "有新版本 → 提示");
ok(derivePending(readNoticeState(), CUR, { enabled: false }) === null, "功能关闭 → 不提示");
ok(derivePending(readNoticeState(), "0.4.12", { enabled: true }) === null, "已是清单版本 → 不提示");
ok(derivePending(readNoticeState(), "0.4.13", { enabled: true }) === null, "本机比清单还新 → 不提示");
ok(
  derivePending(readNoticeState(), CUR, { enabled: true, blocklisted: ["0.4.12"] }) === null,
  "该版本已被回滚拉黑 → 不提示（否则会把用户钉在崩溃版本上）"
);
ok(derivePending(null, CUR, { enabled: true }) === null, "无快照 → 安静不提示（而不是抛错）");

dismissUpdate("0.4.12");
ok(derivePending(readNoticeState(), CUR, { enabled: true }) === null, "点过「以后再说」→ 不再提示");
ok((readNoticeState()?.dismissed ?? []).includes("0.4.12"), "忽略名单已落盘");

writeNoticeState({ checkedAt: new Date().toISOString(), currentVersion: CUR, latestVersion: "0.4.12" });
markApplied("0.4.12");
ok(readNoticeState()?.appliedVersion === "0.4.12", "「已就位」标记落盘");
ok(
  derivePending(readNoticeState(), CUR, { enabled: true }) === null,
  "已就位待重启 → 不再问「要不要更新」（该说的是重启生效）"
);

process.env.XBB_UPDATE_TTL_MIN = "60";
ok(isStale(null), "无快照 → 视为过期（该查）");
writeNoticeState({ checkedAt: new Date().toISOString(), currentVersion: CUR });
ok(!isStale(readNoticeState()), "刚检查过 → 不过期");
writeNoticeState({ checkedAt: new Date(Date.now() - 61 * 60_000).toISOString(), currentVersion: CUR });
ok(isStale(readNoticeState()), "超过 TTL → 过期");
writeNoticeState({ checkedAt: "not-a-date", currentVersion: CUR });
ok(isStale(readNoticeState()), "时间戳损坏 → 视为过期（宁可多查一次）");
process.env.XBB_UPDATE_TTL_MIN = "0";
ok(isStale(readNoticeState()), "TTL=0 → 每次会话都查（自建镜像/调试）");

writeNoticeState({ checkedAt: new Date().toISOString(), currentVersion: CUR, latestVersion: "0.4.12" });
recordProbe({ status: "failed", reason: "net down" });
ok(readNoticeState()?.latestVersion === "0.4.12", "探测失败时保留上次结论（网络抖动不该让已知新版本消失）");
ok(!!readNoticeState()?.failedReason, "失败原因落盘（排障用）");
recordProbe({ status: "up_to_date", version: CUR });
ok(readNoticeState()?.latestVersion === undefined, "探测为最新 → 清掉旧结论");

// ── 8. 更新引导判定：pending 三态 ──
// 2026-10-07 修的 bug「首次 serve 启动必回滚」：原实现"见标记就回滚"，于是新版换上去后，
// **它自己的第一次 serve 启动**就被判失败并回退 + 拉黑 ⇒ 每次更新都被静默退回旧版。
// 这段守的病是"静默降级"——判错既不会抛异常也不报错，只会把用户悄悄退到旧版。
{
  const CURV = "0.4.24";
  ok(decideBootAction(null, CURV) === "none", "无 pending 标记 → 正常启动");
  ok(
    decideBootAction({ version: CURV, prev: "/x", attempts: 0 }, CURV) === "adopt",
    "标记版本 == 运行版本且未尝试过 → 放行（本次启动就是待确认的新版；修复前此处误判回滚）"
  );
  ok(
    decideBootAction({ version: CURV, prev: "/x" }, CURV) === "adopt",
    "attempts 缺省（修复前的旧格式标记）→ 仍按未尝试处理，放行"
  );
  ok(
    decideBootAction({ version: CURV, prev: "/x", attempts: 1 }, CURV) === "rollback",
    "同版本已尝试过一次仍未确认 → 判定上次引导失败，回滚"
  );
  ok(
    decideBootAction({ version: "0.4.25", prev: "/x", attempts: 0 }, CURV) === "rollback",
    "标记版本 ≠ 运行版本（新版根本没起来）→ 回滚"
  );
  ok(
    decideBootAction({ prev: "/x", attempts: 0 }, CURV) === "rollback",
    "标记缺版本号 → 沿用保守回滚语义，不会把用户卡死"
  );

  // 落盘往返：attempts 记账必须只动这一个字段
  __writePendingForTest(CURV, "/nonexistent-prev", 0);
  const m0 = readPendingMarker();
  ok(m0?.version === CURV && m0?.attempts === 0, "标记落盘可读回（attempts=0）");
  markPendingAttempted(m0!);
  const m1 = readPendingMarker();
  ok(
    m1?.attempts === 1 && m1.version === CURV && m1.prev === "/nonexistent-prev",
    "记账 attempts=1 且其余字段不丢"
  );
  ok(decideBootAction(m1, CURV) === "rollback", "记账后同版本再启动 → 回滚（第二次才判失败）");

  // 损坏标记：不能返回 null（否则没人清理它，永远留在盘上）
  writeFileSync(pendingPath(), "{ not json");
  const broken = readPendingMarker();
  ok(broken !== null, "损坏标记不返回 null（否则永远留在盘上没人清）");
  ok(decideBootAction(broken, CURV) === "rollback", "损坏标记 → 保守回滚并清理");

  // 保命闸：非编译产物（bun run）下绝不进入回滚流程 —— 否则 rename 的是 bun 本体
  if (!isCompiledExe()) {
    __writePendingForTest("9.9.9", "/nonexistent-prev", 0);
    const r = runStartupRollback("9.9.9");
    ok(r.action === "none", "非编译产物（bun run）→ 不触碰 process.execPath，绝不 rename bun 本体");
    ok(existsSync(pendingPath()), "该形态下连标记也不动（只读不写）");
  } else {
    ok(true, "（编译产物形态：跳过非编译产物保命闸断言）");
  }
  unlinkSync(pendingPath());
}

// 绝不 throw：源不可达时 prepareNotice 必须安静返回，且受预算约束
const savedUrl2 = process.env.XBB_UPDATE_URL;
process.env.XBB_UPDATE_NOTICE_FORCE = "1";
process.env.XBB_UPDATE_URL = "http://127.0.0.1:9/stable.json"; // 保留端口，必然连不上
{
  const t0 = Date.now();
  const p = await prepareNotice(300);
  const used = Date.now() - t0;
  ok(p === null, "源不可达 → 返回 null 而不是抛异常（会话启动不得被更新检查拖垮）");
  ok(used < 3000, `源不可达时受预算约束（实测 ${used}ms）`);
}
if (savedUrl2 === undefined) delete process.env.XBB_UPDATE_URL;
else process.env.XBB_UPDATE_URL = savedUrl2;
delete process.env.XBB_UPDATE_NOTICE_FORCE;
delete process.env.XBB_UPDATE_TTL_MIN;
delete process.env.XBB_HOME;
rmSync(tmpHome, { recursive: true, force: true });

console.log(failures === 0 ? "\n[update-smoke] 全部通过" : `\n[update-smoke] ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
