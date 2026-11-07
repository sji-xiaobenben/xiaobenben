/**
 * MCP stdio 真机冒烟：模拟 AI 宿主走完整协议（initialize → tools/list → write/search/directives/episodes → inbox/forget）。
 * 工具面合并后版本：断言 20 工具超集（含 episodes、成员目录、补链、可见范围）。
 * 用法：bun run tools/mcp-smoke.ts（隔离 XBB_HOME，不碰真实个人库）
 */
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "xbb-mcp-smoke-"));
// XBB_HOME 隔离后模型目录也空了：指向本机已下载的模型（没有就跳过语义断言，CI 无网不误报）
const modelDir = process.env.XBB_MODEL_DIR ?? join(homedir(), ".xiaobenben", "models", "bge-small-zh-v1.5-int8");
const HAS_MODEL = existsSync(join(modelDir, "model_quantized.onnx"));
const proc = Bun.spawn(["bun", "run", "src/index.ts", "mcp"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, XBB_HOME: dir, ...(HAS_MODEL ? { XBB_MODEL_DIR: modelDir } : {}) },
});

const enc = new TextEncoder();
const send = (obj: unknown) => proc.stdin.write(enc.encode(JSON.stringify(obj) + "\n"));

const reader = proc.stdout.getReader() as ReadableStreamDefaultReader<Uint8Array>;
let buf = "";
const pending = new Map<number, (v: unknown) => void>();
let nextId = 1;

(async () => {
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
        /* 非协议行忽略（stderr 才是日志通道，这里只该有 JSON） */
      }
    }
  }
})();

function request(method: string, params?: unknown): Promise<never> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve as (v: unknown) => void);
    const timer = setTimeout(() => reject(new Error(`timeout waiting ${method}`)), 15000);
    timer.unref?.();
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const body = (r: unknown) =>
  JSON.parse((r as { result?: { content?: { text: string }[] } })?.result?.content?.[0]?.text ?? "{}");

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : "");
  } else {
    console.log(`PASS ${name}`);
  }
}

try {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  check(
    "initialize 握手（品牌 serverInfo + instructions 契约）",
    (init as never as { result?: { serverInfo?: { name?: string } } })?.result?.serverInfo?.name === "xiaobenben" &&
      typeof (init as never as { result?: { instructions?: string } })?.result?.instructions === "string",
    init,
  );
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = await request("tools/list");
  const tools = ((list as never as { result?: { tools?: { name: string }[] } })?.result?.tools ?? []).map((t) => t.name);
  const EXPECTED = [
    // 沿用既有设计
    "write_memory", "search_memory", "recall_topic", "recall_timeline", "recall_session",
    "get_memory", "get_related", "recall_directives", "recall_constraints", "reveal_secret",
    // inbox / ack / forget / stats
    "inbox", "ack", "forget", "stats",
    // 出件箱（2026-10-07）：AI 能答"我发出去的，对方签收了没"（收件人视角的 inbox 答不了）
    "outbox",
    // episodes 情景层（补遗）
    "log_episodes", "recall_episodes",
    // 组织成员目录（2026-10-06：AI 通知同事前的寻址入口）
    "list_members",
    // 事后补链（2026-10-06 C 方案：治"写入时忘了挂 supersedeIds"）
    "supersede",
    // 可见范围（2026-10-06 记忆访问权限：默认仅归属人，放宽要显式说给谁）
    "list_spaces", "set_memory_audience",
    // 取货（2026-10-15 文件记忆 V1：recall 只给提货单，取本体是独立动作）
    "get_asset",
  ];
  check("tools/list 22 工具超集", EXPECTED.every((t) => tools.includes(t)), tools);

  // 出件箱（本地模式）：空清单 + 说明，**不报错**——AI 据此如实回答"单机库没有别人来签收"。
  const obResp = await request("tools/call", { name: "outbox", arguments: {} });
  const obBody = body(obResp);
  check(
    "outbox（本地）空清单 + scope=local",
    obBody.scope === "local" && Array.isArray(obBody.items) && obBody.items.length === 0 &&
      typeof obBody.note === "string",
    obBody,
  );

  // 启动仪式：recall_directives（播种后应含默认约束 + 会话章）
  const dirResp = await request("tools/call", { name: "recall_directives", arguments: {} });
  const dirBody = body(dirResp);
  check(
    "recall_directives（会话章+默认约束+now）",
    dirBody.ok === true && typeof dirBody.sessionId === "string" &&
      (dirBody.defaultConstraints ?? []).length >= 8 && typeof dirBody.now === "string",
    dirBody,
  );
  const sid = dirBody.sessionId as string;

  // 批量写入（items[] 批量协议）
  const w = await request("tools/call", {
    name: "write_memory",
    arguments: {
      items: [
        { content: "冒烟测试：用户的部署日是每周四", type: "fact", terms: ["部署日", "周四", "节奏"], tags: ["smoke"] },
        { content: "冒烟测试：偏好深夜写代码", type: "preference", terms: ["深夜", "写代码", "作息"] },
      ],
    },
  });
  const wBody = body(w);
  check(
    "write_memory items[] 批量",
    wBody.ok !== false && Array.isArray(wBody.results) && wBody.results.length === 2 &&
      typeof wBody.summary === "string" && typeof wBody.now === "string",
    wBody,
  );

  // 检索（三路融合 + 链）
  const q = await request("tools/call", { name: "search_memory", arguments: { terms: ["部署日", "周四"] } });
  const qBody = body(q);
  check("search_memory 命中+now", qBody.ok !== false && (qBody.hits ?? []).some((h: { content: string }) => h.content.includes("部署日")) && typeof qBody.now === "string", qBody);

  // 延续链（supersedeIds 挂链 → 链头重定向）
  const head = wBody.results?.[0]?.id as string;
  const w2 = await request("tools/call", {
    name: "write_memory",
    arguments: { content: "冒烟测试：部署日改为每周三", type: "event", occurredAt: "2026-10-04", supersedeIds: [head], terms: ["部署日", "周三"] },
  });
  const w2Body = body(w2);
  check("write_memory supersede 挂链", w2Body.superseded?.[0] === head, w2Body);
  const q2 = await request("tools/call", { name: "search_memory", arguments: { terms: ["部署日"] } });
  const q2Body = body(q2);
  check(
    "search_memory 链头重定向+历史附注",
    q2Body.hits?.[0]?.id === w2Body.id && q2Body.hits[0].chain?.length === 1,
    q2Body,
  );

  // 语义通道入参分工（2026-10-19）：query 喂向量路（自然语言），terms 只喂词法三路。
  // ⚠️ 这条**只守契约，不证明「原句比词群准」**：小库向量会把候选全召回，名次差不显现
  //    （反向验证过：把实现改回 terms.join(" ") 这条仍 PASS ⇒ 行为断言无判别力，故不写成"效果证明"）。
  //    效果证据在真机 151 条库：词群偷懒场景原句 6/6 名次更前（22→2 / 24→1 / 17→4）。
  const rawTools = (((await request("tools/list")) as never as {
    result?: { tools?: Array<{ name: string; description?: string; inputSchema?: { properties?: Record<string, unknown> } }> };
  }).result?.tools ?? []);
  const smTool = rawTools.find((t) => t.name === "search_memory");
  check(
    "search_memory 暴露 query 入参（向量路吃原句，terms 只喂词法）",
    !!smTool?.inputSchema?.properties?.query && (smTool?.description ?? "").includes("vector"),
    smTool?.inputSchema,
  );
  if (HAS_MODEL) {
    body(await request("tools/call", {
      name: "write_memory",
      arguments: { content: "冒烟语义：这周六去水库钓鱼", type: "event", terms: ["钓鱼", "水库", "周末"] },
    }));
    // 向量回填是 fire-and-forget（写入不等待模型），首次还要加载 24MB ONNX ⇒ 轮询等它 ready
    let hitsQ: Array<{ content: string; matchedTerms?: string[] }> = [];
    for (let i = 0; i < 20; i++) {
      const probe = body(await request("tools/call", {
        name: "search_memory",
        arguments: { query: "这周六去水库钓鱼", terms: ["天气"] },
      }));
      hitsQ = (probe.hits ?? []) as Array<{ content: string; matchedTerms?: string[] }>;
      if (hitsQ.some((h) => h.content.includes("水库钓鱼"))) break;
      await Bun.sleep(300);
    }
    const rankQ = hitsQ.findIndex((h) => h.content.includes("水库钓鱼")) + 1;
    check(
      "search_memory 带 query 可用（语义通道通了，纯向量命中）",
      rankQ > 0 && (hitsQ[rankQ - 1]?.matchedTerms ?? []).join() === "vector",
      hitsQ,
    );
  } else {
    console.log("SKIP search_memory 语义可用性检查（本机没有 bge 模型）");
  }

  // 事后补链（C 方案）：写两条**不挂链** → 候选出现（B 方案）→ supersede 补链 → 链头重定向
  const nc1 = body(await request("tools/call", {
    name: "write_memory",
    arguments: { content: "冒烟补链：我爱吃西瓜", type: "preference", terms: ["西瓜", "爱吃", "水果", "口味"] },
  }));
  const nc2 = body(await request("tools/call", {
    name: "write_memory",
    arguments: { content: "冒烟补链：我不爱吃西瓜了，改吃萝卜", type: "preference", terms: ["西瓜", "萝卜", "口味", "水果"] },
  }));
  check(
    "write_memory 回传候选链头（B 方案只递材料）",
    (nc2.supersedeCandidates ?? []).some((c: { id: string }) => c.id === nc1.id),
    nc2,
  );
  const sp = body(await request("tools/call", { name: "supersede", arguments: { headId: nc2.id, supersededIds: [nc1.id] } }));
  check("supersede 工具补链成功", sp.headId === nc2.id && (sp.superseded ?? []).includes(nc1.id), sp);
  const q4 = body(await request("tools/call", { name: "search_memory", arguments: { terms: ["西瓜"] } }));
  check(
    "补链后 search 命中链头+历史附注",
    (q4.hits ?? []).some((h: { id: string; chain?: unknown[] }) => h.id === nc2.id && (h.chain ?? []).length >= 1),
    q4,
  );
  // 分叉封死：已被 nc2 延续的 nc1 不能再挂给第三条（拒绝并给出真链头）
  const nc3 = body(await request("tools/call", {
    name: "write_memory",
    arguments: { content: "冒烟补链：第三条关于水果", type: "fact", terms: ["西瓜", "萝卜", "水果", "口味"] },
  }));
  const sp2 = body(await request("tools/call", { name: "supersede", arguments: { headId: nc3.id, supersededIds: [nc1.id] } }));
  check(
    "supersede 分叉封死+给出真链头",
    (sp2.rejected ?? []).some((r: { id: string; currentHead?: string }) => r.id === nc1.id && r.currentHead === nc2.id),
    sp2,
  );

  // episodes 情景层
  const ep = await request("tools/call", {
    name: "log_episodes",
    arguments: { sessionId: sid, items: [{ role: "user", content: "冒烟原话：部署日为什么改到周三" }] },
  });
  const epBody = body(ep);
  check("log_episodes 入档", Array.isArray(epBody.ids) && epBody.ids.length === 1, epBody);
  const epq = await request("tools/call", { name: "recall_episodes", arguments: { q: "部署日为什么改到周三" } });
  const epqBody = body(epq);
  check("recall_episodes 冷路径命中", (epqBody.hits ?? []).some((h: { chunk: string }) => h.chunk.includes("部署日")), epqBody);

  // inbox/ack（needsAck）
  await request("tools/call", { name: "write_memory", arguments: { content: "冒烟建议条目待确认", type: "fact", needsAck: true, terms: ["建议"] } });
  const ib = body(await request("tools/call", { name: "inbox", arguments: {} }));
  const ackId = (ib.items ?? [])[0]?.id as string | undefined;
  const ak = body(await request("tools/call", { name: "ack", arguments: { id: ackId } }));
  check("inbox/ack 闭环", (ib.items ?? []).length >= 1 && ak.acked === true, { ib, ak });

  // forget（墓碑）
  const fg = body(await request("tools/call", { name: "forget", arguments: { id: wBody.results[1].id } }));
  const q3 = body(await request("tools/call", { name: "search_memory", arguments: { terms: ["深夜"] } }));
  check("forget 墓碑后不命中", fg.forgotten === true && !(q3.hits ?? []).some((h: { content: string }) => h.content.includes("深夜写代码")), { fg, q3 });

  // stats（含 now 对时）
  const st = body(await request("tools/call", { name: "stats", arguments: {} }));
  check(
    "stats（memories≥3 + now）",
    st.ok !== false && st.memories >= 3 && typeof st.forgotten === "number" && typeof st.now === "string",
    st,
  );

  // 成员目录（本地模式）：空清单 + 说明——**不是报错**（本地没有成员是事实，不是能力故障）
  const lm = body(await request("tools/call", { name: "list_members", arguments: {} }));
  check(
    "list_members 本地模式：空清单 + 说明",
    lm.ok !== false && lm.scope === "local" && Array.isArray(lm.members) && lm.members.length === 0 &&
      typeof lm.note === "string",
    lm,
  );

  // notify 在本地模式必须**显式拒绝**（静默丢弃会让 AI 以为"通知已发出"，对方却什么都收不到）
  const nf = body(
    await request("tools/call", {
      name: "write_memory",
      arguments: { content: "冒烟：试图通知同事", type: "fact", needsAck: true, notify: ["张三"] },
    }),
  );
  check("write_memory notify 本地模式显式拒绝", nf.ok === false && String(nf.error).includes("notify"), nf);

  // 空间清单（本地模式）：空清单 + 说明——同 list_members 的口径（没有部门是事实，不是故障）
  const ls = body(await request("tools/call", { name: "list_spaces", arguments: {} }));
  check(
    "list_spaces 本地模式：空清单 + 说明",
    ls.ok !== false && ls.scope === "local" && Array.isArray(ls.spaces) && ls.spaces.length === 0 &&
      typeof ls.note === "string",
    ls,
  );

  // 可见范围在本地必须**显式拒绝放宽**（静默忽略会让 AI 以为"已经公开给同事了"）
  const au = body(
    await request("tools/call", {
      name: "write_memory",
      arguments: { content: "冒烟：试图公开给全组织", type: "fact", audience: { org: true } },
    }),
  );
  check("write_memory audience 本地模式显式拒绝", au.ok === false && String(au.error).includes("audience"), au);

  // 但「恢复仅归属人」（默认档）是幂等的放宽的反面——本地本就如此，**不该**无谓报错
  const auNoop = body(
    await request("tools/call", {
      name: "write_memory",
      arguments: { content: "冒烟：显式设回默认档", type: "fact", audience: { org: false, spaces: [] } },
    }),
  );
  check("write_memory audience 默认档（不放宽）本地幂等放行", auNoop.ok !== false, auNoop);

  // 改档工具在本地：结构化 ok:false + 说明（不假装成功、不抛异常）
  const sa = body(
    await request("tools/call", { name: "set_memory_audience", arguments: { id: "any-id", audience: { org: true } } }),
  );
  check("set_memory_audience 本地模式：ok:false + 说明", sa.ok === false && typeof sa.reason === "string", sa);
} catch (e) {
  failures++;
  console.error("SMOKE ERROR:", e);
} finally {
  proc.kill();
  console.log(failures === 0 ? "SMOKE ALL PASS" : `SMOKE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
