// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 构建元数据 —— 产品版本与版权署名的单一来源。
 * VERSION / BUILD_TIME 在正式发版时由 release.yml 用 sed 注入（真源分别是 package.json
 * 的 version 与发版时刻），两者同时作为构建指纹的输入：`xbb version` 输出指纹，同源构建
 * 指纹一致，用于核对版本是否出自同一次构建。
 * 注意：MCP stdio 模式下这些信息只进协议字段（serverInfo），不得打印到 stdout。
 */
import { createHash } from "node:crypto";

export const PRODUCT_NAME = "小本本";
export const PRODUCT_EN = "xiaobenben";
// 本地开发的占位值：CI 发版时会被 sed 替换成 package.json 里的 version（真源在那里）。
// 这里跟着改成当前版本，只是为了让本地直接构建出的产物不至于声称自己是个旧版本。
export const VERSION = "0.4.47";
// 发版时同样被 sed 注入成 `2026-11-08 17:40` 这样的实际时刻；本地直接构建保持 "local"。
// **刻意不写一个具体日期**：那会让 fork 者今天构建出的产物自称是某个历史时间构建的，
// 排查「这个 exe 到底哪来的」时会把人带偏——宁可说"不知道"，也不要说一个错的。
export const BUILD_TIME = "local";
export const VENDOR = "世纪之城（广州）信息科技有限公司";
export const VENDOR_SHORT = "SJi";
export const OFFICIAL_SITE = "https://www.xiaobenben.net";

/**
 * 自更新默认清单地址。
 * 固定入口、与版本号无关——这是自更新能成立的**前提**：若这里指向自己版本的清单路径，
 * 客户端永远只能查到自己那一版，版本比较恒判「已是最新」，自更新自我闭环。
 * 发版时被覆盖的只有内容，地址恒定不变。
 * env `XBB_UPDATE_URL` 语义：未设 → 用本默认值；设空串 → 关闭自更新（企业/离线包）；设值 → 用该值（私有镜像）。
 */
export const UPDATE_URL_DEFAULT = "https://dl.xiaobenben.net/channels/stable.json";

/**
 * 自更新清单签名公钥（ed25519，SPKI DER 的 base64）。
 * 与 `UPDATE_SIGNING_KEY`（私钥，只在 CI Secrets 与发版机 ~/.xbb-keys）配对。
 * 指纹（sha256 of SPKI DER）= 42ff1a2292c885cb3e927785b90af39cfffb32310e002f70c66e6915927bb012
 *
 * 为什么必须有它：manifest 里的 sha256 对同一份 manifest 自证，防得住传输损坏、
 * 防不住源被劫持（能改 CDN/OSS/DNS 的人可以同时替换 exe 和 sha256）。公钥内置后，
 * 攻击者没有私钥就签不出新清单，客户端验签失败即拒绝更新。
 */
export const UPDATE_PUBKEY = "MCowBQYDK2VwAyEAc1RR4vsllVQ1BDf4pxauUOI1djJu+L9rS91V581n2wI=";


/** 构建指纹：同源构建一致，改动版本/时间/署名即变——用于识别构建来源 */
export function fingerprint(): string {
  return createHash("sha256").update(`${PRODUCT_EN}|${VERSION}|${BUILD_TIME}|${VENDOR}`).digest("hex").slice(0, 16);
}

/** 单行署名（页脚/日志用） */
export function copyrightLine(): string {
  return `© 2026 ${VENDOR} · 官方站点 ${OFFICIAL_SITE}`;
}

/** 完整版本横幅（version/serve 启动日志用） */
export function banner(): string {
  return `${PRODUCT_NAME} (${PRODUCT_EN}) v${VERSION} · 构建 ${BUILD_TIME} · 指纹 ${fingerprint()}\n${copyrightLine()}`;
}
