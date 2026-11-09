// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 开始菜单快捷方式。
 *
 * 铁律：**这些测试一个字节都不许落到真实的开始菜单里**。所有用例都注入
 * `startMenuDir` / `xdgDataHome` / `home` / `env`，并且 Windows 那条路径永远用假运行器
 * （真跑一次 PowerShell 的用例在 `tools/shortcut-smoke.ts`，那里会在临时目录里造个真 lnk）。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LINUX_DESKTOP_FILE,
  NO_SHORTCUT_ENV,
  SHORTCUT_ARGS,
  WIN_SHORTCUT_FILE,
  ensureStartMenuShortcut,
  linuxApplicationsDir,
  linuxDesktopEntry,
  shortcutPath,
  startMenuProgramsDir,
  windowsShortcutScript,
  type ScriptRunner,
} from "./shortcut";

const TMP = mkdtempSync(join(tmpdir(), "xbb-shortcut-test-"));

// 图标释放会写 `programDir()/icons`，测试一律落到临时 XBB_HOME 里（bun test 一文件一进程）。
const PREV_XBB_HOME = process.env.XBB_HOME;
process.env.XBB_HOME = join(TMP, "proghome");

/** 假的 PowerShell：从脚本里解出 `$p = '…'`，按需把文件"写"出来 —— 顺便验证脚本本身可取。 */
function fakeRunner(o: { write?: boolean; code?: number; out?: string } = {}): {
  run: ScriptRunner;
  calls: () => number;
  paths: string[];
  scripts: string[];
} {
  const paths: string[] = [];
  const scripts: string[] = [];
  let calls = 0;
  const run: ScriptRunner = async (script) => {
    calls++;
    scripts.push(script);
    const m = /\$p = '((?:[^']|'')*)'/.exec(script);
    const p = m ? m[1].replaceAll("''", "'") : "";
    paths.push(p);
    if (o.write !== false && p) {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "fake-lnk");
    }
    return { code: o.code ?? 0, out: o.out ?? "" };
  };
  return { run, calls: () => calls, paths, scripts };
}

describe("路径解析", () => {
  test("Windows 走 APPDATA", () => {
    expect(startMenuProgramsDir({ env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, home: "C:\\Users\\u" })).toBe(
      join("C:\\Users\\u\\AppData\\Roaming", "Microsoft", "Windows", "Start Menu", "Programs"),
    );
  });

  test("APPDATA 缺失/空白时回落到 ~\\AppData\\Roaming，而不是相对路径", () => {
    for (const env of [{}, { APPDATA: "" }, { APPDATA: "   " }]) {
      const d = startMenuProgramsDir({ env, home: "C:\\Users\\u" });
      expect(d).toBe(join("C:\\Users\\u", "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs"));
    }
  });

  test("XDG_DATA_HOME 只认绝对路径（相对值按规范忽略）", () => {
    expect(linuxApplicationsDir({ env: { XDG_DATA_HOME: "/data/home" }, home: "/home/u" })).toBe(
      join("/data/home", "applications"),
    );
    expect(linuxApplicationsDir({ env: { XDG_DATA_HOME: "relative/dir" }, home: "/home/u" })).toBe(
      join("/home/u", ".local", "share", "applications"),
    );
  });

  test("三平台各自的落点，macOS 明确为 null", () => {
    expect(shortcutPath("win32", { startMenuDir: "/sm" })).toBe(join("/sm", WIN_SHORTCUT_FILE));
    expect(shortcutPath("linux", { xdgDataHome: "/xdg" })).toBe(join("/xdg", "applications", LINUX_DESKTOP_FILE));
    expect(shortcutPath("darwin")).toBeNull();
  });

  test("文件名就是显示名", () => {
    expect(WIN_SHORTCUT_FILE).toBe("小本本.lnk");
    expect(LINUX_DESKTOP_FILE).toBe("xbb.desktop");
  });
});

describe("PowerShell 正文", () => {
  const script = windowsShortcutScript({
    lnkPath: "C:\\sm\\小本本.lnk",
    target: "C:\\Users\\u\\.xiaobenben\\bin\\xbb.exe",
    args: SHORTCUT_ARGS,
    workDir: "C:\\Users\\u\\.xiaobenben\\bin",
    icon: "C:\\Users\\u\\.xiaobenben\\bin\\xbb.exe,0",
    description: "小本本 · 面向 AI 的个人记忆库",
  });

  test("目标、参数、图标、工作目录都在", () => {
    expect(script).toContain("$s.TargetPath = 'C:\\Users\\u\\.xiaobenben\\bin\\xbb.exe'");
    expect(script).toContain("$s.Arguments = 'start --open'");
    expect(script).toContain("$s.IconLocation = 'C:\\Users\\u\\.xiaobenben\\bin\\xbb.exe,0'");
    expect(script).toContain("$s.WorkingDirectory = 'C:\\Users\\u\\.xiaobenben\\bin'");
    expect(script).toContain("$s.Save()");
    expect(script).toContain("WScript.Shell");
  });

  test("单引号被写成两个 —— 用户名里带 ' 也不能把脚本撕开", () => {
    const s = windowsShortcutScript({ lnkPath: "x", target: "C:\\Users\\O'Brien\\xbb.exe" });
    expect(s).toContain("'C:\\Users\\O''Brien\\xbb.exe'");
  });

  test("父目录用 CreateDirectory 递归创建", () => {
    expect(script).toContain("[System.IO.Directory]::CreateDirectory");
  });
});

describe("Desktop Entry", () => {
  test("正文含必需字段，Terminal=true", () => {
    const d = linuxDesktopEntry({ exec: "/opt/x y/xbb", icon: "/home/u/.xiaobenben/icons/xbb.png" });
    expect(d.startsWith("[Desktop Entry]\n")).toBe(true);
    expect(d).toContain("Name=小本本");
    expect(d).toContain(`Exec="/opt/x y/xbb" ${SHORTCUT_ARGS}`);
    expect(d).toContain("Icon=/home/u/.xiaobenben/icons/xbb.png");
    expect(d).toContain("Terminal=true");
    expect(d).toContain("Type=Application");
  });
});

describe("ensureStartMenuShortcut · Windows", () => {
  test("缺失时创建，并且确实落到 Programs 下", async () => {
    const dir = join(TMP, "win-created", "Programs");
    const f = fakeRunner();
    const r = await ensureStartMenuShortcut({
      platform: "win32",
      compiled: true,
      exePath: "C:\\Users\\u\\.xiaobenben\\bin\\xbb.exe",
      startMenuDir: dir,
      run: f.run,
    });
    expect(r.status).toBe("created");
    expect(r.path).toBe(join(dir, WIN_SHORTCUT_FILE));
    expect(f.calls()).toBe(1);
    expect(existsSync(join(dir, WIN_SHORTCUT_FILE))).toBe(true);
    // 脚本里写的就是我们复核的那个路径
    expect(f.paths[0]).toBe(join(dir, WIN_SHORTCUT_FILE));
    // 图标取自释放的托盘图标（裸书签），不是 exe 内嵌的那枚红底板。
    // **扩展名不能绑死**：`tray-assets.ts` 按**宿主**平台嵌入资产（Windows 取 .ico、
    // 其它取 .png），而这里是在任意宿主上模拟 win32 分支。绑死 .ico 的结果是
    // 本地 Windows 跑绿、CI 的 ubuntu 必红 —— 第一版就是这么挂的。
    expect(f.scripts[0]).toMatch(/icons[\\/]xbb\.(ico|png),0/);
  });

  test("已存在就什么都不做（不许刷新创建时间）", async () => {
    const dir = join(TMP, "win-exists", "Programs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, WIN_SHORTCUT_FILE), "already");
    const f = fakeRunner();
    const r = await ensureStartMenuShortcut({
      platform: "win32",
      compiled: true,
      startMenuDir: dir,
      run: f.run,
    });
    expect(r.status).toBe("exists");
    expect(f.calls()).toBe(0);
    expect(readFileSync(join(dir, WIN_SHORTCUT_FILE), "utf8")).toBe("already");
  });

  test("PowerShell 非 0 退出 ⇒ failed，带原因，不抛", async () => {
    const dir = join(TMP, "win-fail", "Programs");
    const r = await ensureStartMenuShortcut({
      platform: "win32",
      compiled: true,
      startMenuDir: dir,
      run: async () => ({ code: 1, out: "Access is denied" }),
    });
    expect(r.status).toBe("failed");
    expect(r.message).toContain("Access is denied");
  });

  test("返回成功但文件不在 ⇒ failed（COM 被拦时常静默）", async () => {
    const dir = join(TMP, "win-silent", "Programs");
    const r = await ensureStartMenuShortcut({
      platform: "win32",
      compiled: true,
      startMenuDir: dir,
      run: async () => ({ code: 0, out: "" }),
    });
    expect(r.status).toBe("failed");
    expect(r.message).toContain("不存在");
  });

  test("运行器抛异常也吞掉 ⇒ failed", async () => {
    const r = await ensureStartMenuShortcut({
      platform: "win32",
      compiled: true,
      startMenuDir: join(TMP, "win-throw"),
      run: async () => {
        throw new Error("boom");
      },
    });
    expect(r.status).toBe("failed");
    expect(r.message).toContain("boom");
  });
});

describe("ensureStartMenuShortcut · 门槛", () => {
  test("开发态（未编译）跳过 —— 那时 execPath 是 bun 自己", async () => {
    const f = fakeRunner();
    const r = await ensureStartMenuShortcut({
      platform: "win32",
      compiled: false,
      startMenuDir: join(TMP, "dev"),
      run: f.run,
    });
    expect(r.status).toBe("skipped");
    expect(f.calls()).toBe(0);
  });

  test(`${NO_SHORTCUT_ENV} 能彻底关掉`, async () => {
    const f = fakeRunner();
    const r = await ensureStartMenuShortcut({
      platform: "win32",
      compiled: true,
      startMenuDir: join(TMP, "off"),
      env: { [NO_SHORTCUT_ENV]: "1" },
      run: f.run,
    });
    expect(r.status).toBe("skipped");
    expect(f.calls()).toBe(0);
  });

  test("macOS 明确 unsupported 并说明原因（不糊一个点了没反应的图标）", async () => {
    const r = await ensureStartMenuShortcut({ platform: "darwin", compiled: true });
    expect(r.status).toBe("unsupported");
    expect(r.path).toBeNull();
    expect(r.message).toContain("Launchpad");
  });
});

describe("ensureStartMenuShortcut · Linux", () => {
  test("写 .desktop，第二次是 exists", async () => {
    const xdg = join(TMP, "linux-xdg");
    const home = join(TMP, "linux-home");
    {
      const o = {
        platform: "linux" as NodeJS.Platform,
        compiled: true,
        exePath: "/home/u/.xiaobenben/bin/xbb",
        xdgDataHome: xdg,
        home,
        env: {},
      };
      const r1 = await ensureStartMenuShortcut(o);
      expect(r1.status).toBe("created");
      const p = join(xdg, "applications", LINUX_DESKTOP_FILE);
      expect(r1.path).toBe(p);
      const body = readFileSync(p, "utf8");
      expect(body).toContain("/home/u/.xiaobenben/bin/xbb");
      expect(body).toContain(SHORTCUT_ARGS);
      expect(body).toContain("Terminal=true");

      const r2 = await ensureStartMenuShortcut(o);
      expect(r2.status).toBe("exists");
    }
  });
});

// 一次性清理（bun test 每个文件一个进程，放在末尾即可）
test("清理临时目录", () => {
  if (PREV_XBB_HOME === undefined) delete process.env.XBB_HOME;
  else process.env.XBB_HOME = PREV_XBB_HOME;
  rmSync(TMP, { recursive: true, force: true });
  expect(existsSync(TMP)).toBe(false);
});
