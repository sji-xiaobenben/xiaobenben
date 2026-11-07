# 更新日志

本文件从**开源首发（0.4.47）**开始记录。此前的版本变更散落在私有仓历史里，
不再补写——补写出来的日期和描述只能是编的，不如从这一天开始诚实地记。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)：`0.<minor>.<patch>`，
minor 手工推进（体现语义化主次），patch 位由发版流水线保证唯一。

## [未发布]

## [0.4.47]

### 安全

- **本地服务来源校验补全（P0）**：此前 Host/Origin 校验只挂在 `/api/*` 上，
  而 `src/serve.ts` 自己还挂着一批端点（`/stats`、`/report`、`/report/export`、
  `/update`、`/update-check`、`/update-dismiss` 等）。这些端点完全绕过校验，
  后果不是"少一层防护"，而是在 DNS rebinding 下**整库可读**——恶意页面把自己的
  域名解析到 127.0.0.1，同源请求带 `Host: evil.example`，服务端若不看 Host 就照答。
  现已把校验提到**一切路由之前**，并补上三类回归测试（伪造 Host / 外站 Origin /
  改数据端点），防的是"以后新增路由又忘了挂闸"。

### 变更

- 仓库以 **AGPL-3.0-only** 开源，双许可条款见 `LICENSE-Commercial.md`。
- 每个源码文件带 SPDX 许可头，内置的 `core/` 由 `core:sync` 自动注入，
  CI 有闸防止新增文件漏加。
