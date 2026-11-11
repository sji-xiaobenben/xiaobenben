// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * embed() 在「模型正在加载」这一小段窗口里的行为。
 *
 * 这条守的是一个必然会撞上、而不是偶发的时序：warmup 是 fire-and-forget（不能让
 * 1 秒的解压排在 MCP initialize 响应前面），而 MCP 客户端每开一次连接就 spawn 一个新
 * 进程 —— 于是「连上就问」必然落在模型还没 ready 的几百毫秒里。
 * 老实现 `if (status !== "ready") return null` 既不等也不触发加载：每次首问都白降级一次，
 * 而 AI 拿到降级结果会对用户说「没有相关记录」。
 *
 * 这里不加载真模型（那是 24MB 下载），只把 status/loading 摆成现场的形状，
 * 验「会不会等」和「等多久就放手」这两个判断。
 */
import { describe, expect, test } from "bun:test";
import { embedder } from "./embedder";

type Probe = { status: string; loading: Promise<boolean> | null };
const probe = embedder as unknown as Probe;

/** 摆现场：status=loading，loading 在 ms 后 resolve(false)；返回还原函数 */
function fakeLoading(ms: number): () => void {
  const status = probe.status;
  const loading = probe.loading;
  probe.status = "loading";
  probe.loading = new Promise<boolean>((r) => setTimeout(() => r(false), ms));
  return () => {
    probe.status = status;
    probe.loading = loading;
  };
}

describe("embed 在加载窗口内的取舍", () => {
  test("窗口内会等一会儿再判死刑，而不是立刻返回 null", async () => {
    const restore = fakeLoading(60);
    const t0 = Date.now();
    const v = await embedder.embed("随便一句话");
    const ms = Date.now() - t0;
    restore();
    expect(v).toBeNull(); // 还是没就绪，结果不变
    expect(ms).toBeGreaterThanOrEqual(45); // 但确实等过了
  });

  test("加载迟迟不完成时到点撒手，不会把工具调用一直吊着", async () => {
    // 上限 800ms：真等满说明该降级了（首启解压 + 24MB 下载本来就是分钟级）
    const restore = fakeLoading(3000);
    const t0 = Date.now();
    const v = await embedder.embed("随便一句话");
    const ms = Date.now() - t0;
    restore();
    expect(v).toBeNull();
    expect(ms).toBeGreaterThanOrEqual(700);
    expect(ms).toBeLessThanOrEqual(2500); // 手必须真的撒开，不能等那 3 秒
  });

  test("空闲（从未加载）不进入等待：不存在「等一个永远不开始的加载」", async () => {
    const status = probe.status;
    probe.status = "idle";
    const t0 = Date.now();
    const v = await embedder.embed("随便一句话");
    probe.status = status;
    expect(v).toBeNull();
    expect(Date.now() - t0).toBeLessThan(50);
  });
});
