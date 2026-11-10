# 上游来源

`core/packages/core` 是本仓内置的副本（vendored），不是 submodule。理由是公开仓必须能独立
`bun install && bun test`，不该为了一个目录去要求私有仓访问权或 `--recursive` 克隆。

| 项 | 值 |
|---|---|
| 上游仓库 | `sji-xiaobenben/xbb-core`（私有） |
| 路径 | `packages/core/` |
| 提交 | `1368171` |
| 同步时间 | 2026-11-10 |

与上游的差异只有两处确定性变换，`bun run core:check` 正是按这两条规则逐文件比对：

1. 每个 `.ts` 顶部注入 SPDX 许可头——上游不带，而内置副本要随本仓以 AGPL 发布；
2. `package.json` 的 `license` 规范成单一 `AGPL-3.0-only`（上游带双许可表达式）。

除此之外源码逐字节一致，没有删减。

**不要直接改 `core/`** —— `bun run core:sync` 会整个覆盖。要改行为请改 `src/`，
或对 `src/` 覆盖不到的部分提 issue。

若要追溯某一行的来历，请以上述提交为基准。
