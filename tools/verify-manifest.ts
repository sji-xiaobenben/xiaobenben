// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 核验更新清单签名——发布后自检专用。
 * 用**内置公钥**验（即客户端将来用的同一把），确认上传上去的那份清单确实被我们的私钥签过。
 *
 * 用法:
 *   bun run tools/verify-manifest.ts ./manifest.json
 *   bun run tools/verify-manifest.ts https://dl.xiaobenben.net/channels/stable.json
 */
import { verifyManifestSignature, type UpdateManifest } from "../src/updater";

const target = process.argv[2];
if (!target) {
  console.error("用法: bun run tools/verify-manifest.ts <manifest.json 或 URL>");
  process.exit(1);
}

let manifest: UpdateManifest;
try {
  manifest = (
    target.startsWith("http")
      ? await (await fetch(target, { signal: AbortSignal.timeout(20_000) })).json()
      : await Bun.file(target).json()
  ) as UpdateManifest;
} catch (e) {
  console.error(`✗ 清单读取失败 ${target}: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

const platforms = manifest?.files ? Object.keys(manifest.files) : [];
if (verifyManifestSignature(manifest)) {
  console.log(`✓ 签名有效 · version=${manifest.version} · 平台=${platforms.join(", ") || "（无）"}`);
  process.exit(0);
}

console.error("✗ 签名无效、缺失，或与内置公钥不匹配 —— 拒绝");
process.exit(1);
