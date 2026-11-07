# 被 CCLA 覆盖的开发者（维护者填写）

文件名：`signatures/ccla/covered/<github-login>.md`（**小写**）

```
CLA-Version: 1
github: zhangsan
name: 张三
email: zhangsan@acme.com
company-record: ccla/acme.md
employee: true
```

- `company-record` 指向 `signatures/ccla/<company-slug>.md`，顺着它能找到公司签署件
- `email` 填此人**在 git 里实际使用的提交邮箱**——周审计任务靠这一行把 commit 作者对回签署记录，
  漏了就会出现「人能对上、邮箱对不上」的假红
- `employee: true` 表示这位是被职务作品条款覆盖的正式员工；`false` 表示承包商/顾问，
  这类人**不能**只靠 CCLA 了事，必须由公司出具明确的著作权归属约定，并在 `company-record`
  的备注里写清

机器人只判一件事：这个文件存在、且 `CLA-Version` 与当前版本一致。其余字段是给人看的。
