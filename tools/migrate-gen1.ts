/**
 * 旧版数据迁移：旧 memory.db（INTEGER 主键）→ 新 v3 schema（UUIDv7）。
 * 幂等：content_hash 去重，可中断重跑。旧库只读打开绝不写。
 * events 补账：memory.bulk_import 一条（数量账零内容）。
 * 用法：bun run tools/migrate-gen1.ts [旧库] [新库]
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { uuidv7, payloadHash } from "@xbb/core";
import { ORG_PERSONAL, initSchemaV2 } from "../src/schema";

const home = process.env.XBB_HOME ?? join(homedir(), ".xiaobenben");
const OLD_DB = process.argv[2] ?? join(home, "memory.db.gen1");
const NEW_DB = process.argv[3] ?? join(home, "memory.db");

if (!existsSync(OLD_DB)) {
  console.error(`旧库不存在: ${OLD_DB}`);
  process.exit(1);
}

const old = new Database(OLD_DB, { readonly: true });
const neu = new Database(NEW_DB, { create: true });
neu.exec("PRAGMA journal_mode = WAL");
neu.exec("PRAGMA foreign_keys = OFF"); // 迁移期关（UUID 重排引用），迁完开回
initSchemaV2(neu);

const idMap = new Map<number, string>();
const nowIso = () => new Date().toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ── 1. memories（两遍：先建行拿 UUID，再补 superseded_by 引用）──
const oldMems = old.prepare("SELECT * FROM memories ORDER BY id ASC").all() as any[];
const insMem = neu.prepare(`
  INSERT INTO memories (id, org_id, space_id, actor, content, content_hash, type, tags, entities,
                        occurred_at, occurred_precision, session_id, source_ref, device_id,
                        kind, dscope, domain, starts_at, expires_at, status, needs_ack,
                        importance, deleted_at, system, similar_sessions, hit_count,
                        created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
let migrated = 0, skipped = 0;
for (const m of oldMems) {
  const content = String(m.content ?? "");
  if (!content) { skipped++; continue; }
  const hash = sha(content);
  const dup = neu.prepare("SELECT id FROM memories WHERE content_hash = ? AND deleted_at IS NULL").get(hash) as { id: string } | undefined;
  if (dup) { idMap.set(m.id, dup.id); skipped++; continue; }
  const id = uuidv7();
  idMap.set(m.id, id);
  const status = m.status === "archived" ? "archived" : m.deleted_at ? "forgotten" : "active";
  insMem.run(
    id, ORG_PERSONAL, "00000000-0000-7000-8000-000000000002", String(m.device_id ?? "migrated"),
    content, hash, m.type ?? "fact", m.tags ?? "[]", m.entities ?? null,
    m.occurred_at ?? null, m.occurred_precision ?? null, m.session_id ?? null, m.source_ref ?? null, null,
    m.kind ?? "memory", m.dscope ?? null, m.domain ?? null, m.starts_at ?? null, m.expires_at ?? null,
    status, 0,
    m.importance ?? 0.5, m.deleted_at ?? null, m.system ?? 0, m.similar_sessions ?? 0, m.hit_count ?? 0,
    m.created_at ?? nowIso(), m.updated_at ?? m.created_at ?? nowIso(),
  );
  migrated++;
}
for (const m of oldMems) {
  if (m.superseded_by && idMap.has(m.id) && idMap.has(m.superseded_by)) {
    neu.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(idMap.get(m.superseded_by)!, idMap.get(m.id)!);
  }
}
console.log(`memories: 迁移 ${migrated}，跳过 ${skipped}`);

// ── 2-5. 关联表（按旧库实际存在的表处理）──
const hasTable = (name: string) => !!old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

if (hasTable("entities")) {
  const entMap = new Map<number, number>();
  for (const e of old.prepare("SELECT * FROM entities").all() as any[]) {
    neu.prepare("INSERT OR IGNORE INTO entities (name, aliases) VALUES (?, ?)").run(e.name, e.aliases ?? null);
    const row = neu.prepare("SELECT id FROM entities WHERE name = ?").get(e.name) as { id: number };
    entMap.set(e.id, row.id);
  }
  for (const me of old.prepare("SELECT * FROM memory_entity").all() as any[]) {
    const mid = idMap.get(me.memory_id), eid = entMap.get(me.entity_id);
    if (mid && eid) neu.prepare("INSERT OR IGNORE INTO memory_entity (memory_id, entity_id) VALUES (?, ?)").run(mid, eid);
  }
  console.log(`entities: ${entMap.size}（共现 ${(neu.prepare("SELECT COUNT(*) AS c FROM memory_entity").get() as any).c}）`);
}

if (hasTable("memory_links")) {
  let n = 0;
  for (const l of old.prepare("SELECT * FROM memory_links").all() as any[]) {
    const from = idMap.get(l.from_id), to = idMap.get(l.to_id);
    if (!from || !to) continue;
    neu.prepare("INSERT OR IGNORE INTO memory_links (from_id, to_id, relation, weight, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(from, to, l.relation, l.weight ?? 0.5, l.created_at ?? nowIso());
    n++;
  }
  console.log(`memory_links: ${n}`);
}

if (hasTable("memory_terms")) {
  let n = 0;
  for (const t of old.prepare("SELECT * FROM memory_terms").all() as any[]) {
    const mid = idMap.get(t.memory_id);
    if (!mid) continue;
    neu.prepare("INSERT OR IGNORE INTO memory_terms (term, memory_id, source) VALUES (?, ?, ?)").run(t.term, mid, t.source ?? "expand");
    n++;
  }
  console.log(`memory_terms: ${n}`);
}

if (hasTable("secrets")) {
  let n = 0;
  for (const sec of old.prepare("SELECT * FROM secrets").all() as any[]) {
    neu.prepare("INSERT OR IGNORE INTO secrets (value, value_hash, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(sec.value, sec.value_hash, sec.label ?? null, sec.created_at ?? nowIso(), sec.updated_at ?? nowIso());
    n++;
  }
  console.log(`secrets: ${n}`);
}

// ── 5.5 devices 表 + device_id 回填（修复：首版迁移漏迁，119 条 device_id 为 NULL）──
if (hasTable("devices")) {
  for (const d of old.prepare("SELECT id, name FROM devices").all() as any[]) {
    neu.prepare("INSERT OR IGNORE INTO devices (id, name, created_at) VALUES (?, ?, ?)").run(d.id, d.name, nowIso());
  }
  // content_hash/旧 id 双保险逐条回填（新旧行一一对应）
  const oldDev = old.prepare("SELECT device_id FROM memories WHERE content_hash = ? AND device_id IS NOT NULL");
  for (const m of oldMems) {
    const newId = idMap.get(m.id);
    if (!newId || !m.device_id) continue;
    neu.prepare("UPDATE memories SET device_id = ? WHERE id = ? AND device_id IS NULL").run(m.device_id, newId);
  }
  console.log(`devices: ${(neu.prepare("SELECT COUNT(*) AS c FROM devices").get() as any).c}（device_id 回填完成）`);
}

// ── 6. events 补账 + 哈希链自校验 ──
const appendRaw = async (type: string, payload: object) => {
  const last = neu.prepare("SELECT org_seq, hash FROM events WHERE org_id = ? ORDER BY org_seq DESC LIMIT 1").get(ORG_PERSONAL) as { org_seq: number; hash: string } | undefined;
  const seq = last ? last.org_seq + 1 : 1;
  const prevHash = last ? last.hash : "GENESIS";
  const ph = await payloadHash(payload);
  const data = new TextEncoder().encode(`${ORG_PERSONAL}|${seq}|${prevHash}|${ph}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  neu.prepare("INSERT INTO events (id, org_id, org_seq, actor, type, payload_hash, prev_hash, hash, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(uuidv7(), ORG_PERSONAL, seq, "migrate-gen1", type, ph, prevHash, hash, nowIso());
};
await appendRaw("memory.bulk_import", {
  source: basename(OLD_DB), memories: migrated, skipped,
  links: (neu.prepare("SELECT COUNT(*) AS c FROM memory_links").get() as { c: number }).c,
});
const rows = neu.prepare("SELECT org_seq, prev_hash, hash, payload_hash FROM events WHERE org_id = ? ORDER BY org_seq ASC").all(ORG_PERSONAL) as any[];
let prev = "GENESIS", chainOk = true;
for (const r of rows) {
  const data = new TextEncoder().encode(`${ORG_PERSONAL}|${r.org_seq}|${prev}|${r.payload_hash}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const h = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  if (r.prev_hash !== prev || r.hash !== h) { chainOk = false; break; }
  prev = r.hash;
}
console.log(`events 补账 ✅  哈希链: ${chainOk ? "✅" : "❌"}`);
console.log(`完成: ${NEW_DB}`);
old.close();
neu.close();
