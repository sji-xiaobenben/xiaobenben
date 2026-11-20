// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 界面语言：判定链、字典、终端对齐。
 *
 * 为什么判定链值得单独测：它有三层"用户看不见"的回落，而每一层错了都**不会报错** ——
 * 只会安静地显示另一种语言。这类 bug 只有在用户截图问「为什么我的界面是英文」时才会暴露，
 * 而那时现场已经没了。优先级顺序（env > 配置 > 系统 > 中文）是产品决策，
 * 用测试钉住它，比在注释里写一遍可靠。
 *
 * 环境变量一律自己设了自己还原（`afterEach`），否则一条测试会污染整个进程 ——
 * 而 i18n 的判定是**带缓存**的，污染一次后面全错。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __setSystemLocaleForTest,
  currentLang,
  dict,
  formatNumber,
  formatTime,
  LANGS,
  normalizeLang,
  resetLangCache,
  resolveLang,
} from "./i18n";
import { columnWidth, displayWidth, padTo } from "./i18n/width";
import { writeHomeConfig } from "./home";

type EnvKey = "XBB_LANG" | "XBB_HOME" | "LC_ALL" | "LC_MESSAGES" | "LANG";
const ENV_KEYS: EnvKey[] = ["XBB_LANG", "XBB_HOME", "LC_ALL", "LC_MESSAGES", "LANG"];

// 模块加载时抓一次现场：测试进程里 `XBB_LANG` 已被 test-preload.ts 钉成 zh，
// 而 LC_* / LANG 可能是跑测试那台机器上真实存在的（Git Bash 会导出 LANG）。
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

let home = "";

/** 设定一组环境变量（`null` = 删掉），并让判定链重新跑 */
function setEnv(vars: Partial<Record<EnvKey, string | null>>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  resetLangCache();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "xbb-i18n-"));
  // 起点：四层全部清空 —— 没配置、没 env、系统 locale 也没给
  setEnv({ XBB_LANG: null, XBB_HOME: home, LC_ALL: null, LC_MESSAGES: null, LANG: null });
  __setSystemLocaleForTest(null);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __setSystemLocaleForTest(undefined);
  resetLangCache();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Windows 上偶发 EBUSY，与测试结论无关：目录在系统临时区，下次自会被清
  }
});

describe("normalizeLang —— 区域码只取语言码", () => {
  test("常见的区域写法都归到两种语言", () => {
    expect(normalizeLang("zh")).toBe("zh");
    expect(normalizeLang("zh-CN")).toBe("zh");
    expect(normalizeLang("zh_CN.UTF-8")).toBe("zh");
    expect(normalizeLang("zh-Hant")).toBe("zh");
    expect(normalizeLang("en")).toBe("en");
    expect(normalizeLang("en-US")).toBe("en");
    expect(normalizeLang("en_US")).toBe("en");
    expect(normalizeLang("EN")).toBe("en");
    expect(normalizeLang("  en-GB  ")).toBe("en");
  });

  test("认不出的返回 null，且**绝不猜**", () => {
    // 猜错比不猜更糟：把德语用户硬塞进英文，他会以为程序只支持英文；
    // 返回 null 则会落到中文默认值，但 `xbb lang` 会把可选列表摆出来。
    for (const bad of ["de", "deutsch", "fr-FR", "日本語", "", "  ", "zhx", "e"]) {
      expect(normalizeLang(bad)).toBeNull();
    }
    expect(normalizeLang(undefined)).toBeNull();
    expect(normalizeLang(null)).toBeNull();
  });
});

describe("判定链 —— env > config > 系统 > 中文", () => {
  test("环境变量压过配置文件", () => {
    writeHomeConfig({ lang: "en" }, "test");
    setEnv({ XBB_LANG: "zh" });
    const r = resolveLang();
    expect(r.lang).toBe("zh");
    expect(r.source).toBe("env");
  });

  test("配置文件压过系统 locale —— 中文系统上仍能要到英文", () => {
    writeHomeConfig({ lang: "en" }, "test");
    setEnv({ LC_ALL: "zh_CN.UTF-8" });
    const r = resolveLang();
    expect(r.lang).toBe("en");
    expect(r.source).toBe("config");
  });

  test("没配置时听系统的", () => {
    setEnv({ LANG: "en_US.UTF-8" });
    const r = resolveLang();
    expect(r.lang).toBe("en");
    expect(r.source).toBe("system");
  });

  test("系统 locale 是 C / POSIX 时不算数，继续往下落", () => {
    setEnv({ LC_ALL: "C", LANG: "POSIX" });
    __setSystemLocaleForTest("en-US");
    expect(resolveLang().lang).toBe("en");

    __setSystemLocaleForTest(null);
    const r = resolveLang();
    expect(r.lang).toBe("zh");
    expect(r.source).toBe("default");
  });

  test("环境变量写了认不出的语言，退回下一层而不是崩", () => {
    writeHomeConfig({ lang: "en" }, "test");
    setEnv({ XBB_LANG: "deutsch" });
    const r = resolveLang();
    expect(r.lang).toBe("en");
    expect(r.source).toBe("config");
  });

  test("配置文件坏了当作没设过 —— 手滑的 JSON 不该让客户端起不来", () => {
    // 直接写坏文件，绕开 writeHomeConfig
    writeFileSync(join(home, "config.json"), "{ this is not json", "utf8");
    setEnv({ LANG: "en_US" });
    expect(resolveLang().lang).toBe("en");
  });

  test("判定结果被缓存：改环境变量不会中途换语言", () => {
    setEnv({ XBB_LANG: "zh" });
    expect(currentLang()).toBe("zh");
    // 同一个进程里再改 env —— 不 reset 就不该变。界面上半句中文下半句英文比不翻译更糟。
    process.env.XBB_LANG = "en";
    expect(currentLang()).toBe("zh");
    resetLangCache();
    expect(currentLang()).toBe("en");
  });
});

describe("config.json 往返 —— 写进去的要能被判定链读到", () => {
  test("`xbb lang en` 写下的偏好，下一次判定生效", () => {
    // 这条同时守两处 schema 不漂：home.ts 的 HomeConfig 与 i18n 的只读解析各写了一份
    // 对 `lang` 字段的理解，任何一边改名/改层级都会让这条红。
    writeHomeConfig({ lang: "en" }, "cli.lang");
    const r = resolveLang();
    expect(r.lang).toBe("en");
    expect(r.source).toBe("config");
  });

  test("写语言不会把别的字段清掉", () => {
    writeHomeConfig({ dataDir: "D:/xbb" }, "test");
    writeHomeConfig({ lang: "en" }, "cli.lang");
    setEnv({ XBB_HOME: home });
    expect(resolveLang().lang).toBe("en");
    const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(raw.dataDir).toBe("D:/xbb");
  });
});

describe("取词与格式化", () => {
  test("两种语言的字典都不是空的，且标签确实不同", () => {
    setEnv({ XBB_LANG: "zh" });
    const zhFile = dict().stats.labels.file;
    setEnv({ XBB_LANG: "en" });
    const enFile = dict().stats.labels.file;
    expect(zhFile).toBe("库文件");
    expect(enFile).toBe("Database");
  });

  test("每种支持的语言都有自称，切换器不会列出空名字", () => {
    for (const l of LANGS) {
      setEnv({ XBB_LANG: l });
      for (const tag of LANGS) expect(dict().langNames[tag].length).toBeGreaterThan(0);
    }
  });

  test("读不到的数说「读不到」，绝不说 0", () => {
    // 0 是「一条都没用过」这个**结论**；-1 只是「不知道」。混在一起会让用户误以为记忆丢了。
    setEnv({ XBB_LANG: "zh" });
    expect(formatNumber(-1)).toBe("读不到");
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(1234)).toBe("1,234");
    setEnv({ XBB_LANG: "en" });
    expect(formatNumber(-1)).toBe("unavailable");
  });

  test("时间戳两种语言同一套格式 —— 不让 11/20 与 20/11 的歧义由语言决定", () => {
    const ms = new Date(2026, 10, 20, 9, 5, 7).getTime();
    setEnv({ XBB_LANG: "zh" });
    const a = formatTime(ms);
    setEnv({ XBB_LANG: "en" });
    expect(a).toBe("2026-11-20 09:05:07");
    expect(formatTime(ms)).toBe(a);
  });
});

describe("终端显示宽度", () => {
  test("汉字占两列，ASCII 占一列", () => {
    expect(displayWidth("")).toBe(0);
    expect(displayWidth("Database")).toBe(8);
    expect(displayWidth("记忆")).toBe(4);
    expect(displayWidth("库文件")).toBe(6);
    expect(displayWidth("2026 年")).toBe(7); // 4 + 1 + 2
  });

  test("按列宽补齐，两种语言的表格才都对齐", () => {
    // 改造前列宽是人数格子数出来的 8 列；换成英文标签宽度变成 8~11 列，同一套空格必错位
    expect(padTo("记忆", 6)).toBe("记忆  ");
    expect(padTo("Database", 11)).toBe("Database   ");
    expect(columnWidth(["库文件", "记忆", "原话"])).toBe(6);
    expect(columnWidth(["Database", "Transcripts"])).toBe(11);
  });

  test("超宽不截断 —— 宁可错位也不要把一个词砍一半", () => {
    expect(padTo("Transcripts", 6)).toBe("Transcripts");
    expect(padTo("库文件", 2)).toBe("库文件");
  });
});
