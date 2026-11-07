/**
 * ORT 原生库路径冒烟（2026-10-23，对应 v0.4.40 在 Windows 11 上 `xbb mcp` 段错误）
 *
 * 修的是什么：Win11 24H2+ 的 Windows ML 在 `C:\Windows\System32` 预装 `onnxruntime.dll`
 * （1.17 / ORT_API_VERSION=17），而捆绑的 onnxruntime-node 1.30 要求 API 30。
 * DLL 搜索顺序一旦命中 System32 那份，ORT 在原生层 abort，**进程当场死**，
 * 外层 try/catch 拦不住（真实用户反馈：Win11 Home China 26300）。
 *
 * 本测试验四条，缺一条就等于没验：
 *   ① 正向：`findBundledOrtDir` 能在旁路包里定位到完整的 ORT（DLL + binding.node）
 *   ② 正向：pin 之后进程里的 onnxruntime.dll 路径 = 旁路包目录（不是 System32）
 *   ③ 正向：`loadOrtFromPkg` 真的能加载成功（require 链路没被 pin 弄坏）
 *   ④ 反证：同名 DLL 已被别人先加载时，pin 判 unsafe **且** `loadOrtFromPkg` 返回 null 而不是崩
 *      —— 这条必须在子进程里跑：污染 DLL 搜索是进程级、不可撤销的
 *
 * 用法：
 *   bun run tools/ort-path-smoke.ts                # 非 Windows 打印 SKIPPED 并退出 0
 *   bun run tools/ort-path-smoke.ts --require-win  # 非 Windows 直接 FAIL（本机/Windows CI 用）
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { findBundledOrtDir, loadOrtFromPkg, pinBundledOrt } from "../src/embedder";

const IS_WIN = process.platform === "win32";
const REQUIRE_WIN = process.argv.includes("--require-win");
const PKG =
  process.env.XBB_ORT_PKG ?? join(process.cwd(), "node_modules", "onnxruntime-node");
const TEMP_ROOT = process.env.TEMP ?? process.env.TMP ?? ".";
// 目录名带 pid：并发跑两个（两个终端 / 自托管 runner）不会互相踩。
// 踩踏的方向是假红（EBUSY / dlopen 126）而不是假绿，但没必要制造噪声。
const TMP = join(TEMP_ROOT, `xbb-ort-preempt-${process.pid}`);

/** 清掉别的进程留下的老目录（DLL 被加载后当次删不掉，只能等下次） */
function sweepOldTemps(): void {
  try {
    for (const d of readdirSync(TEMP_ROOT)) {
      if (!/^xbb-ort-preempt-\d+$/.test(d)) continue;
      const p = join(TEMP_ROOT, d);
      try {
        if (Date.now() - statSync(p).mtimeMs > 3_600_000) rmSync(p, { recursive: true, force: true });
      } catch {
        /* 删不掉就留着，不阻塞测试 */
      }
    }
  } catch {
    /* 目录不可读 → 忽略 */
  }
}

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

/* ═════════ 子进程：污染实验（加载一份「路径不对的同名 DLL」） ═════════ */
if (process.argv.includes("--polluted")) {
  const dir = findBundledOrtDir(PKG);
  if (!dir) {
    console.log(JSON.stringify({ skip: "no-bundled-ort" }));
    process.exit(0);
  }
  // 真 ORT 的副本：能加载、能导出 OrtGetApiBase，但路径不是旁路包 → 等价于「被别人抢先」
  // ⚠️ 必须连同级依赖一起复制，否则 dlopen 会因缺 DirectML.dll 失败（那会变成假绿）
  try {
    sweepOldTemps();
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    for (const f of ["onnxruntime.dll", "DirectML.dll", "dxcompiler.dll", "dxil.dll"]) {
      const src = join(dir, f);
      if (existsSync(src)) copyFileSync(src, join(TMP, f));
    }
    const { dlopen, FFIType } = await import("bun:ffi");
    // ⚠️ Bun 的 dlopen 不接受空 symbols（"Expected at least one symbol"），必须给真实导出
    dlopen(join(TMP, "onnxruntime.dll"), { OrtGetApiBase: { args: [], returns: FFIType.ptr } });
  } catch (e) {
    console.log(JSON.stringify({ skip: `cannot-preload: ${String(e).slice(0, 80)}` }));
    process.exit(0);
  }

  const pin = await pinBundledOrt(PKG);
  // 关键：不仅判 unsafe，还要真的走 loadOrtFromPkg —— 用户崩在 require，不崩在 pin
  let loaded: string;
  try {
    loaded = (await loadOrtFromPkg(PKG)) === null ? "null" : "module";
  } catch (e) {
    loaded = `threw:${String(e).slice(0, 60)}`;
  }
  console.log(JSON.stringify({ pinSafe: pin.safe, pinDetail: pin.detail, loaded, tmpBase: basename(TMP) }));
  process.exit(0);
}

/* ═════════ 主进程 ═════════ */
if (!IS_WIN) {
  if (REQUIRE_WIN) {
    console.log("ORT 路径冒烟\n  ✗ 本测试只对 Windows 有意义，但要求必须在 Windows 上跑");
    console.log("\nFAIL  0 通过 / 1 失败");
    process.exit(1);
  }
  console.log("SKIPPED 非 Windows：DLL 抢占问题只存在于 Windows，本测试不作断言");
  process.exit(0);
}

console.log("ORT 路径冒烟");
console.log(`  平台 ${process.platform}/${process.arch}  pkg=${PKG}`);

// ① 定位
const dir = findBundledOrtDir(PKG);
chk("旁路包可定位（含 DLL + binding.node）", dir !== null, `pkg=${PKG}`);
if (!dir) {
  console.log("\nFAIL：旁路包不完整，后续断言无法进行");
  process.exit(1);
}
chk("onnxruntime.dll 存在", existsSync(join(dir, "onnxruntime.dll")));
chk("onnxruntime_binding.node 存在", existsSync(join(dir, "onnxruntime_binding.node")));

// ② pin 后加载的是我们的那份（严格 startsWith 目录，不是子串）
const pin = await pinBundledOrt(PKG);
chk("pin 返回 safe", pin.safe === true, pin.detail);
chk(
  "pin 后路径 = 旁路包目录（而非 System32）",
  pin.detail.toLowerCase().startsWith(`${dir.toLowerCase()}\\`),
  pin.detail,
);
pin.restore();

// ③ require 链路能真的加载（防止「pin 对了但把 require 弄坏了」）
//    前置：dist/ort-bundle.cjs 是构建产物（bun run bundle:ort），bun install 不会生成；
//    test/test:ci 已把它放在链路最前面，所以缺失即视为真问题而不是环境差异。
if (!existsSync(join(PKG, "dist", "ort-bundle.cjs"))) {
  chk("旁路包含 dist/ort-bundle.cjs（缺则先跑 bun run bundle:ort）", false, PKG);
} else {
  const mod = await loadOrtFromPkg(PKG);
  chk("loadOrtFromPkg 加载成功（require 链路可用）", mod !== null && typeof mod.InferenceSession !== "undefined");
  chk("导出的 ORT 提供 Tensor 构造器", mod !== null && typeof mod.Tensor === "function");
}

// ④ 反证：被抢占时必须判 unsafe 且放弃加载（而不是崩）
const child = Bun.spawnSync([process.execPath, import.meta.path, "--polluted"], {
  stdout: "pipe",
  stderr: "pipe",
  env: process.env,
});
const raw = new TextDecoder().decode(child.stdout).trim();
let r: { skip?: string; pinSafe?: boolean; pinDetail?: string; loaded?: string; tmpBase?: string } = {};
try {
  r = JSON.parse(raw.split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}");
} catch {
  /* 解析失败按未通过处理 */
}
if (r.skip) {
  // 不静默跳过：造不出抢占场景本身就是测试失效，必须红
  chk("反证可执行（造不出抢占场景 = 测试失效）", false, r.skip);
} else {
  chk("反证：被抢占时 pin 判 unsafe", r.pinSafe === false, raw);
  // 用 basename 而不是全路径：GetModuleFileNameW 可能返回 8.3 短路径（USERNA~1），
  // 长路径 contains 会假红；basename 在长短两种形态下都一样
  chk("反证：detail 指向抢占者路径", (r.pinDetail ?? "").includes(r.tmpBase ?? "\u0000"), raw);
  chk("反证：loadOrtFromPkg 返回 null（降级而非崩溃）", r.loaded === "null", raw);
  chk("反证：子进程存活（未在原生层 abort）", child.exitCode === 0, `exit=${child.exitCode}`);
}

// 清理：DLL 已被子进程加载，Windows 下多半删不掉；下次运行前会先 rm（那时已无占用）
try {
  rmSync(TMP, { recursive: true, force: true });
} catch {
  console.log(`  – 临时目录残留（下次运行会重建）：${TMP}`);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}  ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
