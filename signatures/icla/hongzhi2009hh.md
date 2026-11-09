# 权利人归属记录（非 ICLA 签署件）

本文件按 [`signatures/README.md`](../README.md)「内部员工」一节的约定登记归属，**不是**一份
签署件：本人是著作权人公司（世纪之城（广州）信息科技有限公司）的权利人，代码属职务作品，
依《著作权法》第 18 条、《计算机软件保护条例》第 13 条著作权归单位，无需另签 ICLA。

登记目的是把「这条提交是职务作品」从「翻劳动合同和岗位说明书」降到「翻一页纸」。

```
CLA-Version: 1
github: hongzhi2009hh
name: 陈泓智
email: chenhongzhi@sji.xin
email: 30995692+hongzhi2009hh@users.noreply.github.com
capacity: copyright-holder
```

## 为什么两个邮箱都要登记

`chenhongzhi@sji.xin` 是本机 `git commit` 的署名邮箱，审计脚本对 `@sji.xin` 域本身就有豁免。

`30995692+hongzhi2009hh@users.noreply.github.com` 是 GitHub 账号的 noreply 地址——
**通过网页或 API 创建提交时**（改一处错字、删一个文件、合并 PR 的 squash 提交）GitHub 会把
作者写成它，而不是本机配置的邮箱。这类提交同样是职务作品，但邮箱不同，不登记就会被每周审计
判成「未签署贡献者」。

## 一并修正的审计规则

`audit.yml` 同时补上机器人豁免：`*[bot]@users.noreply.github.com` 跳过。机器人不可能签署协议，
而 `cla.yml` 早已对 `dependabot[bot]` 单独豁免（`if: github.event.pull_request.user.login !=
'dependabot[bot]'`）。两处判定口径不一致的结果是审计永远红着——一条永远修不好的红灯，比没有
这道闸更糟，人会很快学会无视它。
