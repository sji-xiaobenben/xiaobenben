/**
 * 自更新签名载荷 —— 签名（tools/sign-manifest.ts）与验签（updater.ts）的**唯一真源**。
 *
 * 为什么不直接对 manifest.json 的 JSON 文本签名：
 *   JSON 序列化在不同语言/实现间不稳定——键序、空格缩进、Unicode 转义（"/" 是否转义、
 *   非 ASCII 是否 \uXXXX）任何一处不同，字节就不同。CI 用一套序列化签、客户端用另一套序列化验，
 *   就会算出两个串，更新全线失败。而且这种 bug 只在发版时才暴露，代价极高。
 *   因此改用一个「行式规范化载荷」：结构固定、跨语言可复现、且人工可读可直接 diff。
 *
 * 保护范围 = version + 每个平台的 (sha256, size)。
 *   刻意不保护 url：内容已由 sha256 绑定——改 url 只会导致下载后校验失败，
 *   攻击者无法借改 url 让客户端装上有用之物。少签一个字段 = 少一处漂移风险。
 *
 * 载荷形态（LF 分隔，无尾随换行）：
 *   xbb-update-v1
 *   0.4.12
 *   darwin-arm64:<sha256>:<size>
 *   linux-x64:<sha256>:<size>
 *   win32-x64:<sha256>:<size>
 * key 按字典序排列——顺序即语义，签名双方必须都走本函数。
 */

export const UPDATE_PAYLOAD_MAGIC = "xbb-update-v1";

/** manifest.files 的单项（key 形如 `${platform}-${arch}`） */
export interface ManifestFile {
  url: string;
  /** 多源回落：逐个尝试，首个成功者用（CDN 优先、镜像兜底） */
  urls?: string[];
  sha256: string;
  size: number;
}

export type ManifestFiles = Record<string, ManifestFile>;

/** 生成确定性签名字符串。签名方与验签方都必须调用本函数，不得各自拼串。 */
export function buildUpdatePayload(version: string, files: ManifestFiles): string {
  const lines = Object.keys(files)
    .sort()
    .map((key) => {
      const f = files[key]!;
      return `${key}:${f.sha256}:${f.size}`;
    });
  return [UPDATE_PAYLOAD_MAGIC, version, ...lines].join("\n");
}
