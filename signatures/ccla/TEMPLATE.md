# 公司签署记录格式（维护者填写）

文件名：`signatures/ccla/<company-slug>.md`

```
CLA-Version: 1
company: 某某科技有限公司
authorized-signer: 李四
signer-title: 技术总监
email: lisi@example.com
signed-date: 2026-11-08
signed-document: CLAs/CCLA.md
archive-ref: ccla/2026-11-08-acme
covered:
  - zhangsan
  - lisi
```

| 字段 | 含义 |
|---|---|
| `CLA-Version` | 协议版本，与机器人校验值一致 |
| `company` | 公司法定全称，不要写简称或品牌名 |
| `authorized-signer` / `signer-title` | 有权代表公司签署的人及其职务 |
| `signed-date` | 签署件上的日期 |
| `signed-document` | 指向 `CLAs/CCLA.md` |
| `archive-ref` | 签署件在私有存档里的编号 |
| `covered` | 被覆盖的 GitHub 登录名列表（小写） |

**`covered` 只是给人看的总表，机器人不读它。** 真正让某个人通过检查的是
`signatures/ccla/covered/<github-login>.md` 这个文件——一人一个，指向公司记录。
这样做的原因：在 shell 里解析 YAML 列表容易出错，而「文件存在」是不需要解释的判据。

## 新增一个被覆盖的开发者

1. 确认此人确实是该公司员工，且工作范围覆盖他要提交的内容（岗位与模块对不上时，CCLA 的覆盖可能不成立）
2. 在 `ccla/covered/` 下建 `<github-login>.md`，内容照 `covered/TEMPLATE.md`
3. 把登录名补进上面公司记录的 `covered:` 列表
4. 以上两处一起提交

## 失效

公司撤回 CCLA、或员工离职时：删掉 `ccla/covered/<login>.md`，并在公司记录的
`covered:` 里划掉。删文件本身就会让该账号的下一次 PR 变成未签署状态——不需要额外的作废标记。
