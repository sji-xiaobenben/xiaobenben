// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 统一构建入口 —— 本地 `bun run build:*` 与 `release.yml` 走**同一条**命令。
 *
 * 用法：
 *   bun run tools/build.ts --outfile dist/xbb-windows-x64.exe
 *   bun run tools/build.ts --target bun-linux-x64 --outfile dist/xbb-linux-x64
 *   bun run tools/build.ts --target bun-darwin-x64 --external onnxruntime-node --outfile dist/xbb-darwin-x64
 *
 * ## 为什么不让两处各写一条 `bun build --compile`
 *
 * Windows 产物除了 JS 还要写三样东西进 PE 资源段：图标、版本号、发行者。它们**必须来自
 * 同一个真源**（`package.json` 的 version + `assets/app.ico`），而且写错了不会有任何报错——
 * 产物照样能跑，只是「属性」里写着 Bun 1.4.2 / Oven，图标是个空白壳。
 *
 * 之前正是两处各写一条：本地脚本一条、release.yml 一条，谁的参数都不全，谁也没发现。
 * 收成一个入口之后，「怎么编 Windows 产物」只有一处定义，加一个资源字段也只需改这里。
 *
 * ## 编完就验图标
 *
 * `--windows-icon` 失败是静的（见 `tools/lib/pe-icon.ts` 文件头）。所以这里编完 Windows 产物
 * 立刻读回资源段比对字节，对不上就 **exit 1** —— 让 CI 红在构建这一步，而不是等用户装了
 * 一个没有图标的 exe。同一份断言也做成独立工具 `tools/check-exe-icon.ts`，可用于存量产物复核。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractEmbeddedIcon } from "./lib/pe-icon";

const root = join(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), ".");

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const flags: Record<string, string> = {};
const externals: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] as string;
  if (!a.startsWith("--")) fail(`不认识的参数：${a}`);
  const eq = a.indexOf("=");
  const key = (eq > 0 ? a.slice(0, eq) : a).slice(2);
  const inline = eq > 0 ? a.slice(eq + 1) : undefined;
  // `--external onnxruntime-node` 与 `--external=onnxruntime-node` 都接受：
  // release.yml 的矩阵里写的是带空格那种，改它没意义，两边都认下来最省事。
  const val = inline ?? argv[++i];
  if (val === undefined) fail(`--${key} 后面缺值`);
  if (key === "external") externals.push(val);
  else flags[key] = val;
}

const outfile = flags.outfile;
if (!outfile) fail("缺少 --outfile（产物输出路径）");
const target = flags.target; // 省略 = 编当前平台
const iconPath = flags.icon ?? join(root, "assets", "app.ico");

const isWindows = target ? target.includes("windows") : process.platform === "win32";

// 版本号真源是 package.json：Windows 版本资源要求四段数字，0.4.47 → 0.4.47.0。
// 预发布后缀（-beta.1）在 PE 里没有位置，去掉；缺位补 0。
function peVersion(v: string): string {
  const base = v.split(/[-+]/)[0] as string;
  const parts = base.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n) || n < 0 || n > 65535)) {
    fail(`package.json 的 version「${v}」无法写成 Windows 版本资源（每段须为 0–65535 的整数）`);
  }
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4).join(".");
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string;
  author: string;
};
const version = peVersion(pkg.version);

const cmd = ["bun", "build", "--compile"];
if (target) cmd.push(`--target=${target}`);
for (const e of externals) cmd.push("--external", e);
if (isWindows) {
  // 五个字段都不是装饰：
  //   · icon        —— 资源管理器/任务栏/Alt+Tab 的图标（缺了是空白壳）
  //   · title       —— 「属性 → 详细信息」里的产品名，也是任务管理器的进程名
  //   · description —— 同上那行的说明；不写就继承 bun 的 "Bun"
  //   · publisher   —— 公司名；不写就是 "Oven"
  //   · version     —— 文件版本；不写就是 bun 自己的 1.4.2（用户会以为你发了个老版本）
  //   · copyright   —— 法务署名，跟 LICENSE/NOTICE 里的主体一致
  cmd.push(
    `--windows-icon=${iconPath}`,
    "--windows-title=XiaoBenBen",
    "--windows-description=Local-first memory for AI agents",
    `--windows-publisher=${pkg.author}`,
    `--windows-version=${version}`,
    `--windows-copyright=© 2026 ${pkg.author}`,
  );
}
cmd.push(`--outfile=${outfile}`, "src/index.ts");

console.log(`$ ${cmd.join(" ")}`);
const proc = Bun.spawnSync(cmd, { cwd: root, stdio: ["inherit", "inherit", "inherit"] });
if (proc.exitCode !== 0) fail(`构建失败（退出码 ${proc.exitCode}）`);

// 编完立刻验图标：失败是静的，只能靠读回资源段发现。
if (isWindows) {
  let icon;
  try {
    icon = extractEmbeddedIcon(readFileSync(outfile));
  } catch (err) {
    fail(`Windows 产物没有可用图标：${(err as Error).message}`);
  }
  const src = readFileSync(iconPath);
  if (icon.ico.length !== src.length || !icon.ico.equals(src)) {
    fail(
      `产物的图标与 ${iconPath} 不一致（${icon.ico.length} vs ${src.length} 字节）\n` +
        "  ⇒ --windows-icon 没生效，或产物来自另一次构建。资源管理器会显示空白壳且不报错。",
    );
  }
  console.log(`✓ Windows 图标已嵌入并逐字节核对（${icon.sizes.map((s) => `${s}px`).join("/")}）`);
}

console.log(`✓ ${outfile}`);
