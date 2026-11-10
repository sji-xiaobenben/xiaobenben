// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * API 错误码化 + zh-CN/en-US 词表第一天抽离，代码零硬编码中文。
 * 新增错误必须先加码再接线。
 */
export const ERRORS = {
  E_KEY_INVALID: { zh: "访问密钥无效或已吊销", en: "Access key is invalid or revoked" },
  E_KEY_REVOKED: { zh: "密钥已被撤销", en: "Key has been revoked" },
  /**
   * 设备密钥数量达到上限（2026-11-10 引入）。
   *
   * 口径：**一个成员在单个组织内**同时可持有的「未过期且未吊销」key 至多 N 个（默认 5）。
   * 按组织而非按自然人计，是因为限制的口径必须与「用户在 UI 里能看见、能吊销」的集合一致
   * （`/auth/keys` 列表即 per-org 视角）——否则会出现「说超限了、但我在这个组织里只看到 3 个」
   * 的死锁，用户无从自救。
   *
   * 目的不是防白嫖（按量计费已经防住），而是让「一个 key 后面站着一百个终端用户」这种
   * 代理转售模式在工程上不可行：转售方要覆盖 N 个客户就得先造 N 个成员身份。
   * 转售同时违反《使用条款》第四条（禁止转售、代理、出租服务访问权）。
   */
  E_KEY_LIMIT: {
    zh: "设备密钥数量已达上限，请先吊销不用的密钥再签发新的",
    en: "Device key limit reached; revoke an unused key before issuing a new one",
  },
  E_ORG_FROZEN: { zh: "组织余额已归零，组织通道只读冻结", en: "Organization balance depleted; org channel is read-only" },
  /**
   * 配额用尽（2026-10-09 启用）。
   *
   * 本码此前在词表里预留未用，文案原为「容量配额已用尽」（Storage quota）——那是按**容量**计费的设想。
   * 实际落地的是**个人云端版的月度读写额度**（月付 3000 / 季付 3500 / 年付 4000 次），故改为覆盖两种
   * 口径的通用表述，并**明确写出"下月 1 日自动重置"**：用户此刻最需要知道的是"什么时候能再用"，
   * 而不是"哪一类配额"。文案由服务端按 `kind`（read/write）另行补充细节，此处保持通用。
   */
  E_QUOTA_EXCEEDED: { zh: "本月读写额度已用尽，下月 1 日自动重置", en: "Monthly read/write quota exhausted; it resets on the 1st of next month" },
  /**
   * 个人云端版未订阅（2026-10-09 新增；**当前未启用**，保留为预留码）。
   *
   * 初版用途是"免费档 ⇒ 403 硬拒（免费版本地存储，数据不出本机）"。同日**二次调整**改为
   * 「不要 403，要温馨提示」⇒ 免费档现在**放行**，只在响应头出提示（`X-Xbb-Cloud-Notice`），
   * 故本码**当前没有消费方**。
   *
   * 保留而不删的理由：日后若做真正的付费墙、或其它需要"明确告知未订阅"的硬拒场景可直接启用
   * （语义已定：与 `E_ORG_FROZEN` 的"组织余额归零"、`E_QUOTA_EXCEEDED` 的"有额度但用完了"都不同——
   * 本码说的是**从未购买**）。⚠️ 启用前先确认产品口径真的改回硬拒，别让文案与行为再次失配。
   */
  E_SUBSCRIPTION_REQUIRED: { zh: "个人云端版需订阅后使用；免费版请使用本地客户端（数据只存本机）", en: "Personal Cloud requires a subscription; on the free plan use the local client (data stays on your machine)" },
  E_SPACE_FORBIDDEN: { zh: "无权访问该空间", en: "No access to this space" },
  E_RATE_LIMITED: { zh: "请求过于频繁，请稍后再试", en: "Rate limited, please retry later" },
  E_DUAL_GATE_BLOCKED: { zh: "该操作被双闸策略拦截", en: "Blocked by dual-gate policy" },
  E_SMS_RATE_LIMITED: { zh: "验证码发送过于频繁，请稍后再试", en: "Too many verification codes sent, please retry later" },
  E_SMS_CODE_INVALID: { zh: "验证码错误或已过期", en: "Verification code is invalid or expired" },
  E_ACCOUNT_LOCKED: { zh: "失败次数过多，账号已临时锁定", en: "Too many failed attempts, account temporarily locked" },
  E_SESSION_INVALID: { zh: "登录已过期，请重新登录", en: "Session expired, please sign in again" },
  E_INVITE_INVALID: { zh: "邀请码无效或已撤销", en: "Invite code is invalid or revoked" },
  E_INVITE_EXPIRED: { zh: "邀请链接已过期", en: "This invite has expired" },
  E_INVITE_EXHAUSTED: { zh: "邀请名额已用完", en: "Invite quota is exhausted" },
  E_INVITE_PHONE_NOT_ALLOWED: { zh: "该手机号不在邀请白名单内", en: "This phone number is not on the invite whitelist" },
  E_ORG_NAME_INVALID: { zh: "组织名需要 2-30 个字符", en: "Organization name must be 2-30 characters" },
  E_ORG_CREATE_LIMIT: { zh: "可创建的组织数量已达上限", en: "Organization creation limit reached" },
  E_MEMBER_DISABLED: { zh: "成员已被停用，请联系管理员", en: "Membership is disabled; contact your administrator" },
  /**
   * 成员可变操作的两条护栏（2026-10-07，成员目录加停用/封禁/删除时引入）。
   *
   * owner：组织唯一最高权限，停掉/删掉他就没人能再管这个组织（且 owner 转让需要短信二次验证，
   *   不是一个下拉菜单该顺手做的事）——所以 owner 必须先转让身份，再改自己的状态。
   * self：管理员停用自己 = 自锁（自己的 key/会话在闸②直接失效，且未必还有别的 admin 能救你）。
   *   两者都不是"参数不合法"，而是**机制层面的禁止**，故独立成码，前端可直接照文案提示。
   */
  E_OWNER_PROTECTED: {
    zh: "组织 Owner 不可停用、封禁或删除，请先转让 Owner 身份",
    en: "The organization owner cannot be disabled, banned or removed; transfer ownership first",
  },
  E_SELF_PROTECTED: { zh: "不能对自己执行该操作", en: "You cannot perform this action on yourself" },
  E_NOT_MEMBER: { zh: "你不是该组织的成员", en: "You are not a member of this organization" },
  E_CONSOLE_TICKET_INVALID: { zh: "管理台登录凭据无效或已过期，请重新进入", en: "Console ticket is invalid or expired, please restart from the account page" },
  E_BIND_TICKET_INVALID: { zh: "设备绑定凭据无效或已过期，请在管理台重新发起连接", en: "Device bind ticket is invalid or expired, please restart from the console" },
  E_NOT_FOUND: { zh: "对象不存在或已被删除", en: "Object not found or deleted" },
  E_VALIDATION: { zh: "参数不合法", en: "Invalid parameters" },
  /**
   * 写入/编辑撞去重键（2026-10-06 引入；2026-10-07 修法②后语义收窄）。
   *
   * 历史：`memories_org_content_hash_uq = (org_id, content_hash)` 是 org 级唯一索引
   * （additive-only 纪律，不可 DROP），而去重键原为 `sha256(content)` ⇒ 同组织内**别人的
   * 私密记忆**与本条逐字节相同时必然撞键。当时的处理是明确报错——绝不"静默串号成对方那条"
   * （那会让"我的记忆"变成"别人的记忆"，且调用方无从察觉）。
   *
   * 现状：去重键已纳入归属人（`sha256(归属人 ‖ 0x1F ‖ content)`），
   * 不同人写同一正文**各存一条、互不干扰**，本错误**不再是跨成员冲突**。剩余触发场景只有两个：
   *   ① **并发**：同一归属人同时两次写入同内容，两个事务互不可见 → 一个成功、一个撞键；
   *   ② **编辑**：把一条记忆改成与**自己另一条** active 记忆逐字节相同 → 撞自己的键。
   * 两者都是"你已经有一条一模一样的记忆"，故文案据此重写（旧文案"不在你的可见范围内"已不成立）。
   */
  E_DUPLICATE_CONTENT: {
    zh: "你已有一条完全相同的记忆，无需重复写入",
    en: "You already have an identical memory; no need to write it again",
  },
  E_PURGE_TOO_LARGE: { zh: "命中的记录过多，请收窄删除条件", en: "Too many records matched; narrow the deletion filter" },
  E_INTERNAL: { zh: "服务暂时不可用，请稍后再试", en: "Service temporarily unavailable, please retry later" },
} as const;

export type ErrorCode = keyof typeof ERRORS;
export type Locale = "zh-CN" | "en-US";

export function message(code: ErrorCode, locale: Locale = "zh-CN"): string {
  const m = ERRORS[code];
  return locale === "zh-CN" ? m.zh : m.en;
}
