# 贡献指南

感谢你有兴趣改进小本本。这份文档说明我们接受什么样的贡献，以及在你写第一行代码之前需要知道的事。

## 先读这里：我们的边界

这是一个**有商业形态**的开源项目，不是纯社区项目。因此：

- **代码许可是 AGPL-3.0-only，另有商业许可**（见 `LICENSE-Commercial.md`）。为了让双许可长期成立，**所有贡献都必须先签 CLA**（见下）。
- **不是所有 PR 都会被合并**，即使它质量很好。功能方向由维护者决定，请不要在没有事先沟通的情况下提交大改动。
- **先开 issue，再写代码。** 尤其是新增功能、重构、接口变更。没有对应 issue 的大 PR 很可能会被关闭——这对你是时间浪费。

我们不接受的方向：UI 整体改版、与产品定位无关的功能、增加新的运行时依赖（除非有不可替代的理由）、任何形式的遥测或数据上报。

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

### 关于 `core/` 目录

`core/` 是 `@xbb/core` 的内置副本（唯一真源在维护者的私有仓）。**请不要直接修改 `core/` 下的文件**——下次同步会覆盖，你的改动会丢。

如果你确实需要改 `@xbb/core`：在 issue 里说明，维护者会改上游后同步过来。`bun run core:check` 可以检查副本是否与上游一致。

## 提交规范

- 一个 PR 只做一件事。混入无关改动（格式化、重命名、顺手重构）会让 review 变慢甚至直接退回。
- 提交信息用「`类型(范围): 说明`」，如 `fix(serve): 来源闸覆盖 /update 端点`。类型：`feat` `fix` `docs` `refactor` `test` `chore` `perf`。
- 新增行为要有测试。`bun run test:ci` 必须全绿。
- 不要引入新的运行时依赖，除非在 issue 里先达成一致。

## 不要碰的文件

以下路径的改动一律需要维护者本人 review，外部 PR 请勿包含：

- `.github/`（CI、发布流水线、门禁配置）
- `package.json` / `bun.lock`（依赖清单）
- `LICENSE` / `NOTICE` / `LICENSE-Commercial.md` / `CLAs/`
- `src/build-meta.ts`（版本、更新源、署名等构建元数据）
- `core/`（内置副本，见上）

## 安全相关问题

不要开公开 issue。见 [`SECURITY.md`](SECURITY.md)。

## 许可

提交贡献即表示你同意：你的贡献以 AGPL-3.0-only 授权给所有使用者，同时按 CLA 的条款授权给版权方以其他许可条件再许可。
