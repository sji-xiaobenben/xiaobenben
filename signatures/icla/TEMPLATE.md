# 个人签署记录格式（维护者填写）

文件名：`signatures/icla/<github-login>.md`（**小写**）

```
CLA-Version: 1
github: octocat
name: 张三
email: zhangsan@example.com
email: 12345678+octocat@users.noreply.github.com
signed-date: 2026-11-08
signed-document: CLAs/ICLA.md
capacity: individual
archive-ref: icla/2026-11-08-octocat
```

字段说明：

| 字段 | 含义 | 注意 |
|---|---|---|
| `CLA-Version` | 协议版本 | 与机器人校验的版本号必须一致，否则视为未签 |
| `github` | GitHub 登录名，小写 | 机器人按此值+文件名双重比对 |
| `name` | 签署人真实姓名 | 与签署件上的署名一致 |
| `email` | 该贡献者**实际用于 git 提交**的邮箱 | **可写多行**。周审计按此匹配 commit 作者，漏写就会误报 |
| `signed-date` | 签署件上的日期 | 不是收到邮件的日期 |
| `signed-document` | 签的是哪份协议 | 指向仓库内文件，便于日后核对 |
| `capacity` | `individual` 或个人代表公司 | 代表公司请改用 ccla 流程 |
| `archive-ref` | 签署件在**私有存档**里的编号 | 绝不写公开 URL，也不把扫描件放本仓 |

> **关于多行 `email`**：很多贡献者开启了 GitHub 邮箱隐私保护，提交作者是
> `12345+login@users.noreply.github.com` 而不是真实邮箱。合并 PR 后请用
> `git log -1 --format='%ae' <merge-commit>` 看一眼实际作者邮箱，**把看到的那个也登记进来**。
> 否则每周审计会把这位已签署的贡献者列为「找不到签署记录」。

维护者核对清单：

- [ ] 签署件上有手写或电子签名，不是邮件里一句「我同意」
- [ ] 签署件上的姓名与 `name` 一致
- [ ] 邮件里写明的 GitHub 登录名与 `github` 一致（大小写可不同，登记时统一小写）
- [ ] `signed-date` 不晚于今天
- [ ] 签署件已存进私有存档，`archive-ref` 能对应上
