// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * `xbb doctor` 的回归钉子（2026-11-24）。
 *
 * 体检工具最容易犯的错不是"漏检"，是**报错报得理直气壮**：
 * 分母算错、拿旁证当正据、把正常状态当缺陷。所以每条断言都钉在一个
 * 「看起来正常、实际是另一种情况」的反面样本上：
 *
 *   · 分母若写成 `status='active' AND superseded_by IS NULL` → 被取代的活条目被漏掉（测试 1 变红）
 *   · 覆盖若用 `memories.entities` 列判实体 → 挂边表空的条目被误判为有实体（测试 3 变红）
 *   · 环检测若把"重复访问"当环 → 15 层直链被误报（测试 6 变红）
 *   · 修复若"顺手补个 type=fact" → 语义被无凭据改写（测试 10 变红）
 *
 * 每条都在未修/错修的代码上会红 —— 这是这份文件存在的唯一理由。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { PersonalStore } from "./store";
import { runDoctor, repairDb, integrityProblems, hasFixableWork } from "./doctor";

const dirs: string[] = [];

/** 每个 describe 一个独立库：结构破坏类测试（删 FTS 行、加环）不能污染别人 */
function freshStore(tag: string) {
  const d = mkdtempSync(join(tmpdir(), `xbb-doctor-${tag}-`));
  dirs.push(d);
  const path = join(d, "test.db");
  const store = PersonalStore.open(path);
  return { store, db: store.db, path };
}

function closeAll() {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上 WAL 句柄释放有延迟，残留临时目录不影响断言 */
    }
  }
}
afterAll(closeAll);

describe("分母：必须是检索看得见的那批", () => {
  const { store, db } = freshStore("alive");

  test("准备三条不同存活状态的记忆", async () => {
    const a = await store.deliver({ spaceId: "sp", actor: "u", content: "甲的长期偏好" });
    const b = await store.deliver({ spaceId: "sp", actor: "u", content: "乙的旧结论" });
    const c = await store.deliver({ spaceId: "sp", actor: "u", content: "丙已被遗忘" });
    // b 被取代但**没有**被遗忘：检索照样会返回它（再由链头解析），所以它仍在分母里
    db.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(a.id, b.id);
    // c 是墓碑：`status != 'forgotten'` 会把它挡掉
    await store.forget(c.id, "u");
    expect(runDoctor(db).alive).toBe(2);
  });

  test("archived（到期归档）仍在检索集合内，不能被漏掉", async () => {
    const before = runDoctor(db).alive;
    const d = await store.deliver({ spaceId: "sp", actor: "u", content: "丁已归档但可见" });
    db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(d.id);
    // 若实现把分母写成 status='active'，这一条会漏 → 变红
    expect(runDoctor(db).alive).toBe(before + 1);
  });
});

describe("通道覆盖：只认真正的索引，不认旁证", () => {
  const { store, db } = freshStore("cov");

  test("tags 非空但没有词项行 → 倒排通道对它是失明的", async () => {
    const r = await store.deliver({ spaceId: "sp", actor: "u", content: "带标签但没词项的记忆", tags: ["部署", "流水线"] });
    const rep = runDoctor(db);
    expect(rep.channels.inv.have).toBe(0);
    expect(rep.channels.inv.total).toBe(1);
    // 计的是**缺的 (term, memory) 对**，不是"缺的条数"：两个词都不在倒排里，所以是 2
    expect(rep.fixable.tagTerms).toBe(2);
    // 词项是空的，"无实体"也一并成立（deliver 不写挂边）
    expect(rep.channels.ent.have).toBe(0);
    expect(r).toBeTruthy();
  });

  test("entities 列有名字但挂边表空 → 实体通道仍算失明", async () => {
    const { db: db2, store: s2 } = freshStore("cov2");
    await s2.deliver({ spaceId: "sp", actor: "u", content: "写了实体名但没建挂边" });
    db2.prepare("UPDATE memories SET entities = ?").run(JSON.stringify(["阿里云", "OSS"]));
    const rep = runDoctor(db2);
    // 反面：用 `m.entities != '[]'` 判覆盖的实现，这里会报 have=1 → 变红
    expect(rep.channels.ent.have).toBe(0);
    expect(rep.fixable.entityRows).toBe(1);
    expect(rep.missing.entities).toBe(1);
  });

  test("向量缺失能被单独数出来（语义通道失明）", async () => {
    const { db: db3, store: s3 } = freshStore("cov3");
    const x = await s3.deliver({ spaceId: "sp", actor: "u", content: "没有向量的记忆" });
    const rep = runDoctor(db3);
    expect(rep.channels.vec.have).toBe(0);
    expect(rep.channels.vec.total).toBe(1);
    expect(rep.channels.vec.total - rep.channels.vec.have).toBe(1);
    expect(x).toBeTruthy();
  });

  test("source 标注不同 ≠ 词项缺失：词已经在倒排里就不该报", async () => {
    // 真实库上的原样复现：`memory_terms` 主键是 (term, memory_id)，source 只是来源标注。
    // 同一个词先由 terms 写成 expand，后来 tags 里也有它 —— 那行永远标着 expand。
    // 按 `source='tag'` 判的实现会把这类全报成"缺失"（实测 38 条假警报），
    // 而 `--fix` 一条也插不进去（主键冲突被 INSERT OR IGNORE 静默吞掉）。
    const { db: db5, store: s5 } = freshStore("srcmark");
    const rec = await s5.deliver({ spaceId: "sp", actor: "u", content: "用 bun 打包单文件", tags: ["打包"] });
    db5
      .prepare("INSERT OR IGNORE INTO memory_terms (term, memory_id, source) VALUES (?, ?, 'expand')")
      .run("打包", rec.id);

    const rep = runDoctor(db5);
    expect(rep.channels.inv.have).toBe(1); // 倒排里有它
    expect(rep.fixable.tagTerms).toBe(0); // 所以不该报"缺"
    const plan = repairDb(db5, rep);
    expect(plan.tagTerms).toBe(0); // 也不该"修"点什么（报 N 修 0 是最糟的体验）
  });
});

describe("结构完整性：索引与主表对不上就是问题", () => {
  const { store, db } = freshStore("integrity");

  test("FTS 索引被抽掉 → integrity-check 抓得到（COUNT(*) 抓不到）", async () => {
    const a = await store.deliver({ spaceId: "sp", actor: "u", content: "全文索引里的一条记忆" });
    const row = db.query("SELECT rowid AS r, content AS c FROM memories WHERE id = ?").get(a.id) as { r: number; c: string };
    // external content 表的正确删除方式；直接 DELETE 不会真的移除索引行
    db.prepare("INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', ?, ?)").run(row.r, row.c);

    // ── 这是本轮最贵的教训 ──
    // 索引行已经没了，但 `COUNT(*) FROM memories_fts` 依然等于 memories 行数，
    // 因为 external content 表的 SELECT 从**内容表**取列值。
    // 任何用 COUNT 或 `WHERE rowid=?` 判同步的实现，在这里都会报"一致" → 变红。
    const naiveRows = (db.query("SELECT COUNT(*) AS c FROM memories_fts").get() as { c: number }).c;
    const naiveMem = (db.query("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
    expect(naiveRows).toBe(naiveMem);

    const rep = runDoctor(db);
    expect(rep.integrity.ftsChecked).toBe(true);
    expect(rep.integrity.ftsSynced).toBe(false);
    expect(integrityProblems(rep)).toBeGreaterThan(0);
  });

  test("--fix 重建 FTS 后回到一致", () => {
    const rep = runDoctor(db);
    const plan = repairDb(db, rep);
    expect(plan.ftsRebuilt).toBe(true);
    const after = runDoctor(db);
    expect(after.integrity.ftsSynced).toBe(true);
    expect(integrityProblems(after)).toBe(0);
  });

  test("只读连接上跑不了校验 → 明确说没验，而不是谎报一致", () => {
    const { db: db4, path } = freshStore("integrity-ro");
    const ro = new Database(path, { readonly: true });
    try {
      const rep = runDoctor(ro);
      // 反面：catch 里一律当作"一致"的实现，会让这一条永远绿 ——
      // 所以断言同时要求 checked=false（"没验"和"验过没问题"必须能分开）
      expect(rep.integrity.ftsChecked).toBe(false);
      expect(rep.integrity.ftsSynced).toBe(true);
    } finally {
      ro.close();
      db4.close();
    }
  });

  test("孤儿索引行：记忆被硬删后留下的词项", async () => {
    const b = await store.deliver({ spaceId: "sp", actor: "u", content: "会被硬删的一条" });
    db.prepare("INSERT OR IGNORE INTO entities (name) VALUES ('孤儿实体')").run();
    const eid = (db.query("SELECT id FROM entities WHERE name = '孤儿实体'").get() as { id: number }).id;
    db.prepare("INSERT OR IGNORE INTO memory_terms (term, memory_id, source) VALUES (?, ?, 'expand')").run("孤儿词", b.id);
    db.prepare("INSERT OR IGNORE INTO memory_entity (memory_id, entity_id) VALUES (?, ?)").run(b.id, eid);
    db.prepare("DELETE FROM memories WHERE id = ?").run(b.id);
    const rep = runDoctor(db);
    expect(rep.integrity.orphanTerms).toBeGreaterThan(0);
    expect(rep.integrity.orphanEntities).toBeGreaterThan(0);
    const plan = repairDb(db, rep);
    expect(plan.orphans).toBeGreaterThan(0);
    expect(runDoctor(db).integrity.orphanTerms).toBe(0);
    expect(runDoctor(db).integrity.orphanEntities).toBe(0);
  });

  test("悬空链头：指向一个不存在的 id", async () => {
    const c = await store.deliver({ spaceId: "sp", actor: "u", content: "链头指向虚空" });
    db.prepare("UPDATE memories SET superseded_by = 'this-id-never-existed' WHERE id = ?").run(c.id);
    expect(runDoctor(db).integrity.danglingHead).toBe(1);
    db.prepare("UPDATE memories SET superseded_by = NULL WHERE id = ?").run(c.id);
  });
});

describe("环检测：别把长链当环", () => {
  const { store, db } = freshStore("cycle");

  test("15 层直链不算环", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 15; i++) ids.push((await store.deliver({ spaceId: "sp", actor: "u", content: `第 ${i} 代` })).id);
    for (let i = 0; i < 14; i++) db.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(ids[i + 1]!, ids[i]!);
    // 反面：把"重复访问"当环的实现会报 14 或 1 → 变红
    expect(runDoctor(db).integrity.cycles).toBe(0);
  });

  test("A→B→C→A 数出一个环", async () => {
    const { db: db2, store: s2 } = freshStore("cycle2");
    const a = (await s2.deliver({ spaceId: "sp", actor: "u", content: "环 A" })).id;
    const b = (await s2.deliver({ spaceId: "sp", actor: "u", content: "环 B" })).id;
    const c = (await s2.deliver({ spaceId: "sp", actor: "u", content: "环 C" })).id;
    db2.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(b, a);
    db2.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(c, b);
    db2.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(a, c);
    expect(runDoctor(db2).integrity.cycles).toBe(1);
  });

  test("自指（A→A）也是一个环", async () => {
    const { db: db3, store: s3 } = freshStore("cycle3");
    const a = (await s3.deliver({ spaceId: "sp", actor: "u", content: "自指" })).id;
    db3.prepare("UPDATE memories SET superseded_by = ? WHERE id = ?").run(a, a);
    expect(runDoctor(db3).integrity.cycles).toBe(1);
  });
});

describe("修复：只重建索引，绝不改语义", () => {
  const { store, db } = freshStore("repair");

  test("补词项 / 补挂边，且正文与类型原样不动", async () => {
    const a = await store.deliver({ spaceId: "sp", actor: "u", content: "原始正文不许被改", tags: ["检索", "索引"] });
    // type=NULL 是 `write_memory` 显式传 undefined 后的真实形态（`store.deliver` 走 DEFAULT 'fact'，
    // 造不出这个样本）—— 这正是用户库里那批"无类型"条目的由来
    db.prepare("UPDATE memories SET type = NULL, entities = ? WHERE id = ?").run(JSON.stringify(["向量库"]), a.id);
    const before = db.query("SELECT content, type, entities FROM memories WHERE id = ?").get(a.id) as {
      content: string;
      type: string | null;
      entities: string;
    };

    const rep = runDoctor(db);
    expect(hasFixableWork(rep)).toBe(true);
    const plan = repairDb(db, rep);
    expect(plan.tagTerms).toBe(2);
    // 一次修完：先补挂边、再扫"实体名进没进倒排"，所以实体词项这一轮就补上了
    expect(plan.entityTerms).toBe(1);
    expect(plan.entityRows).toBe(1);

    const after = db.query("SELECT content, type, entities FROM memories WHERE id = ?").get(a.id) as typeof before;
    // 反面：顺手"补个 type=fact"的实现，这一行变红
    expect(after.type).toBeNull();
    expect(after.content).toBe(before.content);
    expect(after.entities).toBe(before.entities);
  });

  test("修完之后倒排覆盖率补齐到满", () => {
    const rep = runDoctor(db);
    expect(rep.channels.inv.have).toBe(rep.channels.inv.total);
    expect(rep.fixable.tagTerms).toBe(0);
    expect(rep.fixable.entityTerms).toBe(0);
    expect(rep.fixable.entityRows).toBe(0);
  });

  test("第二次修复无活可干（幂等）", () => {
    const rep = runDoctor(db);
    const plan = repairDb(db, rep);
    expect(plan.tagTerms).toBe(0);
    expect(plan.entityTerms).toBe(0);
    expect(plan.entityRows).toBe(0);
    expect(plan.blankTerms).toBe(0);
    expect(plan.orphans).toBe(0);
    expect(plan.ftsRebuilt).toBe(false);
  });

  test("空白词项会被清掉（它们永远匹配不上任何输入）", async () => {
    const b = await store.deliver({ spaceId: "sp", actor: "u", content: "带空白词项的一条" });
    db.prepare("INSERT OR IGNORE INTO memory_terms (term, memory_id, source) VALUES ('   ', ?, 'expand')").run(b.id);
    expect(runDoctor(db).fixable.blankTerms).toBe(1);
    const plan = repairDb(db, runDoctor(db));
    expect(plan.blankTerms).toBe(1);
    expect(runDoctor(db).fixable.blankTerms).toBe(0);
  });

  test("读不懂的 entities 列不会被编成实体，也不会被报成「可补」", async () => {
    const c = await store.deliver({ spaceId: "sp", actor: "u", content: "实体列是坏 JSON" });
    db.prepare("UPDATE memories SET entities = ? WHERE id = ?").run("{不是数组", c.id);
    const rep = runDoctor(db);
    // 反面：SQL 里判 `entities != '[]'` 的实现会报 1，于是 --fix 声称能修却什么也修不出来
    expect(rep.fixable.entityRows).toBe(0);
    const before = (db.query("SELECT COUNT(*) AS c FROM entities").get() as { c: number }).c;
    repairDb(db, rep);
    // 解析失败 ⇒ 一个实体都不许新增；同时该条仍算"无实体"（诚实报告，不伪造）
    expect((db.query("SELECT COUNT(*) AS c FROM entities").get() as { c: number }).c).toBe(before);
    expect(runDoctor(db).missing.entities).toBeGreaterThan(0);
  });

  test("实体名不做大小写归一 —— 只报告分裂，不擅自合并", async () => {
    const { db: db2, store: s2 } = freshStore("repair-case");
    await s2.deliver({ spaceId: "sp", actor: "u", content: "用了 React" });
    db2.prepare("UPDATE memories SET entities = ?").run(JSON.stringify(["React"]));
    repairDb(db2, runDoctor(db2));

    const d = await s2.deliver({ spaceId: "sp", actor: "u", content: "用了 react" });
    db2.prepare("UPDATE memories SET entities = ? WHERE id = ?").run(JSON.stringify(["react"]), d.id);
    repairDb(db2, runDoctor(db2));

    const rep = runDoctor(db2);
    expect(rep.caseDupEntities).toBe(1);
    // 反面：如果修复擅自把 react 折进 React，这里会变成 1 个实体 → 变红
    expect((db2.query("SELECT COUNT(*) AS c FROM entities").get() as { c: number }).c).toBe(2);
  });
});

describe("重复内容哈希", () => {
  // 唯一索引 `idx_memories_content_hash` 平时挡住重复；这里模拟"索引被丢过 / 外部导入"
  // 的库，验证检测项真的会亮 —— 否则这个检查项等于永远为 0 的死代码。
  const { store, db } = freshStore("duphash");

  test("没有唯一索引时能数出重复组", async () => {
    db.exec("DROP INDEX IF EXISTS idx_memories_content_hash");
    const a = await store.deliver({ spaceId: "sp", actor: "u", content: "一模一样的内容" });
    const b = await store.deliver({ spaceId: "sp", actor: "u", content: "一模一样的内容" });
    db.prepare("UPDATE memories SET content_hash = ? WHERE id IN (?, ?)").run("deadbeef", a.id, b.id);
    expect(runDoctor(db).integrity.dupHash).toBe(1);
  });
});
