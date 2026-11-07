/**
 * 本地服务的来源闸（Host / Origin）必须覆盖**每一条**路由。
 *
 * 这条测试守的是一个已经真实发生过的缺口：`localGuard` 原本只写在 `web/admin.ts` 的
 * `handleServe` 里，而 `serve.ts` 自己还挂着一批端点（`/memories` 读全库、
 * `/sessions/{id}/transcript` 读原话、`/secrets` 列凭据、`/memories/forget` 与
 * `/secrets/delete` 改数据、`/update` 触发替换 exe）—— 它们全在 `handleServe` 之前返回，
 * 于是**一条都没过闸**。
 *
 * 后果不是"少一层防护"：DNS rebinding 下恶意页面把自己的域名解析到 127.0.0.1，
 * 同源请求带 `Host: evil.example`，服务端不看 Host 就照答 ⇒ **整库可读**。
 *
 * 为什么用裸 TCP 而不是 `fetch`：`Host` 在部分 HTTP 客户端里是受控头，会被改写或忽略。
 * 要验"服务端看不看 Host"，就必须自己把那一行 header 原样发过去。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalStore } from "./store";
import { startServe } from "./serve";

let dir = "";
let store: PersonalStore;
let server: { port: number; stop: (force?: boolean) => void };

/** 发一条原始 HTTP 请求，只取状态码（-1 = 超时/连接失败） */
function rawStatus(port: number, head: string): Promise<number> {
  return new Promise((resolve) => {
    const sock = connect(port, "127.0.0.1");
    let buf = "";
    const done = (code: number) => {
      sock.destroy();
      resolve(code);
    };
    sock.on("connect", () => sock.write(head));
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      const m = buf.match(/^HTTP\/1\.[01] (\d{3})/);
      if (m) done(Number(m[1]));
    });
    sock.on("error", () => done(-1));
    setTimeout(() => done(-1), 3000);
  });
}

const req = (method: string, path: string, host: string, extra = "", body = "") =>
  `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n${extra}` +
  (body ? `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}` : "\r\n");

describe("本地服务的来源闸：每条路由都要过", () => {
  beforeAll(async () => {
    process.env.XBB_SEED = "0"; // 不播种默认约束，测试不该写业务数据
    dir = mkdtempSync(join(tmpdir(), "xbb-serve-guard-"));
    store = PersonalStore.open(join(dir, "memory.db"));
    // startServe 是 async：不 await 拿到的是 Promise，`.port` 会是 undefined
    server = (await startServe(store, 0)) as unknown as { port: number; stop: (f?: boolean) => void };
  });

  afterAll(() => {
    try {
      server?.stop(true);
    } catch {
      /* 已停 */
    }
    // Windows 上 SQLite 的 WAL/SHM 句柄释放有延迟：不重试会 EBUSY。
    try {
      store?.db.close();
    } catch {
      /* 已关 */
    }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      /* 临时目录残留不影响断言（系统会清 tmp） */
    }
  });

  const PORT = () => server.port;
  const LOOP = () => `127.0.0.1:${PORT()}`;

  test("serve.ts 自有端点：伪造 Host 一律 403（这些曾经完全裸奔）", async () => {
    for (const p of [
      "/memories",
      "/memories/inbox",
      "/sessions",
      "/secrets",
      "/report",
      "/stats",
      "/healthz",
      "/update-check",
      "/purge/preview",
    ]) {
      expect(await rawStatus(PORT(), req("GET", p, "evil.example"))).toBe(403);
    }
  });

  test("改数据的端点：伪造 Host 也 403（不能靠方法不同就放行）", async () => {
    const body = JSON.stringify({ id: "x" });
    for (const p of ["/memories/forget", "/memories/ack", "/secrets/delete", "/update-dismiss", "/hooks/turn"]) {
      const code = await rawStatus(
        PORT(),
        req("POST", p, "evil.example", "Content-Type: text/plain\r\n", body),
      );
      expect(code).toBe(403);
    }
  });

  test("Host 合法但 Origin 是外站：403（跨站调用同源照样拦）", async () => {
    const code = await rawStatus(
      PORT(),
      req("POST", "/memories/forget", LOOP(), "Origin: http://evil.example\r\nContent-Type: text/plain\r\n", JSON.stringify({ id: "x" })),
    );
    expect(code).toBe(403);
  });

  test("本机来源正常放行（不能把闸修成一律拒绝）", async () => {
    expect(await rawStatus(PORT(), req("GET", "/healthz", LOOP()))).toBe(200);
    expect(await rawStatus(PORT(), req("GET", "/memories", LOOP()))).toBe(200);
    // localhost 也算本机（自更新探针、托盘、冒烟都用它）
    expect(await rawStatus(PORT(), req("GET", "/healthz", `localhost:${PORT()}`))).toBe(200);
    // 界面与其 API
    expect(await rawStatus(PORT(), req("GET", "/ui", LOOP()))).toBe(200);
    expect(await rawStatus(PORT(), req("GET", "/api/list", LOOP()))).toBe(200);
    expect(await rawStatus(PORT(), req("GET", "/api/list", "evil.example"))).toBe(403);
  });
});
