// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 写入管线的"零件完整性"钉子（2026-11-24）。
 *
 * 起点是一次用户反馈里的数据卫生统计：24 条无类型 / 212 条无实体。
 * 查下来不是脏数据，是**写入端没兑现自己的承诺**：
 *
 *   · MCP 工具的 `type` 是 `z.enum([...]).optional()`，省略时 `item.type` 为 undefined；
 *     `INSERT` 语句逐列写了 type，把 undefined 绑成 `NULL` —— 显式的 NULL 压过
 *     列定义上的 `DEFAULT 'fact'`。于是"省略就按 fact 记"这个意图从来没生效过。
 *   · 这类缺失**不报错**，只在按类型筛选时安静地漏掉那些记忆。
 *
 * doctor（体检）能发现它们，但体检只能报告、不能猜；源头在这里。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { PersonalStore } from "./store";
import { writeMemory } from "./memory-write";
import { runDoctor } from "./doctor";

const dir = mkdtempSync(join(tmpdir(), "xbb-write-"));
const store = PersonalStore.open(join(dir, "test.db"));
const db = store.db;

afterAll(() => {
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上 WAL 句柄释放有延迟，残留临时目录不影响断言 */
  }
});

const rowOf = (id: string) =>
  db.query("SELECT type, kind, tags, entities FROM memories WHERE id = ?").get(id) as {
    type: string | null;
    kind: string;
    tags: string;
    entities: string | null;
  };

describe("省略 type：按 fact 落库，而不是 NULL", () => {
  test("不给 type 时存的是 fact", async () => {
    const r = await writeMemory(store, { content: "省略 type 的一条记忆" });
    // 反面：`INSERT ... VALUES (?, ?, ?)` 里直接绑 `item.type` 的实现，这里拿到 null → 变红
    expect(rowOf(r.id).type).toBe("fact");
  });

  test("给了 type 就原样存", async () => {
    const r = await writeMemory(store, { content: "明确标成决策的一条", type: "decision" });
    expect(rowOf(r.id).type).toBe("decision");
  });

  test("新写入的记忆在体检里不该出现「类型缺失」", async () => {
    const rep = runDoctor(db);
    // 这条断言把"写入端"和"体检"接在一起：任何一端退化都会红
    expect(rep.missing.type).toBe(0);
  });
});

describe("词项与实体：写入时就该齐", () => {
  test("terms / tags / entities 三路都进倒排", async () => {
    const r = await writeMemory(store, {
      content: "用 Bun 打包单文件 exe，产物约 100MB",
      terms: ["打包", "单文件可执行文件"],
      tags: ["构建"],
      entities: ["Bun"],
    });
    const terms = (
      db.query("SELECT term, source FROM memory_terms WHERE memory_id = ? ORDER BY term").all(r.id) as Array<{
        term: string;
        source: string;
      }>
    ).map((x) => `${x.term}:${x.source}`);
    expect(terms).toContain("打包:expand");
    expect(terms).toContain("单文件可执行文件:expand");
    expect(terms).toContain("构建:tag");
    expect(terms).toContain("Bun:entity");
  });

  test("entities 同时建挂边", async () => {
    const r = await writeMemory(store, {
      content: "部署在阿里云 OSS 上的静态站点",
      terms: ["部署"],
      entities: ["阿里云", "OSS"],
    });
    const names = (
      db.query(
        `SELECT e.name AS name FROM memory_entity me JOIN entities e ON e.id = me.entity_id
          WHERE me.memory_id = ? ORDER BY e.name`,
      ).all(r.id) as Array<{ name: string }>
    ).map((x) => x.name);
    expect(names).toEqual(["OSS", "阿里云"]);
  });

  test("刚写进去的记忆，四个零件一个都不缺", async () => {
    const r = await writeMemory(store, {
      content: "一条零件齐全的记忆，用来验证体检不会误报",
      terms: ["零件"],
      entities: ["体检"],
      occurredAt: "2026-11-24",
      type: "fact",
    });
    const d = db
      .query(
        `SELECT
           (SELECT COUNT(*) FROM memory_terms WHERE memory_id = ?) AS terms,
           (SELECT COUNT(*) FROM memory_entity WHERE memory_id = ?) AS ents,
           (SELECT COUNT(*) FROM memories WHERE id = ? AND embedding IS NOT NULL) AS hasvec`,
      )
      .get(r.id, r.id, r.id) as { terms: number; ents: number; hasvec: number };
    expect(d.terms).toBeGreaterThan(0);
    expect(d.ents).toBeGreaterThan(0);
    // 向量是异步回填的，写入当下可以为空 —— 这一项由 embed-backfill 负责，不在这里断言
    void d.hasvec;
  });
});

describe("写入是原子的：要么整条进去，要么一条都不留", () => {
  /**
   * 一条记忆在库里是七处写入（正文/词项/实体/挂边/链接/链头/事件）。
   * 原先各写各的自动提交，中途失败会留下"有正文、没词项"的半条记忆 ——
   * 更糟的是**再写一次也修不好**：`content_hash` 去重会命中那条半成品，
   * 直接返回 `deduped:true`，AI 以为成功了。用户库里那 16 条"倒排看不见"就是这么来的。
   *
   * 用一个只针对 memory_terms 的触发器把第 4 步弄失败，是最贴近真实的方式：
   * 不是 mock，而是真的让第二条 INSERT 抛错。
   */
  test("词项写入失败 → 正文也不许留（不是半条）", async () => {
    const d2 = mkdtempSync(join(tmpdir(), "xbb-atomic-"));
    const s2 = PersonalStore.open(join(d2, "t.db"));
    const db2 = s2.db;
    try {
      db2.exec("CREATE TRIGGER boom BEFORE INSERT ON memory_terms BEGIN SELECT RAISE(ABORT, 'boom'); END");
      await expect(
        writeMemory(s2, { content: "这条记忆的词项写入会失败", terms: ["检索"] }),
      ).rejects.toThrow(/boom/);

      // 反面：不包事务的实现这里是 1，而且 content_hash 已落库 ⇒ 重试永远拿到 deduped
      expect((db2.query("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c).toBe(0);
      expect((db2.query("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c).toBe(0);

      // 触发器拿掉后同一条内容能正常写入 —— 证明失败没有在别处留下"占位"
      db2.exec("DROP TRIGGER boom");
      const r = await writeMemory(s2, { content: "这条记忆的词项写入会失败", terms: ["检索"] });
      expect(r.deduped).toBe(false);
      expect((db2.query("SELECT COUNT(*) AS c FROM memory_terms WHERE memory_id = ?").get(r.id) as { c: number }).c).toBeGreaterThan(0);
    } finally {
      db2.close();
      try {
        rmSync(d2, { recursive: true, force: true });
      } catch {
        /* Windows 句柄延迟 */
      }
    }
  });
});
