// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)
/**
 * 小本本 opencode 适配器（宿主适配器）：
 * 每回合边界把对话文本 POST 到本地 xbb serve（http://127.0.0.1:17630/hooks/turn），
 * 命中记忆由小本本推入 inbox——宿主零感知（失败静默，绝不影响 opencode 本身）。
 *
 * 红线：本插件只"转发文本给本地服务"，不落盘、不外传（目标是 127.0.0.1 回环）；
 * 文本在小本本侧只做内存检索，永不持久化。
 *
 * 安装：把本文件放进 ~/.config/opencode/plugins/（或项目 .opencode/plugins/）即可，
 * 无需任何依赖与配置。未运行 xbb serve 时 fetch 失败静默忽略。
 *
 * 事件面做了防御式兼容：opencode 事件名随版本演进，这里宽松匹配
 * message.* 系列事件并从 payload 中尽力提取 text 字段；提取不到就跳过。
 */

const ENDPOINT = process.env.XBB_HOOK_URL ?? "http://127.0.0.1:17630/hooks/turn";
const MIN_LEN = 3;
const MAX_LEN = 4000;

/** 同一消息的多个 part 更新只 POST 一次（2s 去抖） */
const pending = new Map(); // key = messageID, value = timer

function extractText(info) {
  try {
    const payload = info?.event?.properties ?? info?.properties ?? {};
    // message.part.updated: { part: { type, text, messageID } }
    const part = payload.part ?? payload;
    if (part?.type === "text" && typeof part.text === "string") {
      return { text: part.text, key: part.messageID ?? part.text.slice(0, 32) };
    }
    // message.updated: { info: { ...parts[] } } 兜底
    const infoMsg = payload.info ?? payload.message;
    if (infoMsg?.parts) {
      const text = infoMsg.parts
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n");
      if (text) return { text, key: infoMsg.id ?? text.slice(0, 32) };
    }
  } catch {
    /* 结构不认识就跳过——插件永不抛错 */
  }
  return null;
}

export const XbbPush = async () => ({
  event: async (info) => {
    try {
      const type = String(info?.event?.type ?? info?.type ?? "");
      if (!type.startsWith("message.")) return;
      const hit = extractText(info);
      if (!hit) return;
      const text = hit.text.trim();
      if (text.length < MIN_LEN || text.length > MAX_LEN) return;
      if (pending.has(hit.key)) return;
      pending.set(
        hit.key,
        setTimeout(() => {
          pending.delete(hit.key);
          fetch(ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
          }).catch(() => {}); // serve 不在 = 静默（宿主零感知红线）
        }, 2000),
      );
      if (pending.size > 64) {
        // 防极端场景堆积：直接清最老的
        const oldest = pending.keys().next().value;
        clearTimeout(pending.get(oldest));
        pending.delete(oldest);
      }
    } catch {
      /* 顶层兜底：插件任何异常都不外溢 */
    }
  },
});
