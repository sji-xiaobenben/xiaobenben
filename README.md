# 小本本 · xbb-cli

面向 AI 的个人记忆库客户端 —— local-first，Bun 单文件可执行（Windows / macOS / Linux），本地 SQLite 存储，通过 MCP 接入各类 AI 客户端。

> 让 AI 记住跨年跨会话的事，而记忆始终留在你自己的机器上。

## 特性

- **零登录开箱即用** —— 不注册、不绑定账号，装完即可用
- **local-first** —— 个人记忆存本地 SQLite；组织（企业）记忆 100% 不落本地
- **MCP 接入** —— 以 stdio 方式接入支持 MCP 的 AI 客户端，无需改客户端代码
- **本地服务** —— `xbb serve` 监听 `127.0.0.1:17630`，带 Host / Origin 校验，抵御 DNS rebinding 与跨站调用
- **开机自启** —— 三平台默认开启（Windows 注册表 / macOS launchd / Linux XDG），登录后无窗口静默起服务 + 托盘图标；`xbb autostart off` 一句话关掉
- **自更新** —— ed25519 签名清单，先验签再比版本，sha256 + 大小双校验，非编译形态拒绝替换
- **零遥测** —— 不上报任何使用数据、崩溃信息或统计指标
- **密钥摘出** —— 凭据从记忆正文里摘出、正文只留编号占位符（**掩码存储，非加密**，理由见 [`SECURITY.md`](SECURITY.md)）

## 安装

从官网下载对应平台的单文件可执行：

<https://www.xiaobenben.net>

直接运行，无运行时依赖。之后程序会通过官方签名清单自更新。

```bash
xbb --help          # 查看全部命令（零副作用）
xbb serve           # 启动本地服务（127.0.0.1:17630）
xbb stop            # 停止服务
xbb stop --keep-mcp # 停止本地服务但保留 MCP 连接
xbb version         # 版本 + 构建指纹
```

### 开机自启（默认开启）

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

## 接入 AI 客户端

在客户端的 MCP 配置里把 `xbb` 加为 stdio server 即可。写记忆、召回、时间线、约束域等能力以 MCP 工具形式暴露，完整工具列表见客户端里的工具面板。

## 从源码构建

需要 [Bun](https://bun.sh) ≥ 1.4。

```bash
bun install
bun run typecheck
bun run test:ci

bun run build:win      # dist/xbb-windows-x64.exe
bun run build:linux    # dist/xbb-linux-x64
bun run build:mac-arm  # dist/xbb-darwin-arm64
bun run build:mac-intel
```

`core/` 是 `@xbb/core` 的内置副本（uuidv7 / 事件哈希链 / 端口与错误码），随本仓一同发布，因此 `git clone` 后无需访问任何私有仓即可构建。**不要直接修改 `core/` 下的文件**，说明见 [`core/README.md`](core/README.md)。

本地构建出的产物 `xbb version` 会自报 `构建 local`，且**默认不参与自更新**：它编进去的是官方签名公钥与官方 CDN，若照常自动更新，只会把你的构建换成官方 exe。要用官方源（或自己的镜像）就显式指定 `XBB_UPDATE_URL`；要长期分发自己的版本，还需换掉公钥，见 [`CONTRIBUTING.md`](CONTRIBUTING.md) 的「Fork 之后要分发自己的构建」。

判据是**发布者身份**，不是「有没有构建过」：产物里编了 `BUILD_REPO`，只有它等于 `OFFICIAL_REPO`（官方仓）时才认内置更新源。所以你 fork 之后跑自己的 Actions 发出来的 exe 也不会去官网查更新——哪怕它注入了真实构建时间。核查方式：`xbb update` 会说 `非官方构建：自更新默认关闭（构建来源 <owner/repo>）`。

> `bun.lock` 记录的是官方源 `registry.npmjs.org`。国内网络如遇安装慢，可临时换镜像：
> `bun install --registry https://registry.npmmirror.com`

## 隐私

- **零遥测**：代码中不存在任何上报使用数据的通道；自更新只拉取版本清单，不带任何标识
- **首启下载模型**：嵌入模型不随包分发，首次启动从公开源（HuggingFace）下载并做 sha256 校验；失败时降级为纯全文检索，不影响可用
- **采集范围**：会读取其他 AI 工具在本机的数据（`opencode.db`、Cursor `state.vscdb` 中仅 `composerData:` 与 `bubbleId:` 两类 key、`.claude`、`.codex`、`.workbuddy`），全部在本地处理，不自动上传

本地服务的威胁模型与全部已知设计取舍见 [`SECURITY.md`](SECURITY.md)，建议使用前读一遍。

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
