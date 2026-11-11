// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 存量向量回填。
 *
 * 这条测试守的是一个**静默的数据缺口**：写入路径的向量是 fire-and-forget 的，
 * 一旦错过（模型没就绪/进程提前退出/早期批量导入），那行的 embedding 就永久是 NULL，
 * 而 vecTopK 只认 `embedding IS NOT NULL` —— 这些记忆在语义通道里等于不存在。
 * 实测真实库里 576 条活跃记忆有 121 条（21%）处于这个状态，且没有任何信号。
 *
 * embed 在这里被替换成确定性假实现：本文件验的是回填管线（选行、推进游标、幂等、
 * 缓存失效），不是模型本身 —— 真跑模型会让单元测试变成一次 24MB 下载。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { PersonalStore } from "./store";
import { embedder, VEC_MODEL } from "./embedder";
import { backfillEmbeddings } from "./embed-backfill";

const dir = mkdtempSync(join(tmpdir(), "xbb-backfill-test-"));
const store = PersonalStore.open(join(dir, "test.db"));
const db = store.db;

afterAll(() => {
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 临时目录残留，忽略 */
  }
});

const mem = (content: string) => store.deliver({ spaceId: "sp-1", actor: "ai-host", content });
const nullCount = () =>
  (db.query("SELECT COUNT(*) AS n FROM memories WHERE embedding IS NULL AND deleted_at IS NULL").get() as { n: number }).n;

/** 替换 embed（返回 restore）。这里不需要真模型，只需要「哪些能算、哪些算不出来」 */
function stubEmbed(fn: (t: string) => Float32Array | null): () => void {
  const real = embedder.embed;
  embedder.embed = async (t: string) => fn(t);
  return () => {
    embedder.embed = real;
  };
}

describe("存量向量回填", () => {
  test("有正文没向量的行被补上，已有向量的行一个字都不动", async () => {
    const a = await mem("回填目标甲");
    await mem("回填目标乙");
    const keep = await mem("这条早就有向量了");
    const v0 = new Float32Array(512).fill(0.1);
    db.prepare("UPDATE memories SET embedding = ?, vec_model = ? WHERE id = ?")
      .run(Buffer.from(v0.buffer.slice(0)), VEC_MODEL, keep.id);

    const restore = stubEmbed(() => new Float32Array(512).fill(0.25));
    const r = await backfillEmbeddings(db);
    restore();

    expect(r.failed).toBe(0);
    expect(r.done).toBe(2);
    expect(nullCount()).toBe(0);
    expect(a.id).toBeTruthy();

    // 已存在的那条必须原样保留（回填只补 NULL，不是无脑重算）
    const got = db.prepare("SELECT embedding, vec_model FROM memories WHERE id = ?").get(keep.id) as
      | { embedding: Uint8Array; vec_model: string }
      | undefined;
    expect(got?.vec_model).toBe(VEC_MODEL);
    const f = new Float32Array(got!.embedding.buffer, got!.embedding.byteOffset, 512);
    expect(f[0]).toBeCloseTo(0.1, 5);
  });

  test("补完再跑一次是空转（幂等，不会把全库重算一遍）", async () => {
    const restore = stubEmbed(() => new Float32Array(512).fill(0.25));
    const r = await backfillEmbeddings(db);
    restore();
    expect(r.total).toBe(0);
    expect(r.done).toBe(0);
  });

  test("模型一条都算不出来时不死循环、不写坏数据", async () => {
    await mem("这条永远算不出向量");
    const restore = stubEmbed(() => null);
    // 关键：没有任何行被填上 ⇒ 必须主动收手。若游标不推进或不做这个判断，
    // 这里会变成一个永远填不上的死循环，而它跑在 MCP 进程里。
    const r = await backfillEmbeddings(db);
    restore();
    expect(r.done).toBe(0);
    expect(r.failed).toBeGreaterThan(0);
    expect(nullCount()).toBe(1); // 留成 NULL 等下轮，不是写一坨垃圾进去
  });

  test("reembed 才碰 vec_model 对不上的行（换模型用，默认关）", async () => {
    const rec = await mem("换模型之前算出来的那条");
    const old = new Float32Array(512).fill(0.5);
    db.prepare("UPDATE memories SET embedding = ?, vec_model = ? WHERE id = ?")
      .run(new Uint8Array(old.buffer.slice(0)), "old-model/x", rec.id);

    const restore = stubEmbed(() => new Float32Array(512).fill(0.75));
    // 默认模式只补 NULL（上一条测试留下的那条），不碰 vec_model 对不上的行
    const plainRun = await backfillEmbeddings(db);
    expect(plainRun.done).toBeGreaterThanOrEqual(1);
    const plain = db.prepare("SELECT vec_model FROM memories WHERE id = ?").get(rec.id) as { vec_model: string };
    expect(plain.vec_model).toBe("old-model/x");

    const r = await backfillEmbeddings(db, { reembed: true });
    restore();
    const after = db.prepare("SELECT vec_model FROM memories WHERE id = ?").get(rec.id) as { vec_model: string };
    expect(after.vec_model).toBe(VEC_MODEL);
    expect(r.done).toBeGreaterThanOrEqual(1); // 换模型那条被重算
    expect(nullCount()).toBe(0);
  });
});
