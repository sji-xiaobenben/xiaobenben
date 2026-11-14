// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 蒸馏状态判定的边界测试。
 *
 * 为什么这个模块值得单独测：它的产物是**打扰用户的提示**。判错的两种代价都实打实：
 * 该亮不亮 → 用户又一次靠「感觉它忘了」才发现（2026-11-14 就是）；
 * 不该亮乱亮 → 天天弹警告，用户学会无视，等于把这个信号永久废掉。
 * 所以每条阈值两侧都要有断言。
 */
import { describe, expect, test } from "bun:test";
import { distillHint } from "./distill";

/** 固定时钟，绝不依赖真实时间（否则测试会在某天自己变红）。 */
const NOW = Date.parse("2026-11-14T16:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString();

describe("distillHint", () => {
  test("一天前刚写过：不打扰", () => {
    expect(distillHint({ lastMemoryAt: daysAgo(1), episodeSince: 500, memoryTotal: 600, now: NOW })).toBeNull();
  });

  test("今天刚写过（ageDays=0）：不打扰", () => {
    expect(distillHint({ lastMemoryAt: new Date(NOW).toISOString(), episodeSince: 3, memoryTotal: 604, now: NOW })).toBeNull();
  });

  test("两天前 + 原话攒够 30：亮警告，且文案带天数和条数", () => {
    const h = distillHint({ lastMemoryAt: daysAgo(2), episodeSince: 30, memoryTotal: 604, now: NOW });
    expect(h).not.toBeNull();
    expect(h!.tone).toBe("warn");
    expect(h!.ageDays).toBe(2);
    expect(h!.title).toContain("2 天");
    expect(h!.detail).toContain("30 条原话");
    expect(h!.detail).toContain("604 条");
  });

  test("三天前但只攒了 10 条原话：还不值得提醒", () => {
    expect(distillHint({ lastMemoryAt: daysAgo(3), episodeSince: 10, memoryTotal: 604, now: NOW })).toBeNull();
  });

  // 这条专门夹住「30」这个阈值本身：25 落在 (20, 30) 区间，阈值一旦被改小就会漏出警告。
  // 2026-11-14 变异测试实测抓到过我漏写这个区间——把 30 改成 20 时整套测试仍然全绿。
  test("两天前 + 25 条原话：仍在阈值之下，不提醒", () => {
    expect(distillHint({ lastMemoryAt: daysAgo(2), episodeSince: 25, memoryTotal: 604, now: NOW })).toBeNull();
  });

  test("六天前 + 大量原话：天数没到 7，但量够了，要提醒", () => {
    const h = distillHint({ lastMemoryAt: daysAgo(6), episodeSince: 200, memoryTotal: 604, now: NOW });
    expect(h).not.toBeNull();
    expect(h!.tone).toBe("warn");
  });

  test("超过一周：哪怕原话只有 1 条也提醒（长时间停滞本身就是信号）", () => {
    const h = distillHint({ lastMemoryAt: daysAgo(8), episodeSince: 1, memoryTotal: 604, now: NOW });
    expect(h).not.toBeNull();
    expect(h!.tone).toBe("warn");
    expect(h!.ageDays).toBe(8);
  });

  test("停了很久但一条新原话都没有：不提醒（没东西可蒸馏，提了也没用）", () => {
    expect(distillHint({ lastMemoryAt: daysAgo(30), episodeSince: 0, memoryTotal: 604, now: NOW })).toBeNull();
  });

  test("空库且没有原话：不提醒（新装用户不该一打开就看到警告）", () => {
    expect(distillHint({ lastMemoryAt: null, episodeSince: 0, memoryTotal: 0, now: NOW })).toBeNull();
  });

  test("空库但已经攒下原话：提示去蒸馏", () => {
    const h = distillHint({ lastMemoryAt: null, episodeSince: 12, memoryTotal: 0, now: NOW });
    expect(h).not.toBeNull();
    expect(h!.tone).toBe("tip");
    expect(h!.ageDays).toBeNull();
    expect(h!.title).toContain("12 条原话");
  });

  test("时间戳解析不出来：当作没有信号，绝不误报", () => {
    expect(distillHint({ lastMemoryAt: "not-a-date", episodeSince: 999, memoryTotal: 604, now: NOW })).toBeNull();
  });

  test("时钟漂移导致记忆时间在未来：不报", () => {
    const future = new Date(NOW + 3 * 86400000).toISOString();
    expect(distillHint({ lastMemoryAt: future, episodeSince: 200, memoryTotal: 604, now: NOW })).toBeNull();
  });

  test("负数 episodeSince（脏数据）不会变成「攒够了」", () => {
    expect(distillHint({ lastMemoryAt: daysAgo(3), episodeSince: -5, memoryTotal: 604, now: NOW })).toBeNull();
  });
});
