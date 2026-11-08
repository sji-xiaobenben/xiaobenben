#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 生成 `THIRD-PARTY-LICENSES.md` —— 随分发包分发的第三方组件许可声明。
 *
 *   bun run gen:licenses          写入/更新文件
 *   bun run gen:licenses --check  只比对，不一致时退出码 1（CI 用）
 *
 * ## 为什么必须做这件事
 *
 * MIT / BSD / ISC 的义务是「版权声明与许可全文须随所有副本或其重要部分一同分发」。
 * 我们分发的是**单文件 exe**，第三方 JS 被静态打进去、托盘二进制被作为 asset 嵌进去 ——
 * 许可证文本在文件系统里根本不存在，只能靠一份文档承载。少了它就是违反许可，
 * 不是「文档没写全」。
 *
 * ## 为什么清单来自 metafile 而不是 bun.lock
 *
 * lockfile 是**安装集**（118 个），打包结果才是**分发集**（9 个）。按 lockfile 列会写出
 * 一堆根本没进二进制的包——属于虚假声明，审的人一问就穿帮；反过来漏了某个包更糟。
 * 所以清单由 `bun build --metafile` 反查实际被打进去的模块，零维护、不会漂移。
 *
 * ## 三类分发形态
 *
 *   1. 打包进 exe        —— metafile 反查得到，全部是 JS
 *   2. 运行时旁路加载    —— onnxruntime，外置在 exe 旁边的 node_modules
 *   3. 嵌入的二进制资产  —— 托盘程序，来自 systray-portable（内含 getlantern/systray）
 *
 * 第 2、3 类 metafile 看不到（一个是 external，一个是 asset），只能人工登记；
 * 它们的许可原文放在 `tools/third-party/`，由本脚本原样拼进结果——**不许手打许可文本**，
 * 打错一个字就是在误述别人的授权条件。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "THIRD-PARTY-LICENSES.md";
const BUILD_DIR = ".third-party-build";
const META = join(BUILD_DIR, "meta.json");
const EXTRA_DIR = "tools/third-party";
const CHECK = process.argv.includes("--check");

interface Component {
  name: string;
  version: string;
  license: string;
  /** 许可全文（原样，不加工） */
  text: string;
  /** 分发形态说明，写进表格后的注解 */
  where: string;
}

const errors: string[] = [];

/**
 * 行尾统一成 LF。
 *
 * 不统一就会分平台生成不同结果：Windows 上 bun install 解压出来的 LICENSE 带 CRLF，
 * Linux 上是 LF，于是同一个提交在 Windows 跑 --check 红、在 CI 绿——而 CI 只跑 Linux，
 * 这个不一致会一直藏着，直到某个贡献者在 Windows 上第一次跑闸就被判失败。
 */
function normEol(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

// ── 1. 反查实际打包集 ────────────────────────────────────────────────────────
function buildMeta(): Record<string, unknown> {
  rmSync(BUILD_DIR, { recursive: true, force: true });
  mkdirSync(BUILD_DIR, { recursive: true });
  const r = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--target=bun",
      "--external",
      "*.node",
      "--external",
      "onnxruntime-node",
      `--metafile=${META}`,
      `--outdir=${BUILD_DIR}`,
      "src/index.ts",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0 || !existsSync(META)) {
    console.error("[gen:licenses] bun build 失败，无法确定分发集：");
    console.error(r.stderr.toString());
    process.exit(2);
  }
  return JSON.parse(readFileSync(META, "utf8")) as Record<string, unknown>;
}

/** 从输入路径取包名；取**最后**一个 node_modules，正确处理嵌套安装 */
function pkgNameOf(input: string): string | null {
  const norm = input.replace(/\\/g, "/");
  const i = norm.lastIndexOf("node_modules/");
  if (i < 0) return null;
  const parts = norm.slice(i + "node_modules/".length).split("/");
  if (!parts[0]) return null;
  if (parts[0].startsWith("@")) return parts.length >= 2 && parts[1] ? `${parts[0]}/${parts[1]}` : null;
  return parts[0];
}

function licenseFileOf(pkgDir: string): string | null {
  if (!existsSync(pkgDir)) return null;
  const hit = readdirSync(pkgDir).find((f) => /^(licen[cs]e|copying)/i.test(f));
  return hit ? join(pkgDir, hit) : null;
}

function readPkg(pkg: string): Component | null {
  const dir = join("node_modules", pkg);
  const pkgJson = join(dir, "package.json");
  if (!existsSync(pkgJson)) {
    errors.push(`${pkg}：package.json 不存在（metafile 说有，磁盘上没有？）`);
    return null;
  }
  const j = JSON.parse(readFileSync(pkgJson, "utf8")) as {
    version?: string;
    license?: string | { type?: string };
  };
  const license = typeof j.license === "string" ? j.license : j.license?.type ?? "";
  if (!license) {
    // 没有 license 字段就是「未声明授权」，不能当成 MIT 猜——那是替别人做法律决定
    errors.push(`${pkg}：package.json 未声明 license`);
    return null;
  }
  const lf = licenseFileOf(dir);
  if (!lf) {
    errors.push(
      `${pkg}：包内没有 LICENSE 文件。把上游原文存到 ${EXTRA_DIR}/ 并在 EXTRA 里登记，不要手打。`,
    );
    return null;
  }
  return { name: pkg, version: j.version ?? "?", license, text: normEol(readFileSync(lf, "utf8")).trimEnd(), where: "打包进 exe" };
}

// ── 2. 人工登记的两类 ────────────────────────────────────────────────────────
function extraText(file: string): string {
  const p = join(EXTRA_DIR, file);
  if (!existsSync(p)) {
    errors.push(`缺少许可原文：${p}`);
    return "";
  }
  return normEol(readFileSync(p, "utf8")).trimEnd();
}

function extraVersion(pkg: string): string {
  const p = join("node_modules", pkg, "package.json");
  if (!existsSync(p)) return "?";
  return (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version ?? "?";
}

const meta = buildMeta();
const inputs = (meta.inputs ?? {}) as Record<string, unknown>;
const packed = [...new Set(Object.keys(inputs).map(pkgNameOf).filter((x): x is string => !!x))].sort();

const components: Component[] = [];
for (const pkg of packed) {
  const c = readPkg(pkg);
  if (c) components.push(c);
}

// 旁路加载：onnxruntime 的两个包在 exe 旁边以 node_modules 形式分发，metafile 里是 external
for (const pkg of ["onnxruntime-node", "onnxruntime-common"]) {
  components.push({
    name: pkg,
    version: extraVersion(pkg),
    license: "MIT",
    text: extraText("onnxruntime.LICENSE"),
    where: "运行时旁路加载（外置 node_modules）",
  });
}

// 嵌入资产：托盘二进制。systray2 自身是 MIT，但它内嵌的三个平台二进制是另一个项目的产物
components.push({
  name: "systray-portable（托盘二进制）",
  version: `随 systray2 ${extraVersion("systray2")} 提供`,
  license: "MIT",
  text: extraText("systray-portable.LICENSE"),
  where: "嵌入 exe（三个平台各一份 Go 二进制）",
});
components.push({
  name: "getlantern/systray",
  version: "systray-portable 的上游",
  license: "Apache-2.0",
  text: extraText("getlantern-systray.LICENSE"),
  where: "嵌入 exe（编译进上面那个托盘二进制）",
});

// ── 3. 输出 ─────────────────────────────────────────────────────────────────
function render(): string {
  const rows = components.map((c) => `| \`${c.name}\` | ${c.version} | ${c.license} | ${c.where} |`);
  const sections = components.map(
    (c) => `### ${c.name} ${c.version} — ${c.license}\n\n\`\`\`text\n${c.text}\n\`\`\`\n`,
  );

  return [
    "# 第三方组件许可",
    "",
    "本文件由 `bun run gen:licenses`（`tools/gen-third-party-licenses.ts`）生成，**不要手改** ——",
    "下次生成会被覆盖。许可原文取自各组件随包附带的 LICENSE 文件或上游仓库根目录，未做任何改写。",
    "",
    "清单取自 `bun build --metafile` 的**实际打包结果**，而不是 lockfile 里的安装全集：这里列的每一个",
    "组件都真的在分发包里。依赖升级后 `bun run gen:licenses --check` 会失败，重新生成即可。",
    "",
    "| 组件 | 版本 | 许可 | 分发形态 |",
    "|---|---|---|---|",
    ...rows,
    "",
    "此外，本地嵌入模型 `bge-small-zh-v1.5`（BAAI，MIT）**不由本仓库或官方分发包提供**，",
    "由程序在首次启动时从公开源下载，其许可随模型文件一同获取。详见 `NOTICE`。",
    "",
    "---",
    "",
    "# 许可全文",
    "",
    ...sections,
    "",
  ].join("\n");
}

const content = render();
rmSync(BUILD_DIR, { recursive: true, force: true });

if (errors.length > 0) {
  console.error("[gen:licenses] 无法生成，存在以下问题：");
  for (const e of errors) console.error(`  · ${e}`);
  process.exit(2);
}

if (CHECK) {
  const old = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (old !== content) {
    console.error(`[gen:licenses] ${OUT} 与当前依赖不一致——依赖变过但忘了重新生成。`);
    console.error("              跑 `bun run gen:licenses` 并提交结果。");
    process.exit(1);
  }
  console.log(`[gen:licenses] ${OUT} 与当前依赖一致（${components.length} 个组件）`);
  process.exit(0);
}

writeFileSync(OUT, content, "utf8");
console.log(`[gen:licenses] 已写入 ${OUT}：${components.length} 个组件`);
for (const c of components) console.log(`  · ${c.name} ${c.version} (${c.license})`);
