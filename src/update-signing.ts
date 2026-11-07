// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 发版私钥的处理单一真源——签名工具（tools/sign-manifest.ts）与
 * 流水线自检（tools/check-signing-key.ts）共用，避免两处各写一份解析逻辑。
 *
 * 为什么单独成模块：私钥 PEM 的形态在真实环境里会走样——GitHub 网页 UI 粘贴 secret
 * 时常把换行吃掉、或者存成字面量 `\n`。这类问题只在发版那一刻才暴露，且报错信息通常是
 * 无信息量的 "DECODER routines::unsupported"，排查成本极高。收敛到一处做归一化。
 */
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

/**
 * 把各种走样形态的私钥归一成合法 PEM。
 * 支持三种输入：① 正常多行 PEM；② 换行被转义成字面量 `\n` 的 PEM；③ 只剩 base64 体
 * （头尾被吃掉）。ed25519 私钥必为 PKCS#8，所以形态 ③ 可直接补出 PKCS#8 头尾。
 */
export function normalizePem(raw: string): string {
  const s = raw.trim();
  if (s.includes("-----BEGIN")) {
    // 形态 ②：字面量 \n 还原成真换行（正常 PEM 里不含 "\n" 字面量，替换是安全的）
    return s.replace(/\\n/g, "\n").trim();
  }
  // 形态 ③：补 PKCS#8 头尾
  const body = s.replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

/** 从私钥 PEM 派生出 SPKI DER 的 base64 —— 即 exe 内置公钥 UPDATE_PUBKEY 的同构形态 */
export function derivePublicKeyB64(pem: string): string {
  const priv = createPrivateKey(normalizePem(pem));
  return createPublicKey(priv).export({ format: "der", type: "spki" }).toString("base64");
}

/** 公钥指纹 = sha256(SPKI DER) 的十六进制（build-meta.ts 注释里登记的那一串） */
export function publicKeyFingerprint(pubKeyB64: string): string {
  return createHash("sha256").update(Buffer.from(pubKeyB64, "base64")).digest("hex");
}
