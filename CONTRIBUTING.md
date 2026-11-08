# 贡献指南

感谢你有兴趣改进小本本。这份文档说明我们接受什么样的贡献，以及在你写第一行代码之前需要知道的事。

## 先读这里：我们的边界

这是一个**有商业形态**的开源项目，不是纯社区项目。因此：

- **代码许可是 AGPL-3.0-only，另有商业许可**（见 `LICENSE-Commercial.md`）。为了让双许可长期成立，**所有贡献都必须先签 CLA**（见下）。
- **不是所有 PR 都会被合并**，即使它质量很好。功能方向由维护者决定，请不要在没有事先沟通的情况下提交大改动。
- **先开 issue，再写代码。** 尤其是新增功能、重构、接口变更。没有对应 issue 的大 PR 很可能会被关闭——这对你是时间浪费。

我们不接受的方向：UI 整体改版、与产品定位无关的功能、增加新的运行时依赖（除非有不可替代的理由）、任何形式的遥测或数据上报。

## 行为准则

参与本项目即表示你同意遵守 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。技术分歧很正常，对方案狠一点没问题，对人不行——那份文档里写了几条我们这边的具体约定。

## 贡献者许可协议（CLA）

**首次提交 PR 前必须签署**，否则 CI 的门禁不会通过，PR 无法合并。这一步不可跳过——它保护的是项目能持续以双许可方式运营。

签署**不通过 PR 完成**：

1. 个人读 [`CLAs/ICLA.md`](CLAs/ICLA.md)，代表公司读 [`CLAs/CCLA.md`](CLAs/CCLA.md)
2. 打印签字扫描，或使用你公司认可的电子签
3. 发到 **admin@sji.xin**，正文写明你的 GitHub 登录名（代表公司还要写公司全称与签署人职务）
4. 维护者核对后登记进 `signatures/`，你的 PR 下一轮自动通过

**不要在 PR 里添加 `signatures/` 下的任何文件**——那个 PR 会被门禁直接拒掉。这不只是流程规矩：本检查读的是基线分支，靠 PR 带进来的记录永远等不到自己；而且一份自己写的声明文件在法律上不构成签署件。

签署件原件存在私有存档，公开仓库只放登记信息（姓名、登录名、日期、协议版本）。你的手写签名不该长期挂在搜索引擎里。

> 你的著作权仍然归你自己，CLA 授予的是「永久、不可撤销、可再许可」的使用权，不是版权转让。

## 开发环境

```bash
bun install          # bun 1.4.2（见 package.json engines）
bun run typecheck    # tsc --noEmit
bun run test:ci      # 单测 + 冒烟，2 分钟左右
```

### 构建

```bash
bun run build:win      # -> dist/xbb-windows-x64.exe
bun run build:linux    # -> dist/xbb-linux-x64
bun run build:mac-arm  # -> dist/xbb-darwin-arm64
bun run build:mac-intel
```

构建产物是 Bun 单文件可执行，不需要额外运行时。

四个 `build:*` 都只是 `tools/build.ts` 的薄壳，**不要绕开它直接调 `bun build --compile`**：
Windows 产物的图标、产品名、发行者、文件版本都写在 PE 资源段里，参数漏一项不会报错，
只会让用户装到一个「属性里写着 Bun 1.4.2」、资源管理器里没有图标的 exe。脚本编完会读回
资源段，把图标字节和 `assets/app.ico` 逐字节比一遍，对不上直接失败。

图标与 logo 也是生成物，改品牌图形时改生成器、不要手绘 PNG：

```bash
bun run gen:app-icon     # -> assets/app.ico（exe 资源段）+ assets/brand/logo.svg（README 抬头）
bun run gen:tray-icon    # -> assets/tray.ico / assets/tray.png（托盘）
```

两个生成器共用 `tools/lib/icon-codec.ts`，图形几何各在自己文件里（托盘是透明底裸书签，
应用图标是红底白书签），颜色都取品牌红 `#F22222`。

### 关于 `core/` 目录

`core/` 是 `@xbb/core` 的内置副本（唯一真源在维护者的私有仓）。**请不要直接修改 `core/` 下的文件**——下次同步会覆盖，你的改动会丢。

如果你确实需要改 `@xbb/core`：在 issue 里说明，维护者会改上游后同步过来。`bun run core:check` 可以检查副本是否与上游一致——它需要一个不在本仓里的上游目录，所以**在你 fork 出来的仓里会自动跳过并返回 0**，那不是环境坏了，是设计如此。

## Fork 之后要分发自己的构建

自己用无所谓；但要把改过的版本打包给别人，有三件事必须做，否则你的用户会被自动更新换成官方版：

1. **自更新默认已经是关的，别再打开**。产物里编了构建来源 `BUILD_REPO`，只有它等于 `OFFICIAL_REPO` 时才认内置更新源——本地 `bun run build:*` 编出的是 `未标注（本地直接构建）`，在你 fork 里跑 Actions 编出的是 `<你的账号>/xbb-cli`，两者都判非官方，`xbb update` 直接返回 `disabled`。不要为了让「能更新」顺手把 `XBB_UPDATE_URL` 指向官方源，那等于把用户交还给官方。
2. **换掉清单地址**。改 `src/build-meta.ts` 的 `UPDATE_URL_DEFAULT`，或分发时设 `XBB_UPDATE_URL=<你的清单地址>`。
3. **换掉签名密钥对**。`UPDATE_PUBKEY` 是编译期常量，你的产物验的是**我们**签的清单。不换公钥，你连自己的更新都推不了——客户端只认我们的签名。生成与校验的脚本可参照 `tools/sign-manifest.ts` / `tools/check-signing-key.ts`。

第 3 条最容易被漏掉，漏了不报错，只是你的更新永远装不上。

想让自己分发的版本也能自更新，就把 `OFFICIAL_REPO` 改成你自己的 `owner/repo`（同时完成上面第 2、3 条）——三者一致后，你的 CI 构建会被认成「官方」，检索的是**你的**清单。这不是漏洞而是设计：决定产物连哪个更新源的，是编进产物里的仓库身份，改它的人必然已经能改公钥和地址。

## 提交规范

- 一个 PR 只做一件事。混入无关改动（格式化、重命名、顺手重构）会让 review 变慢甚至直接退回。
- 提交信息用「`类型(范围): 说明`」，如 `fix(serve): 来源闸覆盖 /update 端点`。类型：`feat` `fix` `docs` `refactor` `test` `chore` `perf`。
- 新增行为要有测试。`bun run test:ci` 必须全绿。
- 不要引入新的运行时依赖，除非在 issue 里先达成一致。

## 两个 CI 闸你会撞到

- **SPDX 许可头**：每个 `.ts` / `.mjs` / `.js` / `.sh` 文件开头都要有两行——`SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial` 和版权行，有 shebang 时放在它之后。新增文件漏了会有一个 `::error::` 逐条列出。`core/` 下的头由 `bun run core:sync` 注入，不用手写。
- **版本号单调性**：`package.json` 的 `version` 是唯一真源，发版时会校验它**必须高于线上版本**。单文件 exe 的自更新只升不降，版本倒挂不可回滚——已经升上去的用户再也收不到更新。外部贡献者一般碰不到这个闸，因为版本号在「不要碰的文件」里。

## 第三方许可清单

`THIRD-PARTY-LICENSES.md` 是**生成物**：`bun run gen:licenses` 会跑一次构建、从 `bun build --metafile` 反查实际被打进产物的模块，再把各自的许可原文拼起来。

依赖有任何变动（含版本升级）都要重新生成，否则 CI 的 `gen:licenses --check` 会失败。**不要手改这个文件**——里面是别人的许可原文，改一个字就是在误述别人的授权条件。

## 不要碰的文件

以下路径的改动一律需要维护者本人 review，外部 PR 请勿包含：

- `.github/`（CI、发布流水线、门禁配置）
- `package.json` / `bun.lock`（依赖清单）
- `LICENSE` / `NOTICE` / `LICENSE-Commercial.md` / `CLAs/` / `CODE_OF_CONDUCT.md`
- `THIRD-PARTY-LICENSES.md` 与 `tools/third-party/`（许可原文，手改即误述）
- `src/build-meta.ts`（版本、更新源、署名等构建元数据）
- `core/`（内置副本，见上）

## 安全相关问题

不要开公开 issue。见 [`SECURITY.md`](SECURITY.md)。

## 许可

提交贡献即表示你同意：你的贡献以 AGPL-3.0-only 授权给所有使用者，同时按 CLA 的条款授权给版权方以其他许可条件再许可。
