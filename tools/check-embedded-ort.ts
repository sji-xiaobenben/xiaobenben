// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 内嵌向量运行时自检：拿**真产物**跑一次，确认内嵌的 ORT 能被释放成可加载的目录。
 *
 * 为什么需要这一条：0.4.50 把 onnxruntime 塞进了 exe，而这条链路上每一步失败都是**静的** ——
 *   · `with { type: "file" }` 没被 Bun 内嵌 → 运行时 gz 路径不存在 → 解压失败 → 悄悄降级
 *   · gzip 解压出 0 字节 → 目录结构看着对、加载失败 → 悄悄降级
 *   · 只内嵌了 CPU 文件却漏了 binding.node → 同上
 * 三种情况下用户拿到的都是「能跑但没有语义检索」的 exe，命令行不报错、退出码是 0。
 * 这正是这套改动要消灭的那类失败，所以必须有一条断言盯着它。
 *
 * 判断标准不用「向量就绪」：那还要等 24MB 模型下载，CI 里代价太大且会因网络抖动假红。
 * 这里只验「运行时能落地」——模型能不能下是另一条链路（`models.ts` 自带 sha256 校验）。
 *
 * 用法：
 *   bun run tools/check-embedded-ort.ts dist/xbb-windows-x64.exe
 *   交叉编译的产物（别的平台）会 SKIP 并退出 0。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const arg = process.argv[2];
if (!arg) {
  console.error("用法: bun run tools/check-embedded-ort.ts <可执行文件>");
  process.exit(2);
}
const exe = resolve(arg);
if (!existsSync(exe)) {
  console.error(`✗ 找不到产物：${exe}`);
  process.exit(1);
}

/** 产物平台（从文件名判断；决定了该找哪种原生库） */
const name = exe.toLowerCase();
const plat = name.includes("windows") ? "win32" : name.includes("darwin") ? "darwin" : "linux";
const arch = name.includes("arm64") ? "arm64" : "x64";
const HOST = `${process.platform === "win32" ? "win32" : process.platform}-${process.arch}`;

// 上游对 darwin/x64 不发原生库，产物本来就没有内嵌 —— 不是失败
if (plat === "darwin" && arch === "x64") {
  console.log(`SKIPPED darwin-x64 没有 onnxruntime 原生库，产物按设计不含向量通道`);
  process.exit(0);
}

// 只能真跑本机平台的产物
if (`${plat}-${arch}` !== HOST) {
  console.log(`SKIPPED ${plat}-${arch} 不是本机平台（${HOST}），无法执行验证`);
  process.exit(0);
}

const home = mkdtempSync(join(tmpdir(), "xbb-embed-check-"));
const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "embed-check", version: "0" } },
});

let pass = 0;
let fail = 0;
function chk(name: string, cond: boolean, extra = ""): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

console.log("内嵌向量运行时自检");
console.log(`  产物 ${exe}`);
console.log(`  临时 home ${home}`);

const child = Bun.spawn([exe, "mcp"], {
  // 模型目录指到一个不存在的位置：确保我们等的是 ORT 释放，而不是模型下载完成的副作用
  env: { ...process.env, XBB_HOME: home, XBB_MODEL_DIR: join(home, "__no_model__") },
  stdin: "pipe",
  stdout: "ignore",
  stderr: "pipe",
});
child.stdin.write(`${INIT}\n`);
await child.stdin.flush();

/**
 * 等 ort/<key>/onnxruntime-node 出现。
 *
 * ⚠️ 判据必须是 `.ok` 而不是「目录存在」：释放是先写 `<key>.staging.<pid>.<ts>` 再 rename，
 * 中途轮询会看到 staging 里的半成品（第一个落盘的文件恰好就是 ort-bundle.cjs），
 * 于是"看起来释放好了"但原生库还没写完 —— 上一版这条检查就是这么假红的。
 */
function releaseDir(): string | null {
  const root = join(home, "ort");
  if (!existsSync(root)) return null;
  for (const k of readdirSync(root)) {
    if (k.includes(".staging.")) continue;
    if (!existsSync(join(root, k, ".ok"))) continue;
    const pkg = join(root, k, "onnxruntime-node");
    if (existsSync(join(pkg, "dist", "ort-bundle.cjs"))) return pkg;
  }
  return null;
}

let pkg: string | null = null;
for (let i = 0; i < 60; i++) {
  pkg = releaseDir();
  if (pkg) break;
  await new Promise((r) => setTimeout(r, 250));
}
try {
  child.kill();
} catch {
  /* 已经退出 */
}

chk("进程能启动并响应 initialize（未崩溃）", child.exitCode === null || child.exitCode === 0);

if (!pkg) {
  chk("内嵌 ORT 被释放到 XBB_HOME/ort/<key>/", false, "15 秒内没等到目录 —— 内嵌资源可能没进 exe");
} else {
  const root = join(pkg, "..");
  chk("内嵌 ORT 被释放到 XBB_HOME/ort/<key>/", true);
  chk("释放完成标记 .ok 存在（幂等判据）", existsSync(join(root, ".ok")));

  const bundle = join(pkg, "dist", "ort-bundle.cjs");
  const bundleSize = existsSync(bundle) ? statSync(bundle).size : 0;
  chk("dist/ort-bundle.cjs 存在且非空", bundleSize > 10_000, `${bundleSize} 字节`);

  const nat = join(pkg, "bin", "napi-v6", plat, arch);
  const files = existsSync(nat) ? readdirSync(nat) : [];
  chk("onnxruntime_binding.node 已释放", files.includes("onnxruntime_binding.node"), files.join(","));
  const libRe = plat === "win32" ? /^onnxruntime\.dll$/ : plat === "linux" ? /^libonnxruntime\.so/ : /^libonnxruntime.*\.dylib$/;
  chk(`原生库已释放（${plat}/${arch}）`, files.some((f) => libRe.test(f)), files.join(","));

  // 关键体积断言：解压出 0 字节或截断时上面几条都可能「通过」，加起来一称就露馅
  let total = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  if (existsSync(root)) walk(root);
  chk("释放总字节数合理（> 20MB）", total > 20 * 1048576, `${(total / 1048576).toFixed(1)}MB`);

  // GPU 后端不该被内嵌：代码里写死 cpu execution provider，带上纯属浪费下载量
  chk("未内嵌 GPU 后端（DirectML/dxcompiler）", !files.some((f) => /^(DirectML\.dll|dxcompiler\.dll|dxil\.dll)$/.test(f)), files.join(","));
}

try {
  rmSync(home, { recursive: true, force: true });
} catch {
  /* Windows 上刚 kill 的进程可能还占着文件，删不掉不影响结论 */
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
