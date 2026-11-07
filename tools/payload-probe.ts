// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 载荷（文件记忆 V1）**真机产物**探针：驱动【已安装的 xbb 可执行文件】跑完整 MCP 协议，
 * XBB_HOME 隔离在临时目录，**不碰真实个人库**。
 *
 * 与 tools/payload-smoke.ts 的分工（不是重复，是两个不同的验证目标）：
 *   · payload-smoke.ts = **源码树**回归（spawn `bun run src/index.ts mcp`）⇒ 进 `test:ci`，CI 可跑。
 *   · payload-probe.ts = **发布产物**验收（spawn 已安装的 exe）⇒ **刻意不进 test:ci**（CI 里没有已安装的 exe）。
 *     它要抓的是只在产物上成立的失败：CI 注入的版本号、`--compile` 打包行为、外置依赖（onnxruntime）
 *     在真机路径下的加载 —— 这些源码树跑一辈子也跑不出来。
 *
 * 验收项（16）：
 *   ① 附件写入回执：payloadId / bytes / mime / reused=false
 *   ② get_asset(as:ref) → 本机绝对路径
 *   ③ get_asset(as:inline) → resource block，**base64 解码后 sha256 == 磁盘文件**（字节真回环）
 *   ④ get_memory → payloads[] 提货单（state=ok、description 原样、**不含任何字节键**）
 *   ⑤ 同文件二次引用 → reused=true 且同一 payloadId（内容寻址去重）
 *   ⑥ 路径不存在 → dropped(not_found) 且**记忆照常写入**
 *   ⑦ 相对路径 → dropped(not_absolute)
 *   ⑧ state 实时算 ok → changed → missing，且引用 id 三态稳定
 *   ⑨ 同内容不同路径 → 复用同一 payload；**引用指向「首次登记路径」**（原路径消失即报 missing 的已知语义）
 *   ⑩ 落盘核对：user_version=5、payloads/memory_payloads 精确计数、列名是 description（migrateV5 生效）
 *
 * 用法：
 *   bun run tools/payload-probe.ts                  # 默认 ~/.xiaobenben/bin/xbb(.exe)
 *   bun run tools/payload-probe.ts <path-to-exe>    # 指定二进制
 *   XBB_PROBE_BIN=<path> bun run tools/payload-probe.ts
 *   XBB_PROBE_FILE=<path> ...                       # 用真实文件替代自动生成的 clip.webm
 */
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const isWin = process.platform === "win32";
const DEFAULT_BIN = join(homedir(), ".xiaobenben", "bin", isWin ? "xbb.exe" : "xbb");
const BIN = process.env.XBB_PROBE_BIN || process.argv[2] || DEFAULT_BIN;

if (!existsSync(BIN)) {
  console.error(`找不到可执行文件：${BIN}`);
  console.error(`用 <path-to-exe> 或 XBB_PROBE_BIN=<path> 指定；默认位置是 ${DEFAULT_BIN}`);
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), "xbb-payload-probe-home-"));
const work = mkdtempSync(join(tmpdir(), "xbb-payload-probe-files-"));

console.log(`目标二进制：${BIN}`);
console.log(`  大小 ${statSync(BIN).size} 字节 · 修改时间 ${statSync(BIN).mtime.toISOString()}`);
console.log(`  隔离 XBB_HOME：${home}\n`);

const proc = Bun.spawn([BIN, "mcp"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, XBB_HOME: home, XBB_SEED: "0" },
});

const enc = new TextEncoder();
const send = (obj: unknown) => {
  proc.stdin.write(enc.encode(JSON.stringify(obj) + "\n"));
  proc.stdin.flush();
};

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
    const timer = setTimeout(() => reject(new Error(`timeout waiting ${method}`)), 30000);
    timer.unref?.();
    send({ jsonrpc: "2.0", id, method, params });
  });
}

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
    console.error(`FAIL ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 600) : "");
  } else {
    console.log(`PASS ${name}`);
  }
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const sha256File = (p: string) => sha256(readFileSync(p));

try {
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "payload-probe", version: "0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = (await request("tools/list")) as unknown as { result?: { tools?: { name: string }[] } };
  const tools = (list?.result?.tools ?? []).map((t) => t.name);
  check("tools/list 含 get_asset 取货工具", tools.includes("get_asset"), tools.length);

  // ── 准备文件：① 二进制（宿主读不进文本，只能真挂）② 可改可删的文本 ──
  const probeFile = process.env.XBB_PROBE_FILE;
  const CLIP_BYTES = 196284;
  const clip = probeFile && existsSync(probeFile) ? probeFile : join(work, "clip.webm");
  if (clip !== probeFile) writeFileSync(clip, randomBytes(CLIP_BYTES));
  const clipSize = statSync(clip).size;
  const note = join(work, "note.txt");
  writeFileSync(note, "probe note v1\n", "utf8");
  const missing = join(work, "nope-xyz.txt");

  // ── ① 二进制文件挂附件 ──
  const w1 = await callTool("write_memory", {
    content: "payload probe 条目 alpha：二进制文件按引用登记",
    type: "fact",
    terms: ["payload", "probe", "附件", "文件记忆", "二进制"],
    attachments: [{ ref: clip, description: "一段用于探针的二进制载荷（视频容器），验证非文本文件能否真实登记并原样取回。" }],
  });
  const att1 = ((w1.data as never as { attachments?: Array<{ payloadId: string; reused: boolean; bytes: number; mime: string | null }> }).attachments) ?? [];
  check("① 二进制附件写入 → 回执 payloadId（reused=false）",
    att1.length === 1 && typeof att1[0].payloadId === "string" && att1[0].reused === false, att1);
  check("① bytes 与磁盘一致、mime 已识别",
    att1[0]?.bytes === clipSize && typeof att1[0]?.mime === "string" && att1[0]!.mime!.length > 0,
    { got: att1[0]?.bytes, want: clipSize, mime: att1[0]?.mime });
  const pid1 = att1[0]?.payloadId;

  // ── ② get_asset = ref ──
  const gRef = await callTool("get_asset", { payloadId: pid1, as: "ref" });
  const refPath = String((gRef.data as never as { ref?: string }).ref ?? "");
  check("② get_asset(ref) → 本机绝对路径",
    refPath.toLowerCase().replace(/\//g, "\\") === clip.toLowerCase() || refPath === clip, gRef.data);

  // ── ③ get_asset = inline：字节真回环（sha256 必须相等）──
  const gIn = await callTool("get_asset", { payloadId: pid1, as: "inline" });
  const resBlock = gIn.blocks.find((b) => b.type === "resource");
  const blob = resBlock?.resource?.blob;
  if (!blob) {
    check("③ get_asset(inline) → MCP resource block", false, gIn.blocks.map((b) => b.type));
  } else {
    const got = sha256(Buffer.from(blob, "base64"));
    const want = sha256File(clip);
    check("③ inline 字节 sha256 == 磁盘文件（R1 字节真回环）", got === want, { got: got.slice(0, 16), want: want.slice(0, 16) });
  }

  // ── ④ get_memory → 提货单（不含字节）──
  const gm1 = await callTool("get_memory", { id: (w1.data as never as { id: string }).id });
  const pls = (gm1.data as never as { payloads?: Array<{ id: string; state: string; ref: string; description: string | null; bytes: number }> }).payloads ?? [];
  check("④ get_memory 带 payloads 提货单", pls.length === 1, gm1.data);
  check("④ state=ok、description 原样回读、ref 指向原路径",
    pls[0]?.state === "ok" && (pls[0]?.description ?? "").includes("二进制载荷") && pls[0]?.ref === clip, pls[0]);
  check("④ 提货单不含任何字节键（只给单，不给货）",
    !pls[0] || !["blob", "bytes_b64", "content", "data"].some((k) => k in (pls[0] as object)), Object.keys(pls[0] ?? {}));

  // ── ⑤ 同文件二次引用 → 内容寻址去重 ──
  const w2 = await callTool("write_memory", {
    content: "payload probe 条目 beta：同一份字节只登记一次",
    type: "fact",
    terms: ["payload", "probe", "复用", "去重"],
    attachments: [{ ref: clip, description: "不该覆盖已有描述" }],
  });
  const att2 = ((w2.data as never as { attachments?: Array<{ payloadId: string; reused: boolean }> }).attachments) ?? [];
  check("⑤ 同文件二次引用 → reused=true 且同一 payloadId",
    att2.length === 1 && att2[0].payloadId === pid1 && att2[0].reused === true, att2);

  // ── ⑥ 路径不存在 → dropped，但记忆照常写入（降级铁律）──
  const w3 = await callTool("write_memory", {
    content: "payload probe 条目 gamma：附件进不去但记忆进得去",
    type: "fact",
    terms: ["payload", "probe", "降级", "not_found"],
    attachments: [{ ref: missing }],
  });
  const w3d = w3.data as never as { ok?: boolean; id?: string; droppedAttachments?: Array<{ reason: string }>; attachments?: unknown[] };
  check("⑥ 路径不存在 → dropped(not_found) 且记忆照常写入",
    w3d.ok === true && typeof w3d.id === "string"
      && w3d.droppedAttachments?.[0]?.reason === "not_found" && !w3d.attachments, w3d);

  // ── ⑦ 相对路径 → dropped ──
  const w4 = await callTool("write_memory", {
    content: "payload probe 条目 delta：相对路径被拒",
    type: "fact",
    terms: ["payload", "probe", "绝对路径"],
    attachments: [{ ref: "relative\\note.txt" }],
  });
  const w4d = w4.data as never as { droppedAttachments?: Array<{ reason: string }> };
  check("⑦ 相对路径 → dropped(not_absolute)", w4d.droppedAttachments?.[0]?.reason === "not_absolute", w4d);

  // ── ⑧ state 实时算：ok → changed → missing，引用 id 全程不变 ──
  const w5 = await callTool("write_memory", {
    content: "payload probe 条目 epsilon：state 三态实时计算",
    type: "fact",
    terms: ["payload", "probe", "state", "changed", "missing"],
    attachments: [{ ref: note, description: "probe 用的可修改便签" }],
  });
  const mid5 = (w5.data as never as { id: string }).id;
  const pid5 = (((w5.data as never as { attachments?: Array<{ payloadId: string }> }).attachments) ?? [])[0]?.payloadId;
  const stateOf = async (id: string) => {
    const g = await callTool("get_memory", { id });
    const p = ((g.data as never as { payloads?: Array<{ id: string; state: string }> }).payloads?.[0]) ?? undefined;
    return p;
  };
  const s_ok = await stateOf(mid5);
  writeFileSync(note, "probe note v2 — 内容已变\n", "utf8");
  const s_changed = await stateOf(mid5);
  rmSync(note);
  const s_missing = await stateOf(mid5);
  check("⑧ state 实时算 ok → changed → missing（不是落库的陈旧值）",
    [s_ok?.state, s_changed?.state, s_missing?.state].join(",") === "ok,changed,missing",
    [s_ok, s_changed, s_missing]);
  check("⑧ 引用 id 三态稳定（payloadId 不随文件变动）",
    !!pid5 && s_ok?.id === pid5 && s_changed?.id === pid5 && s_missing?.id === pid5,
    { 写入时: pid5, 三态: [s_ok?.id, s_changed?.id, s_missing?.id] });

  // ── ⑨ 同内容不同路径：去重复用 + 「首次登记路径」语义 ──
  const sameA = join(work, "same-a.txt");
  const sameB = join(work, "same-b.txt");
  for (const p of [sameA, sameB]) writeFileSync(p, "identical bytes\n", "utf8");
  const wa = await callTool("write_memory", {
    content: "payload probe 条目 zeta：同内容不同路径 A",
    type: "fact", terms: ["payload", "probe", "去重语义"],
    attachments: [{ ref: sameA, description: "同内容文件 A" }],
  });
  const wb = await callTool("write_memory", {
    content: "payload probe 条目 eta：同内容不同路径 B",
    type: "fact", terms: ["payload", "probe", "去重语义"],
    attachments: [{ ref: sameB, description: "同内容文件 B" }],
  });
  const pa = (((wa.data as never as { attachments?: Array<{ payloadId: string; reused: boolean }> }).attachments) ?? [])[0];
  const pb = (((wb.data as never as { attachments?: Array<{ payloadId: string; reused: boolean }> }).attachments) ?? [])[0];
  check("⑨ 同内容不同路径 → 复用同一 payload（恒等式是 sha256）",
    pb?.reused === true && pb?.payloadId === pa?.payloadId, { A: pa, B: pb });
  rmSync(sameA);
  const afterA = await stateOf((wa.data as never as { id: string }).id);
  check("⑨ 已知语义：引用指向【首次登记路径】⇒ 原路径消失即报 missing（内容其实还在 B）",
    afterA?.state === "missing" && existsSync(sameB), { state: afterA?.state, B仍存在: existsSync(sameB) });

  // ── ⑩ 落盘核对：迁移链与精确计数 ──
  const db = new Database(join(home, "memory.db"));
  const uv = db.query("PRAGMA user_version").get() as { user_version: number } | null;
  const nPay = db.query("SELECT COUNT(*) AS n FROM payloads").get() as { n: number };
  const nMap = db.query("SELECT COUNT(*) AS n FROM memory_payloads").get() as { n: number };
  const cols = (db.query("PRAGMA table_info(payloads)").all() as Array<{ name: string }>).map((c) => c.name);
  const rows = db.query("SELECT sha256, bytes, mime, status, description FROM payloads").all() as Array<{
    sha256: string; bytes: number; mime: string | null; status: string; description: string | null;
  }>;
  db.close();

  check("⑩ user_version=5（migrateV5 已跑）", uv?.user_version === 5, uv);
  check("⑩ 列名是 description、已无 digest（改名迁移生效）",
    cols.includes("description") && !cols.includes("digest"), cols);
  check("⑩ payloads=3 / memory_payloads=5（2 份字节被挂 5 次 ⇒ 去重生效）",
    nPay.n === 3 && nMap.n === 5, { payloads: nPay.n, memory_payloads: nMap.n });
  check("⑩ 每行都有 description（附件唯一检索入口不可为空）",
    rows.length === 3 && rows.every((r) => (r.description ?? "").length > 0), rows);
  check("⑩ 行状态为 ready（非 evicted —— 本地模式无回收）",
    rows.every((r) => r.status === "ready"), rows.map((r) => r.status));
} catch (e) {
  failures++;
  console.error("PROBE 异常", e);
} finally {
  proc.kill();
  try { rmSync(home, { recursive: true, force: true }); } catch { /* 忽略 */ }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(failures ? `\nPAYLOAD PROBE FAILED (${failures})` : "\nPAYLOAD PROBE OK");
process.exit(failures ? 1 : 0);
