// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 内嵌向量运行时（onnxruntime CPU 后端）的落盘与定位。
 *
 * ## 为什么把原生库塞进 exe（2026-11-11 定稿）
 *
 * `bun build --compile` 打不进 `.node` 原生模块，所以 0.4.49 及以前一直是「exe + 另下一个
 * `xbb-ort-*.zip`」两步分发。结果是绝大多数用户只走了第一步 —— 拿到的是纯词法检索，而降级
 * 提示只打在 stderr 上，MCP 宿主一般不展示子进程的 stderr。用户感受到的是「搜得不准」，
 * 并且一定会把这笔账记在产品头上，而不是记在「少下了一个包」上。
 *
 * 实测的体积账：Windows 包里 36.5MB 是 `DirectML.dll` + `dxcompiler.dll` 两个 GPU 后端，
 * 而 `embedder.ts` 写死 `executionProviders: ["cpu"]`，它们一次都不会被加载。砍掉之后 CPU
 * 必需只剩 30.3MB，gzip 后 11.1MB —— 塞进 exe 之后整包反而比「exe + zip」小，而用户从
 * 三步变成零步。
 *
 * ## 释放策略
 *
 * · 目标 `~/.xiaobenben/ort/<key>/` —— 属**程序资产**，跟着程序走（`programDir()`），
 *   不跟着记忆库走。用户把库挪到 D 盘不该触发重新解压，换台机器也不该读到旧的原生库。
 * · `<key>` = 平台 + 内嵌资源哈希：换版本、换平台自然落到不同目录，绝不会把上一版的
 *   `onnxruntime.dll` 和这一版的 `ort-bundle.cjs` 拼在一起用（那种错配是原生层 abort，
 *   外层 try/catch 拦不住）。
 * · staging 目录 + rename + `.ok` 标记：断电、并发、半截写入都不会留下「看起来装好了」
 *   的目录。标记最后写，所以「有标记」严格等价于「目录完整」。
 * · 任何一步失败都返回 null，调用方按双降级红线退化为纯词法检索，绝不 throw。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { programDir } from "./home";
import { EMBEDDED_ORT } from "./ort-assets.generated";

/** 释放根目录（不含 key）。`null` = 这份产物没有内嵌 ORT（开发模式 / darwin-x64）。 */
export function embeddedOrtRoot(base = programDir()): string | null {
  return EMBEDDED_ORT ? join(base, "ort", EMBEDDED_ORT.key) : null;
}

/** 同一进程只需成功一次：加载失败后的重试要花的代价比收益大（每次都解 30MB） */
const memo = new Map<string, string | null>();

/**
 * 把内嵌 ORT 解压到 `<base>/ort/<key>/`，返回 `onnxruntime-node` 包目录。
 *
 * 已释放（有 `.ok`）时零成本直返。失败返回 `null` —— 调用方据此走纯词法检索。
 */
export function releaseEmbeddedOrt(base = programDir()): string | null {
  const hit = memo.get(base);
  if (hit !== undefined) return hit;
  const out = doRelease(base);
  memo.set(base, out);
  return out;
}

/** 给测试用：清掉进程内缓存（否则同一进程改不动结果） */
export function resetEmbeddedOrtMemo(): void {
  memo.clear();
}

function doRelease(base: string): string | null {
  const b = EMBEDDED_ORT;
  if (!b) return null;
  const root = join(base, "ort", b.key);
  const pkg = join(root, "onnxruntime-node");
  const marker = join(root, ".ok");

  // 完整的判据不只看标记：标记在但 bundle 被用户手动删过（杀软隔离、清理工具）也要重解
  if (existsSync(marker) && existsSync(join(pkg, "dist", "ort-bundle.cjs"))) return pkg;

  const staging = `${root}.staging.${process.pid}.${Date.now()}`;
  try {
    mkdirSync(staging, { recursive: true });
    for (const f of b.files) {
      // 相对路径来自构建脚本（可信），但仍然挡住 `..`：解压路径穿出目录是最难查的一类问题
      if (f.path.includes("..")) continue;
      const dst = join(staging, "onnxruntime-node", f.path);
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, gunzipSync(readFileSync(f.gz)));
    }
    // 标记最后写：有标记 = 目录完整
    writeFileSync(join(staging, ".ok"), `${b.key}\n${new Date().toISOString()}\n`, "utf8");

    if (existsSync(root)) {
      // 并发：MCP 宿主和 serve 可能同时首启。对方先完成就直接用，别把人家好不容易解好的删了
      if (existsSync(marker)) {
        try {
          rmSync(staging, { recursive: true, force: true });
        } catch {
          /* 删不掉就留着，下一次启动会当作陈旧 staging 清掉 */
        }
        return pkg;
      }
      rmSync(root, { recursive: true, force: true }); // 半截目录（没有 .ok）才能删
    }
    renameSync(staging, root);
    return pkg;
  } catch {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      /* 失败现场留不留都无所谓，反正没有 .ok 就不会被当成功 */
    }
    return null;
  }
}

/** 清掉本进程/旧进程留下的半截 staging 目录（`serve` 启动时调一次即可，不是热路径） */
export function sweepStaleStaging(base = programDir()): void {
  const b = EMBEDDED_ORT;
  const root = embeddedOrtRoot(base);
  if (!b || !root) return;
  const dir = dirname(root);
  if (!existsSync(dir)) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // 目录不可读 → 忽略
  }
  for (const name of names) {
    // 只管自己这个 key 的残留：别的 key 可能是另一个版本正在解压
    if (!name.startsWith(`${b.key}.staging.`)) continue;
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
    } catch {
      /* 被占用就下次再说 */
    }
  }
}
