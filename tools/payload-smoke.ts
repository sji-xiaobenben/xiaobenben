// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 载荷（文件记忆 V1）真机冒烟：走完整 MCP 协议，隔离 XBB_HOME，不碰真实个人库。
 * 覆盖的验收项：
 *   ① 带路径附件写入 → payloads 有行 + memory_payloads 有挂载（回执给 payloadId）
 *   ② 同一份字节被第二条记忆引用 → **内容寻址命中，复用同一 payloadId**（零新增）
 * ③ 路径不存在 → dropped(not_found)，**但记忆照常写入**（降级铁律）
 *   ④ 相对路径 → dropped(not_absolute)（只认本机绝对路径）
 *   ⑤ state 三态：ok → changed（改了内容）→ missing（删了文件）
 *   ⑥ recall 带 payloads 提货单（不含字节）；**无载荷的记忆不出现 payloads 键**
 *   ⑦ get_asset：ref 返路径；inline 返 resource block
 * 用法：bun run tools/payload-smoke.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "xbb-payload-smoke-"));
const work = mkdtempSync(join(tmpdir(), "xbb-payload-files-"));

const proc = Bun.spawn(["bun", "run", "src/index.ts", "mcp"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, XBB_HOME: home, XBB_SEED: "0" },
});

const enc = new TextEncoder();
const send = (obj: unknown) => proc.stdin.write(enc.encode(JSON.stringify(obj) + "\n"));

const reader = proc.stdout.getReader() as ReadableStreamDefaultReader<Uint8Array>;
let buf = "";
const pending = new Map<number, (v: unknown) => void>();
let nextId = 1;

void (async () => {
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number };
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch {
        /* stderr 才是日志通道，这里只该有 JSON */
      }
    }
  }
})();

function request(method: string, params?: unknown): Promise<never> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve as (v: unknown) => void);
    const timer = setTimeout(() => reject(new Error(`timeout waiting ${method}`)), 20000);
    timer.unref?.();
    send({ jsonrpc: "2.0", id, method, params });
  });
}

/** 调工具：返回解析后的 JSON（text block）+ 全部 content blocks（get_asset inline 要看 resource） */
async function callTool(name: string, args: unknown) {
  const r = (await request("tools/call", { name, arguments: args })) as unknown as {
    result?: { content?: Array<{ type: string; text?: string; resource?: { blob?: string; mimeType?: string } }> };
  };
  const blocks = r?.result?.content ?? [];
  const textBlock = blocks.find((c) => c.type === "text");
  return { blocks, data: (textBlock?.text ? JSON.parse(textBlock.text) : null) as Record<string, never> };
}

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 500) : "");
  } else {
    console.log(`PASS ${name}`);
  }
}

try {
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "payload-smoke", version: "0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = (await request("tools/list")) as unknown as { result?: { tools?: { name: string }[] } };
  const tools = (list?.result?.tools ?? []).map((t) => t.name);
  check("tools/list 含 get_asset 取货工具", tools.includes("get_asset"), tools.length);

  // ── 准备文件 ──
  const CONTENT1 = "hello payload content v1\n";
  const fileA = join(work, "note.txt");
  writeFileSync(fileA, CONTENT1, "utf8");
  const missing = join(work, "nope.txt");

  // ── ① 带附件写入 ──
  const w1 = await callTool("write_memory", {
    content: "payload smoke 条目 alpha：文件按引用登记",
    type: "fact",
    terms: ["payload", "smoke", "附件", "文件记忆"],
    attachments: [{ ref: fileA, description: "一份用于冒烟的纯文本便签" }],
  });
  const att1 = (w1.data as never as { attachments?: Array<{ payloadId: string; reused: boolean; bytes: number; mime: string | null }> }).attachments ?? [];
  check(
    "① 带路径附件写入 → 回执给 payloadId（reused=false，bytes/mime 已识别）",
    att1.length === 1 && typeof att1[0].payloadId === "string" && att1[0].reused === false
      && att1[0].bytes === Buffer.byteLength(CONTENT1) && att1[0].mime === "text/plain",
    att1,
  );
  const pid1 = att1[0]?.payloadId;

  // ── ② 同一份字节被另一条记忆引用 → 内容寻址命中，复用 ──
  const w2 = await callTool("write_memory", {
    content: "payload smoke 条目 beta：同一份字节只登记一次",
    type: "fact",
    terms: ["payload", "smoke", "复用", "去重"],
    attachments: [{ ref: fileA, description: "不该覆盖已有描述" }],
  });
  const att2 = (w2.data as never as { attachments?: Array<{ payloadId: string; reused: boolean }> }).attachments ?? [];
  check("② 同字节二次引用 → 复用同一 payloadId（reused=true，零新增）",
    att2.length === 1 && att2[0].payloadId === pid1 && att2[0].reused === true, att2);

  // ── ③ 路径不存在 → dropped，但记忆照常写入 ──
  const w3 = await callTool("write_memory", {
    content: "payload smoke 条目 gamma：附件进不去但记忆进得去",
    type: "fact",
    terms: ["payload", "smoke", "降级"],
    attachments: [{ ref: missing }],
  });
  const w3d = w3.data as never as { ok?: boolean; id?: string; droppedAttachments?: Array<{ reason: string }>; attachments?: unknown[] };
  check("③ 路径不存在 → dropped(not_found) 且**记忆照常写入**（id 存在、无 attachments）",
    w3d.ok === true && typeof w3d.id === "string"
      && w3d.droppedAttachments?.[0]?.reason === "not_found" && !w3d.attachments, w3d);

  // ── ④ 相对路径 → dropped ──
  const w4 = await callTool("write_memory", {
    content: "payload smoke 条目 delta：相对路径被拒",
    type: "fact",
    terms: ["payload", "smoke", "绝对路径"],
    attachments: [{ ref: "relative\\note.txt" }],
  });
  const w4d = w4.data as never as { droppedAttachments?: Array<{ reason: string }> };
  check("④ 相对路径 → dropped(not_absolute)", w4d.droppedAttachments?.[0]?.reason === "not_absolute", w4d);

  // ── ⑥a 检索带提货单（此时文件未动 → state=ok）──
  const s1 = await callTool("search_memory", { terms: ["payload", "smoke", "附件"] });
  const hits1 = (s1.data as never as { hits?: Array<{ id: string; content: string; payloads?: Array<{ id: string; state: string; ref: string; description: string | null; bytes: number }> }> }).hits ?? [];
  const withPayload = hits1.find((h) => h.payloads?.length);
  check("⑥a 检索命中带 payloads 提货单（含 ref/description/state，**不含字节**）",
    !!withPayload && withPayload.payloads![0].state === "ok"
      && withPayload.payloads![0].ref === fileA
      && withPayload.payloads![0].description === "一份用于冒烟的纯文本便签"
      && !("blob" in withPayload.payloads![0]),
    withPayload?.payloads);

  // ── ⑤ changed：改内容（大小也变，轻校验即可判出）──
  writeFileSync(fileA, "hello payload content v2 — 内容已变，长度也不同\n", "utf8");
  const s2 = await callTool("search_memory", { terms: ["payload", "smoke", "附件"] });
  const h2 = ((s2.data as never as { hits?: Array<{ payloads?: Array<{ state: string }> }> }).hits ?? []).find((h) => h.payloads?.length);
  check("⑤a 文件被改 → state=changed（不静默当原件）", h2?.payloads?.[0]?.state === "changed", h2?.payloads);

  // ── ⑤ missing：删文件 ──
  rmSync(fileA);
  const s3 = await callTool("search_memory", { terms: ["payload", "smoke", "附件"] });
  const h3 = ((s3.data as never as { hits?: Array<{ payloads?: Array<{ state: string }> }> }).hits ?? []).find((h) => h.payloads?.length);
  check("⑤b 文件被删 → state=missing（缺失不静默）", h3?.payloads?.[0]?.state === "missing", h3?.payloads);

  // ── ⑦ get_asset：missing 时拒绝（不给失效路径）──
  const g0 = await callTool("get_asset", { payloadId: pid1 });
  const g0d = g0.data as never as { ok?: boolean; state?: string; warning?: string };
  check("⑦a get_asset(ref) 对已删除文件 → 仍回 ref 但明确 warning + state=missing",
    g0d.ok === true && g0d.state === "missing" && typeof g0d.warning === "string", g0d);

  // ── ⑦ get_asset inline：把文件**恢复成写入时的原始内容**（验证 state 是实时算的、不是落库的陈旧值）──
  writeFileSync(fileA, CONTENT1, "utf8");
  const g1 = await callTool("get_asset", { payloadId: pid1, as: "inline" });
  const resBlock = g1.blocks.find((b) => b.type === "resource");
  check("⑦b get_asset(inline) → 回传 **resource block**（模态中立载体，不按 mime 分支）",
    !!resBlock?.resource?.blob
      && resBlock.resource.mimeType === "text/plain"
      && Buffer.from(resBlock.resource.blob, "base64").toString("utf8").startsWith("hello payload"),
    { hasBlock: !!resBlock, mime: resBlock?.resource?.mimeType });

  const g1d = g1.data as never as { ok?: boolean; delivered?: boolean; state?: string };
  check("⑦c get_asset(inline) 业务体 delivered=true、state=ok", g1d.ok === true && g1d.delivered === true && g1d.state === "ok", g1d);

  // ── ⑥b 无载荷的记忆**不出现 payloads 键**（向后兼容：不污染既有宿主上下文）──
  const w5 = await callTool("write_memory", {
    content: "payload smoke 条目 epsilon：这条没有任何附件",
    type: "fact",
    terms: ["payload", "smoke", "无附件"],
  });
  const id5 = (w5.data as never as { id?: string }).id;
  const gm = await callTool("get_memory", { id: id5 });
  const gmHas = Object.prototype.hasOwnProperty.call(gm.data ?? {}, "payloads");
  check("⑥b 无载荷的记忆**不出现 payloads 键**（而非空数组）", gmHas === false, Object.keys(gm.data ?? {}));

  // ── 无 payloads 键的一致性：带附件的记忆在 get_memory 里应有 ──
  const gm2 = await callTool("get_memory", { id: (w1.data as never as { id?: string }).id });
  check("⑥c 带附件的记忆在 get_memory 里有 payloads",
    ((gm2.data as never as { payloads?: unknown[] }).payloads ?? []).length === 1, gm2.data);
} catch (e) {
  failures++;
  console.error("SMOKE 异常", e);
} finally {
  proc.kill();
  try { rmSync(home, { recursive: true, force: true }); } catch { /* 忽略 */ }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(failures ? `\nPAYLOAD SMOKE FAILED (${failures})` : "\nPAYLOAD SMOKE OK");
process.exit(failures ? 1 : 0);
