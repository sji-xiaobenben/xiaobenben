// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * xiaobenben — 个人客户端壳。
 * 本地库 SQLite 永远零登录；17630 端口；MCP stdio 工具面。
 */
import { programDir, homeConfigPath, writeHomeConfig, DbMissingError, ConfigCorruptError } from "./home";
import { runMcp } from "./mcp";
import { PersonalStore, DbCorruptError } from "./store";
import { ORG_PERSONAL, SchemaBusyError, SCHEMA_TARGET_VERSION } from "./schema";
import { startServe, lastRequestAtMs } from "./serve";
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
import { dict, formatNumber, formatTime, isLang, normalizeLang, resolveLang, currentLang, LANGS } from "./i18n";
import { columnWidth, displayWidth, padTo } from "./i18n/width";

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

/**
 * 隐藏子命令：采集子进程（`ingest-job.ts` 的内部实现，不出现在帮助里）。
 * 为什么要单独一个进程入口：`collectClientSessions` 一轮要 6.8 秒且全同步，
 * 跑在服务进程里就是把 HTTP 冻住 6.8 秒。父进程只负责起停与回报状态。
 * 必须先于 `serve` 分支：子进程不该走任何服务装配、也不该去动更新回滚标记。
 */
if (cmd === "__ingest") {
  const { runIngestChild } = await import("./ingest-job");
  process.exit(await runIngestChild());
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
    const f = dict().cmd.serveFail;
    const show = (lines: string[], code: number) => {
      for (const l of lines) console.error(l);
      process.exit(code);
    };
    if (e instanceof DbMissingError) show(f.missing(e.message), 2);
    // 结构升级拿不到写锁：给「怎么办」，不要给 Bun 堆栈
    if (e instanceof SchemaBusyError) show(f.busy(e.message), 3);
    // 库文件损坏：**绝不能覆盖**（还有抢救价值），所以这里也拒绝起服务
    if (e instanceof DbCorruptError) show(f.corrupt(e.message), 4);
    throw e;
  }
  // 会话采集（V8）：AI 不一定每轮老实上报，所以引擎自己去读本机客户端库。
  // 5 分钟一轮、首轮延迟 20s —— **跑在独立子进程里**：一轮实测 6.8 秒且全同步，
  // 留在主线程就是把整个 HTTP 服务冻住（管理页点一下卡一下）。详见 ingest-job.ts 文件头。
  // XBB_INGEST=0 或页面上的「不要自动整理」都能关掉。
  const { startIngestScheduler } = await import("./ingest-job");
  const ingest = startIngestScheduler({
    // 有人正在用页面就往后让，不跟用户操作抢 SQLite 写锁
    idleFor: () => Date.now() - lastRequestAtMs(),
    onResult: (r) => {
      if (!r.ok) console.warn(`[xbb] 会话采集失败：${r.error ?? "未知错误"}`);
      else if (r.inserted > 0) {
        const hit = r.sources.filter((x) => x.inserted > 0);
        console.log(`[xbb] 会话采集 +${r.inserted} 条：${hit.map((x) => `${x.label} ${x.inserted}`).join(" / ")}`);
      }
    },
  });

  startServe(store, port, { ingest });
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

    /**
     * 开机自启的**默认态**：装好、跑一次就生效，不需要用户先敲 `xbb autostart on`。
     *
     * 只在这个分支里做 —— `--headless` 是 CI / 无显示环境，往那儿写用户级登录项是错的。
     * 失败只打一行警告，绝不打断 serve：自启是增强，不是服务能否收发记忆的前提。
     * 详情（含"用户已 off 就不写回"）在 `autostart.ts` 的 `ensureAutostartDefault`。
     */
    const {
      ensureAutostartDefault,
      readAutostart,
      enableAutostart,
      disableAutostart,
      setAutostartPref,
    } = await import("./autostart");
    {
      const a = ensureAutostartDefault();
      if (a.action === "enabled") console.log(`[xbb] 开机自启${a.detail}`);
      else if (a.action === "disabled") console.log(`[xbb] ${a.detail}`);
      else if (a.action === "failed") console.warn(`[xbb] 开机自启配置失败（不影响服务）：${a.detail}`);
    }

    /**
     * 开始菜单里那一格「小本本」。
     *
     * 与自启完全同一套纪律（同在这个 `!headless` 分支、只补缺、失败只警告），但**不 await**：
     * 写它要起一个 PowerShell，冷启动几百毫秒，而 serve 就绪时间直接决定 AI 客户端等多久。
     * 这一格写不写跟"记忆能不能收发"毫无关系 ⇒ 它连阻塞的资格都没有。
     *
     * 首次安装的用户大多一次也不会双击图标（他们直接从客户端里调 MCP），所以 serve 这一侧
     * 才是这条路的兜底：登录自启跑起来的同时，系统里的登记也就位了。
     */
    void (await import("./shortcut")).ensureStartMenuShortcut().then((s) => {
      if (s.status === "created") console.log(`[xbb] 已加入开始菜单：${s.path}`);
      else if (s.status === "failed") console.warn(`[xbb] 开始菜单图标没能写入（不影响服务）：${s.message}`);
    });

    /**
     * 托盘菜单要的运行态 —— **每次现读 cloud.ts / 系统启动项**，托盘自己不维护第二份状态。
     * 自启现状也现读：用户可能在系统设置（GNOME 启动应用程序 / 任务管理器）里改过。
     */
    const trayState = (): TrayState => {
      const raw = loadCloudConfigRaw();
      const live = loadCloudConfig();
      const auto = readAutostart();
      return {
        cloudConfigured: !!raw,
        cloudEnabled: !!live,
        orgLabel: raw ? orgDisplayName(raw.orgName, raw.orgKind, raw.orgId) : "",
        autostartSupported: auto.supported,
        autostartOn: auto.enabled,
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

    /**
     * 托盘里的开机自启开关。
     *
     * 两件事都要做，缺一不可：① 动系统里的启动项；② 记下用户意图 —— 只做①的话，
     * 用户在这里关掉，下次 serve 启动 `ensureAutostartDefault` 又会把它打开。
     * 切换完必须重建托盘：菜单只在 spawn 时下发一次，标题里的「已开/已关」不会自己变。
     */
    const toggleAutostart = async () => {
      try {
        const now = readAutostart();
        if (now.enabled) {
          const r = disableAutostart();
          setAutostartPref("off"); // 即使删除失败也记 off：下次启动会再清一次
          console.log(`${r.ok ? "[xbb]" : "[xbb] ⚠️"} 关闭开机自启${r.ok ? "成功" : `失败：${r.message}`}`);
        } else {
          const r = enableAutostart();
          if (r.ok) setAutostartPref("on");
          console.log(`${r.ok ? "[xbb]" : "[xbb] ⚠️"} 开启开机自启${r.ok ? "成功" : `失败：${r.message}`}`);
        }
      } catch (e) {
        console.warn("[xbb] 切换开机自启失败：", e instanceof Error ? e.message : e);
      }
      await rebuildTray();
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
      tray.onToggleAutostart(() => void toggleAutostart());
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
} else if (cmd === "start") {
  // 「双击图标」的入口：确保服务在跑，并且**把结果说出来**。
  //
  // 为什么非要说一声：用户判断"它在不在"的唯一依据是右下角那个图标。服务起在后台却
  // 没有任何可见反馈时，双击的结果就是"什么也没发生" —— 这正是「装了但不知道有没有在用」
  // 的另一半：不是记忆层无感，是**启动这一步本身无感**。
  const { ensureServeRunning, serveLogPath, SERVE_PORT } = await import("./autostart");
  const { showToast } = await import("./notify");
  const r = await ensureServeRunning();
  if (!r.healthy) {
    console.error(`[xbb] 服务没能在 ${Math.round(r.waitedMs / 1000)} 秒内就绪`);
    console.error(
      r.portBusy
        ? `      端口 ${SERVE_PORT} 已被占用 —— 先看是谁：netstat -ano | findstr ${SERVE_PORT}`
        : `      进程没起来，看日志：${serveLogPath()}`,
    );
    process.exit(1);
  }
  // AUMID 必须先注册，否则 Windows 上这条通知会被静默丢弃（不是显示不出来，是压根没投递）
  ensureToastAppId();
  // 三件事一条通知说完：它起来了 / 去哪看它 / 图标被折叠时怎么办。
  //   · url 让**点通知＝直接进管理页**，这是不依赖托盘的备用路径；
  //   · 后半句是给 Windows 那座"隐藏的图标"区的：首次安装的图标默认被折叠，
  //     用户会以为没启动——这是「无感」在启动环节的翻版。
  const body = "托盘图标在右下角。看不到就点开 ^ 拖到任务栏。";
  const uiUrl = `http://127.0.0.1:${SERVE_PORT}/ui`;
  if (r.already) {
    showToast({ title: "小本本已经在运行", body, url: uiUrl });
    console.log(`[xbb] 常驻服务已在运行（127.0.0.1:${SERVE_PORT}）`);
  } else {
    showToast({ title: "小本本 AI 记忆已启动", body, url: uiUrl });
    console.log(`[xbb] 已启动并就绪（${r.waitedMs}ms${r.pid ? ` · PID ${r.pid}` : ""}）`);
  }
  if (args.includes("--open") || args.includes("-o")) openInBrowser(uiUrl);

  /**
   * 服务起来了，顺手把系统里那一格补上（开始菜单快捷方式）。
   *
   * 放在这里而不是只放在 serve 里：`start` 的实例可能已经在跑（服务不重启），
   * 此时 serve 侧那段补写逻辑永远不会再执行 —— 而"双击图标"恰恰是最该发生这件事的时刻。
   * 幂等且失败静默，绝不影响上面那句"已启动"。
   */
  const { ensureStartMenuShortcut } = await import("./shortcut");
  const sc = await ensureStartMenuShortcut();
  if (sc.status === "created") console.log(`[xbb] 已加入开始菜单：${sc.path}`);
  else if (sc.status === "failed") console.warn(`[xbb] 开始菜单图标没能写入（不影响使用）：${sc.message}`);
} else if (cmd === "mcp") {
  await runMcp();
} else if (cmd === "bind") {
  // 协议唤起：xubb://bind?ticket=…&api=…（console「连接我的小本本」唤起）或裸票手动绑定
  const c = dict().cmd;
  const input = args[1];
  if (!input) {
    console.error(c.bind.usage);
    process.exit(1);
  }
  const { bindFromTicket } = await import("./cloud");
  try {
    const { cfg, configPath } = await bindFromTicket(input);
    for (const l of c.bind.ok({
      api: cfg.apiBase,
      org: orgDisplayName(cfg.orgName, cfg.orgKind, cfg.orgId),
      orgId: cfg.orgId,
      member: null,
      space: cfg.spaceId,
      keyShort: cfg.key.slice(0, 14),
      path: configPath,
    }))
      console.log(l);
  } catch (e) {
    console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
} else if (cmd === "unbind") {
  const { clearCloudConfig } = await import("./cloud");
  const had = clearCloudConfig();
  for (const l of dict().cmd.unbind(had)) console.log(l);
} else if (cmd === "cloud") {
  // 本地 ⇄ 云端的模式开关（模式软开关）。缺省子命令 = status：**先看清现状再说**
  const c = dict().cmd;
  const sub = args[1] ?? "status";
  if (sub === "on" || sub === "off") {
    const want = sub === "on";
    if (!loadCloudConfigRaw() && want) {
      for (const l of c.cloud.noKey) console.error(l);
      process.exit(1);
    }
    if (setCloudEnabled(want)) {
      for (const l of c.cloud.switched(want)) console.log(l);
    } else {
      console.log(c.cloud.nothingToSwitch);
    }
  } else if (sub === "status") {
    const raw = loadCloudConfigRaw();
    const live = loadCloudConfig();
    if (!raw) for (const l of c.cloud.statusNone) console.log(l);
    else
      for (const l of c.cloud.status({
        cloud: !!live,
        org: orgDisplayName(raw.orgName, raw.orgKind, raw.orgId),
        orgId: raw.orgId,
        api: raw.apiBase,
        keyShort: raw.key.slice(0, 14),
        path: join(programDir(), "cloud.json"),
      }))
        console.log(l);
  } else {
    console.error(c.cloud.unknownSub(sub));
    process.exit(1);
  }
} else if (cmd === "bind-key") {
  // 手动填密钥（多机共用同一把 key 的快捷路径；也是误删配置后的恢复入口）
  const c = dict().cmd;
  const input = args[1];
  if (!input) {
    for (const l of c.bindKey.usage) console.error(l);
    process.exit(1);
  }
  const { bindFromKey } = await import("./cloud");
  try {
    const r = await bindFromKey(input, args[2]);
    for (const l of c.bindKey.ok({
      api: r.cfg.apiBase,
      org: r.orgLabel,
      orgId: r.cfg.orgId,
      member: r.memberName ?? null,
      space: r.cfg.spaceId,
      keyShort: r.cfg.key.slice(0, 14),
      path: r.configPath,
    }))
      console.log(l);
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
  const {
    autostartUnsupportedMessage,
    readAutostart,
    enableAutostart,
    disableAutostart,
    readAutostartPref,
    setAutostartPref,
  } = await import("./autostart");
  const sub = args[1] ?? "status";
  const c = dict().cmd;

  if (sub === "on") {
    const r = enableAutostart();
    // 只在实际写入成功后记意图：失败却记下 "on"，下次启动会以为"用户要、只是还没写成"，
    // 于是每次启动都重试一遍 —— 一条永远失败的写操作会一直出现在日志里。
    if (r.ok) setAutostartPref("on");
    for (const l of c.autostart.onResult(r.ok, r.message)) console.log(l);
    process.exit(r.ok ? 0 : 1);
  }

  if (sub === "off") {
    const r = disableAutostart();
    // **无论删除成功与否都记 off**：用户的意愿是"别开机启动我"。记下之后，下次启动时
    // `ensureAutostartDefault` 会再清一次残留 —— 比"这次删不掉就永远删不掉"好。
    setAutostartPref("off");
    for (const l of c.autostart.offResult(r.ok, r.message)) console.log(l);
    process.exit(r.ok ? 0 : 1);
  }

  if (sub !== "status") {
    console.error(c.autostart.unknownSub(sub));
    process.exit(1);
  }

  const s = readAutostart();
  const pref = readAutostartPref();
  if (!s.supported) {
    console.log(autostartUnsupportedMessage());
  } else {
    // 三个状态词放这里而不是字典：字典里的 `status()` 是整块排版，
    // 状态词要先算出来才能给它（`autostart.ts` 里那套判定不能搬）。
    const zh = currentLang() === "zh";
    const state = s.enabled
      ? (zh ? "已开启" : "enabled")
      : s.present
        ? (zh ? "已禁用（系统设置里关掉了）" : "disabled (turned off in system settings)")
        : (zh ? "未开启" : "not enabled");
    for (const l of c.autostart.status({ state, location: s.location, command: s.command, pref: pref ?? null })) console.log(l);
  }
} else if (cmd === "ingest") {
  // 客户端会话采集（V8）：应采尽采。
  // 为什么要有这个命令：MCP 拿不到对话流，靠 AI 每轮上报实测不可靠；
  // 而各家客户端本来就把完整会话落在本机盘上，引擎自己去读才是完整性的唯一保证。
  const { collectClientSessions, ingestStatus, layerBalance, probeSources, ALL_SOURCES } = await import("./ingest");
  let store: PersonalStore;
  try {
    store = PersonalStore.open();
  } catch (e) {
    // 这里以前直接裸抛：用户升级后撞上写锁抢占，看到的只有 `SQLiteError: database is locked`
    // 加一段 Bun 内部堆栈（2026-11-11 官网反馈原文）。加锁重试已在 initSchemaV2 内做，
    // 走到这里说明锁被占了整整几轮 —— 只能明确告诉他要先停掉谁。
    if (e instanceof SchemaBusyError) {
      for (const l of dict().cmd.ingest.busy(e.message)) console.error(l);
      process.exit(3);
    }
    if (e instanceof DbCorruptError) {
      for (const l of dict().cmd.ingest.corrupt(e.message)) console.error(l);
      process.exit(4);
    }
    throw e;
  }

  // `xbb ingest on|off`：与页面上的「不要自动整理」写同一份落盘开关。
  // 常驻服务每轮开跑前都会重读它（见 ingest-job.ts 的 tick），所以这里关掉后最迟下一轮生效。
  const toggle = args[1];
  if (toggle === "on" || toggle === "off") {
    const { writeIngestEnabled } = await import("./ingest-job");
    writeIngestEnabled(toggle === "on");
    console.log(dict().cmd.ingest.toggled(toggle === "on"));
    process.exit(0);
  }

  if (args.includes("--status")) {
    const c = dict().cmd.ingest;
    const probe = probeSources();
    const st = ingestStatus(store.db);
    // 列宽统一：数字列与语言无关，所以两种语言共用同一套宽度；文字列左对齐、数字列右对齐。
    // 手敲空格在这里必然失败 —— `最近新增` 是 8 列、`Sessions` 也是 8 列，但一个占 4 个字符。
    const W = [12, 6, 8, 8, 8, 6, 18];
    const RCOL = new Set([2, 3, 4, 5]);
    const cell = (s: string, i: number) => {
      const gap = Math.max(0, W[i]! - displayWidth(s));
      return RCOL.has(i) ? " ".repeat(gap) + s : s + " ".repeat(gap);
    };
    const row = (cells: string[]) => cells.map((s, i) => (i === 7 ? s : cell(s, i))).join(" ");
    console.log(row(c.statusCols));
    for (const p of probe) {
      const s = st.find((x) => x.source === p.source);
      const audio = p.available ? "✅" : "❌";
      const rate =
        s?.parseRate == null ? "  -  " : `${String(Math.round(s.parseRate * 100)).padStart(3)}%${s.parseRate < 0.8 ? "⚠" : " "}`;
      // 库里的 note 是**上一轮采集时**写下的字符串，语言跟着那一轮走。英文界面里若翻出中文，
      // 说明那条是历史记录 —— 此时改用本次探测的 note（现算、必然跟随当前语言）。
      // 不改成「note 存结构化」是因为那要动 schema，而这句话的价值只是解释「最近新增 0」。
      const stored = s?.note ?? p.note;
      const base = currentLang() === "zh" || !/[一-龥]/.test(stored) ? stored : p.note;
      const note = s?.unparsed ? `${base}${c.unparsed(s.unparsed, s.totalLines)}` : base;
      console.log(
        row([
          p.label,
          audio,
          String(s?.episodes ?? 0),
          String(s?.sessions ?? 0),
          String(s?.lastNew ?? 0),
          rate,
          s?.lastRun ?? "-",
          note,
        ]),
      );
    }
    const total = store.db.query("SELECT count(*) c FROM episodes").get() as { c: number };
    console.log(c.statusTotal(total.c));

    const lb = layerBalance(store.db);
    if (lb.level === "idle") {
      console.log(c.balanceIdle);
    } else {
      const ratio = `1:${Math.round(lb.perMemory ?? 0)}`;
      const tag =
        lb.level === "healthy" ? c.balanceTags.healthy : lb.level === "watch" ? c.balanceTags.watch : c.balanceTags.flooding;
      console.log(c.balance(lb.memories, lb.episodes, ratio, tag));
      if (lb.level !== "healthy") for (const l of c.balanceAdvice) console.log(l);
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
    console.error(dict().cmd.ingest.unknownSource(unknown.join(", "), ALL_SOURCES.join(" / ")));
    process.exit(1);
  }

  const t0 = Date.now();
  const r = collectClientSessions(store.db, {
    sources: sources as never,
    maxTurns: limitArg ? Number(limitArg.slice("--limit=".length)) : undefined,
    dryRun,
  });

  const c = dict().cmd.ingest;
  const W = [12, 6, 8, 8, 8, 6, 8];
  const RCOL = new Set([2, 3, 4, 5, 6]);
  const cell = (s: string, i: number) => {
    const gap = Math.max(0, W[i]! - displayWidth(s));
    return RCOL.has(i) ? " ".repeat(gap) + s : s + " ".repeat(gap);
  };
  console.log(c.runTitle(dryRun));
  console.log(c.runCols.map((s, i) => (i === 7 ? s : cell(s, i))).join(" "));
  for (const x of r.results) {
    const rate = x.suspects
      ? `${String(Math.round(((x.suspects - x.unparsed) / x.suspects) * 100)).padStart(3)}%${x.suspects && x.unparsed / x.suspects > 0.2 ? "⚠" : " "}`
      : "  -  ";
    const cells = [
      x.label,
      x.available ? "✅" : "❌",
      String(x.scanned),
      String(x.inserted),
      String(x.skipped),
      rate,
      x.ms + "ms",
      x.note,
    ];
    console.log(cells.map((s, i) => (i === 7 ? s : cell(s, i))).join(" "));
  }
  const drifted = r.results.filter((x) => x.fingerprintChanged);
  if (drifted.length) {
    console.log(c.driftTitle);
    for (const x of drifted) console.log(c.driftLine(x.label, x.fingerprint, x.unparsed, x.suspects));
    console.log(c.driftAdvice);
  }
  const total = store.db.query("SELECT count(*) c FROM episodes").get() as { c: number };
  console.log(c.runSummary(r.scanned, r.inserted, Date.now() - t0, total.c, dryRun));
  if (!dryRun) {
    const after = ingestStatus(store.db).filter((s) => s.episodes > 0);
    if (after.length) {
      console.log(c.cumulative(after.map((s) => `${s.source} ${s.episodes}`).join(" / ")));
    }
  }
} else if (cmd === "stats") {
  // 只看数、不动库：**只读打开**，不建库、不迁移、不起服务、不联网。
  // 文档的「用量查看」整页都在教用户敲这一条，所以它必须真的存在，且输出要能直接读。
  // 读不到的数一律说「读不到」，绝不显示 0 —— 0 是「一条都没用过」这个结论，不是「不知道」。
  const { readUsageCounts } = await import("./home");
  const { defaultDbPath } = await import("./store");
  const { existsSync, statSync } = await import("node:fs");
  const d = dict();
  const p = defaultDbPath();
  if (!existsSync(p)) {
    // 缺库时**不在这里补一个空库** —— 与开库判定闸同一口径：唯一建库入口是 home init --force。
    console.error(d.missingDb.notFound(p));
    console.error(d.missingDb.noAutoCreate);
    console.error(d.missingDb.howToFind);
    process.exit(2);
  }
  const u = readUsageCounts(p);
  const st = statSync(p);
  const L = d.stats.labels;
  // 列宽**现算**，不硬编码：中文标签占 6 列、英文占 8~11 列，同一套空格不可能同时对齐
  // （改造前那 8 列是人数格子数出来的，换个语言必然错位 —— 见 i18n/width.ts 顶部）
  const w = columnWidth([L.file, L.memories, L.recalled, L.links, L.transcripts]);
  const row = (label: string, value: string) => console.log(`${padTo(label, w)}  ${value}`);
  row(L.file, p);
  console.log(`${" ".repeat(w + 2)}${d.stats.meta((st.size / 1048576).toFixed(1), formatTime(st.mtimeMs))}`);
  console.log();
  row(L.memories, d.stats.memories(formatNumber(u.memories)));
  row(L.recalled, d.stats.recalled(formatNumber(u.used), formatNumber(u.hits)));
  row(L.links, d.stats.links(formatNumber(u.links)));
  row(L.transcripts, d.stats.transcripts(formatNumber(u.episodes), formatNumber(u.sessions)));
  console.log();
  console.log(d.stats.adminHint("http://127.0.0.1:17630/ui"));
} else if (cmd === "lang") {
  // 界面语言：查看 / 切换。**只写本机配置文件，不联网、不改库**。
  // 判定链见 i18n/index.ts —— XBB_LANG > config.json > 系统 locale > zh。
  const d = dict();
  const arg = args[1];
  if (!arg) {
    const r = resolveLang();
    // 三行按列宽对齐：中英标签宽度不同（当前语言 4 列 / Current 7 列），
    // 和 stats 同一个理由 —— 空格不能数，要算。
    const kw = columnWidth([d.langCmd.current, d.langCmd.choices, d.langCmd.switchHint]);
    const other = LANGS.find((l) => l !== r.lang) ?? "en";
    console.log(`${padTo(d.langCmd.current, kw)}  ${r.lang}  (${d.langNames[r.lang]})`);
    console.log(`${padTo(d.langCmd.choices, kw)}  ${LANGS.join(" / ")}`);
    console.log(`${padTo(d.langCmd.switchHint, kw)}  xbb lang ${other}`);
    console.log();
    console.log(d.langCmd.storedAt(homeConfigPath()));
    // 环境变量压着配置时必须说出来：否则用户敲完 `xbb lang en` 发现没变化，会怀疑命令坏了
    const envRaw = process.env.XBB_LANG?.trim();
    if (r.source === "env" && envRaw) console.log(d.langCmd.envActive(envRaw));
    else console.log(d.langCmd.envOverride);
  } else {
    const target = normalizeLang(arg);
    if (!target) {
      console.error(d.langCmd.unknown(arg));
      process.exit(2);
    }
    try {
      writeHomeConfig({ lang: target }, "cli.lang");
    } catch (e) {
      // 配置损坏且连备份都做不成时，home.ts 会**拒绝写入**（绝不拿原内容冒险）。
      // 它给出的 message 已经是完整人话；再叠一层 Bun 堆栈，用户只会以为程序坏了。
      if (e instanceof ConfigCorruptError) {
        console.error(e.message);
        process.exit(1);
      }
      throw e;
    }
    const envRaw = process.env.XBB_LANG?.trim();    // 写下去了，但环境变量会盖过它 —— 这是"看起来没生效"的唯一成因，必须直说
    if (envRaw && normalizeLang(envRaw) !== target) console.log(d.langCmd.switchedButEnvWins(target, envRaw));
    else console.log(d.langCmd.switched(target));
  }
} else if (cmd === "version" || cmd === "--version" || cmd === "-v") {
  // 版本横幅 + 构建指纹（版本核对用）
  const { banner } = await import("./build-meta");
  console.log(banner(dict().banner));
  // 附一行接入状态：`npx xiaobenben --version` 往往是用户装完之后唯一会敲的命令，
  // 而「引擎装好了」和「已经接进某个客户端」是两件事 —— 不在这里说，用户就无从得知。
  // 纯本地文件探测，不发网络请求，不拖慢版本查询。
  const { probeClients, connectSummary } = await import("./connect");
  // 跳过进程枚举：`--version` 是脚本高频调用的命令，不该为一行摘要去扫全表进程
  // （Windows 一次 CIM 查询约 0.5s）。进程判据留给 `xbb connect`。
  console.log(connectSummary(probeClients({ skipProcess: true })));
} else if (cmd === "connect") {
  // 「我到底把它装进哪个 AI 客户端了？」—— 只读探测，改动配置的事不在这里做
  const { probeClients, recommendedEntry, renderConnect, toJson } = await import("./connect");
  const { listProcesses, resolveHosts } = await import("./connect-proc");
  // 进程表只枚举一次，两个用途共用：probeClients 拿它认宿主，renderConnect 拿它报
  // 「认不出是谁」的那几个。枚举一次约 0.5s（Windows CIM 全表），不值得做两遍。
  const procs = listProcesses();
  const statuses = probeClients({ procs });
  const entry = recommendedEntry();
  console.log(
    args.includes("--json") ? toJson(statuses, entry) : renderConnect(statuses, entry, resolveHosts(procs)),
  );
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
  const c = dict().cmd.updateStatus;
  const bl = readBlocklist();
  console.log(c.source(resolveUpdateUrl() || c.noSource));
  console.log(c.form(isCompiledExe() ? c.formExe : c.formDev));
  console.log(c.dir(updateRoot()));
  // ⚠️ 这句以前是写死的「有 —— 下次启动将回退上一版本」，**与实现不符**（2026-10-16 实测踩到）：
  //    pending 标记在「刚 swap 完、还没被 serve 确认」时也长这样（version=新版, attempts=0），
  //    而那种情况下的判定是 **adopt（放行首次引导）**，不是回退。照旧文案会把排障的人吓到
  //    （以为更新要丢），甚至去手动删 exe。唯一真源是 decideBootAction 的三态判定。
  if (!existsSync(pendingPath())) {
    console.log(c.pendingNone);
  } else {
    const pend = readPendingMarker();
    const decision = decideBootAction(pend, CURRENT_VERSION);
    console.log(
      decision === "adopt" ? c.pendingAdopt(pend?.version ?? "?") : c.pendingRollback(pend?.version ?? "?"),
    );
  }
  console.log(
    c.blocklist(bl.length ? bl.map((e) => `${e.version}(${e.reason ?? "-"})`).join(", ") : c.blocklistEmpty),
  );
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
    const c = dict().cmd.home;
    const { dir, source } = H.resolveDataDirWithSource();
    const p = H.dbPresence();
    const srcLabel =
      source === "env" ? c.srcEnv : source === "config" ? c.srcConfig(H.homeConfigPath()) : c.srcDefault;
    console.log(c.progDir(H.programDir()));
    console.log(c.dataDir(dir));
    console.log(c.srcLabel(srcLabel));
    if (p.exists) {
      let extra = "";
      try {
        const n = H.readDbCounts(p.dbPath);
        extra = c.dbCounts(n.memories, n.episodes, n.events, n.integrity);
        // 库比程序新 = 曾经用过更高版本（回滚 / 另一台机器）后拿旧程序开库。
        // 程序不拒开也不改结构，但这件事必须能在这里看见 —— 否则「为什么某个新字段读不到」
        // 只能靠翻 stderr，而 MCP 模式下的 stderr 用户根本看不到。
        if (n.schema > SCHEMA_TARGET_VERSION) extra += c.dbNewer(n.schema, SCHEMA_TARGET_VERSION);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        extra = c.dbOpenFailed(msg);
        // 这是用户发现"库坏了"时最可能来的地方，不能只甩一句 file is not a database
        if (/not a database|malformed/i.test(msg)) extra += c.dbCorruptHint;
      }
      const when = (p.mtime ?? "").slice(0, 16).replace("T", " ");
      console.log(c.dbPath(p.dbPath));
      // 第二行带 extra 的多行结构（库比程序新 / 打不开），所以直接拼
      console.log(`          ${mb(p.sizeBytes)}${c.lastWritten(when)}${extra}`);
    } else {
      console.log(c.dbPath(p.dbPath));
      console.log(c.dbMissing);
      if (existsSync(join(H.programDir(), "memory.db")) && source !== "default") {
        console.log(c.dbElsewhere(join(H.programDir(), "memory.db")));
      }
    }
    const modelPath = H.modelsDir();
    console.log(
      c.models(modelPath, existsSync(modelPath) ? mb(H.dirUsage(modelPath)) : c.modelsNotDownloaded),
    );
    console.log(c.configFile(H.homeConfigPath()) + (existsSync(H.homeConfigPath()) ? "" : c.configAbsent));
    const cfg = H.readHomeConfig();
    if (cfg) console.log(`          ${JSON.stringify(cfg)}`);
    process.exit(p.exists ? 0 : 1);
  }

  if (sub === "set") {
    const c = dict().cmd.home;
    // 「设置」不是「搬迁」。设一个空目录等于把自己送进下一次启动的报错里，所以默认拒绝。
    const target = args[2];
    if (!target) {
      for (const l of c.setUsage) console.error(l);
      process.exit(1);
    }
    const abs = await import("node:path").then((m) => m.resolve(target));
    const dbFile = join(abs, "memory.db");
    if (!existsSync(dbFile) && !args.includes("--force")) {
      for (const l of c.setNoDb(abs)) console.error(l);
      process.exit(1);
    }
    // 源目录必须在写配置**之前**取：写完配置 resolveDataDir() 就指向新位置了
    const prevDataDir = H.resolveDataDir();
    H.writeHomeConfig({ dataDir: abs }, "xbb home set");
    console.log(c.setOk(abs));
    console.log(existsSync(dbFile) ? c.setDbReady(dbFile) : c.setDbMissing);
    // 模型不会自己跟过去。缺模型的后果是**静默降级为关键词检索**——用户只会觉得
    // 「好像变笨了」，永远不会想到是换了目录。所以换目录时顺手带过去（约 24MB）。
    const m = H.copyModelsInto(abs, prevDataDir);
    if (m.copied) {
      console.log(c.setModelsCopied(m.from ?? "", join(abs, "models"), `${(m.bytes! / 1048576).toFixed(1)} MB`));
    } else if (!existsSync(join(abs, "models"))) {
      for (const l of c.setNoModels) console.log(l);
    }
    for (const l of c.setRestart) console.log(l);
    process.exit(0);
  }

  if (sub === "move") {
    const c = dict().cmd.home;
    const target = args[2];
    if (!target) {
      for (const l of c.moveUsage) console.error(l);
      process.exit(1);
    }
    try {
      console.log(c.moving);
      const r = H.moveDataDir(target, { cleanup: args.includes("--cleanup"), force: args.includes("--force") });
      console.log(c.moveOk(r.from, r.to));
      console.log(c.moveEntries(r.entries.join(" / "), mb(r.bytes)));
      console.log(c.moveVerify(r.verify?.integrity ?? "?", r.verify?.memories ?? 0, r.verify?.episodes ?? 0, r.verify?.events ?? 0));
      console.log(c.moveConfig(r.configPath));
      console.log("");
      console.log(c.moveRestart);
      if (!args.includes("--cleanup")) console.log(c.moveKeepOld(r.from));
    } catch (e) {
      console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (sub === "find") {
    // 忘了当初放哪时唯一的救命绳。按记忆条数排序 —— 同名空库到处都是，条数才能分出哪个是真的。
    const c = dict().cmd.home;
    const deep = args.includes("--deep");
    console.log(deep ? c.findDeepScanning : c.findScanning);
    const found = H.findDatabases({ deep });
    if (!found.length) {
      console.log(c.findNone);
      process.exit(1);
    }
    const cur = H.resolveDbPath().toLowerCase();
    console.log("");
    console.log(c.findCols);
    for (const f of found) {
      const mark = f.path.toLowerCase() === cur ? c.findCurrent : "";
      console.log(
        `${String(f.memories ?? "?").padStart(6)}  ${mb(f.bytes).padStart(9)}  ${f.mtime.slice(0, 16).replace("T", " ")}  ${f.path}${mark}`,
      );
    }
    console.log(c.findTotal(found.length));
    process.exit(0);
  }

  if (sub === "init") {
    const c = dict().cmd.home;
    // 唯一允许"在配置位置新建空库"的入口 —— 而它必须带 --force。
    if (!args.includes("--force")) {
      const p = H.dbPresence();
      for (const l of c.initRefused(p.dbPath, p.exists)) console.error(l);
      process.exit(1);
    }
    const store = PersonalStore.open(undefined, { force: true });
    const p = H.dbPresence();
    store.db.close();
    for (const l of c.initOk(p.dbPath)) console.log(l);
    process.exit(0);
  }

  if (sub === "reset") {
    const c = dict().cmd.home;
    // 撤掉指向，回到默认位置（老库通常就在那儿）
    H.clearDataDir("xbb home reset");
    const p = H.dbPresence();
    for (const l of c.resetOk(p.dbPath, p.exists)) console.log(l);
    process.exit(p.exists ? 0 : 1);
  }

  console.error(dict().cmd.home.unknownSub(sub));
  process.exit(1);
} else if (cmd === "stop") {
  // 没有这条命令时，`serve --detach` 在托盘没开的情况下只能去任务管理器里杀（2026-11-04 用户反馈）。
  const H = await import("./home");
  const c = dict().cmd.stop;
  const keepMcp = args.includes("--keep-mcp");
  const procs = H.runningProcs();
  if (!procs.length) {
    console.log(c.none);
    process.exit(0);
  }
  // 分隔符跟着语言走：中文用「、」，英文用 ", "
  const sep = currentLang() === "zh" ? "、" : ", ";
  console.log(c.found(procs.map((p) => `PID ${p.pid} ${p.name}`).join(sep), procs.length));
  const r = H.stopAll({ keepMcp });
  for (const p of r.stopped) console.log(c.stopped(p.pid, p.name));
  for (const p of r.kept) {
    const why = !p.cmd ? c.keptWhyNoCmd : H.isMcpCommand(p.cmd) ? c.keptWhyMcpBusy : c.keptWhyMcp;
    console.log(c.kept(p.pid, p.name, why));
  }
  for (const f of r.failed) console.log(c.failed(f.pid, f.name, f.err));
  if (r.failed.length) console.log(c.failedHint);
  if (r.undecidable.length) for (const l of c.undecidable(r.undecidable.length)) console.log(l);

  // 这两段不能省。不说清楚，用户会以为 stop 坏了，然后反复执行、反复看到进程回来。
  if (r.kept.some((p) => p.cmd)) for (const l of c.keptMcp) console.log(l);
  if (r.stopped.length) for (const l of c.stoppedHint) console.log(l);
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
  const P = dict().cmd.plain;
  const cloudLine = !craw
    ? P.cloudLocalOnly
    : clive
      ? P.cloudLive(cLabel, craw.apiBase)
      : P.cloudOff(cLabel);

  if (cmd !== "help") {
    console.error(P.unknownCommand(cmd));
    console.error("");
    console.error(overviewHelp());
    process.exit(1);
  }

  /**
   * 裸调用（真的一个参数都没有）＝ 多半有人双击了图标。
   *
   * 这里做的不是"打印帮助"，而是**让这次双击有个结果**：服务没跑就拉起来，
   * 拉起来了就弹一条通知。`xbb help` 与 `xbb --help` 仍然是纯打印、零副作用 ——
   * 想安静地看命令清单，那条路一直都在。
   *
   * 已知代价：终端里敲 `xbb` 也会顺手确保服务在跑（会等最多 20 秒）。
   * 这是有意的取舍 —— 双击与终端无法区分，而"双击后什么都没发生"的伤害更大。
   */
  if (args.length === 0) {
    const { ensureServeRunning, SERVE_PORT } = await import("./autostart");
    const { showToast } = await import("./notify");
    const r = await ensureServeRunning();
    if (!r.healthy) {
      // 不健康时说"已启动"就是撒谎 —— 用户会去找一个永远不会出现的图标。
      console.log(P.serveNotReady(r.portBusy ? P.portBusy(SERVE_PORT) : P.seeLog));
    } else {
      // 只在**真的把服务拉起来**（或确认它在跑）之后才通知。
      // 已在运行时也发：双击图标的人要的正是"它在不在"这个回答，静默等于没反应。
      ensureToastAppId();
      showToast({
        title: r.already ? P.toastAlreadyTitle : P.toastStartedTitle,
        body: P.toastBody,
        url: `http://127.0.0.1:${SERVE_PORT}/ui`,
      });
      console.log(r.already ? P.serveRunning(SERVE_PORT) : P.serveStarted(r.waitedMs));
    }
    console.log("");
  }
  console.log(cloudLine);
  console.log("");
  console.log(overviewHelp());
}
