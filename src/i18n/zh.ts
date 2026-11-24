// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 中文文案 —— **产品默认语言，也是所有既有输出的逐字节基准**。
 *
 * 铁律：这里的字符串必须与改造前散落在 `index.ts` / `connect.ts` 里的字面量完全一致。
 * 既有的 366 个测试大量用 `toContain` 断言中文措辞，它们是这次重构唯一的回归网 ——
 * 只要中文一字不改，测试全绿就能证明"只是把字搬了个家，没有改行为"。
 */
import type { Dict } from "./types";
import { helpZh } from "./help/zh";
import { adminZh } from "./admin/zh";

export const zh: Dict = {
  langNames: { zh: "中文", en: "English" },

  help: helpZh,

  admin: adminZh,

  org: { personalSpace: "个人空间" },

  shortcut: { description: "小本本 · 面向 AI 的个人记忆库" },

  banner: { built: "构建", fingerprint: "指纹", site: "官方站点" },

  langCmd: {
    current: "当前语言",
    choices: "可选",
    switchHint: "切换",
    storedAt: (path) => `语言偏好记在 ${path}（跟着程序目录走，换库不影响）`,
    envOverride: "环境变量 XBB_LANG 优先级最高，会盖过这个设置",
    envActive: (value) => `⚠️ 环境变量 XBB_LANG=${value} 正在生效，它的优先级高于这里的设置`,
    switched: (tag) => `已切换到 ${tag}：下一条命令起生效（已开着的管理窗口需重启）`,
    switchedButEnvWins: (tag, env) =>
      `已把 ${tag} 记进配置文件，但环境变量 XBB_LANG=${env} 仍压着它 —— 当前实际生效的是 ${env}。要让它听配置的，先把这个环境变量去掉。`,
    unknown: (input) =>
      `认不出语言「${input}」。可选：zh（中文）/ en（English）。换个说法也行，比如 zh-CN、en-US —— 只取前面的语言码。`,
  },

  stats: {
    labels: {
      file: "库文件",
      memories: "记忆",
      recalled: "召回",
      links: "关联",
      transcripts: "原话",
    },
    meta: (sizeMb, when) => `${sizeMb} MB · 最后写入 ${when}`,
    memories: (n) => `${n} 条（含被取代 / 已遗忘的，它们只标记不删除）`,
    recalled: (used, hits) => `被用过 ${used} 条 · 累计 ${hits} 次`,
    links: (n) => `${n} 条边`,
    transcripts: (episodes, sessions) => `${episodes} 条 / ${sessions} 场（自动采集，永不上云）`,
    adminHint: (url) => `管理窗口 ${url}  有同一组数和趋势。`,
    unreadable: "读不到",
    search: {
      title: (days, n) => `检索健康（近 ${days} 天 ${n} 次）`,
      latency: (p50, p90, empty) => `耗时  中位 ${p50}ms · P90 ${p90}ms · 零命中 ${empty}`,
      vec: (rate, share, f) => `语义  参与 ${rate} · 仅它捞到 ${share} · ${f}`,
      failures: (n) => `故障 ${n} 次`,
      chan: (parts) => `通道  ${parts}`,
      labels: { fts: "全文", inv: "倒排", ent: "实体", ng: "拆词" },
      none: "检索健康  还没有检索记录（用起来之后这里会有数）",
    },
  },

  doctor: {
    title: (path) => `记忆库  ${path}`,
    meta: (sizeMb, alive, all) => `${sizeMb} MB · ${alive} 条有效（共 ${all} 条，含被取代与已遗忘）`,
    secChannel: "检索零件",
    secIntegrity: "结构一致性",
    secFixable: "可补（xbb doctor --fix）",
    secMissing: "补不了（需要 AI 或你自己判断）",
    secSplit: "实体分裂",
    secNext: "下一步",
    labels: {
      inv: "倒排",
      ent: "实体",
      vec: "语义",
      fts: "全文",
      orphan: "孤儿索引",
      dangling: "悬空链头",
      cycles: "成环",
      dupHash: "重复内容",
      tagTerms: "标签词项",
      entityTerms: "实体词项",
      entityRows: "实体挂边",
      blankTerms: "空白词项",
      type: "类型缺失",
      entities: "实体缺失",
      occurredAt: "事件时间",
    },
    gap: (n) => `缺 ${n} 条`,
    count: (n) => `${n} 条`,
    groups: (n) => `${n} 组`,
    ftsOk: "索引一致",
    ftsBroken: "索引不一致 —— 重建即可，库本身没坏",
    ftsUnchecked: "未校验（当前没有写权限）",
    whyType: "按类型筛选时会被漏掉",
    whyEntities: "实体通道对它们完全失明",
    whyOccurred: "时间闸回落到写入时间，只是精度差一点",
    splitLine: (n) => `${n}：同一个名字被拆成多个实体，召回被切成两半`,
    nextFix: "xbb doctor --fix             补齐上面「可补」的几项（只重建索引，不改正文）",
    nextDry: "xbb doctor --fix --dry-run   先看会改什么，不动库",
    nextManual: "「补不了」那几项需要 AI 或你自己判断；新写入的记忆会自动带上这些零件。",
    clean: "检索零件齐全、索引一致，没发现问题。",
    fixedTitle: "已修复",
    dryRunNote: "下面只是预计改动（--dry-run，库没有被写入）",
    fixedLine: (label, n) => `${label}  ${n}`,
    fixedNone: "没有需要修的 —— 上面「可补」已经是 0。",
    readonlyHint: "库当前不可写（只读文件或权限不足），--fix 无法执行。",
  },

  missingDb: {
    notFound: (path) => `\n❌ 找不到记忆库：${path}\n`,
    noAutoCreate: "小本本不会在空目录里自动建库：空库比没有库更容易让人误以为「记忆丢了」。",
    howToFind: "查它在哪：xbb home     扫盘找现成的库：xbb home find",
  },

  config: {
    corruptSaved: (path, backup) =>
      `\n⚠️  配置文件读不懂（JSON 解析失败）：${path}\n    原文件已留存到：${backup}\n`,
    corruptWhat:
      "新配置已重新写入。如果原来在里面指定过库位置，用 xbb home set \"<目录>\" 重新指一次；\n然后 xbb home 确认它指向的是哪个库。",
    corruptCantBackup: (path, reason) =>
      `\n❌ 配置文件读不懂（${reason}），而备份也没做成：${path}\n   为了不把原内容冲掉，这次没有写入任何东西。\n   把那行手改的 JSON 修好、或先把这个文件挪走，然后再试。\n`,
  },

  connect: {
    noneAtAll: "接入: 未检测到本机 AI 客户端 · 运行 xbb connect 查看详情",
    noneConfigured: (total, tail) => `接入: 未检测到（${total} 个客户端${tail}）· 运行 xbb connect 查看`,
    allBroken: (total, broken, tail) =>
      `接入: 0/${total}（${broken} 个配置存在但连不上）${tail} · 运行 xbb connect 查看`,
    connected: (names, n, total, tail, warn) =>
      `接入: ${names}（${n}/${total}）${tail}${warn} · 运行 xbb connect 查看全部`,
    tailInUse: (n) => ` · 另 ${n} 个正在使用`,
    warnBroken: (n) => ` · ${n} 个配置异常`,

    title: "小本本 · AI 客户端接入状态",
    cols: { client: "客户端", installed: "已安装", status: "接入", engine: "引擎" },
    cell: { yes: "是", no: "否", dash: "—" },
    status: { ok: "是", broken: "异常", inUse: "使用中", notDetected: "未检测到" },
    engine: { npx: "npx 包", desktop: "桌面版", pkg: "npm 缓存二进制", other: "其他" },
    badJson: (detail) => `配置不是合法 JSON（${detail}）`,
    notObject: "配置顶层不是对象",
    exeMissing: (path) => `配置指向的可执行文件已不存在：${path}`,
    summary: (parts) => "  " + parts.join("，") + "。",
    summaryFound: (n) => `检测到 ${n} 个客户端`,
    summaryNone: "没有检测到本机安装任何 AI 客户端",
    summaryConnected: (n) => `${n} 个已接入`,
    summaryInUse: (n) => `${n} 个正在使用（配置未定位到）`,
    brokenTitle: "  ⚠ 配置有问题（客户端里看着有，实际连不上）：",
    brokenAt: (path) => `     配置：${path}`,
    inUseTitle: "  正在使用、但没在常见位置找到配置的：",
    inUseWho: (host) => `（宿主进程 ${host}）`,
    inUseLine: (label, who) => `     ${label}${who} —— 有 xbb mcp 子进程在跑，说明它已经能用了。`,
    inUseDontReconfigure: "     不要重新配置：这些客户端的配置可能放在项目目录或内部存储里。",
    pendingTitle: "  未检测到接入的客户端 —— 把下面这段放进它自己的配置文件：",
    pendingHead: (label, path) => `  ── ${label} ──  ${path}`,
    allReady: "  所有已安装的客户端都能用了，无需操作。",
    unknownTitle: "  另有 MCP 进程在跑，但认不出是哪个客户端拉起的：",
    unknownHosted: (host) => `挂在 ${host} 下`,
    unknownHostGone: "宿主已退出",
    unknownFromShell: "（像是在终端里手动跑的）",
    unknownLine: (pid, who, fromShell) => `     pid ${pid} · ${who}${fromShell}`,
    noteNotDetected: [
      "  说明：「未检测到」只代表本命令没在常见位置读到配置，不等于没接入。",
      "        部分客户端把配置存在项目目录或内部数据库里，这里读不到但照样能用。",
      "        确定自己在用的客户端，别照着上面的片段重配。",
    ],
    noteNpxY: [
      "  注意：npx 那一行必须带 -y。首次运行会问「Ok to proceed?」，",
      "        而 MCP 下没人能回答，表现是客户端一直连不上而不是报错。",
    ],
    noteRestart: "  改完配置要重启对应客户端才生效（它们只在启动时读一次）。",
    noteReadOnly: "  本命令只读配置与进程，不修改任何文件。",
  },

  dbGate: {
    missing: (d) => {
      const lines: string[] = [];
      lines.push(`记忆库不在预期位置：${d.dbPath}`);
      if (d.kind === "default-missing-but-installed") {
        lines.push("   这里是默认安装目录，而且**程序痕迹都在**（bin / models / logs / cloud.json 之类）——");
        lines.push("   说明这套安装用过，不是首次运行。库应该是被移动、重命名或误删了。");
        lines.push("   所以这里拒绝启动：新建一个空库会让你以为记忆全丢了。");
      } else if (d.kind === "env-missing") {
        lines.push("   位置来自环境变量 XBB_DATA_DIR（临时覆盖，不写盘）");
      } else {
        lines.push(`   位置来自配置：${d.configPath}`);
      }
      if (d.kind === "configured-missing-but-legacy-exists") {
        lines.push("");
        lines.push(`⚠️ 但默认位置**有**库：${d.legacyDbPath}`);
        lines.push("   这不是首次运行 —— 库还在，只是新配置指向的地方没有它。");
        lines.push("   直接新建空库会让你以为记忆全丢了，所以这里拒绝启动。");
      } else if (d.kind === "configured-missing" || d.kind === "env-missing") {
        lines.push("");
        lines.push("可能原因：① 该盘未挂载/已拔出　② 库被移动、重命名或误删　③ 配置指向了错误路径");
      }
      lines.push("");
      lines.push("排查：xbb home show        看程序与库的实际位置、大小、最后写入时间");
      lines.push("      xbb home find        扫各盘找 memory.db（忘了当初放哪时用）");
      if (d.source === "env") {
        // env 的优先级高于配置文件：这时候 move/set 写进去也没用，说清楚免得白折腾一趟
        lines.push("      ↳ 位置来自环境变量，它**优先于配置文件** —— 撤掉或改正 XBB_DATA_DIR 才会生效");
      } else if (d.kind === "configured-missing-but-legacy-exists") {
        lines.push(`      xbb home move "${d.legacyDbPath.replace(/[\/][^\/]*$/, "")}"   把默认位置的库搬过去并校准配置`);
        lines.push(`      xbb home reset       撤掉配置，回到默认位置（${d.legacyDbPath}）`);
      } else if (d.kind === "default-missing-but-installed") {
        lines.push(`      xbb home set "<某个 memory.db 所在的目录>"   找到它之后指过去`);
      }
      lines.push(`确认要从零开始：xbb home init --force（会新建空库，且必须显式指定 --force）`);
      return lines.join("\n");
    },
    corrupt: (file, detail) =>
      [
        `小本本的记忆库打不开：这个文件已损坏（${detail}）。`,
        `   文件：${file}`,
        "   ⚠️ 先别删它 —— 原文件保持不动就还有抢救机会，覆盖或删除才是真的没了。",
        "   怎么处理：",
        "     ① 留证：把 memory.db 连同 memory.db-wal / -shm 一起复制一份到别处",
        "     ② 同目录若有历史备份，可以换上试：memory.db.bak-* / memory.db.gen1",
        "     ③ 确认要从零开始：先把它改名留存（memory.db → memory.db.corrupt），",
        "        再执行 xbb home init --force",
        "   排查：xbb home show        看库的位置、大小、最后写入时间",
      ].join("\n"),
    busy: (detail) =>
      [
        "另一个小本本进程正在写库，结构升级没能拿到写锁。",
        `  底层原因：${detail}`,
        "  怎么处理：把所有 xbb 进程停下，再重跑刚才的命令。最省事的是关掉正在使用小本本的",
        "            AI 客户端会话（每个会话各拉起一个进程），命令行里也可以：",
        "              xbb stop                  装过桌面版（PATH 里有 xbb）时用",
        "              npx -y xiaobenben stop    走 npx 接入、PATH 里没有 xbb 时用",
        "            升级完成后再启动 AI 客户端即可。库里的数据不会丢，升级是幂等的。",
      ].join("\n"),
    writeBusy: (detail) =>
      [
        "这次没能写进记忆库：另一个小本本进程正占着写锁，等了三次也没排上。",
        `  底层原因：${detail}`,
        "  数据没丢，这次的内容整条都没写进去（写入是原子的，不会只存半条）。",
        "  多数情况重试一次就好；反复出现说明有个进程卡住了，把正在用小本本的",
        "  AI 客户端会话关掉再试，或直接在命令行执行：",
        "    xbb stop                   装过桌面版（PATH 里有 xbb）时用",
        "    npx -y xiaobenben stop     走 npx 接入、PATH 里没有 xbb 时用",
      ].join("\n"),
  },

  cmd: {
    serveFail: {
      missing: (detail) => [
        "\n❌ 小本本未启动：记忆库不在预期位置\n",
        detail,
        "\n服务没有起来 —— 这是刻意的：宁可起不来，也不要在空库上继续用下去。\n",
      ],
      busy: (detail) => [
        "\n❌ 小本本未启动：数据库正在被别的进程写入\n",
        detail,
        "\n服务没有起来 —— 这是刻意的：结构没升级完就起服务，用户会以为升级已经生效。\n",
      ],
      corrupt: (detail) => [
        "\n❌ 小本本未启动：记忆库文件已损坏\n",
        detail,
        "\n服务没有起来 —— 这是刻意的：在坏库上继续写只会让抢救更难。\n",
      ],
    },

    bind: {
      usage: '用法: xbb bind "xubb://bind?ticket=…&api=…" 或 xbb bind <ticket>',
      ok: (f) => [
        "✅ 已绑定个人云端版",
        `   API:     ${f.api}`,
        `   组织:    ${f.org}（${f.orgId}）`,
        `   空间:    ${f.space ?? "（首次写入时自动解析）"}`,
        `   Key:     ${f.keyShort}…（明文只存本机 ${f.path}）`,
        "",
        "   " + "─".repeat(60),
        "   ⚠️  必须重启 AI 客户端才会生效",
        "       opencode / Cursor / WorkBuddy 等（或重新拉起 xbb mcp）",
        "",
        "       正在运行中的客户端仍以【本地模式】工作 —— 这期间新写入",
        "       的记忆会落在本地库，不会同步到你刚绑定的云端组织。",
        "       重启后新会话整体走云端（情景层 / 保险箱除外，只在本机）。",
        "   " + "─".repeat(60),
      ],
    },

    unbind: (had) =>
      !had
        ? ["本无云端绑定"]
        : [
            "已解除云端绑定（本地库不受影响）",
            "",
            "   " + "─".repeat(60),
            "   ⚠️  必须重启 AI 客户端才会生效",
            "       正在运行中的客户端仍以【云端模式】工作，记忆会继续写入",
            "       原组织。重启后新会话即回到纯本地模式。",
            "",
            "   💡 只是想暂时用本地模式？用 `xbb cloud off` —— 它保留密钥，",
            "      随时 `xbb cloud on` 切回去，不必回控制台重新生成绑定票。",
            "      上面这条 unbind 会把密钥从本机删掉，不可恢复。",
            "   " + "─".repeat(60),
          ],

    cloud: {
      noKey: [
        "❌ 本机还没有云端密钥，无法切到云端。",
        "   两条路：① 控制台「连接我的小本本」生成绑定票 → `xbb bind <票>`",
        "           ② 已有长期密钥 → `xbb bind-key <xbb_live_…>`，或在管理页 http://127.0.0.1:17630/ui 填写",
      ],
      switched: (toCloud) => [
        `✅ 已切换到${toCloud ? "云端" : "本地"}模式（密钥保留，未删除）`,
        "",
        "   ⚠️  需重启 AI 客户端（opencode / Cursor / WorkBuddy 等）才对新会话生效；",
        "       在那之前，正在跑的客户端仍按原模式读写。",
      ],
      nothingToSwitch: "本机没有云端配置，无需切换（已经是纯本地模式）",
      statusNone: ["模式:     本地（仅本机）—— 尚未绑定任何云端组织"],
      status: (f) => {
        const lines = [`模式:     ${f.cloud ? "云端" : "本地（已关云端，密钥保留）"}`];
        lines.push(`组织:     ${f.org}${f.orgId ? `（${f.orgId}）` : ""}`);
        lines.push(`API:      ${f.api}`);
        lines.push(`密钥:     ${f.keyShort}…（明文只在本机 ${f.path}）`);
        return lines;
      },
      unknownSub: (sub) => `未知子命令: ${sub}（可用: on / off / status）`,
      bindErr: {
        badLink: "xubb 链接格式无效",
        badTicket: "绑定票无效（应为 32-128 位 hex，60 秒单用，过期请回管理台重新生成）",
        bindFailed: (code, message) => `绑定失败 ${code}: ${message}`,
        keyEmpty: "密钥不能为空",
        unreachable: (api, message) => `连不上 ${api}（${message}）——请检查网络或 API 地址`,
        keyRejected: "密钥无效或已被撤销（服务端拒绝认证）",
        verifyFailed: (code, message) => `校验失败 ${code}：${message}`,
        readFailed: "响应不可读",
      },
      protocol: {
        devRun: (exe) =>
          `当前是 bun 开发运行（${exe}），无法注册为协议处理器。请传编译后的 exe 路径：xbb register-protocol "C:\\path\\to\\xbb.exe"`,
        unsupportedOs: (os) => `不支持的平台: ${os}`,
        failed: (message) => `注册失败: ${message}`,
        regFailed: (op, output) => `reg ${op} 失败: ${output}`,
        registeredWin: (exe) => `已注册 HKCU\\Software\\Classes\\xubb → "${exe}" bind "%1"（浏览器唤起立即生效，无需重启）`,
        lsregisterFailed: "lsregister 失败",
        registeredMac: (app) => `已注册 xubb:// → ${app}（若首次唤起无反应，请再点一次「连接我的小本本」）`,
        xdgFailed: "xdg-mime 失败（GNOME/KDE 之外的桌面可能需手动关联）",
        registeredLinux: (desktop) => `已注册 xubb:// → ${desktop}`,
      },
    },

    bindKey: {
      usage: [
        "",
        "用法: xbb bind-key <xbb_live_…> [apiBase]",
        "",
        "  与 `xbb bind <票>` 的区别：绑定票 60 秒单用、必须回控制台现生成；",
        "  这里要的是**你手上已有的长期密钥**——多机共用、或误删配置后的恢复场景。",
        "  apiBase 缺省 https://api.xiaobenben.net（自建部署时显式给）。",
      ],
      ok: (f) => {
        const lines = [
          "✅ 已绑定云端",
          `   API:     ${f.api}`,
          `   组织:    ${f.org}${f.orgId ? `（${f.orgId}）` : ""}`,
        ];
        if (f.member) lines.push(`   成员:    ${f.member}`);
        lines.push(`   空间:    ${f.space ?? "（首次写入时自动解析）"}`);
        lines.push(`   密钥:    ${f.keyShort}…（明文只存本机 ${f.path}）`);
        lines.push("");
        lines.push("   " + "─".repeat(60));
        lines.push("   ⚠️  必须重启 AI 客户端才会生效");
        lines.push("       opencode / Cursor / WorkBuddy 等（或重新拉起 xbb mcp）");
        lines.push("   " + "─".repeat(60));
        return lines;
      },
    },

    autostart: {
      onResult: (ok, message) => {
        const lines = [`${ok ? "✅" : "❌"} 开机自启${ok ? "已开启" : "开启失败"}\n   ${message}`];
        if (ok) {
          lines.push("");
          lines.push("   登录后：常驻服务在后台无声启动 —— 无控制台窗口，也不弹管理页");
          lines.push("   管理页随时可开：http://127.0.0.1:17630/ui（或点托盘「打开管理窗口」）");
          lines.push("   ⚠️ 登录瞬间启动器会闪一下（约 0.2s）—— 真正的服务全程无窗口");
          lines.push("   想立刻体验：xbb serve --detach");
        }
        return lines;
      },
      offResult: (ok, message) => {
        const lines = [`${ok ? "✅" : "❌"} ${message}`];
        if (ok) lines.push("   之后不会再自动开启（xbb autostart on 可恢复）");
        return lines;
      },
      unknownSub: (sub) => `未知子命令: ${sub}（可用: on / off / status）`,
      status: (f) => {
        const lines = [`开机自启: ${f.state}（${f.location}）`];
        if (f.command) lines.push(`  命令: ${f.command}`);
        // 意图与现状不一致是排障时最容易卡住的一类：用户以为关了，系统里还留着。
        if (f.pref === "off") lines.push("  用户意图: 已关闭（serve 不再自动写入）");
        else if (f.pref === "on") lines.push("  用户意图: 已开启");
        else lines.push("  用户意图: 默认开启（没手动关过；启动项缺失或指向变了会自动补）");
        return lines;
      },
      msg: {
        winOnly: (op, platform) =>
          `${op === "write" ? "writeAutostartEntry" : "removeAutostartEntry"} 只用于 Windows 注册表（当前 ${platform}）`,
        writeFailed: (code, out) => `写入失败（reg 退出码 ${code}）：${out}`,
        readbackMismatch: (expected, actual) => `回读不一致 —— 期望 ${expected}，实际 ${actual ?? "（无）"}`,
        absentValue: (valueName) => `本就没有「${valueName}」，无需处理`,
        deleteFailed: (code, out) => `删除失败（reg 退出码 ${code}）：${out}`,
        stillPresentPolicy: "删除后回读仍存在（可能被组策略重新写回）",
        removedValue: (valueName, before) => `已移除「${valueName}」（原值 ${before}）`,
        fileWriteFailed: (msg) => `写入失败：${msg}`,
        fileDeleteFailed: (msg) => `删除失败：${msg}`,
        stillPresentFile: "删除后文件仍存在（权限不足？）",
        absentFile: (path) => `本就没有 ${path}，无需处理`,
        removedFile: (path) => `已移除 ${path}`,
        fileWithCommand: (path, command) => `${path}\n   命令: ${command}`,
        bootstrapPending: (out) => `\n   （launchctl bootstrap 未即时生效，文件已就位，下次登录生效：${out}）`,
        bootoutNonZero: (out) => `\n   （launchctl bootout 非零退码，可能本就未加载：${out}）`,
        launchdHosted: (exe) => `${exe} serve --no-open（launchd 托管）`,
        launchdLocation: (path, label) => `${path}（launchd · ${label}）`,
        xdgLocation: (path) => `${path}（XDG 自启项）`,
        noMechanism: (platform) => `${platform} 无已知自启机制`,
        notCompiled: (exe) => `拒绝写入：当前不是编译产物（${exe}）。请用安装后的 xbb 执行本命令。`,
        winNeedsExe: (exe) => `拒绝写入：Windows 启动项必须指向 .exe（当前 ${exe}）`,
        unsupported: (platform) =>
          `${platform} 暂不支持自动配置开机自启（已落地 Windows / macOS / Linux）。\n` +
          "  其它平台：用系统自带的服务管理器指向 `xbb serve --no-open`。",
      },
    },

    ingestNote: {
      notFoundDb: (name) => `未找到 ${name}`,
      notFoundPath: (path) => `未找到 ${path}`,
      sessionFiles: (n) => `${n} 个会话文件`,
      rolloutFiles: (n) => `${n} 个 rollout 文件`,
      composerParsed: (parsed, total) => `解析 ${parsed} 条会话（${total} 条总量）`,
      composerUnchanged: (n) => `${n} 条会话均无变化`,
      incrementalFiles: (n) => `读取 ${n} 个文件的增量`,
      noNew: "无新增内容",
      failed: (msg) => `失败: ${msg}`,
      stalled: (hours) => `⚠ v2 最新数据比游标新 ${hours} 小时，本轮零产出 —— 解析规则可能已失效`,
      v2Pending: (n) => `v2 水位内 ${n} 条待定`,
      maxTurns: "达单轮上限，余下轮继续",
      schemaTwice: "⚠ 之前能读到 session_message，现在读不到了 —— 上游表结构又变了一次",
    },

    ingest: {
      busy: (detail) => [`\n❌ 采集没能开始：${detail}\n`],
      corrupt: (detail) => [`\n❌ 采集没能开始：记忆库文件已损坏\n`, detail],
      toggled: (on) =>
        on
          ? "已打开自动采集：常驻服务 30 秒内开始读本机会话"
          : "已关闭自动采集：30 秒内停手，不再读取本机会话原文；已入库的原话保留，可用 xbb ingest --status 查看",
      statusCols: ["源", "可用", "已入档", "会话", "最近新增", "解析率", "最近运行", "说明"],
      statusTotal: (n) => `\nepisodes 总计 ${n} 条（本机冷存档，永不上云）`,
      balanceIdle: "分层配比：原话层还是空的（未采集），比值无意义",
      balance: (memories, episodes, ratio, tag) =>
        `分层配比：摘要 ${memories} : 原话 ${episodes} ≈ ${ratio}  ${tag}`,
      balanceTags: { healthy: "✅ 健康", watch: "⚠ 观察", flooding: "⚠ 摘要层可能在灌水" },
      balanceAdvice: [
        "  正常应 ≥1:50（原话是自动采集的，摘要只写结论）。比值塌下来通常是 AI 在复述对话而非提炼：",
        '  判据——这条记忆 3 个月后还有用吗？能从原话里直接翻到（"用户问了X，我答了Y"）就别写。',
      ],
      unparsed: (n, total) => ` [未解析 ${n}/${total}]`,
      unknownSource: (bad, ok) => `未知来源: ${bad}（可用: ${ok}）`,
      runCols: ["源", "可用", "扫描", "新增", "跳过", "解析", "耗时", "说明"],
      runTitle: (dryRun) => `${dryRun ? "【预演，不写库】" : ""}客户端会话采集`,
      driftTitle: "\n⚠ 结构指纹变化 —— 上游可能改版，字段集已不是上次那套：",
      driftLine: (label, fingerprint, unparsed, suspects) =>
        `   ${label}: 新指纹 ${fingerprint}，本次未解析 ${unparsed}/${suspects}`,
      driftAdvice: "   先看 --status 里的未解析行数；若在涨，说明现有解析规则已失效。",
      runSummary: (scanned, inserted, ms, total, dryRun) =>
        `\n本次扫描 ${scanned} 条，${dryRun ? "将新增" : "新增"} ${inserted} 条，用时 ${ms}ms；episodes 现有 ${total} 条`,
      cumulative: (s) => "累计：" + s,
    },

    updateStatus: {
      source: (v) => `清单源:   ${v}`,
      noSource: "（已关闭：XBB_UPDATE_URL 为空）",
      form: (v) => `运行形态: ${v}`,
      formExe: "编译产物 exe",
      formDev: "dev（未编译，自更新被禁用）",
      dir: (v) => `工作目录: ${v}`,
      pendingNone: "pending:  无",
      // 措辞必须与 decideBootAction 的三态一致：写成"将回退"会把只是首次引导的人吓到
      pendingAdopt: (version) =>
        `pending:  有（v${version} 首次引导）—— 下次启动会**放行**它，待 serve 健康检查通过后自动清除标记`,
      pendingRollback: (version) =>
        `pending:  有（v${version}）—— 下次启动会**回退**上一版本并拉黑它（上次引导未走到确认点）`,
      blocklist: (v) => `黑名单:   ${v}`,
      blocklistEmpty: "空",
    },

    home: {
      progDir: (v) => `程序目录  ${v}   （exe / 更新包 / 托盘 / 配置）`,
      dataDir: (v) => `数据目录  ${v}`,
      srcLabel: (v) => `位置来源  ${v}`,
      srcEnv: "环境变量 XBB_DATA_DIR（临时覆盖，不写盘）",
      srcConfig: (path) => `配置文件 ${path}`,
      srcDefault: "默认位置（未配置，向后兼容）",
      dbCounts: (memories, episodes, events, integrity) =>
        `\n          记忆 ${memories} / 原话 ${episodes} / 事件 ${events} · 完整性 ${integrity}`,
      dbNewer: (schema, target) =>
        `\n          ⚠️ 库结构 v${schema} 比当前程序支持的 v${target} 新 —— 照常读写但不改结构，建议升级到最新版`,
      dbOpenFailed: (msg) => `\n          ⚠️ 打不开：${msg}`,
      dbCorruptHint: "\n          ⚠️ 看起来是库文件损坏 —— 先把它连同 -wal / -shm 复制留存；别删、别覆盖",
      dbPath: (path) => `记忆库    ${path}`,
      lastWritten: (when) => ` · 最后写入 ${when}`,
      dbMissing: "          ⚠️ 不在位 —— 现在启动会被拒绝（这是刻意的：宁可起不来，也不要在空库上继续用）",
      dbElsewhere: (path) => `          默认位置有库：${path} —— 用 xbb home move / reset 校准`,
      models: (path, size) => `模型目录  ${path}   ${size}`,
      modelsNotDownloaded: "（尚未下载）",
      configFile: (path) => `配置文件  ${path}`,
      configAbsent: "   （不存在 = 用默认位置）",
      setUsage: ['用法: xbb home set "<目录>" [--force]', "  目标目录里必须已经有 memory.db —— 想把库搬过去请用 `xbb home move`。"],
      setNoDb: (abs) => [
        `❌ ${abs} 里没有 memory.db`,
        '   · 想把库搬过去：xbb home move "' + abs + '"（复制+校验+切配置，一步到位）',
        "   · 库在外接盘、现在没插：确认路径无误后加 --force 先写配置",
      ],
      setOk: (abs) => `✅ 已指向 ${abs}`,
      setDbReady: (path) => `   库已就位：${path}`,
      setDbMissing: "   ⚠️ 该位置当前无库，下次启动会拒绝启动（不会新建空库）",
      setModelsCopied: (from, to, size) => `   模型已一并复制：${from}  →  ${to}（${size}）`,
      setNoModels: [
        "   ⚠️  该位置没有语义检索模型，本机也找不到可复制的副本：",
        "       检索会降级为关键词匹配。联网后重启一次会自动重新下载。",
      ],
      setRestart: [
        "",
        "   ⚠️  必须重启 AI 客户端（opencode / Cursor / WorkBuddy）与 xbb serve 才会生效；",
        "       正在运行的进程仍拿着旧路径。",
      ],
      moveUsage: [
        '用法: xbb home move "<目录>" [--cleanup] [--force]',
        "  复制 → 校验（完整性 + 行数逐项比对）→ 才切配置。校验不过不切，原库不动。",
        "  --cleanup 校验通过后删除旧位置的数据（默认保留，确认新位置能用后自己删）。",
        "  --force   跳过「库是否被占用」检查（已自行确认无进程时用；校验照样执行）。",
      ],
      moving: "迁移中（先复制、再校验、最后才切配置）…",
      moveOk: (from, to) => `✅ 已迁移：${from}  →  ${to}`,
      moveEntries: (entries, size) => `   搬了 ${entries}，共 ${size}`,
      moveVerify: (integrity, memories, episodes, events) =>
        `   校验：完整性 ${integrity} · 记忆 ${memories} / 原话 ${episodes} / 事件 ${events}（与源库逐项一致）`,
      moveConfig: (path) => `   配置：${path}`,
      moveRestart: "   ⚠️  重启 xbb serve 和所有 AI 客户端才会用新位置。",
      moveKeepOld: (from) => `   旧位置的数据仍在 ${from}，确认新位置工作正常后自行删除。`,
      moveErrSamePath: (to) => `目标就是当前位置：${to}`,
      moveErrProcs: (list) =>
        `还有 xbb 进程在跑：${list.join("、")}\n` +
        `  迁移会丢 WAL 里尚未落盘的写入。先停掉：xbb stop\n` +
        `  （托盘菜单退出也可以；Cursor / opencode / WorkBuddy 会各自拉起一个 xbb mcp，` +
        `关掉客户端后它们才会消失，被杀掉会被立刻重新拉起。）\n` +
        `  确认这些进程都不在了，但仍被拦住：xbb home move "<目录>" --force`,
      moveErrBusy: (srcDb) =>
        `库被占用，现在搬会丢掉尚未写盘的数据：${srcDb}\n` +
        `  · 先试：xbb stop（停掉后台服务），并关掉开着小本本的 AI 客户端\n` +
        `  · 仍然报这一句：xbb home move "<目录>" --force（跳过这项检查，校验照做）`,
      moveErrTargetHasDb: (dstDb, to) =>
        `目标位置已有库：${dstDb}\n` +
        `   为避免覆盖别人的记忆，这里不继续。\n` +
        `   · 想用这份现成的：xbb home set "${to}"（先确认它是你要的那一份）\n` +
        `   · 想换个地方：换一个空目录`,
      moveErrNothing: (from) => `当前位置没有可搬的数据：${from}`,
      moveErrNoVerify: (dstDb) => `复制后校验未产生结果：${dstDb}`,
      moveErrIntegrity: (integrity, dstDb, srcDb) =>
        `复制后完整性校验失败（${integrity}）：${dstDb}\n   未切换配置，原库完好：${srcDb}`,
      moveErrDstMissing: (dstDb) => `复制后目标库不存在：${dstDb}`,
      moveErrRowMismatch: (key, src, dst, srcDb) =>
        `复制后行数不一致（${key}: 源 ${src} / 目标 ${dst}）——未切换配置，原库完好：${srcDb}`,
      lockProbeFailed: (dbPath, msg) =>
        `无法确认库是否空闲：${dbPath}\n` +
        `  原因：${msg}\n` +
        `  这不是「被占用」，而是这项检查本身失败了——请把上面这行原文发给我们。\n` +
        `  确认没有 xbb 进程在跑时，可以跳过检查：xbb home move "<目录>" --force`,
      findScanning: "扫描中（各盘根+家目录，深度 4，预算 15 秒）…",
      findDeepScanning: "全盘深扫（可能几分钟）…",
      findNone: "没找到任何 memory.db。若库在外接盘，请先插上再扫；或用 --deep 全盘深扫。",
      findCols: "记忆数   大小      最后写入          路径",
      findCurrent: " ← 当前",
      findTotal: (n) => `\n共 ${n} 个。换过去：xbb home set "<路径的目录>"`,
      initRefused: (path, exists) => [
        "拒绝执行：新建空库是一个**不可逆的判断**（用户会以为记忆全丢了）。",
        `   当前位置：${path}${exists ? "（有库，无需 init）" : "（无库）"}`,
        "   确认要从零开始，加 --force：xbb home init --force",
        "   更可能想要的是：xbb home show / xbb home find / xbb home reset",
      ],
      initOk: (path) => [`✅ 已在 ${path} 建了一个空库`, "   ⚠️  这是一个全新的空库 —— 旧记忆不在里面。"],
      resetOk: (path, exists) => [
        `✅ 已撤掉数据目录配置，回到默认位置：${path}`,
        `   ${exists ? "库在位。" : "⚠️ 该位置没有库 —— 用 xbb home find 找一下。"}`,
      ],
      unknownSub: (sub) => `未知子命令: ${sub}（可用: show / set / move / find / init / reset）`,
    },

    stop: {
      none: "没有在跑的 xbb 进程。",
      found: (list, n) => `发现 ${n} 个 xbb 进程：${list}`,
      stopped: (pid, name) => `  ✅ 已停止 PID ${pid} ${name}`,
      kept: (pid, name, why) => `  ⏭  已保留 PID ${pid} ${name}（${why}）`,
      keptWhyNoCmd: "拿不到命令行，保守跳过",
      keptWhyMcpBusy: "mcp，当前会话仍在用",
      keptWhyMcp: "mcp",
      signalTimeout: "已发出退出信号，但 3 秒内没有退出",
      failed: (pid, name, err) => `  ❌ 停不掉 PID ${pid} ${name}：${err}`,
      failedHint: "\n  停不掉的通常是权限问题：Windows 用管理员身份重试，Unix 检查进程属主。",
      undecidable: (n) => [
        `\n  ⚠️ ${n} 个进程的启动参数取不到（系统限制了进程查询），已全部保守跳过 ——`,
        "     宁可少停一个 serve，也不误杀正在给你供记忆的 mcp。要全停就去掉 --keep-mcp。",
      ],
      keptMcp: [
        "",
        "  --keep-mcp 保留了 mcp：当前会话的记忆工具不受影响，serve 已停。",
        "  但 mcp 仍连着库，所以现在跑 xbb home move 还是会报「库被占用」。",
        "  搬家前请先关掉 AI 客户端，再执行一次不带 --keep-mcp 的 xbb stop。",
      ],
      stoppedHint: [
        "",
        "  注意：Cursor / opencode / WorkBuddy 拉起的 mcp 会被这些客户端自动重启。",
        "  要彻底停干净，先关掉这些客户端，再执行一次 xbb stop。",
        "  后台服务停了要重新起来：xbb serve --detach（或点托盘「打开管理窗口」先 xbb serve）",
      ],
    },

    plain: {
      serveNotReady: (extra) => `常驻服务: 未就绪${extra}`,
      portBusy: (port) => ` — 端口 ${port} 被别的程序占着`,
      seeLog: " — 看 logs/serve.log",
      toastAlreadyTitle: "小本本已经在运行",
      toastStartedTitle: "小本本 AI 记忆已启动",
      toastBody: "托盘图标在右下角。看不到就点开 ^ 拖到任务栏。",
      serveRunning: (port) => `常驻服务: 运行中（127.0.0.1:${port}）`,
      serveStarted: (ms) => `常驻服务: 已启动并就绪（${ms}ms）`,
      cloudLocalOnly: "模式: 本地（仅本机）—— 尚未绑定云端",
      cloudLive: (org, api) => `模式: 云端 · ${org}  @ ${api}`,
      cloudOff: (org) => `模式: 本地（已关云端，密钥保留）· 随时可切回 ${org}`,
      unknownCommand: (cmd) => `未知命令: ${cmd}（运行 xbb --help 看全部命令）`,
    },
  },

  tray: {
    bound: "已绑定",
    openWindow: "打开管理窗口",
    modeCloud: (org) => `模式：云端 · ${org}`,
    modeLocalKeep: "模式：本地（已关云端，密钥保留）",
    modeLocalOnly: "模式：本地（仅本机）",
    switchHint: "切换后需重启 AI 客户端才生效",
    toCloudBound: (org) => `切换到云端模式 · ${org}`,
    toCloudUnbound: "切换到云端模式…",
    toLocal: "切换到本地模式（保留密钥）",
    bindKey: "填写云端密钥…",
    verify: "校验哈希链",
    report: "导出诊断报告",
    update: "检查更新",
    autostart: (on) => `开机自启：${on ? "已开" : "已关"}`,
    exit: "退出",
    tipCloud: (org) => `小本本 · 云端模式 · ${org}`,
    tipLocal: "小本本 · 本地模式 (127.0.0.1:17630)",
  },
};
