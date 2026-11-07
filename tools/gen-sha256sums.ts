/**
 * 从已签名清单 manifest.json 生成 SHA256SUMS.txt（供 dl.xiaobenben.net/latest/ 使用）。
 *
 * 用法:
 *   bun run tools/gen-sha256sums.ts manifest.json > SHA256SUMS.txt
 *
 * 为什么复用 manifest 而不是重算：
 *  - manifest 的 sha256 已被 ed25519 签名覆盖，是**本次发布的权威哈希**；重算只是在
 *    重复同一件事，且会把 292MB 再读一遍。
 *  - 文件名从 manifest 各条目的 `url` 取 basename —— 单一真源，不在两处各写一份命名表
 *    （命名表一旦分叉，SHA256SUMS 里的文件名就会与实际产物对不上，用户校验永远失败）。
 *
 * 输出格式对齐 `sha256sum -c`：前两行是 `#` 注释，其后每行 `<hash>  <filename>`。
 */
import type { ManifestFiles } from "../src/update-payload";

const [manifestPath] = process.argv.slice(2);
if (!manifestPath) {
  console.error("用法: bun run tools/gen-sha256sums.ts <manifest.json>");
  process.exit(1);
}

const raw = JSON.parse(await Bun.file(manifestPath).text()) as {
  version?: string;
  files?: ManifestFiles;
};
const version = String(raw.version ?? "").trim();
const files = raw.files ?? {};

if (!version) {
  console.error("✗ manifest.json 里没有 version —— 拒绝生成来源不明的校验清单");
  process.exit(1);
}

/** 只收主产物与向量旁路包；两类的 url 都在 manifest 里，命名以 url 为准 */
const lines: string[] = [];
for (const key of Object.keys(files).sort()) {
  const entry = files[key];
  if (!entry?.url || !entry.sha256) continue;
  const name = entry.url.split("/").pop() ?? "";
  if (!name || name.includes("?")) {
    console.error(`✗ 条目 ${key} 的 url 取不出干净文件名：${entry.url}`);
    process.exit(1);
  }
  lines.push(`${entry.sha256}  ${name}`);
}

if (lines.length === 0) {
  console.error("✗ manifest 里没有任何可校验条目 —— 拒绝生成空清单");
  process.exit(1);
}

console.error(`[sha256sums] version=${version} · 条目=${lines.length}`);
console.log(
  [
    `# xiaobenben v${version} · sha256 校验清单`,
    `# 官方真源：https://dl.xiaobenben.net/latest/   （版本化归档：/releases/v${version}/）`,
    `# 用法：sha256sum -c SHA256SUMS.txt`,
    ...lines,
  ].join("\n"),
);
