import { describe, expect, test } from "bun:test";
import { parseSseBlock, parseSseChunk } from "./events-parse";

describe("parseSseBlock", () => {
  test("常规块：event + id + data（服务端 org_event 帧的真实形状）", () => {
    const f = parseSseBlock('event: org_event\nid: 42\ndata: {"seq":42,"type":"memory.ack"}');
    expect(f).toEqual({ event: "org_event", id: "42", data: '{"seq":42,"type":"memory.ack"}' });
  });

  test("只吃**一个**前导空格（SSE 规范原文：a single U+0020），不做 trim——多了就该原样留着", () => {
    expect(parseSseBlock("data: x")!.data).toBe("x"); // 一个空格：吃掉
    expect(parseSseBlock("data:x")!.data).toBe("x"); // 没有空格：不动
    expect(parseSseBlock("data:  x")!.data).toBe(" x"); // 两个空格：只吃一个（不是 trim）
  });

  test("多行 data 用 \\n 拼接（SSE 规范）", () => {
    expect(parseSseBlock("data: a\ndata: b")!.data).toBe("a\nb");
  });

  test("注释行被忽略（服务端 25s 心跳就是注释；当成数据会炸）", () => {
    expect(parseSseBlock(": ping\n")).toBeNull();
    expect(parseSseBlock(":ping\ndata: x")!.data).toBe("x");
  });

  test("空块 → null；只有 event 无 data 也照样出帧（ready 帧带 data，但别假设一定有）", () => {
    expect(parseSseBlock("")).toBeNull();
    expect(parseSseBlock("event: ping")).toEqual({ event: "ping", data: "" });
  });

  test("块内残留 \\r 被剥掉（CRLF 分包到达的最后一道保险）", () => {
    expect(parseSseBlock("id: 7\r\ndata: y\r")).toEqual({ event: "message", id: "7", data: "y" });
  });

  test("字段名无冒号（`data` 裸行）→ 空值，不报错", () => {
    expect(parseSseBlock("data")!.data).toBe("");
  });
});

describe("parseSseChunk（流式切帧：跨 chunk 半帧 + CRLF）", () => {
  test("完整两帧一次到达", () => {
    const { frames, rest } = parseSseChunk("data: a\n\ndata: b\n\n");
    expect(frames.map((f) => f.data)).toEqual(["a", "b"]);
    expect(rest).toBe("");
  });

  test("半帧必须暂存——**这是流式解析唯一的真坑**", () => {
    const one = parseSseChunk('event: org_event\ndata: {"seq":1');
    expect(one.frames).toEqual([]);
    expect(one.rest).toBe('event: org_event\ndata: {"seq":1');

    // 续上后半段，并且后面还跟了一整帧
    const two = parseSseChunk(one.rest + '}\n\ndata: {"seq":2}\n\n');
    expect(two.frames.map((f) => f.data)).toEqual(['{"seq":1}', '{"seq":2}']);
    expect(two.rest).toBe("");
  });

  test("CRLF：整块 \\r\\n\\r\\n", () => {
    const { frames } = parseSseChunk("event: org_event\r\nid: 3\r\ndata: z\r\n\r\n");
    expect(frames).toEqual([{ event: "org_event", id: "3", data: "z" }]);
  });

  test("CRLF 的 \\r 与 \\n 分包到达（代理改写的极端情形）", () => {
    const a = parseSseChunk("data: q\r");
    expect(a.frames).toEqual([]);
    const b = parseSseChunk(a.rest + "\n\r\n");
    expect(b.frames.map((f) => f.data)).toEqual(["q"]);
  });

  test("纯心跳注释块不产生帧（否则每次心跳都会触发一次无谓的业务动作）", () => {
    const { frames, rest } = parseSseChunk(": keepalive\n\n: keepalive\n\n");
    expect(frames).toEqual([]);
    expect(rest).toBe("");
  });

  test("ready 帧可被识别（调用方据此在重连后补一次全量同步）", () => {
    const { frames } = parseSseChunk('event: ready\ndata: {"ok":true}\n\n');
    expect(frames[0]!.event).toBe("ready");
  });
});
