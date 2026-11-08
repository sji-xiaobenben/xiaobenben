#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)
/**
 * 小本本钩子适配器（通用版）：六宿主共用一份脚本。
 *
 * 零依赖、零 import（只用全局 API）→ node / bun 皆可直接执行，
 * 不受所在目录 package.json type 影响。
 *
 * 兼容两种输入形态，自动识别：
 *   1) stdin JSON —— Claude Code / Cursor(beforeSubmitPrompt) / Trae / WorkBuddy
 *      的 UserPromptSubmit：{"prompt": "...", "session_id": "..."}
 *      （字段探测顺序 prompt → text → user_prompt → input → message → content）
 *   2) 命令行参数 JSON —— Codex CLI 的 notify 钩子（argv 中找第一段可解析 JSON）：
 *      {"type":"agent-turn-complete","input-messages":[...],"last-assistant-message":"..."}
 *
 * 行为红线（违者即翻车）：
 *   - 对话原文只在本地内存匹配，绝不落盘；适配器自身零持久化
 *   - 候选不注入：stdout 恒为空，绝不往宿主上下文塞任何记忆内容
 *     （Trae 等宿主会把 stdout 当 additionalContext 注入，故本脚本什么都不打印）
 *   - fail-open：任何失败（服务未起/超时/解析失败）静默退出 0，绝不阻塞宿主回合
 *
 * 配置：XBB_HOOK_URL 环境变量可覆盖端点，默认 http://127.0.0.1:17630/hooks/turn
 */
const ENDPOINT = process.env.XBB_HOOK_URL || "http://127.0.0.1:17630/hooks/turn";

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(""); // 交互调用无管道输入
    let d = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => resolve(d));
    setTimeout(() => resolve(d), 1500); // 兜底：个别宿主不关 stdin
  });
}

function extractText(obj) {
  if (!obj || typeof obj !== "object") return "";
  // 注意：last-assistant-message 刻意不在此列——Codex 形态须与 input-messages 一同拼接，
  // 若放进这里会短路掉用户消息（2026-10-04 修：hooks-smoke 的 argv 用例因此长期红）。
  for (const k of ["prompt", "text", "user_prompt", "input", "message", "content"]) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  // Codex 形态：用户消息数组 + 助手最后一条
  const parts = [];
  if (Array.isArray(obj["input-messages"])) parts.push(...obj["input-messages"].filter((x) => typeof x === "string"));
  if (typeof obj["last-assistant-message"] === "string" && obj["last-assistant-message"].trim()) parts.push(obj["last-assistant-message"]);
  return parts.join("\n");
}

async function main() {
  try {
    let obj = null;
    const raw = await readStdin();
    try {
      obj = JSON.parse(raw);
    } catch {
      /* stdin 非 JSON → 落 argv 探测（Codex 形态） */
    }
    if (!obj || typeof obj !== "object") {
      for (const a of process.argv.slice(2)) {
        try {
          const p = JSON.parse(a);
          if (p && typeof p === "object") { obj = p; break; }
        } catch { /* 非JSON参数跳过 */ }
      }
    }
    const text = extractText(obj).trim().slice(0, 3500); // server 上限 4000，留余量
    if (text.length < 3) return; // 太短不值得检索（server 同校验，双保险）
    await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* 静默：服务未起/网络故障绝不影响宿主 */
  }
}
main();
