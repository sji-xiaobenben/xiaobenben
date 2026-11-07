/**
 * SSE 字节流 → 帧 的纯解析（从 `events.ts` 抽出来的唯一理由：**可单测**）。
 *
 * 流式解析有两个必须成对做对的事，任何一件漏了都只在"网络刚好在中间切开"时才暴露，
 * 本地跑一次往往看不出来：
 *  ① **跨 chunk 的半帧**：`data: {"seq":1` 与 `2}` 分两次到达，必须暂存拼接；
 *  ② **CRLF**：代理/中间件把 `\n\n` 改写成 `\r\n\r\n`，且 `\r` 与 `\n` 还可能分包到达。
 */

/** 一帧（只保留我们真正会用到的字段；`retry:` 等忽略） */
export interface SseFrame {
  /** `event:` 的值（缺省为 `message`） */
  event: string;
  /** `data:` 多行按 SSE 规范用 `\n` 拼接 */
  data: string;
  /** `id:` 的值（`org_event` 帧上是 org_seq） */
  id?: string;
}

/**
 * 纯函数：解析一个 SSE 块（不含块尾空行）。
 * 返回 `null` = 该块没有任何可交付内容（纯注释/心跳注释行、空块）。
 */
export function parseSseBlock(block: string): SseFrame | null {
  let event = "";
  let id: string | undefined;
  const data: string[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line) continue;
    if (line.startsWith(":")) continue; // 注释行（sse.ts 的 25s 心跳就是这种）
    const c = line.indexOf(":");
    const field = c < 0 ? line : line.slice(0, c);
    let value = c < 0 ? "" : line.slice(c + 1);
    if (value.startsWith(" ")) value = value.slice(1); // 规范：冒号后一个前导空格要吃掉
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (!data.length && !event) return null;
  return { event: event || "message", data: data.join("\n"), ...(id !== undefined ? { id } : {}) };
}

/**
 * 纯函数：从累积缓冲区里切出**完整**的帧，返回剩下的**半帧**（调用方存回去等下一 chunk）。
 * 只认 `\n\n` 分隔——先把 `\r\n` 归一成 `\n`，这样"`\r` 与 `\n` 分包到达"也自然成立。
 */
export function parseSseChunk(buf: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let s = buf.replace(/\r\n/g, "\n");
  for (;;) {
    const i = s.indexOf("\n\n");
    if (i < 0) break;
    const block = s.slice(0, i);
    s = s.slice(i + 2);
    const f = parseSseBlock(block);
    if (f) frames.push(f);
  }
  return { frames, rest: s };
}
