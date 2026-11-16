// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * JSONC 剥离。
 *
 * 这一组存在的理由很具体：opencode 的官方配置示例全用 `opencode.jsonc`，带注释和尾逗号。
 * 只要剥离器少处理一种情况，`xbb connect` 就会把一份正在工作的配置判成「未接入」——
 * 2026-11-16 那条用户反馈的成因之一。
 *
 * 特别要盯住的是**字符串里的 `//`**：用正则删注释的实现会把 `"https://x"` 删成 `"https:`，
 * 配置直接坏掉。这不是理论风险，是最容易踩的那条路。
 */
import { describe, expect, test } from "bun:test";

import { parseJsonc, stripJsonc } from "./jsonc";

describe("stripJsonc", () => {
  test("纯 JSON 原样通过（对合法 JSON 必须是恒等变换）", () => {
    const src = '{"a":1,"b":[2,3],"c":{"d":"x"}}';
    expect(stripJsonc(src)).toBe(src);
    expect(parseJsonc(src)).toEqual({ a: 1, b: [2, 3], c: { d: "x" } });
  });

  test("行注释被去掉，剩下的仍然能解析", () => {
    const src = `{
  // opencode 的官方写法
  "mcp": { "servers": {} } // 尾注释
}`;
    expect(parseJsonc(src)).toEqual({ mcp: { servers: {} } });
  });

  test("块注释被去掉", () => {
    const src = '{ /* 说明 */ "a": 1 }';
    expect(parseJsonc(src)).toEqual({ a: 1 });
  });

  test("字符串里的 // 不被当注释 —— 这条是分水岭", () => {
    const src = '{"url":"https://api.example.com/mcp","note":"a//b"}';
    expect(parseJsonc(src)).toEqual({ url: "https://api.example.com/mcp", note: "a//b" });
  });

  test("字符串里的 /* 也不被当块注释", () => {
    const src = '{"glob":"src/*/x.ts"}';
    expect(parseJsonc(src)).toEqual({ glob: "src/*/x.ts" });
  });

  test("转义引号不会提前结束字符串", () => {
    const src = '{"path":"C:\\\\x\\\\y","commented":"// not a comment"}';
    expect(parseJsonc(src)).toEqual({ path: "C:\\x\\y", commented: "// not a comment" });
  });

  test("尾逗号（对象与数组）被去掉", () => {
    expect(parseJsonc('{"a":1,}')).toEqual({ a: 1 });
    expect(parseJsonc('{"a":[1,2,],}')).toEqual({ a: [1, 2] });
    expect(parseJsonc('{"a":1,\n  "b":2,\n}')).toEqual({ a: 1, b: 2 });
  });

  test("字符串里的 ,] 不被误删（不能用正则事后替换的理由）", () => {
    expect(parseJsonc('{"a":",]","b":",}"}')).toEqual({ a: ",]", b: ",}" });
  });

  test("未闭合的块注释不崩，交给 JSON.parse 报错由调用方兜底", () => {
    expect(() => parseJsonc('{"a":1 /* 没关')).toThrow();
  });

  test("空文本报错而不是返回 undefined", () => {
    expect(() => parseJsonc("")).toThrow();
  });

  test("注释里的中文与换行不影响后续行号", () => {
    const src = `{
  // 第一行注释
  // 第二行注释
  "ok": true
}`;
    expect(parseJsonc(src)).toEqual({ ok: true });
  });
});
