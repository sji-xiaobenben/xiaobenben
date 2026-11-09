// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 本地服务装配：healthz / stats / verify / report / 管理窗口页。
 * 纪律：只监听 127.0.0.1（个人库默认态）；端口 17630 固定。
 */
import { modelsDir } from "./home";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PersonalStore } from "./store";
import { defaultDbPath } from "./store";
import { ORG_PERSONAL } from "./schema";
import { handleServe as handleAdmin, localGuard } from "./web/admin";
import { tokenize } from "./tokenize";
import { VERSION as BUILD_VERSION } from "./build-meta";
import type { IngestScheduler } from "./ingest-job";
import { INACTIVE_SNAPSHOT } from "./ingest-job";

const STARTED_AT = Date.now();

/**
 * 最后一次收到请求的时刻。
 * 唯一用途：会话采集挑**没人用页面的时候**开跑（采集子进程会写库，
 * 在用户点「删除」的同一瞬间去抢写锁，换来的是"点了没反应"）。
 * 记在这里而不是 sessionStorage：服务端才是唯一知道全局有没有人在用的地方。
 */
let lastRequestAt = 0;
export function lastRequestAtMs(): number {
  return lastRequestAt || Number.NEGATIVE_INFINITY;
}

/** 行规范化：tags JSON → 数组（查询端点共用） */
function this_rows(rows: unknown[]): unknown[] {
  return (rows as Array<{ tags: string }>).map((r) => {
    let tags: unknown = [];
    try { tags = JSON.parse(r.tags); } catch { /* 损坏行不阻断列表 */ }
    return { ...r, tags };
  });
}

/** 健康报告（A6）：用户可读的诊断快照——无内容、无隐私，只有计数与状态 */
async function buildReport(store: PersonalStore, port: number) {
  const dbPath = defaultDbPath();
  let dbSize = 0;
  try {
    dbSize = statSync(dbPath).size;
  } catch {
    /* 库文件尚未创建 */
  }
  // 模型缓存扫描（通用目录扫描，不耦合具体模型名）：models/<name>/ 下的文件清单
  const modelsRoot = modelsDir(); // 模型跟数据目录走，不跟程序目录
  const models: Array<{ name: string; files: Array<{ name: string; size: number }>; verified: boolean }> = [];
  try {
    for (const name of readdirSync(modelsRoot)) {
      const dir = join(modelsRoot, name);
      if (!statSync(dir).isDirectory()) continue;
      const files = readdirSync(dir).map((f) => ({ name: f, size: statSync(join(dir, f)).size }));
      models.push({ name, files, verified: existsSync(join(dir, ".ok")) });
    }
  } catch {
    /* models 目录不存在 = 未下载任何模型 */
  }
  let chainOk = false;
  try {
    chainOk = await store.verifyChain(ORG_PERSONAL);
  } catch {
    /* 空库等边界 */
  }
  return {
    ok: true,
    service: "xiaobenben",
    version: process.env.XBB_VERSION ?? BUILD_VERSION,
    platform: `${process.platform}/${process.arch}`,
    runtime: `bun-${Bun.version}`,
    ts: new Date().toISOString(),
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    port,
    db: { path: dbPath, sizeBytes: dbSize },
    chain: { ok: chainOk },
    stats: store.stats(),
    models,
  };
}

export async function startServe(store: PersonalStore, port = 17630, opts: { ingest?: IngestScheduler } = {}) {
  const db = () => store.db;
  // 采集器由 index.ts 装配（测试里不传 ⇒ 页面不显示采集相关提示，也不会有子进程）
  const ingest = opts.ingest;
  // 默认约束幂等播种（补遗；XBB_SEED=0 关闭）
  if (process.env.XBB_SEED !== "0") {
    const { seedDefaultConstraints } = await import("./seed");
    await seedDefaultConstraints(store);
  }
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: async (req) => {
      // 来源闸必须在**一切路由之前**：本文件自己还挂着一批端点（读全库 / 删密钥 / 触发更新），
      // 早期这些端点是在 handleAdmin 之外处理的，于是 Host/Origin 校验只护住了 /api/*。
      // 后果不是"少一层防护"，而是 DNS rebinding 下**整库可读**：恶意页面把自己的域名解析到
      // 127.0.0.1，同源请求带上 `Host: evil.example`，只要服务端不看 Host 就会照答。
      const guard = localGuard(req);
      if (guard) return guard;
      const url = new URL(req.url);
      // 页面每 5 秒轮询一次采集状态：那不算「有人在用」，否则空闲闸永远等不到窗口
      if (url.pathname !== "/api/ingest") lastRequestAt = Date.now();
      if (url.pathname === "/healthz") {
        return Response.json({ ok: true, service: "xiaobenben", ts: new Date().toISOString() });
      }
      if (url.pathname === "/stats") {
        return Response.json({ ok: true, db: defaultDbPath(), port, ...store.stats() });
      }
      if (url.pathname === "/verify") {
        const ok = await store.verifyChain(ORG_PERSONAL);
        return Response.json({ ok, events: store.stats().events });
      }
      // ---------- 自更新：提示 → 用户明确同意 → 才落盘 ----------
      // 只读快照，不打网络：管理窗口可能轮询，不能每次轮询都去捶 CDN
      if (url.pathname === "/update-check" && req.method === "GET") {
        const { currentVersion, readNoticeState, pendingUpdate, noticeEnabled } = await import("./update-notice");
        const state = readNoticeState();
        const pending = pendingUpdate();
        return Response.json({
          ok: true,
          enabled: noticeEnabled(),
          current: currentVersion(),
          latest: state?.latestVersion ?? null,
          available: !!pending,
          // 已就位待重启：这时该说的是「重启生效」而不是「要不要更新」
          applied: !!state?.latestVersion && state.appliedVersion === state.latestVersion,
          checkedAt: state?.checkedAt ?? null,
        });
      }
      // 显式更新入口：管理窗口「立即更新」/ 托盘「检查更新」/ `xbb update` 三者同一语义。
      // 刻意不做后台静默替换——那样"要不要更新"这句询问就是假的。
      if (url.pathname === "/update" && req.method === "POST") {
        const { Updater } = await import("./updater");
        const { markApplied } = await import("./update-notice");
        const result = await new Updater().checkAndApply(true);
        if (result.status === "swapped") markApplied(result.version);
        return Response.json({ ok: result.status !== "failed", result });
      }
      if (url.pathname === "/update-dismiss" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as { version?: string } | null;
        if (!body?.version) return Response.json({ ok: false, error: "invalid_version" }, { status: 400 });
        const { dismissUpdate } = await import("./update-notice");
        dismissUpdate(body.version);
        return Response.json({ ok: true });
      }
      // ---------- 会话采集的开关与状态（页面「温馨提示」的数据源） ----------
      // 采集跑在独立子进程里，父进程只知道"在跑/跑完了/上次进了几条"。
      if (url.pathname === "/api/ingest" && req.method === "GET") {
        return Response.json({ ok: true, ...(ingest ? ingest.snapshot() : INACTIVE_SNAPSHOT) });
      }
      if (url.pathname === "/api/ingest" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
        if (!ingest) return Response.json({ ok: false, error: "ingest_unavailable" }, { status: 409 });
        if (typeof body?.enabled !== "boolean") {
          return Response.json({ ok: false, error: "invalid_enabled" }, { status: 400 });
        }
        return Response.json({ ok: true, ...ingest.setEnabled(body.enabled) });
      }
      if (url.pathname === "/report") {
        return Response.json(await buildReport(store, port));
      }
      if (url.pathname === "/report/export") {
        const report = await buildReport(store, port);
        const name = `xbb-report-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
        return new Response(JSON.stringify(report, null, 2), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="${name}"`,
          },
        });
      }
      // ---------- 内容侧面板（A4 内容管理）：浏览 / 搜索 / 忘记 / 确认 ----------
      // 只读端点直接查库（127.0.0.1 only）；变更动作必须走 store（落 events 哈希链）。
      if (url.pathname === "/memories" && req.method === "GET") {
        const urlQ = new URL(req.url);
        const q = (urlQ.searchParams.get("q") ?? "").trim();
        const limit = Math.min(Number(urlQ.searchParams.get("limit")) || 20, 100);
        const offset = Math.max(Number(urlQ.searchParams.get("offset")) || 0, 0);
        const toks = q ? [...new Set(tokenize(q))] : [];
        let rows: unknown[];
        let total: number;
        if (toks.length > 0) {
          // 搜索：与 MCP recall 同一三级漏斗（AND 优先 → OR 降级），加分页与状态过滤
          const likeAnd = toks.map(() => `content LIKE '%' || ? || '%'`).join(" AND ");
          const likeOr = toks.map(() => `content LIKE '%' || ? || '%'`).join(" OR ");
          const hitOrder = toks.map(() => `(CASE WHEN content LIKE '%' || ? || '%' THEN 1 ELSE 0 END)`).join(" + ");
          const base = (where: string, order: string, params: unknown[]) =>
            `FROM memories WHERE status = 'active' AND (${where}) ${order}`;
          let hits = this_rows(store.db.query(
            `SELECT id, content, tags, needs_ack AS needsAck, created_at AS createdAt ` +
            base(likeAnd, "ORDER BY created_at DESC LIMIT ? OFFSET ?", [...toks, limit, offset]),
          ).all(...toks, limit, offset) as unknown[]);
          if (hits.length === 0 && toks.length > 1) {
            hits = this_rows(store.db.query(
              `SELECT id, content, tags, needs_ack AS needsAck, created_at AS createdAt ` +
              base(likeOr, `ORDER BY (${hitOrder}) DESC, created_at DESC LIMIT ? OFFSET ?`, [...toks, ...toks, limit, offset]),
            ).all(...toks, ...toks, limit, offset) as unknown[]);
          }
          rows = hits;
          const tr = store.db.query(
            `SELECT count(*) AS n ` + base(likeAnd, "", toks),
          ).get(...toks) as { n: number };
          total = tr.n;
        } else {
          rows = this_rows(store.db.query(
            `SELECT id, content, tags, needs_ack AS needsAck, created_at AS createdAt
             FROM memories WHERE status = 'active'
             ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          ).all(limit, offset) as unknown[]);
          total = (store.db.query(`SELECT count(*) AS n FROM memories WHERE status = 'active'`).get() as { n: number }).n;
        }
        return Response.json({ ok: true, rows, total });
      }
      if (url.pathname === "/memories/inbox" && req.method === "GET") {
        return Response.json({ ok: true, rows: store.inbox({ limit: 100 }) });
      }
      if (url.pathname === "/memories/forget" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as { id?: string } | null;
        if (!body?.id) return Response.json({ ok: false, error: "invalid_id" }, { status: 400 });
        const forgotten = await store.forget(body.id, "user-ui");
        return Response.json({ ok: forgotten, error: forgotten ? undefined : "not_found" }, { status: forgotten ? 200 : 404 });
      }
      // ---------- 管理后台 v2（功能面增补）----------
      // 会话存档：sessions 分组统计 + 原话回放（冷存档，仅本地）
      if (url.pathname === "/sessions" && req.method === "GET") {
        const rows = db().prepare(
          `SELECT session_id, COUNT(*) AS count, MIN(created_at) AS first, MAX(created_at) AS last
           FROM memories WHERE session_id IS NOT NULL AND status != 'forgotten'
           GROUP BY session_id ORDER BY last DESC LIMIT 100`
        ).all();
        return Response.json({ ok: true, rows });
      }
      const mSession = url.pathname.match(/^\/sessions\/([\w-]+)\/transcript$/);
      if (mSession && req.method === "GET") {
        const { sessionTranscript } = await import("./episodes");
        return Response.json({ ok: true, rows: sessionTranscript(db(), mSession[1]!) });
      }
      // 密钥保险箱：脱敏清单（永不返回明文）+ 删除
      if (url.pathname === "/secrets" && req.method === "GET") {
        const rows = db().prepare(
          "SELECT id, label, substr(value_hash, 1, 8) AS hash8, created_at FROM secrets ORDER BY id DESC"
        ).all();
        // 挂到哪条记忆在用（编号占位符反查）
        const usage = db().prepare(
          "SELECT id, substr(content, 1, 60) AS preview FROM memories WHERE content LIKE ? AND status = 'active' LIMIT 5"
        );
        const rows2 = (rows as Array<{ id: number; label: string | null; hash8: string; created_at: string }>).map((r) => {
          const used = usage.all(`%[[xbb_secret_id:${r.id}]]%`) as Array<{ id: string; preview: string }>;
          return { ...r, usedIn: used };
        });
        return Response.json({ ok: true, rows: rows2 });
      }
      if (url.pathname === "/secrets/delete" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as { id?: number } | null;
        if (!body?.id) return Response.json({ ok: false, error: "invalid_id" }, { status: 400 });
        const used = db().prepare("SELECT COUNT(*) AS n FROM memories WHERE content LIKE ? AND status = 'active'").get(`%[[xbb_secret_id:${body.id}]]%`) as { n: number };
        if (used.n > 0) return Response.json({ ok: false, error: `仍有 ${used.n} 条在用记忆引用此箱号，先处理引用再删` }, { status: 409 });
        db().prepare("DELETE FROM secrets WHERE id = ?").run(body.id);
        return Response.json({ ok: true });
      }
      // 清理预览（purge 纪律：只统计不动数据，用户在页面确认后另行操作）
      if (url.pathname === "/purge/preview" && req.method === "GET") {
        const one = (sql: string) => (db().prepare(sql).get() as { n: number }).n;
        return Response.json({
          ok: true,
          forgotten: one("SELECT COUNT(*) AS n FROM memories WHERE status = 'forgotten'"),
          expiredDirectives: one("SELECT COUNT(*) AS n FROM memories WHERE kind = 'directive' AND expires_at IS NOT NULL AND expires_at < datetime('now','localtime') AND status = 'active'"),
          lowImportance: one("SELECT COUNT(*) AS n FROM memories WHERE importance < 0.3 AND kind = 'memory' AND status = 'active' AND superseded_by IS NULL"),
          note: "预览只统计不动数据；遗忘走 /memories/forget（墓碑可审计）",
        });
      }
      if (url.pathname === "/memories/ack" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as { id?: string } | null;
        if (!body?.id) return Response.json({ ok: false, error: "invalid_id" }, { status: 400 });
        const acked = await store.ack(body.id, "user-ui");
        return Response.json({ ok: acked, error: acked ? undefined : "not_found" }, { status: acked ? 200 : 404 });
      }
      // 主动记忆推送：客户端钩子在回合边界转发的文本，内存检索命中即推 inbox。
      // 红线①：text 只在内存中匹配，永不落盘、永不进 events、永不进日志。
      if (url.pathname === "/hooks/turn" && req.method === "POST") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
        }
        const raw = (body as { text?: unknown } | null)?.text;
        if (typeof raw !== "string" || raw.trim().length < 3 || raw.length > 4000) {
          return Response.json({ ok: false, error: "invalid_text" }, { status: 400 });
        }
        const text = raw.trim();
        const hits = store.searchProactive(text, { limit: 3 }); // 每回合最多推 3 条（噪声上限）
        const pushed: { id: string; score: number }[] = [];
        for (const h of hits) {
          // 已在 inbox 的返回 false——同一条记忆绝不重复打扰（去重）
          if (await store.pushToInbox(h.memoryId, "hook")) pushed.push({ id: h.memoryId, score: h.score });
        }
        return Response.json({ ok: true, matched: hits.length, pushed });
      }
      if (url.pathname === "/" || url.pathname === "/ui") {
        // 管理后台（浅色暖调 + 全部交互）
        return handleAdmin(store, req);
      }
      if (url.pathname.startsWith("/api/")) {
        return handleAdmin(store, req);
      }
      return new Response("not found" + String.fromCharCode(10), { status: 404 });
    },
  });
}
