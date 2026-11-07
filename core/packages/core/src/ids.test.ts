import { describe, expect, test } from "bun:test";
import { isUUIDv7, uuidv7 } from "./ids";

describe("uuidv7", () => {
  test("格式合法：version=7、variant=10", () => {
    const id = uuidv7();
    expect(isUUIDv7(id)).toBe(true);
  });

  test("时间位 ≈ 当前时间（48-bit unix ms，容差 5s）", () => {
    const id = uuidv7();
    const ts = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    expect(Math.abs(ts - Date.now())).toBeLessThan(5000);
  });

  test("时间有序：跨毫秒生成的 id 保持字典序（同毫秒对跳过——排序由随机位决定）", () => {
    const a = uuidv7();
    let b = uuidv7();
    let tries = 0;
    // 同毫秒内时间位相同、次序随机，不构成有序性断言；跨毫秒后时间位单调
    while (a.slice(0, 13) === b.slice(0, 13) && tries < 1000) {
      b = uuidv7();
      tries++;
    }
    expect(b.slice(0, 13)).not.toBe(a.slice(0, 13)); // 毫秒必然推进
    expect(b >= a).toBe(true);
  });

  test("唯一性：批量生成无碰撞", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(uuidv7());
    expect(seen.size).toBe(10_000);
  });

  test("isUUIDv7 拒绝非 v7 / 非 variant10 的 UUID", () => {
    expect(isUUIDv7("00000000-0000-7000-8000-000000000000")).toBe(true); // v7 合法
    expect(isUUIDv7("00000000-0000-4000-8000-000000000000")).toBe(false); // v4 不是 v7
    expect(isUUIDv7("00000000-0000-7000-c000-000000000000")).toBe(false); // variant 11 非法
    expect(isUUIDv7("not-a-uuid")).toBe(false);
  });
});
