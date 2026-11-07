/**
 * models 单测——首启静默下载契约。
 * 本地 Bun.serve 起源（端口 0），请求计数器验证「TTL 内零请求」「过期后零文件请求」。
 * ttlMs:-1 = 确定性过期（age>=0 恒 > -1），避开同毫秒竞态（uuidv7 那课）。
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseManifest, sha256File, ensureModel, type ModelManifest } from "./models";

const CONTENT = Buffer.from("bge-small-zh-int8-fake-weights::".repeat(32));
const SHA = new Bun.CryptoHasher("sha256").update(CONTENT).digest("hex");

let manifestHits = 0;
let fileHits = 0;

function manifestWithUrls(prefix: string): ModelManifest {
  return {
    name: "bge-small-zh",
    version: "v1",
    files: [{ name: "weights.bin", sha256: SHA, size: CONTENT.length, urls: [`http://127.0.0.1:${server.port}${prefix}/weights.bin`] }],
  };
}

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/manifest") {
      manifestHits++;
      return Response.json(manifestWithUrls("/files"));
    }
    if (p === "/manifest-badurls") {
      manifestHits++;
      return Response.json(manifestWithUrls("/badfiles"));
    }
    if (p.startsWith("/files/")) {
      fileHits++;
      return new Response(CONTENT);
    }
    if (p.startsWith("/badfiles/")) {
      fileHits++;
      return new Response(Buffer.from("corrupted-payload!".repeat(8))); // 同量级不同内容
    }
    return new Response("not found", { status: 404 });
  },
});

const ROOT = mkdtempSync(join(tmpdir(), "xbb-models-"));
const caseDir = (n: string) => join(ROOT, n);

afterAll(() => {
  server.stop(true);
  rmSync(ROOT, { recursive: true, force: true });
});

describe("parseManifest", () => {
  test("合法 manifest 通过", () => {
    const m = parseManifest({ name: "bge", version: "v1", files: [{ name: "a.bin", sha256: SHA, size: 1, urls: ["http://x/a"] }] });
    expect(m).not.toBeNull();
    expect(m!.name).toBe("bge");
    expect(m!.files[0]!.name).toBe("a.bin");
  });
  test("非法输入全拒：非对象/缺 name/坏 sha/负 size/空 urls/空 files", () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest(42)).toBeNull();
    expect(parseManifest({ version: "v1", files: [{ name: "a", sha256: SHA, size: 1, urls: ["u"] }] })).toBeNull();
    expect(parseManifest({ name: "m", version: "v1", files: [{ name: "a", sha256: "xyz", size: 1, urls: ["u"] }] })).toBeNull();
    expect(parseManifest({ name: "m", version: "v1", files: [{ name: "a", sha256: SHA, size: -1, urls: ["u"] }] })).toBeNull();
    expect(parseManifest({ name: "m", version: "v1", files: [{ name: "a", sha256: SHA, size: 1, urls: [] }] })).toBeNull();
    expect(parseManifest({ name: "m", version: "v1", files: [] })).toBeNull();
  });
});

describe("ensureModel", () => {
  test("首次下载：downloaded + 内容正确 + .ok 落盘", async () => {
    const dir = caseDir("fresh");
    const r = await ensureModel(`${"http://127.0.0.1"}:${server.port}/manifest`, dir);
    expect(r.status).toBe("downloaded");
    if (r.status !== "downloaded") return;
    expect(r.bytes).toBe(CONTENT.length);
    expect(Buffer.from(readFileSync(join(dir, "weights.bin")))).toEqual(CONTENT);
    expect(existsSync(join(dir, ".ok"))).toBe(true);
    // .ok = manifest JSON 快照（可解析回）
    const ok = JSON.parse(readFileSync(join(dir, ".ok"), "utf8"));
    expect(ok.version).toBe("v1");
  });

  test("TTL 内二次调用：cached 零请求", async () => {
    const dir = caseDir("fresh");
    const m0 = manifestHits, f0 = fileHits;
    const r = await ensureModel(`http://127.0.0.1:${server.port}/manifest`, dir, { ttlMs: 60_000 });
    expect(r.status).toBe("cached");
    expect(manifestHits).toBe(m0);
    expect(fileHits).toBe(f0);
  });

  test("TTL 过期版本没变：cached，manifest 重拉但文件零请求（touch 续期）", async () => {
    const dir = caseDir("fresh");
    const m0 = manifestHits, f0 = fileHits;
    const r = await ensureModel(`http://127.0.0.1:${server.port}/manifest`, dir, { ttlMs: -1 });
    expect(r.status).toBe("cached");
    expect(manifestHits).toBe(m0 + 1); // manifest 要重拉确认版本
    expect(fileHits).toBe(f0); // 文件零请求
  });

  test("文件损坏：自动重下恢复", async () => {
    const dir = caseDir("fresh");
    writeFileSync(join(dir, "weights.bin"), Buffer.from("xxx")); // size 3 ≠ 原值
    const f0 = fileHits;
    const r = await ensureModel(`http://127.0.0.1:${server.port}/manifest`, dir, { ttlMs: -1 });
    expect(r.status).toBe("downloaded");
    expect(fileHits).toBe(f0 + 1);
    expect(Buffer.from(readFileSync(join(dir, "weights.bin")))).toEqual(CONTENT);
  });

  test(".ok 损坏：自愈重下", async () => {
    const dir = caseDir("fresh");
    writeFileSync(join(dir, ".ok"), "not-json-at-all");
    const r = await ensureModel(`http://127.0.0.1:${server.port}/manifest`, dir, { ttlMs: -1 });
    expect(r.status).toBe("downloaded");
    const ok = JSON.parse(readFileSync(join(dir, ".ok"), "utf8"));
    expect(ok.version).toBe("v1");
  });

  test("TTL 内信任 .ok（旧版本快照也 cached）——零请求契约的已知取舍", async () => {
    const dir = caseDir("fresh");
    const stale = { ...manifestWithUrls("/files"), version: "v0" };
    writeFileSync(join(dir, ".ok"), JSON.stringify(stale));
    writeFileSync(join(dir, "weights.bin"), CONTENT);
    const m0 = manifestHits, f0 = fileHits;
    const r = await ensureModel(`http://127.0.0.1:${server.port}/manifest`, dir, { ttlMs: 60_000 });
    expect(r.status).toBe("cached");
    expect(manifestHits).toBe(m0);
    expect(fileHits).toBe(f0);
  });

  test("文件级多源 fallback：坏源 sha 不符换好源", async () => {
    const dir = caseDir("mixed");
    const port = server.port;
    const m: ModelManifest = {
      name: "m",
      version: "1",
      files: [{ name: "weights.bin", sha256: SHA, size: CONTENT.length, urls: [`http://127.0.0.1:${port}/badfiles/weights.bin`, `http://127.0.0.1:${port}/files/weights.bin`] }],
    };
    const r = await ensureModel(m, dir);
    expect(r.status).toBe("downloaded");
    expect(Buffer.from(readFileSync(join(dir, "weights.bin")))).toEqual(CONTENT);
  });

  test("文件全源失败：failed + staging 清理 + 无 .ok", async () => {
    const dir = caseDir("allfail");
    const port = server.port;
    const m: ModelManifest = {
      name: "m",
      version: "1",
      files: [{ name: "weights.bin", sha256: SHA, size: CONTENT.length, urls: [`http://127.0.0.1:${port}/badfiles/weights.bin`] }],
    };
    const r = await ensureModel(m, dir);
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.reason).toContain("weights.bin");
    expect(existsSync(join(dir, ".ok"))).toBe(false);
    const leftovers = readdirSync(ROOT).filter((n) => n.includes(".staging-"));
    expect(leftovers).toEqual([]);
  });

  test("manifest 全源 404：failed 且 reason 指向 manifest", async () => {
    const dir = caseDir("nomanifest");
    const port = server.port;
    const r = await ensureModel([`http://127.0.0.1:${port}/none1`, `http://127.0.0.1:${port}/none2`], dir);
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.reason).toContain("manifest");
  });
});

describe("sha256File", () => {
  test("流式哈希与 Bun.CryptoHasher 一致", async () => {
    const dir = caseDir("fresh");
    expect(await sha256File(join(dir, "weights.bin"))).toBe(SHA);
  });
});
