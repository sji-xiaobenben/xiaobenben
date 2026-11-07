// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * xbb-cli — 个人客户端壳。
 * 本地库 SQLite 永远零登录；17630 端口；MCP stdio 工具面。
 */
import { programDir, DbMissingError } from "./home";
import { runMcp } from "./mcp";
import { PersonalStore } from "./store";
import { ORG_PERSONAL } from "./schema";
import { startServe } from "./serve";
import { startTray, type TrayHandle, type TrayState } from "./tray";
import { ensureToastAppId } from "./notify";
import { startNotifyWatch, desktopNotifyEnabled } from "./notify-watch";
import { loadCloudConfig, loadCloudConfigRaw, orgDisplayName, setCloudEnabled, consoleBase } from "./cloud";
import { openInBrowser } from "./open";
import { Updater } from "./updater";
import { runStartupRollback, confirmStartupSuccess } from "./update-rollback";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { helpText, helpTopic, isHelpRequest, overviewHelp } from "./cli-help";

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";

/**
 * 帮助拦截 —— **必须在一切都之前**（2026-11-04 用户反馈）。
 *
 * 以前只有 `home` 分支自己处理 `-h/--help`，其余命令一路往下执行：
 *   `xbb stop --help`      → 真的把 serve 停了
 *   `xbb serve --help`     → 真的前台起服务并挂住终端
 *   `xbb home move --help` → 真的开始搬家（靠占用检查才中止）
 * 「查帮助」变成破坏性操作，脚本用 `--help` 探测命令能力也会误伤。
 *
 * 放在这里而不是各分支各写一遍：那样新增命令必漏，而且漏了不报错 ——
 * 只有别人真的去查帮助时才会炸，而那时他已经在执行了。
 */
if (isHelpRequest(args)) {
  const t = helpTopic(args);
  console.log(helpText(t.cmd, t.sub));
  process.exit(0);
}

if (cmd === "serve") {
  // `--detach` 是**启动器模式**：把自己以 CREATE_NO_WINDOW 再拉起来就立刻退出（不跑服务）。
  // 必须先于回滚自检 —— 启动器不持有任何服务状态，让它去动 pending 标记是错的。
  if (args.includes("--detach")) {
    const { launchDetachedServe } = await import("./autostart");
    await launchDetachedServe(args);
  }

  // 自更新回滚自检必须最先做：若上次装上的新版没走到确认点就退了，
  // 这里把备份版本换回磁盘。本次进程仍跑着内存里的旧代码，但下次启动即恢复。
  // 注意：只在 serve 挂载——MCP stdio 是短命进程，它留下的标记会被误判成崩溃。
  const rollback = runStartupRollback();
  if (rollback.action === "rolled_back") {
    console.warn(
      `[xbb] ⚠️ 上次更新（${rollback.version ?? "未知版本"}）未能正常启动，已回退：${rollback.detail ?? ""}\n` +
        "      该版本已进黑名单，不会被自动重装；请重启 xbb 以运行恢复后的版本。"
    );
  } else if (rollback.action === "adopted") {
    // 本次启动的就是那个"刚换上、还没确认"的新版。**不是失败**，别吓用户。
    console.log(
      `[xbb] 已就位的新版 v${rollback.version ?? "?"} 首次引导中 —— healthz 通过后即确认（不再回退）`
    );
  }

  const port = Number(process.env.PORT) || 17630; // PORT 仅冒烟覆盖用，默认固定 17630
  const headless = args.includes("--headless"); // CI/无显示环境
  // 不自动开管理页。给「开机自启」用的（`--detach` 会自动带上）：登录时没人坐在那里等这个页面。
  const noOpen = args.includes("--no-open");
  // 库不在预期位置就**别起服务**：起一个没有库的服务，等于给用户一个"一切正常"的假象。
  // 报错文案由 home.ts 统一生成（含排查命令），这里只保证它在控制台和 serve.log 里都看得见。
  let store: PersonalStore;
  try {
    store = PersonalStore.open();
  } catch (e) {
    if (e instanceof DbMissingError) {
      console.error("\n❌ 小本本未启动：记忆库不在预期位置\n");
      console.error(e.message);
      console.error("\n服务没有起来 —— 这是刻意的：宁可起不来，也不要在空库上继续用下去。\n");
      process.exit(2);
    }
    throw e;
  }
  startServe(store, port);
  console.log(`xbb serve listening on http://127.0.0.1:${port}`);

  // 更新确认点：**真实 healthz 通过**才算本次更新成功（删 pending 标记；不删则下次启动回退）。
  // · 为什么不用"起 30s 定时器，到点算成功"：假阳性代价太重——用户在窗口内重启（很常见）就会让
  //   一个本来健康的版本被判失败并拉黑，用户被钉在旧版。确认点必须落在"初始化真的完成了"这个事实上。
  // · 为什么必须带重试：startServe 返回时监听端口未必已经 accept（异步启动、系统繁忙都会滞后）。
  //   一次性探测会把"慢启动"误判成"启动失败"→ 下次启动无谓回滚一个健康版本——比不确认更糟。
  void (async () => {
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (res.ok) {
          confirmStartupSuccess();
        } else {
          console.warn(`[xbb] healthz ${res.status} —— 暂不确认本次更新（下次启动将回退）`);
        }
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 500)); // 端口还没起来，稍后再试
      }
    }
    console.warn("[xbb] healthz 10s 内未就绪 —— 暂不确认本次更新（下次启动将回退）");
  })();

  // 客户端会话采集（V8）：AI 不一定每轮老实上报，所以引擎自己去读本机客户端库。
  // 5 分钟一轮、首轮延迟 15s（先让端口与托盘安顿好）；XBB_INGEST=0 可整块关掉。
  if (process.env.XBB_INGEST !== "0") {
    const { collectClientSessions } = await import("./ingest");
    const runIngest = () => {
      try {
        const r = collectClientSessions(store.db);
        const hit = r.results.filter((x) => x.inserted > 0);
        if (hit.length) console.log(`[xbb] 会话采集 +${r.inserted} 条：${hit.map((x) => `${x.label} ${x.inserted}`).join(" / ")}`);
      } catch (e) {
        console.warn("[xbb] 会话采集失败:", e instanceof Error ? e.message : e);
      }
    };
    setTimeout(runIngest, 15_000).unref?.();
    setInterval(runIngest, 5 * 60_000).unref?.();
  }

  // 自更新：源地址 = env XBB_UPDATE_URL ?? build-meta.UPDATE_URL_DEFAULT
  // （显式设空串即关闭，供企业分发/离线场景）。
  //
  // 后台**只探测、不再静默替换**：2026-10-04 起改为「新会话 / 管理窗口明确问用户要不要更新」
  // （见 update-notice.ts）。若后台仍偷偷把 exe 换好，"要更新吗？"这句询问就是假的——
  // 用户答不答都已经被更新了。实际替换一律由用户显式触发（管理窗口按钮 / 托盘 / `xbb update`）。
  const updater = new Updater();
  if (updater.enabled) {
    const { prepareNotice, ttlMs } = await import("./update-notice");
    void prepareNotice(4000); // 起来先热一次快照，管理窗口一打开就有结论
    const timer = setInterval(() => void prepareNotice(4000), ttlMs());
    timer.unref?.();
  }

  if (!headless) {
    const url = `http://127.0.0.1:${port}/ui`;
    const cloudUrl = `${url}#cloud`; // 管理页的云端区块锚点：托盘里没法输入文本，只能把人送过去
    if (!noOpen) openInBrowser(url); // 管理窗口必须可见（产品纪律）；后台常驻则不带这个副作用

    /** 托盘菜单要的运行态 —— **每次现读 cloud.ts**，托盘自己不维护第二份状态。 */
    const trayState = (): TrayState => {
      const raw = loadCloudConfigRaw();
      const live = loadCloudConfig();
      return {
        cloudConfigured: !!raw,
        cloudEnabled: !!live,
        orgLabel: raw ? orgDisplayName(raw.orgName, raw.orgKind, raw.orgId) : "",
      };
    };

    let tray: TrayHandle | null = null;

    const verifyAndReport = async () => {
      const ok = await store.verifyChain(ORG_PERSONAL);
      console.log(`[xbb] 托盘触发校验: ${ok ? "chain OK" : "CHAIN BROKEN"}`);
    };
    const exportDiag = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/report`);
        const report = (await res.json()) as object;
        const dir = programDir();
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `xbb-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`);
        writeFileSync(file, JSON.stringify(report, null, 2));
        console.log(`[xbb] 诊断报告已导出: ${file}`);
        openInBrowser(dir); // 打开所在文件夹（浏览器协议对目录同 start 行为）
      } catch (e) {
        console.warn("[xbb] 诊断导出失败:", e instanceof Error ? e.message : e);
      }
    };

    /**
     * 本地 ⇄ 云端切换（托盘）。
     *
     * 关键语义：**切到本地是"软关"** —— 只把 `cloud.json` 的 `enabled` 置 false，
     * **密钥留在盘上**。这正是"便捷切换"成立的前提：切回来不必回控制台重新生成绑定票。
     * 真要销毁密钥是另一件事（管理页的「解除绑定」/ `xbb unbind`），两者刻意分开。
     *
     * 本机尚无密钥时，「切换到云端模式」在托盘里无法完成（菜单收不了文本输入）⇒
     * 直接把管理窗口的填写处打开，而不是静默失败或假装切换成功。
     */
    const switchMode = async (toCloud: boolean) => {
      if (toCloud && !loadCloudConfigRaw()) {
        console.log("[xbb] 本机还没有云端密钥：已打开管理窗口的「云端密钥」填写处");
        openInBrowser(cloudUrl);
        return;
      }
      setCloudEnabled(toCloud);
      console.log(
        `[xbb] 已切换到${toCloud ? "云端" : "本地"}模式（密钥保留）—— 需重启 AI 客户端才对新会话生效`,
      );
      await rebuildTray();
    };

    /**
     * 切换后重建托盘 —— **必须重建**：线协议只在 spawn 后下发一次菜单，
     * 状态行（「模式：本地/云端」）与两条切换项的灰态都不会自己刷新。
     * 重启一个几十毫秒的子进程，比赌一个没有文档的动态更新指令便宜。
     */
    const rebuildTray = async () => {
      tray?.dispose();
      tray = await startTray(trayState());
      wireTray();
    };

    const wireTray = () => {
      if (!tray) return; // 托盘不可用（无显示环境 / 资产异常）⇒ 静默降级，服务照常收发记忆
      tray.onOpenWindow(() => openInBrowser(url));
      tray.onVerify(verifyAndReport);
      tray.onExportDiag(() => void exportDiag());
      tray.onCheckUpdate(() => void updater.checkAndApply(true));
      tray.onSwitchCloud(() => void switchMode(true));
      tray.onSwitchLocal(() => void switchMode(false));
      tray.onBindKey(() => openInBrowser(cloudUrl));
      tray.onExit(() => process.exit(0));
    };

    tray = await startTray(trayState());
    wireTray();

    // 托盘子进程必须显式收尾：它是**独立进程**，serve 退出（Ctrl+C / 关控制台窗口 / 崩溃）
    // 不会带走它 ⇒ 不清就会在托盘区留下一个点不掉的幽灵图标 + 一个孤儿进程。
    // 信号也一并接住：默认的 SIGINT 终止路径不会触发 'exit' 事件。
    process.on("exit", () => tray?.dispose());
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => {
        tray?.dispose();
        process.exit(0);
      });
    }

    // 桌面通知：组织事件经 SSE → 系统气泡。
    // 三个 gate，缺一不可：① 非 headless（CI/无显示环境不弹）② 用户没显式关掉
    // ③ **已绑定云端组织**——本地单机库没有第二个成员，"通知同事"这件事不存在，
    //    挂上去只会空转。没有任何一条失败会阻断 serve：通知是增强不是必需。
    if (desktopNotifyEnabled()) {
      const cfg = loadCloudConfig();
      if (cfg) {
        ensureToastAppId(); // Windows AUMID 注册（幂等、失败静默）
        const watch = startNotifyWatch({
          apiBase: cfg.apiBase,
          key: cfg.key,
          consoleBase: consoleBase(cfg.apiBase),
        });
        process.on("exit", () => watch.stop());
        console.log("[xbb] 桌面通知已启用（有人投递/签收/查看你的记忆时会弹系统气泡）");
      }
    }
  }
} else if (cmd === "mcp") {
  await runMcp();
} else if (cmd === "bind") {
  // 协议唤起：xubb://bind?ticket=…&api=…（console「连接我的小本本」唤起）或裸票手动绑定
  const input = args[1];
  if (!input) {
    console.error('用法: xbb bind "xubb://bind?ticket=…&api=…" 或 xbb bind <ticket>');
    process.exit(1);
  }
  const { bindFromTicket } = await import("./cloud");
  try {
    const { cfg, configPath } = await bindFromTicket(input);
    console.log("✅ 已绑定个人云端版");
    console.log(`   API:     ${cfg.apiBase}`);
    console.log(`   组织:    ${orgDisplayName(cfg.orgName, cfg.orgKind, cfg.orgId)}（${cfg.orgId}）`);
    console.log(`   空间:    ${cfg.spaceId ?? "（首次写入时自动解析）"}`);
    console.log(`   Key:     ${cfg.key.slice(0, 14)}…（明文只存本机 ${configPath}）`);
    console.log("");
    console.log("   ────────────────────────────────────────────────────────────");
    console.log("   ⚠️  必须重启 AI 客户端才会生效");
    console.log("       opencode / Cursor / WorkBuddy 等（或重新拉起 xbb mcp）");
    console.log("");
    console.log("       正在运行中的客户端仍以【本地模式】工作 —— 这期间新写入");
    console.log("       的记忆会落在本地库，不会同步到你刚绑定的云端组织。");
    console.log("       重启后新会话整体走云端（情景层 / 保险箱除外，只在本机）。");
    console.log("   ────────────────────────────────────────────────────────────");
  } catch (e) {
    console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
} else if (cmd === "unbind") {
  const { clearCloudConfig } = await import("./cloud");
  const had = clearCloudConfig();
  console.log(had ? "已解除云端绑定（本地库不受影响）" : "本无云端绑定");
  if (had) {
    console.log("");
    console.log("   ────────────────────────────────────────────────────────────");
    console.log("   ⚠️  必须重启 AI 客户端才会生效");
    console.log("       正在运行中的客户端仍以【云端模式】工作，记忆会继续写入");
    console.log("       原组织。重启后新会话即回到纯本地模式。");
    console.log("");
    console.log("   💡 只是想暂时用本地模式？用 `xbb cloud off` —— 它保留密钥，");
    console.log("      随时 `xbb cloud on` 切回去，不必回控制台重新生成绑定票。");
    console.log("      上面这条 unbind 会把密钥从本机删掉，不可恢复。");
    console.log("   ────────────────────────────────────────────────────────────");
  }
} else if (cmd === "cloud") {
  // 本地 ⇄ 云端的模式开关（模式软开关）。缺省子命令 = status：**先看清现状再说**
  const sub = args[1] ?? "status";
  if (sub === "on" || sub === "off") {
    const want = sub === "on";
    if (!loadCloudConfigRaw() && want) {
      console.error("❌ 本机还没有云端密钥，无法切到云端。");
      console.error("   两条路：① 控制台「连接我的小本本」生成绑定票 → `xbb bind <票>`");
      console.error("           ② 已有长期密钥 → `xbb bind-key <xbb_live_…>`，或在管理页 http://127.0.0.1:17630/ui 填写");
      process.exit(1);
    }
    if (setCloudEnabled(want)) {
      console.log(`✅ 已切换到${want ? "云端" : "本地"}模式（密钥保留，未删除）`);
      console.log("");
      console.log("   ⚠️  需重启 AI 客户端（opencode / Cursor / WorkBuddy 等）才对新会话生效；");
      console.log("       在那之前，正在跑的客户端仍按原模式读写。");
    } else {
      console.log("本机没有云端配置，无需切换（已经是纯本地模式）");
    }
  } else if (sub === "status") {
    const raw = loadCloudConfigRaw();
    const live = loadCloudConfig();
    if (!raw) {
      console.log("模式:     本地（仅本机）—— 尚未绑定任何云端组织");
    } else {
      const label = orgDisplayName(raw.orgName, raw.orgKind, raw.orgId);
      console.log(`模式:     ${live ? "云端" : "本地（已关云端，密钥保留）"}`);
      console.log(`组织:     ${label}${raw.orgId ? `（${raw.orgId}）` : ""}`);
      console.log(`API:      ${raw.apiBase}`);
      console.log(`密钥:     ${raw.key.slice(0, 14)}…（明文只在本机 ${join(programDir(), "cloud.json")}）`);
    }
  } else {
    console.error(`未知子命令: ${sub}（可用: on / off / status）`);
    process.exit(1);
  }
} else if (cmd === "bind-key") {
  // 手动填密钥（多机共用同一把 key 的快捷路径；也是误删配置后的恢复入口）
  const input = args[1];
  if (!input) {
    console.error("");
    console.error("用法: xbb bind-key <xbb_live_…> [apiBase]");
    console.error("");
    console.error("  与 `xbb bind <票>` 的区别：绑定票 60 秒单用、必须回控制台现生成；");
    console.error("  这里要的是**你手上已有的长期密钥**——多机共用、或误删配置后的恢复场景。");
    console.error("  apiBase 缺省 https://api.xiaobenben.net（自建部署时显式给）。");
    process.exit(1);
  }
  const { bindFromKey } = await import("./cloud");
  try {
    const r = await bindFromKey(input, args[2]);
    console.log("✅ 已绑定云端");
    console.log(`   API:     ${r.cfg.apiBase}`);
    console.log(`   组织:    ${r.orgLabel}${r.cfg.orgId ? `（${r.cfg.orgId}）` : ""}`);
    if (r.memberName) console.log(`   成员:    ${r.memberName}`);
    console.log(`   空间:    ${r.cfg.spaceId ?? "（首次写入时自动解析）"}`);
    console.log(`   密钥:    ${r.cfg.key.slice(0, 14)}…（明文只存本机 ${r.configPath}）`);
    console.log("");
    console.log("   ────────────────────────────────────────────────────────────");
    console.log("   ⚠️  必须重启 AI 客户端才会生效");
    console.log("       opencode / Cursor / WorkBuddy 等（或重新拉起 xbb mcp）");
    console.log("   ────────────────────────────────────────────────────────────");
  } catch (e) {
    console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
} else if (cmd === "register-protocol") {
  // 三平台注册 xubb:// handler；HKCU/desktop 无需管理员
  const { registerProtocol } = await import("./cloud");
  const r = registerProtocol(args[1]);
  console.log(`${r.ok ? "✅" : "❌"} ${r.message}`);
  process.exit(r.ok ? 0 : 1);
} else if (cmd === "autostart") {
  // 开机自启（常驻服务）。缺省子命令 = status：**不加参数先看清现状**，避免误写。
  const { AUTOSTART_VALUE, autostartUnsupportedMessage, readAutostart, enableAutostart, disableAutostart } =
    await import("./autostart");
  const sub = args[1] ?? "status";

  if (sub === "on") {
    const r = enableAutostart();
    console.log(`${r.ok ? "✅" : "❌"} 开机自启${r.ok ? "已开启" : "开启失败"}\n   ${r.message}`);
    if (r.ok) {
      console.log("");
      console.log("   登录后：常驻服务在后台无声启动 —— 无控制台窗口，也不弹管理页");
      console.log("   管理页随时可开：http://127.0.0.1:17630/ui（或点托盘「打开管理窗口」）");
      console.log("   ⚠️ 登录瞬间启动器会闪一下（约 0.2s）—— 真正的服务全程无窗口");
      console.log("   想立刻体验：xbb serve --detach");
    }
    process.exit(r.ok ? 0 : 1);
  }

  if (sub === "off") {
    const r = disableAutostart();
    console.log(`${r.ok ? "✅" : "❌"} ${r.message}`);
    process.exit(r.ok ? 0 : 1);
  }

  if (sub !== "status") {
    console.error(`未知子命令: ${sub}（可用: on / off / status）`);
    process.exit(1);
  }

  const s = readAutostart();
  if (!s.supported) {
    console.log(autostartUnsupportedMessage());
  } else {
    console.log(`开机自启: ${s.present ? "已开启" : "未开启"}（HKCU\\…\\CurrentVersion\\Run → ${AUTOSTART_VALUE}）`);
    if (s.present) console.log(`  命令: ${s.command}`);
  }
} else if (cmd === "ingest") {
  // 客户端会话采集（V8）：应采尽采。
  // 为什么要有这个命令：MCP 拿不到对话流，靠 AI 每轮上报实测不可靠；
  // 而各家客户端本来就把完整会话落在本机盘上，引擎自己去读才是完整性的唯一保证。
  const { collectClientSessions, ingestStatus, layerBalance, probeSources, ALL_SOURCES } = await import("./ingest");
  const store = PersonalStore.open();

  if (args.includes("--status")) {
    const probe = probeSources();
    const st = ingestStatus(store.db);
    console.log("源           可用  已入档      会话   最近新增  解析率  最近运行          说明");
    for (const p of probe) {
      const s = st.find((x) => x.source === p.source);
      const audio = p.available ? "✅" : "❌";
      const rate =
        s?.parseRate == null ? "  -  " : `${String(Math.round(s.parseRate * 100)).padStart(3)}%${s.parseRate < 0.8 ? "⚠" : " "}`;
      const note = s?.unparsed ? `${s.note ?? p.note} [未解析 ${s.unparsed}/${s.totalLines}]` : (s?.note ?? p.note);
      console.log(
        `${p.label.padEnd(12)} ${audio}   ${String(s?.episodes ?? 0).padStart(8)}  ${String(s?.sessions ?? 0).padStart(5)}  ${String(
          s?.lastNew ?? 0,
        ).padStart(7)}  ${rate}  ${(s?.lastRun ?? "-").padEnd(17)} ${note}`,
      );
    }
    const total = store.db.query("SELECT count(*) c FROM episodes").get() as { c: number };
    console.log(`\nepisodes 总计 ${total.c} 条（本机冷存档，永不上云）`);

    const lb = layerBalance(store.db);
    if (lb.level === "idle") {
      console.log("分层配比：原话层还是空的（未采集），比值无意义");
    } else {
      const ratio = `1:${Math.round(lb.perMemory ?? 0)}`;
      const tag =
        lb.level === "healthy"
          ? "✅ 健康"
          : lb.level === "watch"
            ? "⚠ 观察"
            : "⚠ 摘要层可能在灌水";
      console.log(`分层配比：摘要 ${lb.memories} : 原话 ${lb.episodes} ≈ ${ratio}  ${tag}`);
      if (lb.level !== "healthy") {
        console.log("  正常应 ≥1:50（原话是自动采集的，摘要只写结论）。比值塌下来通常是 AI 在复述对话而非提炼：");
        console.log("  判据——这条记忆 3 个月后还有用吗？能从原话里直接翻到（\"用户问了X，我答了Y\"）就别写。");
      }
    }
    process.exit(0);
  }

  const dryRun = args.includes("--dry-run");
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const srcArg = args.find((a) => a.startsWith("--source="));
  const sources = srcArg
    ? (srcArg.slice("--source=".length).split(",").map((s) => s.trim()).filter(Boolean) as string[])
    : undefined;
  const unknown = sources?.filter((s) => !ALL_SOURCES.includes(s as never));
  if (unknown?.length) {
    console.error(`未知来源: ${unknown.join(", ")}（可用: ${ALL_SOURCES.join(" / ")}）`);
    process.exit(1);
  }

  const t0 = Date.now();
  const r = collectClientSessions(store.db, {
    sources: sources as never,
    maxTurns: limitArg ? Number(limitArg.slice("--limit=".length)) : undefined,
    dryRun,
  });

  console.log(`${dryRun ? "【预演，不写库】" : ""}客户端会话采集`);
  console.log("源           可用  扫描      新增   跳过  解析    耗时    说明");
  for (const x of r.results) {
    const rate = x.suspects
      ? `${String(Math.round(((x.suspects - x.unparsed) / x.suspects) * 100)).padStart(3)}%${x.suspects && x.unparsed / x.suspects > 0.2 ? "⚠" : " "}`
      : "  -  ";
    console.log(
      `${x.label.padEnd(12)} ${x.available ? "✅" : "❌"}  ${String(x.scanned).padStart(6)}  ${String(x.inserted).padStart(7)}  ${String(
        x.skipped,
      ).padStart(5)}  ${rate}  ${String(x.ms + "ms").padStart(7)}  ${x.note}`,
    );
  }
  const drifted = r.results.filter((x) => x.fingerprintChanged);
  if (drifted.length) {
    console.log("\n⚠ 结构指纹变化 —— 上游可能改版，字段集已不是上次那套：");
    for (const x of drifted) {
      console.log(`   ${x.label}: 新指纹 ${x.fingerprint}，本次未解析 ${x.unparsed}/${x.suspects}`);
    }
    console.log("   先看 --status 里的未解析行数；若在涨，说明现有解析规则已失效。");
  }
  const total = store.db.query("SELECT count(*) c FROM episodes").get() as { c: number };
  console.log(
    `\n本次扫描 ${r.scanned} 条，${dryRun ? "将新增" : "新增"} ${r.inserted} 条，用时 ${Date.now() - t0}ms；episodes 现有 ${total.c} 条`,
  );
  if (!dryRun) {
    const after = ingestStatus(store.db).filter((s) => s.episodes > 0);
    if (after.length) {
      console.log("累计：" + after.map((s) => `${s.source} ${s.episodes}`).join(" / "));
    }
  }
} else if (cmd === "version" || cmd === "--version" || cmd === "-v") {
  // 版本横幅 + 构建指纹（版本核对用）
  const { banner } = await import("./build-meta");
  console.log(banner());
} else if (cmd === "update") {
  // 手动检查更新：与托盘「检查更新」同一入口，并放行黑名单——便于排障与应急
  const updater = new Updater();
  const r = await updater.checkAndApply(true);
  console.log(`[update] ${JSON.stringify(r)}`);
  process.exit(r.status === "failed" ? 1 : 0);
} else if (cmd === "update-status") {
  // 自更新状态速览（排障用）：源地址 / pending 标记 / 回滚黑名单
  const { resolveUpdateUrl, updateRoot, readBlocklist, isCompiledExe, pendingPath, CURRENT_VERSION } = await import("./updater");
  const { existsSync } = await import("node:fs");
  const { readPendingMarker, decideBootAction } = await import("./update-rollback");
  const bl = readBlocklist();
  console.log(`清单源:   ${resolveUpdateUrl() || "（已关闭：XBB_UPDATE_URL 为空）"}`);
  console.log(`运行形态: ${isCompiledExe() ? "编译产物 exe" : "dev（未编译，自更新被禁用）"}`);
  console.log(`工作目录: ${updateRoot()}`);
  // ⚠️ 这句以前是写死的「有 —— 下次启动将回退上一版本」，**与实现不符**（2026-10-16 实测踩到）：
  //    pending 标记在「刚 swap 完、还没被 serve 确认」时也长这样（version=新版, attempts=0），
  //    而那种情况下的判定是 **adopt（放行首次引导）**，不是回退。照旧文案会把排障的人吓到
  //    （以为更新要丢），甚至去手动删 exe。唯一真源是 decideBootAction 的三态判定。
  if (!existsSync(pendingPath())) {
    console.log(`pending:  无`);
  } else {
    const pend = readPendingMarker();
    const decision = decideBootAction(pend, CURRENT_VERSION);
    console.log(
      `pending:  ${
        decision === "adopt"
          ? `有（v${pend?.version} 首次引导）—— 下次启动会**放行**它，待 serve 健康检查通过后自动清除标记`
          : `有（v${pend?.version}）—— 下次启动会**回退**上一版本并拉黑它（上次引导未走到确认点）`
      }`,
    );
  }
  console.log(`黑名单:   ${bl.length ? bl.map((e) => `${e.version}(${e.reason ?? "-"})`).join(", ") : "空"}`);
} else if (cmd === "home") {
  // ── 数据位置 ───────────────────────────────────────────────────────
  // 「程序在哪、库在哪、凭什么这么判断」必须任何时刻都能一眼答出来。
  // 起因：改了指路配置而旧库不跟着走，程序就在空目录里静默新建空库 ——
  // 用户只看到「AI 突然失忆」，而小本本一切看起来正常。这条链路上每一环都得能自证。
  const H = await import("./home");
  const { existsSync } = await import("node:fs");
  const sub = args[1] ?? "show";
  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

  if (sub === "help" || sub === "-h" || sub === "--help") {
    // 文案在 cli-help.ts（唯一真源）。`--help` 已在入口被拦下，这里兜住 `xbb home help`。
    console.log(helpText("home"));
    process.exit(0);
  }

  if (sub === "show") {
    const { dir, source } = H.resolveDataDirWithSource();
    const p = H.dbPresence();
    const srcLabel =
      source === "env"
        ? "环境变量 XBB_DATA_DIR（临时覆盖，不写盘）"
        : source === "config"
          ? `配置文件 ${H.homeConfigPath()}`
          : "默认位置（未配置，向后兼容）";
    console.log(`程序目录  ${H.programDir()}   （exe / 更新包 / 托盘 / 配置）`);
    console.log(`数据目录  ${dir}`);
    console.log(`位置来源  ${srcLabel}`);
    if (p.exists) {
      let extra = "";
      try {
        const c = H.readDbCounts(p.dbPath);
        extra = `\n          记忆 ${c.memories} / 原话 ${c.episodes} / 事件 ${c.events} · 完整性 ${c.integrity}`;
      } catch (e) {
        extra = `\n          ⚠️ 打不开：${e instanceof Error ? e.message : String(e)}`;
      }
      const when = (p.mtime ?? "").slice(0, 16).replace("T", " ");
      console.log(`记忆库    ${p.dbPath}`);
      console.log(`          ${mb(p.sizeBytes)} · 最后写入 ${when}${extra}`);
    } else {
      console.log(`记忆库    ${p.dbPath}`);
      console.log(`          ⚠️ 不在位 —— 现在启动会被拒绝（这是刻意的：宁可起不来，也不要在空库上继续用）`);
      if (existsSync(join(H.programDir(), "memory.db")) && source !== "default") {
        console.log(`          默认位置有库：${join(H.programDir(), "memory.db")} —— 用 xbb home move / reset 校准`);
      }
    }
    const modelPath = H.modelsDir();
    console.log(`模型目录  ${modelPath}${existsSync(modelPath) ? `   ${mb(H.dirUsage(modelPath))}` : "   （尚未下载）"}`);
    console.log(`配置文件  ${H.homeConfigPath()}${existsSync(H.homeConfigPath()) ? "" : "   （不存在 = 用默认位置）"}`);
    const cfg = H.readHomeConfig();
    if (cfg) console.log(`          ${JSON.stringify(cfg)}`);
    process.exit(p.exists ? 0 : 1);
  }

  if (sub === "set") {
    // 「设置」不是「搬迁」。设一个空目录等于把自己送进下一次启动的报错里，所以默认拒绝。
    const target = args[2];
    if (!target) {
      console.error('用法: xbb home set "<目录>" [--force]');
      console.error("  目标目录里必须已经有 memory.db —— 想把库搬过去请用 `xbb home move`。");
      process.exit(1);
    }
    const abs = await import("node:path").then((m) => m.resolve(target));
    const dbFile = join(abs, "memory.db");
    if (!existsSync(dbFile) && !args.includes("--force")) {
      console.error(`❌ ${abs} 里没有 memory.db`);
      console.error("   · 想把库搬过去：xbb home move \"" + abs + "\"（复制+校验+切配置，一步到位）");
      console.error("   · 库在外接盘、现在没插：确认路径无误后加 --force 先写配置");
      process.exit(1);
    }
    // 源目录必须在写配置**之前**取：写完配置 resolveDataDir() 就指向新位置了
    const prevDataDir = H.resolveDataDir();
    H.writeHomeConfig({ dataDir: abs }, "xbb home set");
    console.log(`✅ 已指向 ${abs}`);
    console.log(`   ${existsSync(dbFile) ? `库已就位：${dbFile}` : "⚠️ 该位置当前无库，下次启动会拒绝启动（不会新建空库）"}`);
    // 模型不会自己跟过去。缺模型的后果是**静默降级为关键词检索**——用户只会觉得
    // 「好像变笨了」，永远不会想到是换了目录。所以换目录时顺手带过去（约 24MB）。
    const m = H.copyModelsInto(abs, prevDataDir);
    if (m.copied) {
      console.log(`   模型已一并复制：${m.from}  →  ${join(abs, "models")}（${(m.bytes! / 1048576).toFixed(1)} MB）`);
    } else if (!existsSync(join(abs, "models"))) {
      console.log("   ⚠️  该位置没有语义检索模型，本机也找不到可复制的副本：");
      console.log("       检索会降级为关键词匹配。联网后重启一次会自动重新下载。");
    }
    console.log("");
    console.log("   ⚠️  必须重启 AI 客户端（opencode / Cursor / WorkBuddy）与 xbb serve 才会生效；");
    console.log("       正在运行的进程仍拿着旧路径。");
    process.exit(0);
  }

  if (sub === "move") {
    const target = args[2];
    if (!target) {
      console.error('用法: xbb home move "<目录>" [--cleanup] [--force]');
      console.error("  复制 → 校验（完整性 + 行数逐项比对）→ 才切配置。校验不过不切，原库不动。");
      console.error("  --cleanup 校验通过后删除旧位置的数据（默认保留，确认新位置能用后自己删）。");
      console.error("  --force   跳过「库是否被占用」检查（已自行确认无进程时用；校验照样执行）。");
      process.exit(1);
    }
    try {
      console.log("迁移中（先复制、再校验、最后才切配置）…");
      const r = H.moveDataDir(target, { cleanup: args.includes("--cleanup"), force: args.includes("--force") });
      console.log(`✅ 已迁移：${r.from}  →  ${r.to}`);
      console.log(`   搬了 ${r.entries.join(" / ")}，共 ${mb(r.bytes)}`);
      console.log(
        `   校验：完整性 ${r.verify?.integrity} · 记忆 ${r.verify?.memories} / 原话 ${r.verify?.episodes} / 事件 ${r.verify?.events}（与源库逐项一致）`,
      );
      console.log(`   配置：${r.configPath}`);
      console.log("");
      console.log("   ⚠️  重启 xbb serve 和所有 AI 客户端才会用新位置。");
      if (!args.includes("--cleanup")) console.log(`   旧位置的数据仍在 ${r.from}，确认新位置工作正常后自行删除。`);
    } catch (e) {
      console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (sub === "find") {
    // 忘了当初放哪时唯一的救命绳。按记忆条数排序 —— 同名空库到处都是，条数才能分出哪个是真的。
    const deep = args.includes("--deep");
    console.log(deep ? "全盘深扫（可能几分钟）…" : "扫描中（各盘根+家目录，深度 4，预算 15 秒）…");
    const found = H.findDatabases({ deep });
    if (!found.length) {
      console.log("没找到任何 memory.db。若库在外接盘，请先插上再扫；或用 --deep 全盘深扫。");
      process.exit(1);
    }
    const cur = H.resolveDbPath().toLowerCase();
    console.log("");
    console.log("记忆数   大小      最后写入          路径");
    for (const f of found) {
      const mark = f.path.toLowerCase() === cur ? " ← 当前" : "";
      console.log(
        `${String(f.memories ?? "?").padStart(6)}  ${mb(f.bytes).padStart(9)}  ${f.mtime.slice(0, 16).replace("T", " ")}  ${f.path}${mark}`,
      );
    }
    console.log(`\n共 ${found.length} 个。换过去：xbb home set "<路径的目录>"`);
    process.exit(0);
  }

  if (sub === "init") {
    // 唯一允许"在配置位置新建空库"的入口 —— 而它必须带 --force。
    if (!args.includes("--force")) {
      const p = H.dbPresence();
      console.error(`拒绝执行：新建空库是一个**不可逆的判断**（用户会以为记忆全丢了）。`);
      console.error(`   当前位置：${p.dbPath}${p.exists ? "（有库，无需 init）" : "（无库）"}`);
      console.error("   确认要从零开始，加 --force：xbb home init --force");
      console.error("   更可能想要的是：xbb home show / xbb home find / xbb home reset");
      process.exit(1);
    }
    const store = PersonalStore.open(undefined, { force: true });
    const p = H.dbPresence();
    store.db.close();
    console.log(`✅ 已在 ${p.dbPath} 建了一个空库`);
    console.log("   ⚠️  这是一个全新的空库 —— 旧记忆不在里面。");
    process.exit(0);
  }

  if (sub === "reset") {
    // 撤掉指向，回到默认位置（老库通常就在那儿）
    H.clearDataDir("xbb home reset");
    const p = H.dbPresence();
    console.log(`✅ 已撤掉数据目录配置，回到默认位置：${p.dbPath}`);
    console.log(`   ${p.exists ? "库在位。" : "⚠️ 该位置没有库 —— 用 xbb home find 找一下。"}`);
    process.exit(p.exists ? 0 : 1);
  }

  console.error(`未知子命令: ${sub}（可用: show / set / move / find / init / reset）`);
  process.exit(1);
} else if (cmd === "stop") {
  // 没有这条命令时，`serve --detach` 在托盘没开的情况下只能去任务管理器里杀（2026-11-04 用户反馈）。
  const H = await import("./home");
  const keepMcp = args.includes("--keep-mcp");
  const procs = H.runningProcs();
  if (!procs.length) {
    console.log("没有在跑的 xbb 进程。");
    process.exit(0);
  }
  console.log(`发现 ${procs.length} 个 xbb 进程：${procs.map((p) => `PID ${p.pid} ${p.name}`).join("、")}`);
  const r = H.stopAll({ keepMcp });
  for (const p of r.stopped) console.log(`  ✅ 已停止 PID ${p.pid} ${p.name}`);
  for (const p of r.kept) {
    const why = !p.cmd ? "拿不到命令行，保守跳过" : H.isMcpCommand(p.cmd) ? "mcp，当前会话仍在用" : "mcp";
    console.log(`  ⏭  已保留 PID ${p.pid} ${p.name}（${why}）`);
  }
  for (const f of r.failed) console.log(`  ❌ 停不掉 PID ${f.pid} ${f.name}：${f.err}`);
  if (r.failed.length) {
    console.log("\n  停不掉的通常是权限问题：Windows 用管理员身份重试，Unix 检查进程属主。");
  }
  if (r.undecidable.length) {
    console.log(
      `\n  ⚠️ ${r.undecidable.length} 个进程的启动参数取不到（系统限制了进程查询），已全部保守跳过 ——` +
        "\n     宁可少停一个 serve，也不误杀正在给你供记忆的 mcp。要全停就去掉 --keep-mcp。",
    );
  }

  // 这两段不能省。不说清楚，用户会以为 stop 坏了，然后反复执行、反复看到进程回来。
  if (r.kept.some((p) => p.cmd)) {
    console.log("");
    console.log("  --keep-mcp 保留了 mcp：当前会话的记忆工具不受影响，serve 已停。");
    console.log("  但 mcp 仍连着库，所以现在跑 xbb home move 还是会报「库被占用」。");
    console.log("  搬家前请先关掉 AI 客户端，再执行一次不带 --keep-mcp 的 xbb stop。");
  }
  if (r.stopped.length) {
    console.log("");
    console.log("  注意：Cursor / opencode / WorkBuddy 拉起的 mcp 会被这些客户端自动重启。");
    console.log("  要彻底停干净，先关掉这些客户端，再执行一次 xbb stop。");
    console.log("  后台服务停了要重新起来：xbb serve --detach（或点托盘「打开管理窗口」先 xbb serve）");
  }
  process.exit(r.failed.length ? 1 : 0);
} else if (cmd === "verify") {
  // 审计自检：哈希链完整性（账不可改只能增）
  const store = PersonalStore.open();
  const ok = await store.verifyChain("00000000-0000-7000-8000-000000000001");
  console.log(ok ? "chain OK" : "CHAIN BROKEN");
  process.exit(ok ? 0 : 1);
} else {
  // 无参数 / `xbb help` = 状态速览 + 命令总览。
  // 未知命令**明确报错并 exit 1**：以前静默当帮助打一遍、退出码 0，脚本里 `xbb typo && next`
  // 会一路往下跑，错误在上游被吃掉。帮助文本仍在 cli-help.ts（唯一真源）。
  const craw = loadCloudConfigRaw();
  const clive = loadCloudConfig();
  const cLabel = craw ? orgDisplayName(craw.orgName, craw.orgKind, craw.orgId) : "";
  const cloudLine = !craw
    ? "模式: 本地（仅本机）—— 尚未绑定云端"
    : clive
      ? `模式: 云端 · ${cLabel}  @ ${craw.apiBase}`
      : `模式: 本地（已关云端，密钥保留）· 随时可切回 ${cLabel}`;

  if (cmd !== "help") {
    console.error(`未知命令: ${cmd}（运行 xbb --help 看全部命令）`);
    console.error("");
    console.error(overviewHelp());
    process.exit(1);
  }
  console.log(cloudLine);
  console.log("");
  console.log(overviewHelp());
}
