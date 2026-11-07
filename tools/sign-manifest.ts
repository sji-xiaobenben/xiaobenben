/**
 * 给更新清单 manifest.json 加 ed25519 签名。
 * 发布流水线（.github/workflows/release.yml）与本地应急脚本（tools/publish-local.sh）共用本工具。
 *
 * 载荷由 src/update-payload.ts 生成 —— 与客户端 updater.ts 的验签**同一份代码**，
 * 不存在「CI 用一套序列化签、客户端用另一套验」的漂移风险（这类 bug 只在发版时才炸）。
 *
 * 用法：
 *   UPDATE_SIGNING_KEY="$(cat ~/.xbb-keys/xbb-update-signing.pem)" \
 *     bun run tools/sign-manifest.ts manifest.json
 *
 * 私钥只从环境变量读，绝不落盘、绝不进 git。
 */
import { createPrivateKey, sign } from "node:crypto";
import { buildUpdatePayload, type ManifestFiles } from "../src/update-payload";
import { normalizePem, publicKeyFingerprint, derivePublicKeyB64 } from "../src/update-signing";

const file = process.argv[2];
if (!file) {
  console.error("用法: UPDATE_SIGNING_KEY=<PKCS#8 PEM> bun run tools/sign-manifest.ts <manifest.json>");
  process.exit(1);
}

const pem = process.env.UPDATE_SIGNING_KEY;
if (!pem) {
  console.error("缺少 UPDATE_SIGNING_KEY（ed25519 PKCS#8 PEM）。");
  console.error("提示: 本地应急发版请 export UPDATE_SIGNING_KEY=\"$(cat ~/.xbb-keys/xbb-update-signing.pem)\"");
  process.exit(1);
}

const manifest = (await Bun.file(file).json()) as {
  version?: string;
  files?: ManifestFiles;
  sig?: string;
};

if (!manifest.version || !manifest.files || typeof manifest.files !== "object") {
  console.error("manifest 缺 version 或 files —— 拒绝签名（签一个残缺清单比不签更危险）");
  process.exit(1);
}

const payload = buildUpdatePayload(manifest.version, manifest.files);
let signature: Buffer;
let fingerprint = "";
try {
  const key = createPrivateKey(normalizePem(pem));
  signature = sign(null, Buffer.from(payload, "utf8"), key);
  fingerprint = publicKeyFingerprint(derivePublicKeyB64(pem));
} catch (e) {
  console.error(`私钥解析/签名失败: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

manifest.sig = signature.toString("base64");
await Bun.write(file, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `[sign] 已签名 ${file} · version=${manifest.version} · 平台数=${Object.keys(manifest.files).length}` +
    ` · payload=${payload.length}B · sig=${signature.length}B · key-fp=${fingerprint.slice(0, 16)}`
);
