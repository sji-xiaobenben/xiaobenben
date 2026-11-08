# 小本本 · xbb-cli

**面向 AI 的个人记忆库客户端。** local-first，Bun 编译的单文件可执行（Windows / macOS / Linux），本地 SQLite 存储，通过 MCP 接入各类 AI 客户端。

> 让 AI 记住跨年跨会话的事，而记忆始终留在你自己的机器上。

不注册、不登录、零遥测；断网也能完整读写记忆（用不了的是云端协作）。装完双击即跑，没有运行时依赖，不用装系统服务，也不用先写配置文件。

---

## 它解决什么问题

AI 的记忆现状是三条断点：

1. **每次对话从零开始。** 上下文窗口一关，昨天定的方案、上周踩过的坑、你的偏好和禁忌，全部归零。你不得不反复复述同一段背景。
2. **换个客户端就断片。** opencode 里聊的、Cursor 里改的、Claude Code 里定的，各自为政，互不相通。
3. **想让它记住，就得交出去。** 现成的"AI 记忆"大多在云端：你的项目结构、客户名字、内部决策、密钥片段，全都要过别人的服务器。

小本本的做法是：**记忆存在你机器上的一个 SQLite 文件里**，AI 通过 MCP 读写它。换客户端、换模型、换机器（走云端组织模式），记忆都跟着你走。

---

## 特性一览

### 记忆模型

| 能力 | 说明 |
|---|---|
| **双层记忆** | `episodes` 原话层（当时具体说了什么，append-only 冷存档）+ `memories` 蒸馏层（我们定了什么，可检索的原子事实）。两者用 `source_chunk` 互指，细节丢了能回原文 |
| **类型与用途** | 五种内容类型 `fact` / `preference` / `decision` / `event` / `procedure`，叠加四种用途 `kind` = `memory` / `directive`（限时叮嘱）/ `habit`（长期习惯）/ `constraint`（长期约束）。同一套工具、同一张表，用途不同检索语义不同 |
| **延续链** | 信息更新时不删旧条目，而是 `supersede` 成链：**链头 = 当前真相**，历史环仍可查。改过的偏好不会与旧偏好同时命中 |
| **双时间轴** | `occurred_at`（事情何时发生，可只精确到年月）与 `created_at`（何时入库）分开存。问"去年这个时候我们在干什么"才有意义 |
| **实体与别名** | 同一个人/项目/产品的大小写、缩写、旧名归并到同一实体，`recall_topic` 按实体聚合 |
| **语义链接** | `related_to` / `elaborates` / `caused_by` / `contradicts` 四种关系显式声明，配赫布式权重（越常一起被召回越强，长期不用会衰减） |
| **附件** | 图片、PDF、日志、设计稿按内容寻址（sha256）挂到记忆上；本地**只登记引用、不搬字节**，同一文件挂 12 条记忆也只存一份 |
| **密钥摘出** | 凭据从正文里摘进保险箱，正文只留 `[[xbb_secret_id:N]]` 占位。复制、导出、同步记忆时密钥不会跟着走 |
| **可审计** | 所有变更落 SHA-256 哈希链（`events` 表，`prev_hash` 串联），`xbb verify` 一条命令验全库 |
| **遗忘即墓碑** | `forget` 是打墓碑而非 `DELETE`：检索立刻看不到，审计链上仍留痕 |

### 检索

| 能力 | 说明 |
|---|---|
| **三路词法并行** | FTS5 trigram（CJK 友好的子串匹配）∥ 着陆垫倒排（AI 写入时生成的同义词/上位词/场景词）∥ 实体精确匹配，按 IDF 加权融合 |
| **第四路向量** | 本地跑 `bge-small-zh-v1.5` INT8（24 MB，512 维），与词法结果用 RRF 融合。**不联网、不调 API** |
| **延续链重定向** | 命中历史环时自动跳到链头（当前真相），旧值作为附注一并给出 —— 解决"记着的都是旧信息"这个最常见的记忆失效 |
| **1-hop 链接扩展** | 命中一条即带出它声明的邻居，按链接强度排序，可逐层深挖 |
| **换词引导** | 没命中时返回 `related_tags`，告诉 AI"换这些说法再试"，而不是干巴巴一句"无结果" |
| **预算封顶** | 结果条数与 token 数双闸，永不把整库灌进上下文窗口 |
| **自动降级** | 模型缺失 / 加载失败 / 推理异常 → 静默退回纯词法，明文照存，**永不因模型故障挂掉** |

### 接入

| 能力 | 说明 |
|---|---|
| **MCP stdio** | 一段配置即接入，宿主自动拉起、退出即回收，不改客户端代码 |
| **六宿主钩子** | 一份零依赖脚本兼容 Claude Code / Cursor / Trae / WorkBuddy / Codex CLI，另有 opencode 专用插件。每回合把文本转给本地服务做内存检索，宿主零感知 |
| **五个采集源** | opencode / Cursor / WorkBuddy / Claude Code / Codex 的本地会话库，直接读、只读、幂等 |
| **识别结构而非客户端** | 专用解析器优先命中，不中就走格式描述符，再走通用嗅探。上游改字段名不再致命，并记结构指纹，改版当天就能从 `xbb ingest --status` 看出来 |

### 隐私与主权

- **零登录** —— 不注册、不绑定账号、不填邮箱，装完即用
- **零遥测** —— 代码里不存在任何上报使用数据、崩溃信息或统计指标的通道
- **local-first** —— 个人记忆 100% 在本地 SQLite；组织（企业）记忆 100% 不落本地
- **不自动上传** —— 只有你显式使用云端功能时才有网络出站
- **原话层永不上云** —— `episodes` 是纯本地冷存档，云端后端根本不实现这个能力
- **采集全在本地** —— 读取其他 AI 工具的数据只在内存与本地库之间流动

### 安全与供应链

- **自更新先验签再比版本** —— ed25519 签名清单，签名不过直接拒绝，不存在"验签失败就跳过"的分支
- **双重校验** —— sha256 + 文件大小，任一不符即拒绝替换
- **失败自动回滚** —— 新版装完起不来会换回旧版并拉黑该版本，不会把你钉在一个坏版本上
- **非编译形态拒绝替换** —— 只有编译后的单文件二进制才允许被 swap
- **本地服务来源校验** —— Host / Origin 在**一切路由之前**拦截，抵御 DNS rebinding 与跨站调用
- **威胁模型公开** —— 不夸大防御能力，[`SECURITY.md`](SECURITY.md) 逐条列出已知取舍（含"密钥保险箱是掩码不是加密"）

### 三平台体验

- **开机自启** —— 三平台默认开启（Windows 注册表 / macOS launchd / Linux XDG），登录后无窗口静默起服务 + 托盘图标
- **托盘菜单** —— 打开管理窗口、校验、导出诊断、检查更新、切换本地/云端、开关自启、退出
- **管理窗口** —— `http://127.0.0.1:17630/ui`：列表 / 搜索 / 按会话查 / 按类型筛选（记忆·叮嘱·习惯·约束）/ 编辑 / 删除（墓碑）/ 保险箱 / 云端绑定 / 清理预览 / 诊断报告
- **桌面通知** —— 组织里有人给你发记忆、有人签收了你发的东西，系统气泡通知（Windows Toast / macOS 通知中心 / libnotify）
- **本地 ⇄ 云端一键切换** —— 切到本地时**保留密钥**，随时切回来，不必回控制台重新走一遍绑定

---

## 它是怎么做到的

### 为什么写入由 AI 发起，而不是"自动抓取对话"

MCP 是请求-响应协议，引擎**看不到**对话流。所以小本本开了三个入口，各管一层：

| 入口 | 怎么进来 | 写进哪一层 |
|---|---|---|
| `xbb mcp` | AI 宿主以 MCP stdio 拉起 | **蒸馏层** `memories` —— AI 主动蒸馏的原子事实 |
| `xbb serve` 回合钩子 | 插件 / 钩子 POST 到 `/hooks/turn` | **原话层** `episodes` —— 实时回合 |
| `xbb ingest` | 只读扫描客户端本地库 | **原话层** `episodes` —— 历史会话 |

- **蒸馏层由 AI 主动写**：AI 判断什么值得长期记住（结论、决策、踩过的坑、你的纠正），把它蒸馏成原子事实并附上检索着陆垫。这是记忆质量的来源。
- **原话层由引擎自己抓**：钩子拿实时回合、采集器读客户端落盘的历史会话。不依赖任何客户端配合，也就不存在"每新增一个 agent 就要写一个插件"。

两层都落在同一个本地 SQLite 文件里，`source_chunk` 互指：蒸馏层记结论，原话层留证据。

### 检索管线

```
查询词群（由 AI 扩展：同义词 / 上位词 / 场景词 / 实体名）
   ├─ FTS5 trigram 子串匹配
   ├─ 着陆垫倒排（≥3 字）
   ├─ 着陆垫倒排（1–2 字）
   └─ 本地向量 cosine（512 维）
         ↓
   IDF 加权融合 + RRF（向量并轨）
         ↓
   链头重定向 → 预算封顶 → 1-hop 扩展 → 换词引导
```

全部是本地 SQL 与本地推理，**零网络、零模型 API**。查询词群由 AI 侧扩展后传入 —— 这是"机制不语义"的体现：引擎只提供检索机器，语义判断交给更懂上下文的那个 AI。

### 三条设计原则

这三条贯穿全项目，也是它和"给记忆加个向量库"最本质的区别：

1. **机制不语义。** 引擎不预设分类，也不枚举"有哪些域"。约束的 `domain` 是个空容器，具体有哪些域（UI 设计 / 代码风格 / 沟通语气）由 AI 写入时动态归并；记忆的 `terms` 由 AI 生成。代码里没有一张硬编码的业务分类表，所以加新场景不需要改引擎。
2. **append-only。** 变更走事件哈希链，遗忘是墓碑，原话是冷存档。任何"改"都留痕，`xbb verify` 能证明账没被改过。
3. **默认态保守。** 云端可见性默认私有（要共享必须显式指定）；库不在预期位置**拒绝启动**（宁可起不来，也不在空库上继续用）；建库必须显式 `--force`；自启可以一键永久关掉且不会被偷偷写回。

### 与云端记忆产品的区别

| 维度 | 小本本（local-first） | 典型云端记忆 SaaS |
|---|---|---|
| 数据位置 | 你自己的磁盘，一个 SQLite 文件 | 厂商服务器 |
| 离线可用 | 可用（云端协作除外） | 通常不可用或降级 |
| 延迟 | 本地 SQL，无网络往返 | 每次检索一次往返 |
| 密钥/敏感信息 | 可摘进本地保险箱，不出机器 | 通常需上传 |
| 审计 | 哈希链在本地，可自证未被篡改 | 依赖厂商日志 |
| 跨设备 | 个人版本地；组织模式走云端 API | 天然支持 |
| 换客户端 | MCP 是标准协议，通用 | 各自生态 |

不是所有场景都该选本地：团队跨地域协作、需要集中检索时，云端是对的。小本本的选择是**默认留在本地，需要时才上行**。

---

## 接入 AI 客户端

在客户端的 MCP 配置里把 `xbb` 加为 stdio server 即可。宿主会自动拉起进程，不需要手动跑。

```json
{
  "mcpServers": {
    "xiaobenben": { "command": "xbb", "args": ["mcp"] }
  }
}
```

Windows 上若 exe 不在 `PATH` 里，把 `command` 写成完整路径（如 `C:\\Users\\你\\.xiaobenben\\bin\\xbb.exe`）。

### MCP 工具面

工具按**一次检索旅程**排列：写入 → 检索 → 取用 → 规则 → 维护 → 组织。

数量本身不是指标——上下文窗口是稀缺资源，每多一个工具，宿主的提示里就多一段描述要读、多一次选错的可能。所以这里刻意**不设**「记忆分类管理」这类入口：分类是 AI 写入时该判断的事，不该变成用户维护的目录树。

| 类别 | 工具 | 干什么 |
|---|---|---|
| 写入 | `write_memory` `log_episodes` | 批量落 3–5 条原子事实、补录原话 |
| 检索 | `search_memory` `recall_topic` `recall_session` `recall_timeline` `recall_episodes` `recall_transcript` | 混合检索、按实体聚合、按会话回放、按时间线还原、按原文翻页 |
| 取用 | `get_memory` `get_related` `get_asset` `reveal_secret` | 取全文与延续链、1-hop 邻居、附件字节、密钥明文 |
| 规则 | `recall_directives` `recall_constraints` | 新会话必查：长期习惯 + 限时叮嘱 + 全局约束 + 按任务词群命中领域约束 |
| 维护 | `supersede` `forget` `stats` `inbox` `ack` `outbox` | 修链、墓碑、用量、待办收件箱、签收、发件箱 |
| 组织 | `list_spaces` `list_members` `set_memory_audience` | 空间树、成员、可见范围（云端组织模式） |

工具描述里写的是**给 AI 看的判断准则**，不是参数说明 —— 什么该记、什么绝对不该记（"能靠翻原文找到的别记，记那些原文永远不会说出口的结论"）、何时必须先检索、密钥怎么标。这些准则直接决定记忆库的长期质量。

### 回合钩子（可选）

想让小本本在**每回合**自动参与（命中相关记忆就推进收件箱），装一个零依赖脚本即可：

- `plugins/opencode/xbb-push.js` → 放进 `~/.config/opencode/plugins/`
- `plugins/hooks/xbb-hook.mjs` → 六个宿主通用，接法见 [`plugins/hooks/README.md`](plugins/hooks/README.md)

红线是**候选不注入**：脚本 stdout 恒为空，绝不往宿主上下文里塞任何记忆内容（Trae 等宿主会把 stdout 当上下文注入）。失败一律静默退出 0，绝不阻塞宿主回合。

---

## 云端模式（可选，服务端不开源）

**默认不发一个字节。** 只有你显式执行 `xbb bind`（控制台发的一次性票）或 `xbb bind-key`（多机复用已有密钥）之后，客户端才会连 `api.xiaobenben.net`，且只在你使用云端功能时出站。

这一层解决的是**协作**，不是存储：

- **个人记忆始终在本地** —— 上云的是组织（企业）记忆，它 100% 不落本地，与个人库物理分离
- **默认私有** —— 每条记忆只有作者可见；共享给部门或整个组织必须显式指定，写入响应会回显实际可见范围，不靠猜
- **能退** —— `xbb cloud off` 只是暂停（密钥保留，随时 `on` 切回）；`xbb unbind` 才真删。没有这一步，「上云」就是单向门
- **多设备** —— 同一条长期密钥可在多台机器复用

### 怎么开通

不需要申请，也不是邀请制：账号登录后每月有 1 GB 免费读写额度，超出按 ¥10/GB 从余额扣，余额不过期（价格与额度以 <https://xiaobenben.net/versions/personal-cloud/#pricing> 为准）。

绑定分两步，**票和密钥不是一回事**：

```bash
xbb register-protocol                    # 一次性：把 xubb:// 协议指向本机 exe
xbb bind "xubb://bind?ticket=…&api=…"    # 控制台「连接我的小本本」生成，60 秒内单次有效
xbb bind-key <xbb_live_…>                # 已有长期密钥：多机复用、误删配置后恢复
```

`register-protocol` **不会自动执行**，不跑这一步，控制台上的「连接我的小本本」按钮点下去毫无反应——而它不会给出任何错误，只是什么都不发生。这是整条链路上最容易卡住的地方。

票用来**建立**信任（一次性、60 秒过期、必须回控制台现生成），密钥用来**复用**信任（长期、可多机）。第二台机器重复第二步即可。

流程入口：账号中心 <https://account.xiaobenben.net> 看额度与余额，工作台 <https://console.xiaobenben.net> 生成绑定票。

服务端、控制台与组织管理不在本仓，也不开源。这属于边界声明，不是功能清单——实现细节不给，因为给了你也验证不了。**能被验证的是这一条**：不绑定时，`xbb mcp` 与 `xbb serve` 的全部本地功能在断网环境下照常工作，相关代码路径完全不参与运行。

客户端的接入点只有一个文件：[`src/cloud.ts`](src/cloud.ts)（六工具按 profile 路由本地/云端）。

---

## 安装

从官网下载对应平台的单文件可执行：

<https://xiaobenben.net>

直接运行，无运行时依赖。之后程序会通过官方签名清单自更新。

```bash
xbb --help          # 查看全部命令（零副作用）
xbb serve           # 启动本地服务（127.0.0.1:17630）
xbb stop            # 停止服务
xbb stop --keep-mcp # 停止本地服务但保留 MCP 连接
xbb version         # 版本 + 构建指纹
```

`--help` 在参数解析最前面统一拦截，**任意位置都能用且不执行任何动作** —— `xbb stop --help` 不会真的把服务停掉。

## 开机自启（默认开启）

第一次跑 `xbb serve` 就会写一条启动项，之后每次登录都在后台静默起一个常驻服务
——无控制台窗口、不弹管理页，任务栏/菜单栏出现小本本图标。

```bash
xbb autostart           # 看现状（在哪、指向谁、用户意图）
xbb autostart off       # 关掉，且之后不再自动写回
xbb autostart on        # 重新打开
```

各平台用的都是系统原生的自启机制，不额外装服务：

| 平台 | 位置 | 登录后执行 |
|---|---|---|
| Windows | `HKCU\…\CurrentVersion\Run` → `小本本服务` | `"xbb.exe" serve --detach`（无窗口） |
| macOS | `~/Library/LaunchAgents/net.xiaobenben.xbb.plist` | launchd 托管 `xbb serve --no-open` |
| Linux | `~/.config/autostart/xbb.desktop` | `xbb serve --detach`（XDG 自启项） |

两点值得知道：

- **`xbb autostart off` 是粘的**。它会在 `config.json` 记下 `autostart: "off"`，此后
  `serve` 启动时不再自动写回。托盘菜单里那个「开机自启：已开/已关」也是同一个开关。
- **建议把 exe 放在固定位置**（如 `~/.xiaobenben/bin/xbb`）。启动项记的是绝对路径，
  如果你从下载目录直接运行，清理下载目录后这条启动项就会指向一个不存在的文件；
  下次再运行一次 exe 会自动修正。程序目录内有程序时，`autostart status` 会如实显示它指向哪儿。

---

## 命令速查

```
服务与接入
  xbb                                        状态速览（模式 / 库在哪 / 常用命令）
  xbb serve [--detach|--no-open|--headless]   启动本地服务 + 托盘 + 管理窗口（:17630）
  xbb mcp                                     MCP stdio（AI 宿主的接入点，由宿主拉起）
  xbb stop [--keep-mcp]                       停掉本机所有 xbb 进程
  xbb autostart [on|off|status]               开机自启（默认开；三平台）

数据位置
  xbb home                 看程序在哪、库在哪、凭什么这么判断
  xbb home move <目录>     把库搬到别的盘：复制 → 校验 → 才切配置；校验不过不切
  xbb home set <目录>      只改配置不搬库（目标必须已有 memory.db）
  xbb home find [--deep]   扫各盘找 memory.db，按记忆条数排序
  xbb home reset           撤掉配置，回到默认位置
  xbb home init --force    在当前位置新建空库（唯一的建库入口）

云端
  xbb cloud [on|off|status]   本地 ⇄ 云端开关（保留密钥）
  xbb bind <票>               绑定云端（xubb:// 唤起，或粘 60 秒单用的绑定票）
  xbb bind-key <密钥>         用手上已有的长期密钥直接绑定
  xbb unbind                  解除绑定并删除本机密钥（不可恢复）
  xbb register-protocol       注册 xubb:// 协议处理器（三平台）

采集与维护
  xbb ingest [--status|--dry-run|--source=…|--limit=N]   采集本机 AI 客户端会话原文
  xbb verify                  审计自检：个人库哈希链完整性
  xbb version                 版本横幅 + 构建指纹

更新
  xbb update                  检查并应用更新（放行回滚黑名单）
  xbb update-status           自更新状态速览
```

命令的取舍也能看出纪律：`xbb home move` 是"复制 → 完整性校验 + 行数逐项比对 → 才切配置"，任何一步不过就中止，原库完好；`xbb home init` 必须显式 `--force`，因为"新建空库"是不可逆的判断，用户会以为记忆全丢了而程序一切正常。

---

## 数据在哪

| 内容 | 位置 |
|---|---|
| 记忆库 `memory.db` | 程序目录（可用 `xbb home move` 搬到任意盘） |
| 配置 `config.json` | 程序目录 —— **锚点跟着程序走，绝不跟着库走**，所以"锚点在、货不在"是可检测的异常，而不是"首次运行" |
| 向量模型 | 数据目录下 `models/`（默认即程序目录，约 24 MB，首启下载） |
| 云端密钥 | `~/.xiaobenben/cloud.json`（仅云端模式） |

忘记库放哪了：`xbb home find --deep`（按记忆条数排序 —— 同名空库到处都是，条数才能分出哪个是真的）。

---

## 工程品质

| 项 | 实测 |
|---|---|
| 测试 | 冒烟钉的是**具体灾难**而不是覆盖率数字：验签失败的清单必须被拒、被篡改的清单必须检出、向量模型缺失要静默降级而不是报错、上游改了字段名要能靠嗅探继续工作、托盘资产必须真嵌进 exe、数据库迁移要能回滚。CI 在 Windows 与 Linux 双平台实跑 |
| 类型 | `tsc --noEmit` 零错误（`strict: true`） |
| 产物 | 单文件，Windows 约 87 MB / Linux 约 83 MB / macOS 约 61 MB（含 SQLite 与 ONNX 运行时） |
| 冷启动 | `xbb --help` 约 140 ms |
| 依赖 | 4 个生产依赖（MCP SDK / ONNX Runtime / 托盘 / zod），全部来自 npmjs 官方源，`bun.lock` 无内网镜像 |

实际分发进产物的第三方组件（含间接依赖）与许可全文见 [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md) —— 按 `bun build --metafile` 的实际打包结果生成，不是按 lockfile 罗列。

`core/` 是 `@xbb/core` 的内置副本（uuidv7 / 事件哈希链 / 端口与错误码），随本仓一同发布，因此 `git clone` 后无需访问任何私有仓即可构建。**不要直接修改 `core/` 下的文件**，说明见 [`core/README.md`](core/README.md)。

---

## 从源码构建

需要 [Bun](https://bun.sh) ≥ 1.4.2（与 `package.json` 的 `engines` 一致；CI 固定在 1.4.2 上构建）。

```bash
bun install
bun run typecheck
bun run test:ci

bun run build:win      # dist/xbb-windows-x64.exe
bun run build:linux    # dist/xbb-linux-x64
bun run build:mac-arm  # dist/xbb-darwin-arm64
bun run build:mac-intel
```

本地构建出的产物 `xbb version` 会自报 `构建 local`，且**默认不参与自更新**：它编进去的是官方签名公钥与官方 CDN，若照常自动更新，只会把你的构建换成官方 exe。要用官方源（或自己的镜像）就显式指定 `XBB_UPDATE_URL`；要长期分发自己的版本，还需换掉公钥，见 [`CONTRIBUTING.md`](CONTRIBUTING.md) 的「Fork 之后要分发自己的构建」。

判据是**发布者身份**，不是「有没有构建过」：产物里编了 `BUILD_REPO`，只有它等于 `OFFICIAL_REPO`（官方仓）时才认内置更新源。所以你 fork 之后跑自己的 Actions 发出来的 exe 也不会去官网查更新——哪怕它注入了真实构建时间。核查方式：`xbb update` 会说 `非官方构建：自更新默认关闭（构建来源 <owner/repo>）`。

> `bun.lock` 记录的是官方源 `registry.npmjs.org`。国内网络如遇安装慢，可临时换镜像：
> `bun install --registry https://registry.npmmirror.com`

---

## 隐私

- **零遥测**：代码中不存在任何上报使用数据的通道；自更新只拉取版本清单，不带任何标识
- **首启下载模型**：嵌入模型不随包分发，首次启动从公开源（HuggingFace / hf-mirror）下载并做 sha256 校验；失败时降级为纯全文检索，不影响可用
- **采集范围**：会读取其他 AI 工具在本机的数据（`opencode.db`、Cursor `state.vscdb` 中仅 `composerData:` 与 `bubbleId:` 两类 key、`.claude`、`.codex`、`.workbuddy`），全部在本地处理，不自动上传
- **原话层永不上云**：`episodes` 仅本地，云端后端不实现该能力
- **云端可见性默认私有**：每条记忆只有作者可见；共享给组织或指定部门必须显式指定，写入响应会回显实际可见范围

本地服务的威胁模型与全部已知设计取舍见 [`SECURITY.md`](SECURITY.md)，建议使用前读一遍。要点：本地 HTTP 无鉴权（视为"本机同用户"边界）、数据库不加密（依赖文件权限）、密钥保险箱是**掩码不是加密**。

---

## 许可

本项目以 **GNU Affero 通用公共许可协议第 3 版（AGPL-3.0-only）** 发布，见 [`LICENSE`](LICENSE)。

另有商业许可可选，适用于闭源分发、闭源对外服务、OEM 预装等场景，见 [`LICENSE-Commercial.md`](LICENSE-Commercial.md)。咨询请发邮件至 `admin@sji.xin`。

**内部使用不触发任何开源义务** —— 公司内部部署、内部二次开发、用本软件处理自己的数据，都不需要商业许可。

每个源码文件头都带一行机器可读的许可标识：

```
SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
```

`LicenseRef-Commercial` 是 SPDX 规范里的自定义许可引用，指向上面那份商业许可文档。
扫描工具提示"未知许可 `LicenseRef-Commercial`"是正常的——它不是标准许可编号，
也不应该被替换成 `MIT`、`Apache-2.0` 之类的名字。合规审查请直接读 [`LICENSE-Commercial.md`](LICENSE-Commercial.md)。

## 商标

「小本本」「xiaobenben」「SJi」及相关名称与标识为 世纪之城（广州）信息科技有限公司 的商标或商业标识。著作权许可**不包含商标许可**：可以自由修改和分发代码，但不得以相同或近似标识命名、推广衍生版本。详见 [`NOTICE`](NOTICE)。

## 反馈与支持

| 事项 | 去哪里 |
| --- | --- |
| 使用问题、bug、功能建议 | 优先开 [issue](https://github.com/sji-xiaobenben/xbb-cli/issues)（公开可搜索，别人也能受益）；不便公开可发 `support@sji.xin` |
| 安全漏洞 | **不要开公开 issue**，见 [`SECURITY.md`](SECURITY.md) |
| 商业许可 / OEM 咨询 | 见 [`LICENSE-Commercial.md`](LICENSE-Commercial.md)，邮箱 `admin@sji.xin` |

## 贡献

欢迎提交 issue 与 PR。请先读 [`CONTRIBUTING.md`](CONTRIBUTING.md) —— **所有外部贡献都需要先签 CLA**，这是为了让项目能持续以 AGPL + 商业许可双轨运营。

## 关于本仓库的提交历史

本仓库的公开历史从 `v0.4.47` 开始，此前的开发历史由版权方私有保留。本仓只包含客户端，服务端与云端能力不在本仓，也不开源。

初始提交与发布标签使用 SSH 签名，可用 `git log --show-signature` 验证。

---

Copyright (C) 2026 世纪之城（广州）信息科技有限公司
