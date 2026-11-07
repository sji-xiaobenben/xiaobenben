// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 小本本 web 管理后台（serve 模式）
 * 零依赖：HTML 内嵌字符串 + Bun.serve API 路由
 * 功能：列表 / 搜索 / 查看 / 编辑 / 删除（软删除墓碑）
 */
/**
 * 管理后台（浅色暖调）。
 * 适配点（全部注释在案）：
 *  1. id INTEGER→UUIDv7 字符串（memories；secrets 保留 INTEGER——占位符格式兼容存量文案）
 *  2. recorded_at→created_at（SELECT 别名保持前端字段名不变；purge 时间窗改 ISO）
 *  3. FTS：触发器自动同步 → 删手动 ftsDelete/ftsInsert（防双写）
 *  4. 软删除双列：deleted_at + status='forgotten'（触发器据 status 同步 FTS）
 *  5. 存活过滤补 status!='forgotten'（双保险）
 *  6. 增量端点（memories、sessions、secrets 系列）仍并存于 serve.ts，本文件接管 / 与 /api/*
 */
import type { Database } from "bun:sqlite";
import { ORG_PERSONAL } from "../schema";
import { payloadHash } from "@xbb/core";
import type { PersonalStore } from "../store";
import { searchMemory } from "../memory-search";
import { localNow } from "../memory-write";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
// 产品元数据单一来源（此前此处硬编码 VERSION = "0.2.0"，与 build-meta 漂移）
import { PRODUCT_NAME, PRODUCT_EN, VERSION, OFFICIAL_SITE } from "../build-meta";

type AnyDb = Database;

// ── FTS 同步（外部内容表必须手动维护索引） ──

function ftsDelete(db: AnyDb, id: number, content: string) {
  db.prepare(
    "INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', ?, ?)"
  ).run(id, content);
}
function ftsInsert(db: AnyDb, id: number, content: string) {
  db.prepare("INSERT INTO memories_fts (rowid, content) VALUES (?, ?)").run(id, content);
}

// ── API 处理 ──

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function readBody(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}

/** 本机来源白名单：Host 防 DNS rebinding（恶意域名解析到 127.0.0.1 伪装同源），
 *  Origin 防 CSRF（恶意网页跨站 POST；浏览器对同源 POST 会带 Origin=本机来源，curl 不带）。
 *  将来若支持 --host 局域网访问，必须配套开机一次性令牌鉴权，仅放开绑定不够。 */
/** 回环主机名（端口无关——serve 支持 PORT 覆盖冒烟；过去写死 17630，已适配） */
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function localGuard(req: Request): Response | null {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  const hostName = host.replace(/:\d+$/, "");
  if (!LOOPBACK_NAMES.has(hostName)) {
    return new Response(JSON.stringify({ error: "forbidden host" }), { status: 403, headers: { "content-type": "application/json" } });
  }
  const origin = req.headers.get("origin");
  if (origin) {
    const o = origin.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "").replace(/:\d+$/, "");
    if (!LOOPBACK_NAMES.has(o)) {
      return new Response(JSON.stringify({ error: "forbidden origin" }), { status: 403, headers: { "content-type": "application/json" } });
    }
  }
  return null;
}

export async function handleServe(store: PersonalStore, req: Request): Promise<Response> {
  const db = store.db;
  const guard = localGuard(req);
  if (guard) return guard;
  const url = new URL(req.url);
  const p = url.pathname;

  if (p === "/" || p === "/ui" || p === "/index.html") return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });

  // GET /api/list —— 最近记忆（分页 + kind 类型筛选 + session 会话检索）
  if (p === "/api/list") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
    const kind = url.searchParams.get("kind") ?? "all";
    const KINDS = ["memory", "directive", "habit", "constraint"];
    const kindOn = KINDS.includes(kind);
    const session = (url.searchParams.get("session") ?? "").trim();
    const where = session
      ? "m.session_id = ?"
      : kindOn ? "m.kind = ?" : "1=1";
    const params = session ? [session] : kindOn ? [kind] : [];
    const rows = db.prepare(`
      SELECT m.id, m.kind, m.type, m.dscope, m.domain, m.starts_at, m.expires_at, m.status, m.system, m.similar_sessions, m.hit_count, m.superseded_by,
             m.session_id, m.content, m.tags, m.entities, m.occurred_at, m.created_at AS recorded_at, m.device_id,
             d.name AS device
      FROM memories m LEFT JOIN devices d ON d.id = m.device_id
      WHERE m.deleted_at IS NULL AND m.status != 'forgotten' AND ${where}
      ORDER BY ${session ? "m.created_at ASC" : "COALESCE(m.occurred_at, m.created_at) DESC"}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];
    const total = (db.prepare(
      `SELECT COUNT(*) AS c FROM memories m WHERE m.deleted_at IS NULL AND m.status != 'forgotten' AND ${where}`
    ).get(...params) as any).c;
    return json({ total, items: rows.map(prettyRow), session });
  }

  // GET /api/search —— 词群检索（空格分词）
  if (p === "/api/search") {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) return json({ hits: [], tokensUsed: 0 });
    const terms = q.split(/\s+/).filter(Boolean);
    const r = searchMemory(db, { terms, limit: 20 });
    return json({ hits: r.hits, tokensUsed: r.tokensUsed, relatedTags: r.relatedTags });
  }

  // GET /api/get —— 单条 + 链接全景
  if (p === "/api/get") {
    const id = String(url.searchParams.get("id") ?? "");
    const row = db.prepare(`
      SELECT m.*, d.name AS device FROM memories m LEFT JOIN devices d ON d.id = m.device_id
      WHERE m.id = ? AND m.deleted_at IS NULL
    `).get(id) as any;
    if (!row) return json({ error: "not found" }, 404);
    const terms = db.prepare("SELECT term, source FROM memory_terms WHERE memory_id = ?").all(id) as any[];
    const linksOut = db.prepare(`
      SELECT l.to_id AS id, l.relation, l.eff AS weight, l.hits, m.content
      FROM memory_links_eff l JOIN memories m ON m.id = l.to_id
      WHERE l.from_id = ?
      ORDER BY l.eff DESC
    `).all(id) as any[];
    const linksIn = db.prepare(`
      SELECT l.from_id AS id, l.relation, l.eff AS weight, l.hits, m.content
      FROM memory_links_eff l JOIN memories m ON m.id = l.from_id
      WHERE l.to_id = ?
      ORDER BY l.eff DESC
    `).all(id) as any[];
    const { resolveChain } = await import("../memory-search");
    const { getRelated } = await import("../memory-tools");
    return json({
      memory: prettyRow(row), terms, linksOut, linksIn,
      chain: resolveChain(db, id).filter((l) => l.id !== id), // 延续链（不含自身；链头 current=true）
      related: getRelated(db, id),                            // 赫布邻居（有效权重 ÷ √度）
    });
  }

  // POST /api/update —— 编辑内容（同步 FTS + content_hash）
  if (p === "/api/update" && req.method === "POST") {
    const body = await readBody(req);
    const id = String(body.id ?? "");
    const content = String(body.content ?? "").trim();
    if (!id || !content) return json({ error: "id and content required" }, 400);
    const old = db.prepare("SELECT content FROM memories WHERE id = ? AND deleted_at IS NULL").get(id) as any;
    if (!old) return json({ error: "not found" }, 404);
    const hash = createHash("sha256").update(content).digest("hex");
    const dup = db.prepare("SELECT id FROM memories WHERE content_hash = ? AND id != ? AND deleted_at IS NULL").get(hash, id) as any;
    if (dup) return json({ error: "与记忆 #" + dup.id + " 内容重复" }, 409);
    // FTS 由触发器 AFTER UPDATE OF content 自动同步（手动维护已删）
    db.prepare("UPDATE memories SET content = ?, content_hash = ?, updated_at = ? WHERE id = ?").run(content, hash, new Date().toISOString(), id);
    // 审计纪律：管理台编辑也落哈希链（payload 只记 id，零内容）
    await store.appendEvent({ orgId: ORG_PERSONAL, actor: "admin-ui", type: "memory.update", payloadHash: await payloadHash({ id }) });
    // 向量重嵌（fire-and-forget：旧向量对应旧文案，不更新会语义漂移）
    void (async () => {
      try {
        const { embedder, VEC_MODEL } = await import("../embedder");
        if ((await embedder.load()) !== true) return;
        const vec = await embedder.embed(content);
        if (vec) db.prepare("UPDATE memories SET embedding = ?, vec_model = ? WHERE id = ?").run(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), VEC_MODEL, id);
      } catch { /* 双降级：模型故障不影响编辑 */ }
    })();
    return json({ ok: true });
  }

  // POST /api/delete —— 软删除（墓碑）+ FTS 清理；system=1 默认约束受引擎保护不可删
  if (p === "/api/delete" && req.method === "POST") {
    const body = await readBody(req);
    const id = String(body.id ?? "");
    const old = db.prepare("SELECT content, system FROM memories WHERE id = ? AND deleted_at IS NULL").get(id) as any;
    if (!old) return json({ error: "not found" }, 404);
    if (old.system) return json({ error: "「小本本默认约束」受引擎保护，不可删除（可编辑措辞）" }, 403);
    // 双列同步：deleted_at + status（触发器据 status 同步 FTS）
    const nowIsoDel = new Date().toISOString();
    db.prepare("UPDATE memories SET deleted_at = ?, status = 'forgotten', updated_at = ? WHERE id = ?").run(nowIsoDel, nowIsoDel, id);
    // 审计纪律：墓碑事件与 store.forget 同构（可审计）
    await store.appendEvent({ orgId: ORG_PERSONAL, actor: "admin-ui", type: "memory.forget", payloadHash: await payloadHash({ id }) });
    return json({ ok: true });
  }

  // ── 批量物理删除（后台专属危险操作；MCP 层无此能力，AI 永远够不到）──
  // system=1 默认约束一律豁免（引擎保护，删除后下次启动也会重播种）

  function purgeWhere(mode: string, body: any): { where: string; params: any[]; desc: string } | null {
    if (mode === "session") {
      const s = String(body.sessionId ?? "").trim();
      if (!s) return null;
      return { where: "session_id = ?", params: [s], desc: "会话「" + s + "」" };
    }
    if (mode === "time") {
      const from = String(body.from ?? ""), to = String(body.to ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
      return { where: "created_at >= ? AND created_at <= ?", params: [from + "T00:00:00", to + "T23:59:59"], desc: from + " ~ " + to + " 入库的记忆" };
    }
    if (mode === "domain") {
      const d = String(body.domain ?? "").trim();
      if (!d) return null;
      return { where: "domain = ?", params: [d], desc: "域「" + d + "」" };
    }
    if (mode === "hits") {
      const n = Number(body.maxHits);
      if (!Number.isInteger(n) || n < 0) return null;
      return { where: "COALESCE(hit_count, 0) <= ?", params: [n], desc: "回忆命中次数 ≤ " + n + " 的记忆" };
    }
    if (mode === "all") return { where: "1=1", params: [], desc: "全部记忆" };
    return null;
  }

  // POST /api/purge/preview —— 预览：只统计和抽样，不动任何数据
  if (p === "/api/purge/preview" && req.method === "POST") {
    const body = await readBody(req);
    const w = purgeWhere(String(body.mode ?? ""), body);
    if (!w) return json({ error: "参数不完整或维度无效" }, 400);
    const total = (db.prepare(
      `SELECT COUNT(*) AS c FROM memories WHERE deleted_at IS NULL AND system = 0 AND ${w.where}`
    ).get(...w.params) as any).c;
    const sample = db.prepare(
      `SELECT id, content, created_at AS recorded_at, session_id, COALESCE(hit_count, 0) AS hit_count
       FROM memories WHERE deleted_at IS NULL AND system = 0 AND ${w.where} ORDER BY created_at LIMIT 10`
    ).all(...w.params) as any[];
    return json({ total, sample, desc: w.desc });
  }

  // POST /api/purge —— 执行物理删除：含 terms/links/entity 卫星表 + FTS 索引 + 孤儿实体清理
  if (p === "/api/purge" && req.method === "POST") {
    const body = await readBody(req);
    if (body.confirm !== "DELETE") return json({ error: "缺少二次确认" }, 400);
    const w = purgeWhere(String(body.mode ?? ""), body);
    if (!w) return json({ error: "参数不完整或维度无效" }, 400);
    if (w.where === "1=1" && String(body.typeText ?? "").trim() !== "清空全部记忆")
      return json({ error: "清空全部需先在输入框键入「清空全部记忆」" }, 400);
    const rows = db.prepare(
      `SELECT id, content FROM memories WHERE deleted_at IS NULL AND system = 0 AND ${w.where}`
    ).all(...w.params) as any[];
    if (!rows.length) return json({ ok: true, deleted: 0 });
    // FTS 清理由 AFTER DELETE 触发器接管
    db.prepare(`DELETE FROM memory_terms WHERE memory_id IN (SELECT id FROM memories WHERE system = 0 AND ${w.where})`).run(...w.params);
    db.prepare(`DELETE FROM memory_entity WHERE memory_id IN (SELECT id FROM memories WHERE system = 0 AND ${w.where})`).run(...w.params);
    db.prepare(`DELETE FROM memory_links WHERE from_id IN (SELECT id FROM memories WHERE system = 0 AND ${w.where}) OR to_id IN (SELECT id FROM memories WHERE system = 0 AND ${w.where})`).run(...w.params, ...w.params);
    db.prepare(`DELETE FROM memories WHERE deleted_at IS NULL AND system = 0 AND ${w.where}`).run(...w.params);
    db.prepare("DELETE FROM entities WHERE id NOT IN (SELECT DISTINCT entity_id FROM memory_entity)").run();
    return json({ ok: true, deleted: rows.length, desc: w.desc });
  }

  // GET /api/vault —— 密钥保险箱列表（值掩码展示 + 引用计数）
  if (p === "/api/vault") {
    const rows = db.prepare(`
      SELECT s.id, s.value, s.label, s.created_at, s.updated_at,
             (SELECT COUNT(*) FROM memories m
              WHERE m.deleted_at IS NULL AND instr(m.content, '[[xbb_secret_id:' || s.id || ']]') > 0) AS refs
      FROM secrets s ORDER BY s.id
    `).all() as any[];
    return json({
      total: rows.length,
      items: rows.map((r) => ({
        id: r.id, label: r.label ?? null, refs: r.refs,
        created_at: r.created_at, updated_at: r.updated_at,
        mask: String(r.value).length <= 4 ? "••••" : String(r.value).slice(0, 1) + "••••" + String(r.value).slice(-1),
      })),
    });
  }

  // POST /api/vault/update —— 编辑凭据值（改密）或用途标签
  if (p === "/api/vault/update" && req.method === "POST") {
    const { id, value, label } = await readBody(req);
    const sid = Number(id);
    if (!sid) return json({ error: "id 不能为空" }, 400);
    const row = db.prepare("SELECT id FROM secrets WHERE id = ?").get(sid) as any;
    if (!row) return json({ error: "保险箱条目不存在" }, 404);
    if (typeof value === "string" && value.trim()) {
      db.prepare("UPDATE secrets SET value = ?, value_hash = ?, updated_at = datetime('now','localtime') WHERE id = ?")
        .run(value.trim(), createHash("sha256").update(value.trim()).digest("hex"), sid);
    }
    if (typeof label === "string") {
      db.prepare("UPDATE secrets SET label = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(label.trim() || null, sid);
    }
    return json({ ok: true });
  }

  // POST /api/vault/delete —— 删除箱条目（悬空编号在页面上显示为"已失效"）
  if (p === "/api/vault/delete" && req.method === "POST") {
    const { id } = await readBody(req);
    const sid = Number(id);
    if (!sid) return json({ error: "id 不能为空" }, 400);
    db.prepare("DELETE FROM secrets WHERE id = ?").run(sid);
    return json({ ok: true });
  }

  // GET /api/home —— 数据位置：管理页顶部常驻展示，用户永远能在 GUI 里看见库在哪
  if (p === "/api/home") {
    const H = await import("../home");
    const { dir, source } = H.resolveDataDirWithSource();
    const presence = H.dbPresence();
    const modelPath = H.modelsDir();
    let counts: { memories: number; episodes: number; events: number } | null = null;
    try {
      const c = H.readDbCounts(presence.dbPath); // 只读、只数 3 张表：不给管理页开第二条写路径
      counts = { memories: c.memories, episodes: c.episodes, events: c.events };
    } catch {
      /* 打不开就不报数，页面仍要能渲染 */
    }
    return json({
      ok: true,
      programDir: H.programDir(),
      dataDir: dir,
      source,
      dbPath: presence.dbPath,
      dbExists: presence.exists,
      dbBytes: presence.sizeBytes,
      dbMtime: presence.mtime,
      configPath: H.homeConfigPath(),
      config: H.readHomeConfig(),
      modelsDir: modelPath,
      modelsExists: existsSync(modelPath),
      counts,
    });
  }

  // POST /api/home/reveal —— 在文件管理器里打开**当前数据目录**。
  // 刻意不接受任何参数：这不是"打开任意路径"的通用能力，只是把已经在页面上显示出来的那个目录指给用户看。
  if (p === "/api/home/reveal" && req.method === "POST") {
    const H = await import("../home");
    const { openInBrowser } = await import("../open");
    const dir = H.resolveDataDir();
    openInBrowser(dir);
    return json({ ok: true, dir });
  }

  // GET /api/stats —— 统计
  if (p === "/api/stats") {
    const total = (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE deleted_at IS NULL AND status != 'forgotten'").get() as any).c;
    const byType = db.prepare("SELECT type, COUNT(*) AS c FROM memories WHERE deleted_at IS NULL AND status != 'forgotten' AND kind = 'memory' GROUP BY type").all() as any[];
    const byKind = db.prepare("SELECT kind, COUNT(*) AS c FROM memories WHERE deleted_at IS NULL AND status != 'forgotten' GROUP BY kind").all() as any[];
    const domains = db.prepare("SELECT domain, COUNT(*) AS c FROM memories WHERE deleted_at IS NULL AND status != 'forgotten' AND kind = 'constraint' GROUP BY domain ORDER BY c DESC").all() as any[];
    const devices = db.prepare("SELECT name FROM devices").all() as any[];
    // 原话层（episodes）单独成域：它是采集器冷存档，与 memories 不是同一回事，
    // 页面上必须分开计数——否则「共 369 条」会被误读成"整个小本本只有 369 条"。
    const ep = db.prepare(
      "SELECT COUNT(*) AS c, COUNT(DISTINCT session_id) AS s, MIN(recorded_at) AS first, MAX(recorded_at) AS last FROM episodes"
    ).get() as any;
    const epSources = db.prepare(
      "SELECT COALESCE(source,'unknown') AS source, COUNT(*) AS c FROM episodes GROUP BY 1 ORDER BY c DESC"
    ).all() as any[];
    return json({
      total, byType, byKind, domains, devices: devices.map((d) => d.name),
      episodes: { total: ep.c, sessions: ep.s, first: ep.first, last: ep.last, sources: epSources },
    });
  }

  // ── 原话层（episodes）只读接口 ──────────────────────────────────────────
  // 纪律：**列表永不返回全文**（库里有单条 4.7 万字的记录，50 条全文能撑爆一个响应），
  // 只给 240 字预览 + 总字数；要看全文再单独点开 /api/episode?id=。三处硬闸缺一不可：
  // limit ≤ 100、offset 封顶、每条只切 240 字。
  if (p === "/api/episodes") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 100);
    const offset = Math.min(Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0), 500000);
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
    const src = (url.searchParams.get("source") ?? "").trim().slice(0, 40);
    const sess = (url.searchParams.get("session") ?? "").trim().slice(0, 200);
    const day = (url.searchParams.get("day") ?? "").trim();
    const w: string[] = [];
    const args: Array<string | number> = [];
    if (sess) { w.push("session_id = ?"); args.push(sess); }
    if (src) { w.push("COALESCE(source,'unknown') = ?"); args.push(src); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      // 半开区间 [当天 00:00, 次日 00:00)：避免 '23:59:59' 漏掉带毫秒的尾条
      const next = new Date(day + "T00:00:00Z");
      next.setUTCDate(next.getUTCDate() + 1);
      w.push("recorded_at >= ? AND recorded_at < ?");
      args.push(day + " 00:00:00", next.toISOString().slice(0, 10) + " 00:00:00");
    }
    if (q) { w.push("content LIKE '%' || ? || '%'"); args.push(q); }
    const where = w.length ? w.join(" AND ") : "1=1";
    const items = db.prepare(
      `SELECT id, session_id AS sessionId, role, COALESCE(source,'unknown') AS source, topic,
              recorded_at AS recordedAt, length(content) AS chars, substr(content,1,240) AS preview
       FROM episodes WHERE ${where}
       ORDER BY recorded_at DESC, id DESC LIMIT ? OFFSET ?`
    ).all(...args, limit, offset) as any[];
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM episodes WHERE ${where}`).get(...args) as any).c;
    return json({ total, offset, limit, items, filter: { q, source: src, session: sess, day } });
  }

  // 单条原话全文（点开才取；只读，无任何写路径）
  if (p === "/api/episode") {
    const id = Number(url.searchParams.get("id"));
    if (!Number.isFinite(id)) return json({ error: "invalid id" }, 400);
    const item = db.prepare(
      `SELECT id, session_id AS sessionId, role, COALESCE(source,'unknown') AS source, topic,
              recorded_at AS recordedAt, length(content) AS chars, content
       FROM episodes WHERE id = ?`
    ).get(id) as any;
    if (!item) return json({ error: "not found" }, 404);
    return json({ item });
  }

  // GET /api/cloud —— 云端绑定状态（2026-10-04：本地页此前完全不显示云端绑定）。
  // 只读展示元信息，**永不返回 key**（连前缀都不给——管理页是浏览器上下文）
  //
  // 2026-10-07 改读 `loadCloudConfigRaw()`：软关（enabled=false）后 `loadCloudConfig()` 会返回 null，
  // 于是"从未绑定"与"已绑定但切回了本地"在页面上长得一模一样 —— 而这两者给用户的选项完全不同
  // （前者要填 key，后者只要点一下切回）。必须用 raw 才能如实分出三态。
  if (p === "/api/cloud") {
    const { loadCloudConfigRaw, orgDisplayName, consoleBase, DEFAULT_API } = await import("../cloud");
    const cfg = loadCloudConfigRaw();
    const apiBase = cfg?.apiBase ?? (url.searchParams.get("api")?.trim() || DEFAULT_API);
    if (!cfg) {
      return json({ hasConfig: false, enabled: false, apiBase, consoleUrl: consoleBase(apiBase) });
    }
    return json({
      hasConfig: true,
      enabled: cfg.enabled !== false,
      apiBase: cfg.apiBase,
      orgId: cfg.orgId,
      orgKind: cfg.orgKind ?? null,
      label: orgDisplayName(cfg.orgName, cfg.orgKind, cfg.orgId),
      nameKnown: !!cfg.orgName,
      deviceName: cfg.deviceName,
      boundAt: cfg.boundAt,
      consoleUrl: consoleBase(cfg.apiBase),
    });
  }

  // POST /api/cloud/enable | disable —— 模式软开关（**保留密钥**，随时切回）
  // 与 /api/cloud/unbind 的分野是本设计的要点：软关不删文件、不动 key，切一次不必回控制台。
  if ((p === "/api/cloud/enable" || p === "/api/cloud/disable") && req.method === "POST") {
    const { setCloudEnabled } = await import("../cloud");
    const toCloud = p.endsWith("/enable");
    if (!setCloudEnabled(toCloud)) {
      return json({ error: "本机还没有云端密钥，无法切换模式——请先在下方手动填写密钥（或从控制台绑定）" }, 400);
    }
    return json({ ok: true, enabled: toCloud });
  }

  // POST /api/cloud/bind-key —— 手动填密钥绑定（{ key, apiBase? }）
  // 信任路径：不看 key 格式，只拿它换一次 /v1/me/summary 由**服务端**判有效性；
  // 校验不过则**一个字节都不落盘**（不破坏现有配置）。
  if (p === "/api/cloud/bind-key" && req.method === "POST") {
    const body = await readBody(req);
    const key = String(body?.key ?? "").trim();
    if (!key) return json({ error: "密钥不能为空" }, 400);
    const { bindFromKey, BindError, DEFAULT_API } = await import("../cloud");
    try {
      const r = await bindFromKey(key, String(body?.apiBase ?? "").trim() || DEFAULT_API);
      return json({ ok: true, label: r.orgLabel, memberName: r.memberName });
    } catch (e) {
      const msg = e instanceof BindError || e instanceof Error ? e.message : String(e);
      return json({ error: msg }, 400);
    }
  }

  // POST /api/cloud/unbind —— 解除绑定（**真删 cloud.json**，密钥永久丢失，只能回控制台重新绑定）
  if (p === "/api/cloud/unbind" && req.method === "POST") {
    const { clearCloudConfig } = await import("../cloud");
    return json({ ok: clearCloudConfig() });
  }

  if (p === "/health") return json({ ok: true });

  return new Response(`${PRODUCT_EN} v${VERSION} admin\n`);
}

// ── 行美化（JSON 字段解析） ──

function prettyRow(row: any) {
  const parse = (s: any) => { try { return s ? JSON.parse(s) : []; } catch { return []; } };
  return { ...row, tags: parse(row.tags), entities: parse(row.entities) };
}

// ── 管理页面（内嵌，零外部资源） ──
// 注意：HTML/JS 内刻意不使用反引号与 ${}，保证模板字符串安全

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='22' viewBox='0 0 18 22'%3E%3Cpath d='M2 0h14v22l-7-5-7 5z' fill='%23F22'/%3E%3C/svg%3E">
<title>小本本 · 记忆管理</title>
<style>
  :root { --bg:#fafaf8; --card:#ffffff; --line:#e5e3dc; --tx:#2c2c2a; --tx2:#6f6e68; --acc:#534ab7; --accl:#eeedfe; --danger:#a32d2d; --dl:#fcebeb; --warn:#854f0b; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--tx); font-size:14px; line-height:1.6; padding:0 0 60px; }
  header { padding:20px 24px 12px; display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  h1 { font-size:18px; font-weight:500; }
  .sub { color:var(--tx2); font-size:13px; }
  .bar { padding:0 24px 14px; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  input[type=text] { flex:1; min-width:220px; padding:8px 12px; border:1px solid var(--line); border-radius:8px; font-size:14px; background:#fff; }
  button { padding:8px 16px; border:1px solid var(--line); border-radius:8px; background:#fff; cursor:pointer; font-size:14px; }
  button:hover { border-color:var(--acc); color:var(--acc); }
  button.pri { background:var(--acc); border-color:var(--acc); color:#fff; }
  button.pri:hover { opacity:.9; color:#fff; }
  button.dgr { background:var(--dl); border-color:var(--danger); color:var(--danger); }
  /* 云端区块（2026-10-07）：本地 ⇄ 云端一键切换 + 手动填密钥 + 解绑。
     三态同屏：未绑定 / 已绑定·切到本地（密钥保留）/ 已绑定·云端模式。 */
  .cloudbar { margin:0 24px 12px; padding:10px 14px; border:1px solid var(--line); border-radius:10px; background:#fff; font-size:13px; color:var(--tx2); display:none; }
  .cloudbar b { color:var(--tx); font-weight:500; }
  /* 数据位置条：常驻显示库在哪。**不是**设置项，是"认路"——用户换过盘之后
     唯一能自证"我现在读写的到底是哪个库"的地方。换盘动作留在 CLI（复制+校验+切配置）。 */
  .homebar { margin:0 24px 8px; padding:8px 14px; border:1px solid var(--line); border-radius:10px; background:#fff; font-size:13px; color:var(--tx2); display:none; align-items:center; gap:8px; flex-wrap:wrap; }
  .homebar b { color:var(--tx); font-weight:500; }
  .homebar code { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px; color:var(--tx); background:#faf7f2; padding:2px 6px; border-radius:5px; word-break:break-all; }
  .homebar .sp { flex:1 1 auto; }
  .homebar button { font-size:12px; padding:3px 9px; }
  .homebar details summary { cursor:pointer; color:var(--acc); font-size:12px; }
  .homebar .hgrid { display:grid; grid-template-columns:82px 1fr; gap:4px 10px; margin-top:8px; font-size:12px; }
  .homebar .hgrid span:nth-child(odd) { color:var(--tx2); }
  .homebar .hgrid span:nth-child(even) { color:var(--tx); font-family:ui-monospace,Menlo,Consolas,monospace; word-break:break-all; }
  .crow { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .crow .sp { flex:1 1 auto; }
  .cmode { display:inline-flex; align-items:center; gap:6px; color:var(--tx); font-weight:500; }
  .dot { width:8px; height:8px; border-radius:99px; display:inline-block; background:var(--tx2); }
  .dot.local { background:var(--warn); }
  .dot.cloud { background:#2d7a46; }
  .csub { color:var(--tx2); font-size:12px; }
  .csub a { color:var(--acc); text-decoration:none; border-bottom:1px dashed var(--line); }
  .cloudbar details.cbind { margin-top:8px; padding-top:8px; border-top:1px dashed var(--line); }
  .cloudbar details.cbind summary { cursor:pointer; color:var(--acc); font-size:12px; }
  .cloudbar details.cbind[open] summary { margin-bottom:8px; }
  .cloudbar input[type=password], .cloudbar input[type=text] { padding:7px 12px; border:1px solid var(--line); border-radius:8px; font-size:13px; background:#fff; font-family:ui-monospace,Menlo,Consolas,monospace; flex:1 1 240px; min-width:180px; }
  /* 绑定变更提示（A/B 方案）：绑定/解绑由独立进程写盘，正在跑的 AI 客户端不会自动换模式——
     这段是常驻操作说明（不是告警），形态刻意低调，避免被当成"出错了" */
  .cloudhint { margin-top:8px; padding-top:8px; border-top:1px dashed var(--line); font-size:12px; color:var(--warn); }
  .cloudbar .cloudhint b { color:var(--warn); font-weight:500; }
  /* 更新横幅：唯一行动色留给「立即更新」，其余按钮保持中性——一屏只该有一个主行动 */
  .updatebar { margin:0 24px 12px; padding:10px 14px; border:1px solid var(--acc); border-radius:10px; background:#fff; font-size:13px; color:var(--tx2); display:none; align-items:center; gap:10px; flex-wrap:wrap; }
  .updatebar b { color:var(--acc); font-weight:500; }
  .updatebar .sp { flex:1 1 auto; }
  .stats { padding:0 24px 10px; color:var(--tx2); font-size:13px; display:flex; gap:16px; flex-wrap:wrap; }
  .list { padding:0 24px; max-width:860px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin-bottom:10px; cursor:pointer; }
  .card:hover { border-color:var(--acc); }
  .meta { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px; font-size:12px; color:var(--tx2); }
  .badge { padding:1px 8px; border-radius:99px; background:var(--accl); color:var(--acc); }
  .badge.k-memory { background:#eeedfe; color:#534ab7; }
  .badge.k-directive { background:#fdf1e3; color:#b26a1b; }
  .badge.k-habit { background:#e8f5ec; color:#2d7a46; }
  .badge.k-constraint { background:#fcebeb; color:#a32d2d; }
  .badge.sys { background:#2c2c2a; color:#fff; }
  .badge.expired { background:#eceae4; color:#6f6e68; }
  .filterbar { padding:0 24px 12px; display:flex; gap:8px; flex-wrap:wrap; }
  .fbtn { padding:4px 14px; border:1px solid var(--line); border-radius:99px; background:#fff; cursor:pointer; font-size:13px; color:var(--tx2); }
  .fbtn:hover { border-color:var(--acc); color:var(--acc); }
  .fbtn.on { background:var(--acc); border-color:var(--acc); color:#fff; }
  /* ── 原话层（episodes）视图 ──
     与记忆卡片刻意长得不一样：左侧色条分用户/AI，一眼能看出这是"当时说的话"而不是"提炼出的结论"。
     展开区 max-height + overflow 兜住单条 4.7K 字的极端记录，不让一屏被一条吃满。 */
  .card.ep { position:relative; padding-left:20px; }
  .card.ep::before { content:""; position:absolute; left:8px; top:12px; bottom:12px; width:3px; border-radius:3px; background:var(--line); }
  .card.ep.u::before { background:#534ab7; }
  .card.ep.a::before { background:#c9c4ef; }
  .badge.ep-u { background:#eeedfe; color:#534ab7; }
  .badge.ep-a { background:#f1f0f8; color:#6a67a8; }
  .epfull { margin-top:10px; padding-top:10px; border-top:1px dashed var(--line); white-space:pre-wrap; word-break:break-word; max-height:420px; overflow:auto; font-size:13px; cursor:text; }
  .eploading { color:var(--tx2); font-size:13px; }
  .epbar { padding:0 24px 12px; display:none; gap:8px; flex-wrap:wrap; align-items:center; }
  .epbar select, .epbar input[type=date] { padding:7px 10px; border:1px solid var(--line); border-radius:8px; font-size:13px; background:#fff; color:var(--tx); }
  .epbar .sp { flex:1 1 auto; }
  .epbar .csub { color:var(--tx2); font-size:12px; }
  .domain { color:#a32d2d; font-size:12px; }
  .window { color:#b26a1b; font-size:12px; }
  .content { white-space:pre-wrap; word-break:break-word; }
  .empty { text-align:center; color:var(--tx2); padding:40px 0; }
  .overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.35); align-items:center; justify-content:center; padding:20px; }
  .overlay.on { display:flex; }
  .modal { background:#fff; border-radius:12px; padding:20px; width:100%; max-width:640px; max-height:85vh; overflow:auto; }
  .modal h3 { font-size:15px; font-weight:500; margin-bottom:12px; }
  .modal .content { font-size:13px; color:var(--tx2); background:var(--bg); border-radius:8px; padding:10px; margin-bottom:12px; }
  textarea { width:100%; min-height:120px; padding:10px; border:1px solid var(--line); border-radius:8px; font:inherit; resize:vertical; }
  .terms span { display:inline-block; padding:1px 8px; margin:2px 4px 2px 0; background:var(--bg); border:1px solid var(--line); border-radius:99px; font-size:12px; }
  .linkrow { font-size:12px; color:var(--tx2); padding:4px 0; border-top:1px dashed var(--line); word-break:break-word; }
  .acts { display:flex; gap:8px; justify-content:flex-end; margin-top:14px; }
  .toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); background:var(--tx); color:#fff; padding:8px 20px; border-radius:99px; font-size:13px; display:none; }
  .pager { display:flex; gap:10px; align-items:center; justify-content:center; padding:16px 0 0; color:var(--tx2); font-size:13px; }
  .pager button { padding:4px 14px; }
  .purgebox { margin:28px 24px 0; max-width:860px; border:1px solid var(--danger); background:var(--dl); border-radius:12px; padding:14px 16px; }
  .ptitle { color:var(--danger); font-weight:500; font-size:13px; margin-bottom:10px; }
  .prow { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .prow select { padding:8px 12px; border:1px solid var(--line); border-radius:8px; font-size:14px; background:#fff; }
  .prow input[type=text] { min-width:170px; flex:0 1 auto; }
  .presult { margin-top:10px; font-size:13px; display:none; }
  .presult .srow { padding:4px 0; border-top:1px dashed var(--line); color:var(--tx2); word-break:break-word; }
  .foot { margin:26px 0 10px; padding-top:12px; border-top:1px solid var(--line); font-size:12px; color:var(--tx3); line-height:1.7; }
  .foot a { color:var(--tx2); text-decoration:none; border-bottom:1px dashed var(--line); }
  .foot a:hover { color:var(--tx); }
</style>
</head>
<body>
<h2 style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">小本本记忆管理页：搜索、查看、编辑和删除记忆</h2>
<header>
  <h1>小本本 · 记忆管理</h1>
  <span class="sub">xiaobenben admin</span>
</header>
<div class="bar">
  <input type="text" id="q" placeholder="搜索记忆，或粘贴会话编号后点「按会话查」；清空回车回到列表">
  <button class="pri" onclick="doSearch()">搜索</button>
  <button onclick="doSession()">按会话查</button>
</div>
<div class="filterbar" id="filterbar">
  <button class="fbtn on" data-kind="all" onclick="setKind('all')">全部</button>
  <button class="fbtn" data-kind="memory" onclick="setKind('memory')">记忆</button>
  <button class="fbtn" data-kind="directive" onclick="setKind('directive')">短期叮嘱</button>
  <button class="fbtn" data-kind="habit" onclick="setKind('habit')">长期习惯</button>
  <button class="fbtn" data-kind="constraint" onclick="setKind('constraint')">长期约束</button>
  <button class="fbtn" data-kind="vault" onclick="setKind('vault')">🔑 保险箱</button>
  <button class="fbtn" data-kind="episodes" onclick="setKind('episodes')">📄 原话</button>
</div>
<div class="epbar" id="epbar">
  <select id="epSrc" onchange="epFilterChange()"><option value="">全部来源</option></select>
  <input type="date" id="epDay" onchange="epFilterChange()" title="只看这一天的原话">
  <button onclick="epClear()">清空筛选</button>
  <span class="sp"></span>
  <span class="csub" id="epInfo"></span>
</div>
<div class="filterbar" id="sessbar" style="display:none">
  <span class="window" id="sessLabel"></span>
  <button class="fbtn" onclick="exitSession()">✕ 退出会话视图</button>
</div>
<div class="homebar" id="homebar"></div>
<div class="cloudbar" id="cloudbar"></div>
<div class="updatebar" id="updatebar"></div>
<div class="stats" id="stats"></div>
<div class="list" id="list"></div>
<div class="pager" id="pager"></div>

<div class="purgebox" id="purgebox">
  <div class="ptitle">危险区 · 批量物理删除（不可恢复，默认约束不受影响）</div>
  <div class="prow">
    <select id="pMode" onchange="pModeChange()">
      <option value="session">按会话编号</option>
      <option value="time">按入库时间段</option>
      <option value="domain">按约束域</option>
      <option value="hits">按回忆命中次数</option>
      <option value="all">全部记忆清空</option>
    </select>
    <input type="text" id="pIn1" placeholder="会话编号" style="display:none">
    <input type="date" id="pIn2" style="display:none">
    <select id="pDom" style="display:none"></select>
    <input type="text" id="pIn3" placeholder="命中次数上限，如 0" style="display:none">
    <input type="text" id="pText" placeholder="键入：清空全部记忆" style="display:none">
    <button onclick="pPurgePreview()">预览</button>
  </div>
  <div class="presult" id="pResult"></div>
</div>

<div class="overlay" id="ov">
  <div class="modal">
    <h3 id="mTitle"></h3>
    <div id="mMeta" class="meta"></div>
    <div id="mOrig" class="content"></div>
    <textarea id="mEdit"></textarea>
    <div id="mTerms" class="terms"></div>
    <div id="mLinks"></div>
    <div id="mChainHead" class="linkrow" style="color:#534ab7;font-weight:500;margin-top:10px;"></div>
    <div id="mChain"></div>
    <div id="mRelHead" class="linkrow" style="color:#534ab7;font-weight:500;margin-top:10px;"></div>
    <div id="mRel"></div>
    <div class="acts">
      <button id="btnDel" class="dgr" onclick="delCur()">删除</button>
      <button onclick="closeModal()">取消</button>
      <button class="pri" onclick="saveEdit()">保存</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>

<footer class="foot">
  <div><a href="${OFFICIAL_SITE}" target="_blank" rel="noopener">${PRODUCT_NAME} (${PRODUCT_EN}) ${OFFICIAL_SITE}</a></div>
</footer>

<script>
var curId = null, curSystem = false, curKind = "all", curSession = null;
var page = 0, pageSize = 20, total = 0;
function esc(s){ var d=document.createElement("div"); d.textContent=s==null?"":String(s); return d.innerHTML; }
function toast(m){ var t=document.getElementById("toast"); t.textContent=m; t.style.display="block"; setTimeout(function(){t.style.display="none";},1800); }
function badge(t){ var map={decision:"决策",preference:"偏好",fact:"事实",event:"事件",procedure:"步骤"}; return esc(map[t]||t); }
function kindBadge(m){
  if(m.system) return '<span class="badge sys">系统</span>';
  var map={memory:"记忆",directive:"叮嘱",habit:"习惯",constraint:"约束"};
  var k = m.kind || "memory";
  return '<span class="badge k-'+esc(k)+'">'+esc(map[k]||k)+'</span>';
}
function kindLabel(k){ var map={memory:"记忆",directive:"叮嘱",habit:"习惯",constraint:"约束"}; return map[k]||k; }
function nowLocal(){
  var d=new Date(); function p(n){ return (n<10?"0":"")+n; }
  return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds());
}
function expired(m){
  if(!m.expires_at) return false;
  return (m.status === "archived") || (m.expires_at < nowLocal());
}

function renderList(items){
  var el = document.getElementById("list");
  if(!items.length){
    el.innerHTML = curSession
      ? '<div class="empty">该会话编号下没有记忆，注意 session_id 需完整精确匹配。</div>'
      : '<div class="empty">没有记忆。去 AI 客户端聊点什么，让它帮你记下来。</div>';
    return;
  }
  var h = "";
  for(var i=0;i<items.length;i++){
    var m = items[i];
    var tags = (m.tags||[]).map(function(t){return "#"+esc(t);}).join(" ");
    var extras = "";
    if(m.session_id){
      var safeSid = String(m.session_id).replace(/["']/g, "");
      extras += '<span class="badge" style="cursor:pointer" data-sid="'+esc(safeSid)+'" onclick="event.stopPropagation();sessFromEl(this)">'+esc(m.session_id)+' ↗</span>';
    }
    if(m.domain) extras += '<span class="domain">域·'+esc(m.domain)+'</span>';
    if(m.expires_at) extras += '<span class="window'+(expired(m)?' expired':'')+'">'+(expired(m)?'已过期 · ':'生效至 ')+esc(m.expires_at)+'</span>';
    if(m.kind==="directive" && m.similar_sessions>1) extras += '<span class="window">×'+esc(m.similar_sessions)+' 会话</span>';
    if(m.hit_count>0) extras += '<span class="badge">命中 ×'+esc(m.hit_count)+'</span>';
    if(m.superseded_by) extras += '<span class="badge" style="cursor:pointer" data-open="'+esc(m.superseded_by)+'">已延续 → '+esc(String(m.superseded_by).slice(0,8))+'</span>';
    var legacy = (!m.kind || m.kind==="memory") && m.type && m.type!=="fact" ? '<span class="badge">'+badge(m.type)+'</span>' : '';
    h += '<div class="card" data-open="'+m.id+'">'
      + '<div class="meta">'+kindBadge(m)+legacy
      + '<span>#'+m.id+'</span>'
      + '<span>'+esc(m.occurred_at||m.recorded_at||"")+'</span>'
      + '<span>'+esc(m.device||"未知设备")+'</span>'
      + (tags?'<span>'+tags+'</span>':'')+extras+'</div>'
      + '<div class="content">'+secBadge(esc(m.content))+'</div></div>';
  }
  el.innerHTML = h;
}

function renderPager(){
  var el = document.getElementById("pager");
  var pages = Math.max(1, Math.ceil(total/pageSize));
  if(total === 0){ el.innerHTML = ""; return; }
  var unit = (curKind === "episodes") ? " 条原话" : " 条";
  el.innerHTML = '<button onclick="pageTurn(-1)"' + (page===0?' disabled':'') + '>上一页</button>'
    + '<span>第 ' + (page+1) + ' / ' + pages + ' 页 · 共 ' + total + unit + '</span>'
    + '<button onclick="pageTurn(1)"' + (page>=pages-1?' disabled':'') + '>下一页</button>';
}
function pageTurn(d){
  var p = page + d;
  if(p < 0 || p*pageSize >= total) return;
  page = p;
  if(curKind === "episodes") loadEpisodes(); else loadList();
  window.scrollTo(0, 0);
}

// ── 云端区块（2026-10-07 重写）：三态 + 一键切换 + 手动填密钥 ──
// 三态必须是三态，不能塌成两态：未绑定 / 已绑定但切到本地（密钥还在） / 已绑定且在云端。
// 塌成两态的后果是"切到本地"之后页面长得和"从未绑定"一样 —— 用户会以为密钥没了，回控制台重绑一遍。
// ── 数据位置：常驻一条"库在哪" ──────────────────────────────────
// 为什么必须常驻而不是藏进"设置"：用户换过盘之后，唯一能自证"我现在读写的
// 到底是哪个库"的地方就是这里。库不在位时它得**先于一切**变红，因为那一屏
// 看起来最正常的时刻，恰恰是最需要被告警的时刻。
function loadHome(){
  fetch("/api/home").then(function(r){return r.json();}).then(function(d){ homeRender(d); }).catch(function(){});
}

function homeRender(d){
  var el = document.getElementById("homebar");
  if(!el) return;
  el.style.display = "flex";
  var mb = function(n){ return (Number(n||0)/1048576).toFixed(1) + " MB"; };
  var srcMap = { env:"环境变量 XBB_DATA_DIR", config:"配置文件", "default":"默认位置" };
  var h = '<b>记忆库</b><code>' + esc(d.dbPath) + '</code>';
  if(d.dbExists){
    h += '<span class="csub">' + mb(d.dbBytes)
      + (d.counts ? ' · 记忆 ' + d.counts.memories + ' / 原话 ' + d.counts.episodes : '')
      + ' · ' + esc(srcMap[d.source] || d.source) + '</span>';
  } else {
    h += '<span class="csub" style="color:var(--warn)">⚠️ 库不在位 —— 下次启动会被拒绝，避免在空库上继续用</span>';
  }
  h += '<span class="sp"></span>';
  h += '<button onclick="homeReveal()">打开所在文件夹</button>';
  h += '<details><summary>详情</summary><div class="hgrid">'
    + '<span>程序目录</span><span>' + esc(d.programDir) + '</span>'
    + '<span>数据目录</span><span>' + esc(d.dataDir) + '</span>'
    + '<span>位置来源</span><span>' + esc(srcMap[d.source] || d.source) + '</span>'
    + '<span>模型目录</span><span>' + esc(d.modelsDir) + (d.modelsExists ? '' : '（尚未下载）') + '</span>'
    + '<span>配置文件</span><span>' + esc(d.configPath) + '</span>'
    + '<span>最后写入</span><span>' + (d.dbMtime ? esc(String(d.dbMtime).slice(0,19).replace("T"," ")) : '-') + '</span>'
    + (d.config ? '<span>配置内容</span><span>' + esc(JSON.stringify(d.config)) + '</span>' : '')
    + '</div><div class="csub" style="margin-top:8px">换盘走命令行：<code>xbb home move "D:\\xbb-data"</code>'
    + ' —— 复制 → 校验（完整性 + 行数逐项比对）→ 才切配置；校验不过不切，原库不动。</div></details>';
  el.innerHTML = h;
}

function homeReveal(){
  fetch("/api/home/reveal", {method:"POST"}).then(function(r){return r.json();})
    .then(function(d){ if(!d || !d.ok) toast((d && d.error) || "打开失败"); })
    .catch(function(){ toast("打开失败"); });
}

function loadCloud(){
  fetch("/api/cloud").then(function(r){return r.json();}).then(function(d){ cloudRender(d); }).catch(function(){});
}

function cloudRender(d){
  var el = document.getElementById("cloudbar");
  el.style.display = "block";
  var bound = !!d.hasConfig, on = !!d.enabled;
  var h = '<div class="crow">';
  if(bound && on){
    var nameTxt = d.nameKnown ? esc(d.label) : (d.orgId ? esc(d.orgId) : "已绑定");
    h += '<span class="cmode"><span class="dot cloud"></span>云端模式</span>'
      + '<span>记忆写入组织 <b>' + nameTxt + '</b>'
      + (d.nameKnown && d.orgId ? ' <span class="csub">(' + esc(d.orgId) + ')</span>' : '')
      + (d.deviceName ? ' · ' + esc(d.deviceName) : '')
      + (d.boundAt ? ' <span class="csub">绑定于 ' + esc(String(d.boundAt).slice(0,10)) + '</span>' : '')
      + '</span><span class="sp"></span>'
      + '<button onclick="cloudSwitch(false)">切到本地（保留密钥）</button>'
      + '<button class="dgr" onclick="cloudUnbind()">解除绑定</button>';
  } else if(bound){
    h += '<span class="cmode"><span class="dot local"></span>本地模式</span>'
      + '<span>记忆只存本机 · <b>云端密钥仍保留</b>，随时可切回</span><span class="sp"></span>'
      + '<button class="pri" onclick="cloudSwitch(true)">切换到云端</button>'
      + '<button class="dgr" onclick="cloudUnbind()">解除绑定</button>';
  } else {
    h += '<span class="cmode"><span class="dot local"></span>本地模式</span>'
      + '<span>记忆只存本机 · 未绑定云端组织</span>';
  }
  h += '</div>';

  // 手动填密钥：首次绑定与"换一把 key"走同一条路。收起态默认（已绑定时）避免喧宾夺主。
  h += '<details class="cbind"' + (bound ? '' : ' open') + '><summary>'
    + (bound ? '更换 / 手动填写云端密钥' : '手动填写云端密钥，连接云端')
    + '</summary>'
    + '<div class="crow">'
    + '<input type="password" id="ckey" autocomplete="off" spellcheck="false" placeholder="粘贴云端密钥">'
    + '<button class="pri" onclick="cloudBindKey()">连接</button>'
    + '</div>'
    + '<div class="crow" style="margin-top:6px">'
    + '<input type="text" id="capi" spellcheck="false" placeholder="API 地址（默认 ' + esc(d.apiBase || '') + '，自建部署才需要改）">'
    + '</div>'
    + '<div class="csub" style="margin-top:6px">密钥在云端控制台生成并复制'
    + (d.consoleUrl ? '（<a href="' + esc(d.consoleUrl) + '" target="_blank" rel="noopener">打开控制台</a>）' : '')
    + '。连接时会先拿它向服务端校验一次，<b>校验不通过则不改动本机配置</b>。</div>'
    + '</details>';

  h += '<div class="cloudhint">切换 / 绑定 / 解绑后，需重启 AI 客户端（opencode、Cursor、WorkBuddy 等）才会生效'
    + '——<b>未重启的客户端仍按旧模式读写</b>，这期间新写入的记忆会落到旧目标'
    + '（切到本地前写云端、切到云端前写本地库）。</div>';
  el.innerHTML = h;
}

function cloudSwitch(toCloud){
  fetch(toCloud ? "/api/cloud/enable" : "/api/cloud/disable", {method:"POST"})
    .then(function(r){return r.json();}).then(function(d){
      if(d && d.ok){ toast(toCloud ? "已切到云端模式" : "已切到本地模式（密钥保留）"); loadCloud(); }
      else toast((d && d.error) || "切换失败");
    }).catch(function(){ toast("切换请求失败"); });
}

function cloudBindKey(){
  var kEl = document.getElementById("ckey");
  var aEl = document.getElementById("capi");
  var key = kEl ? kEl.value.trim() : "";
  if(!key){ toast("先粘贴云端密钥"); if(kEl) kEl.focus(); return; }
  var body = { key: key };
  if(aEl && aEl.value.trim()) body.apiBase = aEl.value.trim();
  if(kEl) kEl.value = "";   // 立刻清空：密钥不留在输入框里等下一次截图
  fetch("/api/cloud/bind-key",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)})
    .then(function(r){return r.json();}).then(function(d){
      if(d && d.ok){ toast("已连接云端：" + (d.label || "已绑定")); loadCloud(); }
      else toast((d && d.error) || "连接失败");
    }).catch(function(){ toast("连接请求失败"); });
}

function cloudUnbind(){
  if(!confirm("解除绑定会删除本机的云端密钥，且不可恢复——只能回云端控制台重新绑定。\\n\\n"
    + "如果只是暂时想用本地模式，请点「切到本地（保留密钥）」，密钥会留着，随时能切回来。\\n\\n"
    + "确定要解除绑定吗？")) return;
  fetch("/api/cloud/unbind",{method:"POST"}).then(function(r){return r.json();}).then(function(d){
    if(d && d.ok){ toast("已解除云端绑定"); loadCloud(); }
    else toast((d && d.error) || "解除失败");
  }).catch(function(){ toast("请求失败"); });
}

function loadStats(){
  fetch("/api/stats").then(function(r){return r.json();}).then(function(s){
    // 第一段必须是「记忆」而不是含糊的「共」——原话层紧接着一起报，
    // 让两个量级的数字（几百 vs 几万）同时在场，用户不会再把摘要层当成全部存量。
    var parts = ["记忆 "+s.total+" 条"];
    (s.byKind||[]).forEach(function(t){ parts.push(kindLabel(t.kind)+" "+t.c); });
    var ep = s.episodes || {};
    if(ep.total) parts.push("原话 "+ep.total+" 条 · "+ep.sessions+" 会话");
    var doms = (s.domains||[]).map(function(d){ return d.domain+"("+d.c+")"; }).join("、");
    if(doms) parts.push("约束域: "+doms);
    document.getElementById("stats").textContent = parts.join(" · ") + " · 设备: " + s.devices.join("、");
    // 来源下拉按实际来源生成（不写死客户端名单：采集谁就有谁）
    var sel = document.getElementById("epSrc");
    if(sel && !sel.getAttribute("data-filled")){
      var srcs = ep.sources || [];
      var h = '<option value="">全部来源</option>';
      for(var i=0;i<srcs.length;i++){
        h += '<option value="'+esc(srcs[i].source)+'">'+esc(srcs[i].source)+'（'+srcs[i].c+'）</option>';
      }
      sel.innerHTML = h;
      sel.setAttribute("data-filled","1");
    }
  });
}

function setTabs(k){
  var btns = document.querySelectorAll("#filterbar .fbtn");
  for(var i=0;i<btns.length;i++){ btns[i].className = "fbtn" + (btns[i].getAttribute("data-kind")===k ? " on" : ""); }
}
function showSessionBar(){
  var b = document.getElementById("sessbar");
  b.style.display = "flex";
  document.getElementById("sessLabel").textContent = "会话 " + curSession + " 的全部记忆（按记录时间正序）";
}
function hideSessionBar(){ document.getElementById("sessbar").style.display = "none"; }

function setKind(k){
  curKind = k;
  if(curSession){ curSession = null; hideSessionBar(); }
  page = 0;
  setTabs(k);
  var isEp = (k === "episodes");
  document.getElementById("epbar").style.display = isEp ? "flex" : "none";
  // 危险区（批量删记忆）在原话页一律收起：那页上一条也删不得，摆着只会误触
  document.getElementById("purgebox").style.display = isEp ? "none" : "";
  if(isEp){
    // 切进原话层时沿用搜索框里的词（用户常常先输词再切视图），会话过滤则重置
    epQ = document.getElementById("q").value.trim();
    epSession = null;
    epFilterSync();
    loadEpisodes();
    return;
  }
  epQ = ""; epSession = null;
  document.getElementById("q").value = "";
  if(k==="vault"){ loadVault(); } else { loadList(); }
}

// ── 原话层视图（episodes）────────────────────────────────────────────────
// 三条铁律：①一页最多 100 条、默认 20；②列表只拿预览不拿全文；③任何筛选变化都回第 0 页。
// 这不是装饰性约束——库里有单条 4.7 万字的记录，一次全捞浏览器会卡死。
var epQ = "", epSource = "", epDay = "", epSession = null;

function epFilterSync(){
  var info = document.getElementById("epInfo");
  var bits = [];
  if(epSession) bits.push("会话 "+epSession.slice(0,16)+"…");
  if(epQ) bits.push("含「"+epQ+"」");
  if(epDay) bits.push(epDay+" 当天");
  if(epSource) bits.push("来源 "+epSource);
  info.textContent = bits.length ? ("筛选中：" + bits.join(" · ")) : "";
}
function epFilterChange(){
  epSource = document.getElementById("epSrc").value || "";
  epDay = document.getElementById("epDay").value || "";
  page = 0;
  epFilterSync();
  loadEpisodes();
}
function epClear(){
  epSource = ""; epDay = ""; epQ = ""; epSession = null;
  document.getElementById("epSrc").value = "";
  document.getElementById("epDay").value = "";
  document.getElementById("q").value = "";
  page = 0;
  epFilterSync();
  loadEpisodes();
}
function epSessFromEl(el){
  var sid = el.getAttribute("data-sid");
  if(!sid) return;
  epSession = sid;
  page = 0;
  epFilterSync();
  loadEpisodes();
  window.scrollTo(0, 0);
}

function loadEpisodes(){
  var u = "/api/episodes?limit="+pageSize+"&offset="+(page*pageSize);
  if(epQ) u += "&q="+encodeURIComponent(epQ);
  if(epSource) u += "&source="+encodeURIComponent(epSource);
  if(epDay) u += "&day="+encodeURIComponent(epDay);
  if(epSession) u += "&session="+encodeURIComponent(epSession);
  fetch(u).then(function(r){return r.json();}).then(function(d){
    total = d.total || 0;
    renderEpisodes(d.items||[], d.filter||{});
    renderPager();
  }).catch(function(){ toast("原话加载失败"); });
}

function renderEpisodes(items, f){
  var el = document.getElementById("list");
  if(!items.length){
    el.innerHTML = '<div class="empty">'
      + (f && (f.q||f.day||f.source||f.session) ? '这组条件下没有原话，放宽筛选试试。' : '还没有采集到原话。')
      + '</div>';
    return;
  }
  var h = "";
  for(var i=0;i<items.length;i++){
    var e = items[i];
    var isU = (e.role === "user");
    var safeSid = String(e.sessionId||"").replace(/["']/g, "");
    var meta = '<span class="badge '+(isU?"ep-u":"ep-a")+'">'+(isU?"我":"AI")+'</span>'
      + '<span>#'+e.id+'</span>'
      + '<span>'+esc(e.recordedAt||"")+'</span>'
      + '<span class="badge">'+esc(e.source||"?")+'</span>';
    if(e.chars > 240) meta += '<span class="window">'+e.chars+' 字 · 点击展开</span>';
    if(safeSid) meta += '<span class="badge" style="cursor:pointer" data-sid="'+esc(safeSid)+'" onclick="event.stopPropagation();epSessFromEl(this)">'+esc(safeSid.slice(0,14))+(safeSid.length>14?"…":"")+' ↗</span>';
    h += '<div class="card ep '+(isU?"u":"a")+'" data-eid="'+e.id+'">'
      + '<div class="meta">'+meta+'</div>'
      + '<div class="content">'+esc(e.preview||"")+'</div></div>';
  }
  el.innerHTML = h;
}

// 点卡片展开全文（懒加载：点一次取一条，绝不预取）。再点一次折叠。
function epToggle(card){
  var full = card.querySelector(".epfull");
  if(full){ card.removeChild(full); return; }
  var id = card.getAttribute("data-eid");
  if(!id) return;
  var ph = document.createElement("div");
  ph.className = "epfull eploading";
  ph.textContent = "读取中…";
  card.appendChild(ph);
  fetch("/api/episode?id="+encodeURIComponent(id))
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.item){ ph.textContent = (d.error||"读取失败"); return; }
      ph.className = "epfull";
      ph.textContent = d.item.content;   // textContent 而非 innerHTML：原话原样呈现，不解析任何标记
    })
    .catch(function(){ ph.textContent = "读取失败"; });
}

// ── 密钥保险箱视图 ──
function secBadge(escapedText){
  // 转义后的文案里把 [[xbb_secret_id:N]] 换成可读徽章（编辑框保持原文以便编辑标记）
  // ⚠️ 本文件 ADMIN_HTML 整段是模板字面量：内联 JS 里的每个反斜杠都必须「双写」，
  //    否则会被模板字面量提前吃掉（转义引号、正则里的 d 与方括号转义全部失效）。
  //    回归闸：tools/check-admin-html.ts
  return String(escapedText).replace(/\\[\\[xbb_secret_id:(\\d+)\\]\\]/g, function(_m, n){
    return '<span class="badge" style="cursor:default">🔑 #' + n + '</span>';
  });
}
function loadVault(){
  document.getElementById("pager").innerHTML = "";
  fetch("/api/vault").then(function(r){return r.json();}).then(function(d){
    var el = document.getElementById("list");
    if(!d.items || !d.items.length){
      el.innerHTML = '<div class="empty">保险箱是空的。AI 写入记忆时用 [[xbb_secret_value:值]] 标记的凭据会自动入箱。</div>';
      return;
    }
    var h = "";
    for(var i=0;i<d.items.length;i++){
      var s = d.items[i];
      var refTxt = s.refs > 0 ? ('被 '+s.refs+' 条记忆引用') : '<span style="color:var(--danger)">无引用 · 可清理</span>';
      h += '<div class="card" style="cursor:default">'
        + '<div class="meta">'
        + '<span class="badge" style="background:#f3e5f5;color:#6a1b9a">🔑 #'+s.id+'</span>'
        + '<span>值 '+esc(s.mask)+'</span>'
        + '<span>'+(s.label?('用途: '+esc(s.label)):'<em>无用途标签</em>')+'</span>'
        + '<span>'+esc(s.updated_at||"")+'</span>'
        + '<span class="badge">'+refTxt+'</span>'
        + '</div>'
        + '<div class="acts" style="margin-top:8px;justify-content:flex-start">'
        + '<button onclick="vaultEditValue('+s.id+')">改密</button>'
        + '<button onclick="vaultEditLabel('+s.id+')">改标签</button>'
        + '<button class="dgr" onclick="vaultDel('+s.id+')">删除</button>'
        + '</div></div>';
    }
    el.innerHTML = h;
  });
}
function vaultEditValue(id){
  var v = prompt("输入新值（改密后所有引用该编号的记忆自动生效）：");
  if(v === null) return;
  if(!v.trim()){ toast("值不能为空"); return; }
  fetch("/api/vault/update",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:id,value:v.trim()})})
    .then(function(r){return r.json();}).then(function(d){ if(d.ok){ toast("已改密"); loadVault(); } else { toast(d.error||"失败"); } });
}
function vaultEditLabel(id){
  var v = prompt("输入用途标签（如：服务器 SSH 密码；留空清除）：");
  if(v === null) return;
  fetch("/api/vault/update",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:id,label:v})})
    .then(function(r){return r.json();}).then(function(d){ if(d.ok){ toast("已保存"); loadVault(); } else { toast(d.error||"失败"); } });
}
function vaultDel(id){
  if(!confirm("确定删除保险箱 #"+id+"？引用它的记忆里将只剩失效编号。")) return;
  fetch("/api/vault/delete",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:id})})
    .then(function(r){return r.json();}).then(function(d){ if(d.ok){ toast("已删除"); loadVault(); } else { toast(d.error||"失败"); } });
}

function doSession(){
  var sid = document.getElementById("q").value.trim();
  if(!sid){ toast("先在搜索框粘贴会话编号，再点按会话查"); return; }
  // 原话视图下「按会话查」查的是原话表 —— 一场会话的原始往来才是这里要看的东西
  if(curKind === "episodes"){
    epSession = sid.replace(/["']/g, "");
    epQ = "";
    page = 0;
    epFilterSync();
    loadEpisodes();
    window.scrollTo(0, 0);
    return;
  }
  viewSession(sid);
}
function viewSession(sid){
  if(!sid) return;
  curSession = String(sid).replace(/["']/g, "");
  curKind = "all";
  page = 0;
  setTabs("all");
  document.getElementById("q").value = curSession;
  showSessionBar();
  closeModal();
  loadList();
  window.scrollTo(0, 0);
}
function exitSession(){
  curSession = null;
  hideSessionBar();
  document.getElementById("q").value = "";
  page = 0;
  loadList();
}
function sessFromEl(el){
  var sid = el.getAttribute("data-sid");
  if(sid) viewSession(sid);
}

function loadList(){
  var u = "/api/list?limit="+pageSize+"&offset="+(page*pageSize);
  if(curSession) u += "&session="+encodeURIComponent(curSession);
  else u += "&kind="+encodeURIComponent(curKind);
  fetch(u).then(function(r){return r.json();}).then(function(d){
    total = d.total;
    renderList(d.items);
    renderPager();
  });
}

function doSearch(){
  var q = document.getElementById("q").value.trim();
  // 原话视图：搜的是原话正文（LIKE 扫表），走 /api/episodes 的同一套分页，不混进记忆检索漏斗
  if(curKind === "episodes"){
    epQ = q;
    epSession = null;
    page = 0;
    epFilterSync();
    loadEpisodes();
    return;
  }
  if(!q){ page = 0; if(curSession){ curSession=null; hideSessionBar(); } loadList(); return; }
  curSession = null; hideSessionBar();
  document.getElementById("pager").innerHTML = "";
  fetch("/api/search?q="+encodeURIComponent(q)).then(function(r){return r.json();}).then(function(d){
    renderList(d.hits);
    if(!d.hits.length) toast("没捞到，换个词试试");
  });
}
document.getElementById("q").addEventListener("keydown", function(e){ if(e.key==="Enter") doSearch(); });

function openEdit(id){
  fetch("/api/get?id="+id).then(function(r){return r.json();}).then(function(d){
    if(d.error){ toast(d.error); return; }
    curId = id;
    var m = d.memory;
    curSystem = !!m.system;
    document.getElementById("mTitle").textContent = "记忆 "+String(m.id).slice(0,8);
    var meta = kindBadge(m);
    if((!m.kind || m.kind==="memory") && m.type && m.type!=="fact") meta += '<span class="badge">'+badge(m.type)+'</span>';
    meta += '<span>'+esc(m.occurred_at||m.recorded_at||"")+'</span><span>'+esc(m.device||"")+'</span>';
    if(m.dscope) meta += '<span>scope: '+esc(m.dscope)+'</span>';
    if(m.domain) meta += '<span class="domain">域·'+esc(m.domain)+'</span>';
    if(m.session_id){
      var safeSid = String(m.session_id).replace(/["']/g, "");
      meta += '<span class="badge" style="cursor:pointer" data-sid="'+esc(safeSid)+'" onclick="event.stopPropagation();sessFromEl(this)">会话 '+esc(m.session_id)+' ↗</span>';
    }
    if(m.starts_at) meta += '<span class="window">始于 '+esc(m.starts_at)+'</span>';
    if(m.expires_at) meta += '<span class="window'+(expired(m)?' expired':'')+'">'+(expired(m)?'已过期 · ':'生效至 ')+esc(m.expires_at)+'</span>';
    if(m.kind==="directive" && m.similar_sessions>0) meta += '<span class="window">相似 '+esc(m.similar_sessions)+' 个会话</span>';
    if(m.hit_count>0) meta += '<span class="badge">命中 ×'+esc(m.hit_count)+'</span>';
    if(m.superseded_by) meta += '<span class="badge" style="cursor:pointer" data-open="'+esc(m.superseded_by)+'">已延续 → '+esc(String(m.superseded_by).slice(0,8))+'</span>';
    document.getElementById("mMeta").innerHTML = meta;
    document.getElementById("mOrig").innerHTML = secBadge(esc(m.content));
    document.getElementById("mEdit").value = m.content;
    document.getElementById("mTerms").innerHTML = (d.terms||[]).map(function(t){return "<span>"+esc(t.term)+"</span>";}).join("");
    var lh = "";
    (d.linksOut||[]).forEach(function(l){ lh += '<div class="linkrow">→ '+esc(l.relation)+' #'+l.id+' '+esc(l.content.slice(0,60))+'</div>'; });
    (d.linksIn||[]).forEach(function(l){ lh += '<div class="linkrow">← '+esc(l.relation)+' #'+l.id+' '+esc(l.content.slice(0,60))+'</div>'; });
    document.getElementById("mLinks").innerHTML = lh;
    // ── 延续链（故事线：链头=现状，历史环可点击跳转）──
    var ch = d.chain||[];
    document.getElementById("mChainHead").innerHTML = ch.length ? "📜 延续链 · "+ch.length+" 环（[链头]=现状，点击跳转）" : "";
    document.getElementById("mChain").innerHTML = ch.map(function(c){
      return '<div class="linkrow">'+(c.current?'<b style="color:#534ab7">[链头·现状]</b> ':'[历史环] ')+'<span style="cursor:pointer;color:#534ab7" data-open="'+esc(c.id)+'">'+esc(String(c.content).slice(0,50))+'</span>'+(c.occurredAt?' <span class="window">'+esc(c.occurredAt)+'</span>':'')+'</div>';
    }).join("");
    // ── 赫布关联（weight 条形可视化）──
    var rl = d.related||[];
    document.getElementById("mRelHead").innerHTML = rl.length ? "🕸 赫布关联 · "+rl.length+" 条（weight 排序，点击跳转）" : "";
    document.getElementById("mRel").innerHTML = rl.map(function(r){
      var bar = ""; for(var i=0;i<Math.round((r.weight||0)*10);i++) bar += "▎";
      return '<div class="linkrow">'+esc(r.relation)+' <span style="color:#534ab7">'+bar+'</span> '+(r.weight||0).toFixed(1)+' <span style="cursor:pointer;color:#534ab7" data-open="'+esc(r.id)+'">'+esc(String(r.content).slice(0,40))+'</span></div>';
    }).join("");
    document.getElementById("btnDel").style.display = curSystem ? "none" : "";
    document.getElementById("ov").classList.add("on");
  });
}
function closeModal(){ document.getElementById("ov").classList.remove("on"); curId = null; }
function saveEdit(){
  var content = document.getElementById("mEdit").value.trim();
  if(!content || !curId) return;
  fetch("/api/update",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:curId,content:content})})
    .then(function(r){return r.json();}).then(function(d){
      if(d.ok){ toast("已保存"); closeModal(); refresh(); } else { toast(d.error||"保存失败"); }
    });
}
function delCur(){
  if(!curId) return;
  if(!confirm("确定删除记忆 #"+curId+"？（软删除，可从数据库恢复）")) return;
  fetch("/api/delete",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:curId})})
    .then(function(r){return r.json();}).then(function(d){
      if(d.ok){ toast("已删除"); closeModal(); refresh(); } else { toast(d.error||"删除失败"); }
    });
}
function refresh(){
  loadStats();
  if(curKind === "episodes"){ loadEpisodes(); return; }
  if(document.getElementById("q").value.trim()) doSearch();
  else { page = 0; loadList(); }
}

document.getElementById("ov").addEventListener("click", function(e){ if(e.target===this) closeModal(); });

// ── 危险区：批量物理删除 ──
var pPreview = null;
function pModeChange(){
  var m = document.getElementById("pMode").value;
  document.getElementById("pIn1").type = (m==="time") ? "date" : "text";
  document.getElementById("pIn1").style.display = (m==="session"||m==="time") ? "" : "none";
  document.getElementById("pIn2").style.display = m==="time" ? "" : "none";
  document.getElementById("pDom").style.display = m==="domain" ? "" : "none";
  document.getElementById("pIn3").style.display = m==="hits" ? "" : "none";
  document.getElementById("pText").style.display = m==="all" ? "" : "none";
  document.getElementById("pResult").style.display = "none";
  pPreview = null;
  document.getElementById("pIn1").value = "";
  document.getElementById("pIn2").value = "";
  if(m==="time"){ document.getElementById("pIn1").title = "起始日期"; document.getElementById("pIn2").title = "结束日期"; }
  if(m==="session") document.getElementById("pIn1").placeholder = "会话编号";
  if(m==="domain"){
    var sel = document.getElementById("pDom");
    sel.innerHTML = '<option value="">加载中…</option>';
    fetch("/api/stats").then(function(r){return r.json();}).then(function(s){
      var doms = (s.domains||[]).filter(function(d){ return d.domain!=="小本本默认约束"; });
      sel.innerHTML = doms.length
        ? doms.map(function(d){ return '<option value="'+esc(d.domain)+'">'+esc(d.domain)+'（'+d.c+' 条）</option>'; }).join("")
        : '<option value="">暂无自定义域</option>';
    });
  }
}
function pParams(){
  var m = document.getElementById("pMode").value;
  var b = { mode: m };
  if(m==="session") b.sessionId = document.getElementById("pIn1").value.trim();
  if(m==="time"){ b.from = document.getElementById("pIn1").value.trim(); b.to = document.getElementById("pIn2").value.trim(); }
  if(m==="domain") b.domain = document.getElementById("pDom").value;
  if(m==="hits") b.maxHits = parseInt(document.getElementById("pIn3").value, 10);
  if(m==="all") b.typeText = document.getElementById("pText").value.trim();
  return b;
}
function pPurgePreview(){
  var b = pParams();
  fetch("/api/purge/preview",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)})
    .then(function(r){return r.json();}).then(function(d){
      var el = document.getElementById("pResult");
      el.style.display = "block";
      if(d.error){ el.innerHTML = esc(d.error); pPreview = null; return; }
      pPreview = b;
      var h = '<div class="ptitle" style="margin-bottom:6px">将物理删除 '+d.total+' 条（'+esc(d.desc)+'）：</div>';
      (d.sample||[]).forEach(function(s){
        h += '<div class="srow">#'+s.id+' · 命中×'+(s.hit_count||0)+' · '+esc(s.recorded_at||"")+' · '+esc(s.content.slice(0,60))+'</div>';
      });
      if(d.total > (d.sample||[]).length) h += '<div class="srow">…仅展示前 10 条，实际删除以总数为准</div>';
      h += '<div class="acts" style="justify-content:flex-start"><button class="dgr" onclick="pPurgeExec()">确认物理删除（不可恢复）</button></div>';
      el.innerHTML = h;
      if(d.total===0){ el.innerHTML = '该维度下没有可删除的记忆。'; pPreview = null; }
    });
}
function pPurgeExec(){
  if(!pPreview){ toast("请先点预览"); return; }
  var b = pParams();
  b.confirm = "DELETE";
  if(!confirm("物理删除后无法从数据库恢复，确定执行？")) return;
  fetch("/api/purge",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)})
    .then(function(r){return r.json();}).then(function(d){
      if(d.ok){ toast("已物理删除 "+d.deleted+" 条"); pPreview = null; document.getElementById("pResult").style.display = "none"; refresh(); }
      else toast(d.error||"删除失败");
    });
}

// 详情跳转委托（data-open 属性 → openEdit；避免内联 onclick 的引号转义地狱）
document.addEventListener("click", function(e){
  var t = e.target;
  if(!t || !t.closest) return;
  // 在展开区里点 = 想选中复制文字，不能一碰就折叠（否则读到一半内容消失）
  if(t.closest(".epfull")) return;
  var ep = t.closest("[data-eid]");
  if(ep){ epToggle(ep); return; }
  var el = t.closest("[data-open]");
  if(el){ closeModal(); openEdit(el.getAttribute("data-open")); }
});
// ── 更新提示：有新版本时才出现；一次点击完成，不打扰 ──
// 数据源是 /update-check（只读本地快照，不打网络），所以这里可以放心轮询式刷新。
function loadUpdate(){
  fetch("/update-check").then(function(r){return r.json();}).then(function(d){
    var el = document.getElementById("updatebar");
    if(!el) return;
    if(!d || !d.enabled || !d.latest){ el.style.display = "none"; return; }
    if(d.applied){
      el.style.display = "flex";
      el.innerHTML = '<b>新版本 v' + esc(d.latest) + ' 已就位</b><span>重启小本本后生效。</span>';
      return;
    }
    if(!d.available){ el.style.display = "none"; return; }
    el.style.display = "flex";
    el.innerHTML = '<b>发现小本本有新版本 v' + esc(d.latest) + '</b>'
      + '<span>（当前 v' + esc(d.current) + '）要更新至 v' + esc(d.latest) + ' 吗？</span>'
      + '<span class="sp"></span>'
      + '<button class="pri" onclick="doUpdate()">立即更新</button>'
      + '<button onclick="dismissUpdate(\\'' + esc(d.latest) + '\\')">以后再说</button>';
  }).catch(function(){});
}
function doUpdate(){
  var el = document.getElementById("updatebar");
  if(el) el.innerHTML = "正在下载并校验…";
  fetch("/update", {method:"POST"}).then(function(r){return r.json();}).then(function(d){
    var st = d && d.result && d.result.status;
    if(st === "swapped") toast("新版本已就位，重启小本本生效");
    else if(st === "up_to_date") toast("已是最新版本");
    else toast("更新未完成：" + ((d && d.result && (d.result.reason || d.result.status)) || "未知"));
    loadUpdate();
  }).catch(function(){ toast("更新请求失败"); loadUpdate(); });
}
function dismissUpdate(v){
  fetch("/update-dismiss", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({version:v})})
    .then(function(){ document.getElementById("updatebar").style.display = "none"; });
}
loadHome(); loadCloud(); loadStats(); loadList(); loadUpdate();
</script>
</body>
</html>`;
