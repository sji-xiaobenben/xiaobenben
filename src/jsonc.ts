// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 最小 JSONC 剥离器：把 `//` 行注释、`/* *\/` 块注释、尾逗号去掉，得到可 `JSON.parse` 的文本。
 *
 * 为什么需要它：opencode 的官方配置示例**全部**用 `opencode.jsonc`，带注释和尾逗号是常态。
 * 而 `JSON.parse` 遇到注释直接抛错 —— 于是 `xbb connect` 会把一个完全正常、正在工作的
 * 配置判成「未接入」（2026-11-16 用户反馈原文）。
 *
 * 为什么不引依赖：这里只做「读一眼配置」这一件事，引一个 JSONC 库等于给一条只读命令
 * 增加一份攻击面与升级负担。项目在 `install.mjs` 的签名校验、`connect.ts` 的 TOML 扫描
 * 上已经做过同样的取舍。
 *
 * 为什么不用「正则一次性删注释」：正则分不清「字符串里的 // 」和「注释」——
 * `"command": "https://x/y"` 会被删成 `"command": "https:`，配置直接坏掉。
 * 所以必须是状态机：只有**不在字符串内**的 `/` 才可能是注释。
 *
 * 已知取舍：只处理双引号字符串（JSON/JSONC 不允许单引号，遇到单引号按普通字符处理，
 * 这样反而更安全 —— 不会把 `'...//...'` 里的内容误删）。剥离失败时调用方仍会走
 * `JSON.parse` 的 catch 分支，降级成「这个文件读不了」，不会崩。
 */

/** 去掉注释与尾逗号。返回的文本可以直接喂给 `JSON.parse`。 */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;

  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];

    if (inString) {
      out += c;
      // 转义序列要整段吞掉：`"\\"` 里的 `\` 不能结束字符串
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    // 行注释：吃到换行为止（换行本身保留，行号才不会错位）
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    // 块注释：吃到 */ 为止。未闭合就吃到结尾 —— 交给 JSON.parse 去报错
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // 尾逗号：`,` 后面除了空白就是 } 或 ] ⇒ 丢掉这个逗号。
    // 必须在状态机里做，不能用 `/,(\s*[}\]])/` 事后替换 —— 那会把字符串里的 `",]"` 也改坏。
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      const after = text[j];
      if (after === "}" || after === "]") {
        i++; // 跳过逗号，把空白留给下一轮原样输出
        continue;
      }
    }

    out += c;
    i++;
  }

  return out;
}

/** 解析 JSONC；失败时抛出的仍是 `JSON.parse` 的原始错误，便于调用方统一话术。 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text));
}
