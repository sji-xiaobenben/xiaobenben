// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 发版前自检：确认手里的私钥与 exe 内置公钥是同一对。
 *
 * 守的是什么灾难：私钥一旦轮换而 build-meta.ts 的 UPDATE_PUBKEY 没同步更新，客户端会对
 * **所有**新清单判验签失败 → 全量用户的自更新静默停摆，而服务端一切正常、CI 全绿、
 * 上传成功。没有任何其他环节会报错，只能靠人肉发现。所以必须在出包前硬拦。
 *
 * 用法（CI 与本地应急发版共用）：
 *   UPDATE_SIGNING_KEY="$(cat ~/.xbb-keys/xbb-update-signing.pem)" bun run tools/check-signing-key.ts
 *
 * 退出码：0 = 配对；1 = 不配对 / 私钥不可用；2 = 未提供私钥（调用方自行决定是否视为错误）
 */
import { UPDATE_PUBKEY } from "../src/build-meta";
import { derivePublicKeyB64, publicKeyFingerprint } from "../src/update-signing";

const pem = process.env.UPDATE_SIGNING_KEY;
if (!pem) {
  console.error("未提供 UPDATE_SIGNING_KEY —— 无法判断密钥配对，跳过（调用方请自行决定语义）");
  process.exit(2);
}

let derived: string;
try {
  derived = derivePublicKeyB64(pem);
} catch (e) {
  console.error(`✗ 私钥无法解析：${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

if (derived !== UPDATE_PUBKEY) {
  console.error("✗ 私钥与 exe 内置公钥不是一对 —— 拒绝发版。");
  console.error(`  私钥派生公钥 fingerprint: ${publicKeyFingerprint(derived)}`);
  console.error(`  build-meta 内置公钥 fp : ${publicKeyFingerprint(UPDATE_PUBKEY)}`);
  console.error("  修法：把新公钥写进 cli/src/build-meta.ts 的 UPDATE_PUBKEY，或换回与内置公钥配对的私钥。");
  process.exit(1);
}

console.log(`✓ 私钥与内置公钥配对 · fingerprint=${publicKeyFingerprint(derived)}`);
