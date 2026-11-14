// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 命令行帮助的唯一真源（2026-11-04 用户反馈）。
 *
 * 为什么要有这一层：以前只有 `home` 一个分支自己处理 `-h/--help`，其余命令把 `--help`
 * 当普通参数继续往下跑 —— `xbb stop --help` 真的把 serve 停了、`xbb serve --help`
 * 真的前台起服务并挂住终端、`xbb home move --help` 真的开始搬家（靠占用检查才中止）。
 * 「查帮助」成了破坏性操作，脚本用 `--help` 探测命令能力也会误伤。
 *
 * 铁律：**帮助的优先级高于执行，且在参数解析最前面统一拦截。**
 * 不给每个分支各写一遍 `if (args.includes("--help"))` —— 那样新增一个命令就会漏一个，
 * 而且漏了不报错、只在别人真的去查帮助时炸。
 *
 * 本文件**零依赖**（不 import 任何 node 内置模块）：它会被 index.ts 静态引入，
 * 而 `xbb stop --help` 要在 5ms 内退出，不能因为加载 tray / onnx / sqlite 而变慢。
 */

/** 是否在要帮助。任意位置生效（`xbb home move --help` / `xbb --help` / `xbb serve -h`）。 */
export function isHelpRequest(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

/**
 * 帮助的主题：`xbb home move --help` → `{cmd:"home", sub:"move"}`。
 *
 * 只认**不以 `-` 开头**的参数当命令/子命令 —— 否则 `xbb home --help` 会把 `--help`
 * 本身当成子命令名，去查一个不存在的 `home --help` 帮助。
 * `xbb help home move` 这种动词式写法也归一到这里。
 */
export function helpTopic(args: string[]): { cmd: string; sub?: string } {
  const bare = args.filter((a) => !a.startsWith("-"));
  if (!bare.length) return { cmd: "help" };
  if (bare[0] === "help") return { cmd: bare[1] ?? "help", sub: bare[2] };
  return { cmd: bare[0]!, sub: bare[1] };
}

const DATA_LOCATION = `  xbb home                 看程序在哪、库在哪、凭什么这么判断（缺省 = show）
  xbb home move <目录>     把库搬到别的盘：复制 → 校验 → 才切配置；校验不过不切
  xbb home set <目录>      只改配置不搬库（目标必须已有 memory.db，模型会自动带过去）
  xbb home find [--deep]   扫各盘找 memory.db（忘了当初放哪时用）
  xbb home reset           撤掉配置，回到默认位置
  xbb home init --force    在当前位置新建空库（唯一的建库入口，必须显式确认）`;

const SERVE_HELP = `用法: xbb serve [选项]

启动本地服务 + 托盘 + 管理窗口（默认 http://127.0.0.1:17630）。

  --detach     后台常驻：无控制台窗口、不弹管理页（开机自启用的就是它）
  --no-open    前台运行，但不自动打开管理页
  --headless   无托盘、无窗口（CI / 无显示环境）

说明：
  库不在预期位置时**拒绝启动**（exit 2），这是刻意的 —— 宁可起不来，
  也不要在空库上继续用下去。排查：xbb home show / xbb home find
  优先用 xbb stop 停服务，不要直接杀进程：serve 会拉起 ingest 之类的伴生进程。`;

const MCP_HELP = `用法: xbb mcp

以 MCP stdio 模式运行 —— 这是 AI 宿主（opencode / Cursor / WorkBuddy 等）的接入点，
由宿主自动拉起，一般不需要手动执行。

  库打不开时不会崩：23 个工具照常注册，统一返回可读原因，写入类工具降级并提示握手。

手动排障：先 xbb home show 确认库在位，再看宿主的 MCP 日志里 xbb 的 stderr。`;

const CONNECT_HELP = `用法: xbb connect [--json]

看这台机器上**哪些 AI 客户端已经接入了小本本**，以及每个客户端该把配置写在哪。

为什么要单独一条命令：装引擎和接入客户端是两件事。npx 只把可执行文件放到磁盘上，
接入是反过来的 —— 你要在客户端自己的配置里加一条 command，客户端启动时再把它拉起来。
所以「我装哪了」从来不能靠安装动作回答，只能靠反过来读那些配置。

  输出包含：
    · 客户端是否安装（配置目录在不在）
    · 是否已接入、接的是桌面版还是 npx 包
    · 配置里指向的可执行文件**是否还在**（升级/搬目录后失效是最难自查的故障）
    · 未接入的客户端给出可直接粘贴的片段，路径按它自己的格式生成

  --json    机器可读输出（脚本/安装器用）

**本命令只读，不修改任何文件。** 自动写入客户端配置需要备份、逐项确认与幂等设计，
风险等级和「查状态」不是一回事，不会混在同一个命令里。

npx 那行必须带 -y：首次会问「Ok to proceed?」，MCP stdio 下没人能回答，
现象是客户端一直连不上，而不是报错。`;

const STOP_HELP = `用法: xbb stop [--keep-mcp]

停掉本机所有 xbb 进程（含后台 serve）。进程名会改名，所以判据取"命令行首 token 是 xbb"，
不靠名字前缀硬匹配。

  --keep-mcp   保留 AI 客户端拉起的 mcp 进程，只停 serve / 托盘

两个必须知道的边界：
  · **不加 --keep-mcp 会连 mcp 一起停**，当前会话的记忆工具立刻失效，
    要重启 AI 客户端才恢复；被杀的 mcp 还会被宿主自动重新拉起（不是 stop 坏了）。
  · **--keep-mcp 保留的 mcp 仍然持有库连接**，所以此时「xbb home move」还是会报占用。
    搬家前请先关掉 AI 客户端，再做一次不带参数的 stop。

停不掉通常是权限问题：Windows 用管理员重试，Unix 检查进程属主。`;

const HOME_HELP = `用法: xbb home <子命令>

数据位置唯一真源。铁律：**锚点跟着程序走，绝不跟着库走** ——
配置 config.json 落在程序目录，所以库没了它也还在，「锚点在、货不在」是可检测的异常，
而不是"首次运行"。

  show                  程序目录 / 数据目录 / 位置来源 / 库大小与条数 / 模型与配置（缺省）
  move <目录>           复制 → 校验（完整性 + 行数逐项比对）→ 才切配置。校验不过不切，原库不动
  set <目录>            只改配置；目标必须已有 memory.db，模型会自动复制过去
  find [--deep]         扫各盘找 memory.db，按记忆条数排序（同名空库太多了）
  reset                 撤掉配置，回到默认位置
  init --force          新建空库（唯一的建库入口，必须显式 --force）

  xbb home move --help  看搬家那一堆选项（--cleanup / --force）的完整说明`;

const HOME_MOVE_HELP = `用法: xbb home move "<目录>" [--cleanup] [--force]

把记忆库搬到别的盘。程序留在原地，配置指向新位置。

  --cleanup   校验通过后删除旧位置的数据（默认保留 —— 确认新位置真能用再删）
  --force     跳过「库是否被占用」的检查（已自行确认无进程时用；**校验照样执行**）

流程：复制 → 校验（PRAGMA integrity_check + 记忆/原话/事件行数逐项比对）→ 写配置。
任何一步不过就中止，原库完好、配置不动 —— 半截库被当成真库，比没有库更糟。

被拦住时按顺序试：
  1. xbb stop            停掉后台 serve（不加 --keep-mcp，mcp 也一起停）
  2. 关掉 Cursor / opencode / WorkBuddy —— 它们各自托管一个 xbb mcp，杀了会被重新拉起
  3. xbb home move "<目录>" --force

搬完要重启 xbb serve 和所有 AI 客户端才会用新位置。`;

const HOME_SET_HELP = `用法: xbb home set "<目录>" [--force]

只改配置，不搬库。目标目录里**必须已经有 memory.db**，否则拒绝
（设一个空目录等于把自己送进下一次启动的报错里）。

  --force   目标暂时没有库也先写配置（外接盘还没插、稍后会插的场景）

模型（约 24MB）会自动从当前数据目录或程序目录复制过去；缺模型不会报错，
只会**静默降级成关键词检索** —— 所以这一步必须做，不能让用户自己发现"怎么变笨了"。`;

const HOME_FIND_HELP = `用法: xbb home find [--deep]

扫盘找所有 memory.db，按记忆条数排序 —— 同名空库到处都是，条数才能分出哪个是真的。

默认扫各盘根 + 家目录，深度 4、最多 25000 个目录、15 秒（Windows 全盘深扫能跑十分钟）。
  --deep   放开深度到 10、预算 120 秒

换过去：xbb home set "<找到的路径的目录>"`;

const HOME_INIT_HELP = `用法: xbb home init --force

在当前位置新建一个空库。这是**唯一**允许建库的入口，而且必须显式 --force。

为什么这么严：新建空库是不可逆的判断 —— 用户会以为记忆全丢了，而小本本一切看起来正常。
先确认真的不需要旧库：
  xbb home show    看现在指向哪、库里有多少条
  xbb home find    旧库可能还在别的盘上
  xbb home reset   配置指错了，撤掉即可回到默认位置`;

const CLOUD_HELP = `用法: xbb cloud [on|off|status]

本地 ⇄ 云端模式开关（缺省 = status）。

  on       切到云端（用本机已有的密钥，不删）
  off      切回本地（**密钥保留**，随时 on 切回去）
  status   看当前模式、组织、API 地址

切换后需重启 AI 客户端才对新会话生效；正在跑的客户端仍按原模式读写。`;

const BIND_HELP = `用法: xbb bind "<票或 xubb:// 链接>"

用控制台「连接我的小本本」生成的一次性绑定票（60 秒内单用）绑定云端组织。
也可以直接贴 xubb://bind?ticket=…&api=… 的完整链接。

已经有长期密钥（多机共用 / 误删配置后恢复）用 xbb bind-key。
解除绑定（删本机密钥，不可恢复）用 xbb unbind；只想临时切回本地用 xbb cloud off。`;

const BIND_KEY_HELP = `用法: xbb bind-key <xbb_live_…> [apiBase]

用手上已有的长期密钥直接绑定（多机共用、或误删 cloud.json 后的恢复路径）。
apiBase 缺省 https://api.xiaobenben.net，自建部署时显式给。`;

const UNBIND_HELP = `用法: xbb unbind

解除云端绑定并从本机**删除密钥**（不可恢复）。

只是想暂时不用云端？用 xbb cloud off —— 它保留密钥，随时 on 切回来。`;

const AUTOSTART_HELP = `用法: xbb autostart [on|off|status]

开机自启（缺省 = status，先看清现状再动手）。

**默认就是开的**：装好后第一次运行会自动写一条启动项，之后每次登录都会在后台静默
起一个常驻服务 —— 无控制台窗口，也不弹管理页，右下角/菜单栏出现小本本图标。
不想开机启动？\`xbb autostart off\`（或在托盘菜单里点「开机自启：已开」），
之后不会再被自动写回。

三平台各走系统原生机制：
  Windows   HKCU\\…\\CurrentVersion\\Run → 「小本本服务」
  macOS     ~/Library/LaunchAgents/net.xiaobenben.xbb.plist（launchd）
  Linux     ~/.config/autostart/xbb.desktop（XDG）

想立刻体验：xbb serve --detach`;

const INGEST_HELP = `用法: xbb ingest [on|off] [--status] [--dry-run] [--source=a,b] [--limit=N]

采集本机各 AI 客户端的会话原文（原话层）。幂等，重跑不重复。

  on / off           打开或关闭**自动**采集（常驻服务每 5 分钟一轮；关掉后不再读本机会话）
  --status           各来源可用性、已入档条数、解析率、分层配比
  --dry-run          只统计不写库（先看会灌多少）
  --source=opencode,cursor   只采指定来源
  --limit=5000       每源单次上限（首刷分页）

原话层是本机冷存档，永不上云。`;

const UPDATE_HELP = `用法: xbb update

手动检查并应用更新（放行回滚黑名单，便于排障与应急）。
后台不会静默替换 exe —— 换不换由你决定，这条命令是"现在就换"。

装完要重启 xbb serve 与所有 AI 客户端才会生效。`;

const UPDATE_STATUS_HELP = `用法: xbb update-status

自更新状态速览：清单源、运行形态（编译产物 / dev）、pending 标记、回滚黑名单。

pending 有两种含义，别混：
  · 新版刚换上、还没被 serve 确认 → 下次启动**放行**它
  · 上次引导没走到确认点 → 下次启动**回退**并拉黑——这个文件的输出会说明是哪种`;

const VERIFY_HELP = `用法: xbb verify

审计自检：校验个人库的哈希链完整性（账不可改、只能增）。
输出 chain OK / CHAIN BROKEN，退出码对应 0 / 1。`;

const REGISTER_PROTOCOL_HELP = `用法: xbb register-protocol [exe 路径]

注册 xubb:// 协议处理器（三平台），让控制台的「连接我的小本本」能唤起本机客户端。
缺省用当前 exe。Windows 写 HKCU，无需管理员。`;

const VERSION_HELP = `用法: xbb version（等同 --version / -v）

打印版本横幅与构建指纹。版本与指纹都来自编译期写入的 build-meta，
用于版本核对 —— 不要手写。`;

const START_HELP = `用法: xbb start [--open | -o]

确保常驻服务在跑，并把结果说出来。**幂等**：已经在跑就什么都不做。

这是**给图标用的命令** —— 桌面快捷方式、开始菜单、任务栏都指向它即可。
双击后的行为：

  服务没跑   → 后台拉起（无窗口）→ 等 healthz 真的就绪 → 弹系统通知「小本本 AI 记忆已启动」
  服务在跑   → 只弹一条「已经在运行」，不重复启动（端口只有一个）

  --open / -o   就绪后打开管理页（http://127.0.0.1:17630/ui）

和另外两条启动方式的分工：

  xbb serve           前台跑，Ctrl+C 结束，会打开管理页 —— 开发/排障时看输出
  xbb serve --detach  后台跑，起完立刻返回，不等待也不通知 —— 开机自启用的就是它
  xbb start           后台跑 + **等到真的就绪**才返回 + 通知 —— 所以适合双击

为什么 start 要等就绪而不是起完就说"已启动"：
  bind 失败、库损坏、端口被占都发生在 spawn 之后。先报"已启动"再让它失败，
  用户会去找一个永远不出现的托盘图标 —— 那比不报更糟。

⚠️ 托盘图标会不会被折叠进 ^ 溢出区，由 Windows 决定，程序无法强制。
   第一次如果没直接看到：点开 ^ 把「小本本」拖到任务栏，之后系统会记住。`;

const OVERVIEW = `xbb — 小本本个人客户端

用法: xbb <命令> [参数]
      xbb                     确保服务在跑（没跑就启动）+ 状态速览
      xbb <命令> --help       看该命令的完整说明（任意位置生效，且**不执行任何动作**）

服务与接入
  xbb serve [--detach|--no-open|--headless]   启动本地服务 + 托盘 + 管理窗口（:17630）
  xbb start [--open]                          确保服务在跑 + 弹通知；绑桌面图标用这个
  xbb mcp                                     MCP stdio（AI 宿主的接入点，由宿主拉起）
  xbb connect [--json]                        看引擎接进了哪些 AI 客户端（只读，不改配置）
  xbb stop [--keep-mcp]                       停掉本机所有 xbb 进程
  xbb autostart [on|off|status]               开机自启（默认开；三平台）

数据位置
${DATA_LOCATION}

云端
  xbb cloud [on|off|status]   本地 ⇄ 云端开关（保留密钥，缺省 = 查看现状）
  xbb bind <票>               绑定云端（xubb:// 唤起，或粘 60 秒单用的绑定票）
  xbb bind-key <密钥>         用手上已有的长期密钥直接绑定
  xbb unbind                  解除绑定并删除本机密钥（不可恢复）
  xbb register-protocol       注册 xubb:// 协议处理器（三平台）

采集与维护
  xbb ingest [on|off|--status|--dry-run|--source=…]   采集本机 AI 客户端会话原文
  xbb verify                  审计自检：个人库哈希链完整性
  xbb version                 版本横幅 + 构建指纹

更新
  xbb update                  检查并应用更新（放行回滚黑名单）
  xbb update-status           自更新状态速览（源地址 / pending / 黑名单）

本地 ⇄ 云端也能在托盘图标里切换，或管理窗口 http://127.0.0.1:17630/ui 。`;

/** 命令 → 帮助文本。`cmd` 为空或未知一律给总览（查帮助不该报错）。 */
export function helpText(cmd: string, sub?: string): string {
  switch (cmd) {
    case "serve":
      return SERVE_HELP;
    case "start":
      return START_HELP;
    case "mcp":
      return MCP_HELP;
    case "connect":
      return CONNECT_HELP;
    case "stop":
      return STOP_HELP;
    case "cloud":
      return CLOUD_HELP;
    case "bind":
      return BIND_HELP;
    case "bind-key":
      return BIND_KEY_HELP;
    case "unbind":
      return UNBIND_HELP;
    case "autostart":
      return AUTOSTART_HELP;
    case "ingest":
      return INGEST_HELP;
    case "update":
      return UPDATE_HELP;
    case "update-status":
      return UPDATE_STATUS_HELP;
    case "verify":
      return VERIFY_HELP;
    case "register-protocol":
      return REGISTER_PROTOCOL_HELP;
    case "version":
    case "--version":
    case "-v":
      return VERSION_HELP;
    case "home":
      return homeHelp(sub);
    default:
      return OVERVIEW;
  }
}

function homeHelp(sub?: string): string {
  switch (sub) {
    case "move":
      return HOME_MOVE_HELP;
    case "set":
      return HOME_SET_HELP;
    case "find":
      return HOME_FIND_HELP;
    case "init":
      return HOME_INIT_HELP;
    case "show":
      return `用法: xbb home show

程序目录 / 数据目录 / 位置来源 / 库大小与条数 / 模型目录 / 配置内容，一次全给。
「为什么是这个路径」必须能回答 —— 否则排障只能猜。

退出码：库在位 0，不在位 1 —— 脚本可以直接拿它判断。

其它子命令见: xbb home --help`;
    case "reset":
      return `用法: xbb home reset

撤掉 config.json 里的 dataDir，回到默认位置（程序目录）。旧库通常就在那儿。
撤完会顺带报一次库在位情况；不在位就用 xbb home find 找一下。

其它子命令见: xbb home --help`;
    default:
      return HOME_HELP;
  }
}

/** 无参数 / `xbb help` 时的总览（index.ts 的兜底分支与 --help 共用同一份） */
export function overviewHelp(): string {
  return OVERVIEW;
}
