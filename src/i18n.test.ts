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
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
  refreshLang,
  resetLangCache,
  resolveLang,
} from "./i18n";
import { columnWidth, displayWidth, padTo } from "./i18n/width";
import { helpEn } from "./i18n/help/en";
import { helpZh } from "./i18n/help/zh";
import { en } from "./i18n/en";
import { adminEn } from "./i18n/admin/en";
import { adminZh } from "./i18n/admin/zh";
import { adminHtml, LANG_SELF_NAMES } from "./web/admin";
import { helpText } from "./cli-help";
import { homeConfigPath, writeHomeConfig } from "./home";

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

describe("帮助文案 —— 27 条，两种语言都要在", () => {
  // `HelpDict` 是显式接口、没有索引签名，所以按下标/entries 遍历要先摊平成 Record。
  // 用 `as unknown as` 而不是 `as`：后者会被 tsc 判为「类型不够重叠」，那正是它在提醒
  // 「你可能以为这里有索引签名」—— 这里确实需要，所以显式承认一次。
  const zhMap = helpZh as unknown as Record<string, string>;
  const enMap = helpEn as unknown as Record<string, string>;

  test("每一条都非空，且两种语言的键完全对应", () => {
    // 键的对应关系由 `HelpDict` 在编译期强制（tsc 会报缺键），这里守的是**运行时**
    // 那一半：某条被写成空串或只剩空白，类型检查看不出来，用户看到的是「输入 --help 没反应」。
    const zhKeys = Object.keys(zhMap).sort();
    const enKeys = Object.keys(enMap).sort();
    expect(enKeys).toEqual(zhKeys);
    for (const k of zhKeys) {
      expect({ k, v: zhMap[k]!.trim().length > 0 }).toEqual({ k, v: true });
      expect({ k, v: enMap[k]!.trim().length > 0 }).toEqual({ k, v: true });
    }
  });

  test("英文帮助里不许残留中文 —— 漏译 27 条里的一条，用户就看到一半中文", () => {
    // 这是加语种时最容易犯的错：复制一份英文包，逐条改，改到第 19 条去接了个电话。
    // 类型检查发现不了（每条都是非空字符串），只有真的扫一遍才能抓住。
    // 允许名单必须**逐字精确**，宁可让测试红一次，也不要放一个宽泛的例外进来。
    const ALLOWED = ['"小本本服务"']; // Windows 启动项的真实注册值名，翻了它启动项就对不上了
    const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff01-\uff60]/; // 汉字 + 中文标点 + 全角符号
    const offenders: string[] = [];
    for (const [key, raw] of Object.entries(enMap)) {
      let text = raw;
      for (const ok of ALLOWED) text = text.split(ok).join("");
      const hit = text.match(CJK);
      if (hit) offenders.push(`${key}: …${text.slice(Math.max(0, hit.index! - 20), hit.index! + 20).replace(/\n/g, "⏎")}…`);
    }
    expect(offenders).toEqual([]);
  });

  test("helpText 跟着语言走，而不是只会说中文", () => {
    setEnv({ XBB_LANG: "zh" });
    expect(helpText("serve")).toContain("用法: xbb serve");
    setEnv({ XBB_LANG: "en" });
    expect(helpText("serve")).toContain("Usage: xbb serve");
    // 未知命令一律给总览（查帮助不该报错），两种语言都一样
    expect(helpText("nonesuch")).toContain("Usage: xbb <command>");
  });
});

describe("管理页文案 —— 200 多条，键要对齐、英文里不许有中文", () => {
  /** 把嵌套字典摊成「路径 + 是不是函数」，用来比两边的**形状**是否一致 */
  function shapeOf(v: unknown, path = ""): string[] {
    if (typeof v === "function") return [path + "()"];
    if (v && typeof v === "object") {
      return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => shapeOf(x, path + "." + k));
    }
    return [path];
  }
  /** 取出所有可比较的值（函数取 `zh` 包闭包里的? 不行 —— 只比形状与字符串） */
  function leaves(v: unknown, path = ""): Array<[string, unknown]> {
    if (v && typeof v === "object") {
      return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => leaves(x, path + "." + k));
    }
    return [[path, v]];
  }
  const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff01-\uff60]/;

  test("两种语言的键路径与函数位完全对应", () => {
    // 少一个键，页面上就是一处 `undefined`；多一个函数位，序列化进页面的 JSON 就会少一句。
    // 类型检查已经守了一半（AdminDict 是显式接口），这里守另一半：运行时真的对得上。
    expect(shapeOf(adminEn).sort()).toEqual(shapeOf(adminZh).sort());
  });

  test("每个字符串都有内容 —— 漏填的键在页面上是一块空白，肉眼最难发现", () => {
    // 唯一的例外：英文把量词吃进上一句（"Page [3]"），`pageJumpUnit` 必须为空。
    const ALLOW_EMPTY = new Set([".js.pageJumpUnit"]);
    for (const [k, v] of leaves(adminZh)) {
      if (typeof v !== "string") continue;
      expect({ k, zh: v.trim().length > 0 }).toEqual({ k, zh: true });
    }
    for (const [k, v] of leaves(adminEn)) {
      if (typeof v !== "string" || ALLOW_EMPTY.has(k)) continue;
      expect({ k, en: v.trim().length > 0 }).toEqual({ k, en: true });
    }
  });

  test("英文包里不许残留中文 —— 含中文标点与全角符号", () => {
    // 这段 200 多条是本次改造里最容易漏的地方：一边对照原文件一边改，
    // 改到第 150 条去接个电话，回来就接着写了。类型检查对此完全无感。
    const offenders: string[] = [];
    for (const [k, v] of leaves(adminEn)) {
      if (typeof v !== "string") continue;
      const hit = v.match(CJK);
      if (hit) offenders.push(`${k}: …${v.slice(Math.max(0, hit.index! - 16), hit.index! + 16)}…`);
    }
    expect(offenders).toEqual([]);
  });

  test("英文页面里唯一的汉字是品牌名", () => {
    // 这条是端到端的：直接渲染整页，扫一遍真实产物。
    // 骨架里漏一句没接字典的中文，只有这里能抓到（字典测试看不见模板正文）。
    //
    // ⚠️ 扫之前必须**去掉注释**：内联 CSS/JS 里的中文注释是有意保留的（判据是
    // 「谁读它」—— 注释的读者是维护者，不是用户），它们随页面一起发出去但人看不见。
    // 不去掉就会把「注释是中文」误报成「漏翻」。
    setEnv({ XBB_LANG: "en" });
    const html = adminHtml();
    expect(html).toContain('<html lang="en">');
    // 两处刻意保留中文：
    //  · 品牌名「小本本」不译（用户报 bug 时贴的就是这行，翻了就对不上号）；
    //  · `"小本本默认约束"` 是**库里存着的域名**，是数据不是文案 —— 它是筛选条件，
    //    翻译它等于让英文用户看不到默认约束的统计，而且会悄悄改变行为。
    const DATA_LITERALS = ['"小本本默认约束"'];
    let text = html;
    for (const lit of DATA_LITERALS) text = text.split(lit).join("");
    // 语言开关里那两个名字是**自指**的（中文界面写「中文」，英文界面也写「中文」），
    // 从常量取而不是在测试里硬写一个「中文」—— 那样页面上允许出现什么汉字就没人说得清了。
    for (const name of Object.values(LANG_SELF_NAMES)) text = text.split(name).join("");
    const stripped = text
      .split("小本本").join("")
      .replace(/\/\*[\s\S]*?\*\//g, "") // CSS 块注释
      // JS 行注释：只认「行首或空白之后的 //」，所以 `http://` 这类 URL 不会被误剪
      .replace(/(^|\s)\/\/[^\n]*/gm, "");
    const hit = stripped.match(CJK);
    expect(hit ? stripped.slice(Math.max(0, hit.index! - 40), hit.index! + 40) : null).toBeNull();
  });

  test("中文页面与改造前一模一样：标题、页签、危险区通行词都在", () => {
    setEnv({ XBB_LANG: "zh" });
    const html = adminHtml();
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain("<title>小本本 · 记忆管理</title>");
    expect(html).toContain(">短期叮嘱</button>");
    expect(html).toContain("危险区 · 批量物理删除（不可恢复，默认约束不受影响）");
    // 通行词必须同时出现在页面与服务端校验里，否则「清空全部」永远删不掉
    expect(html).toContain("键入：清空全部记忆");
  });

  test("内联脚本拿到的是能 JSON.parse 的字典，且不是空的", () => {
    setEnv({ XBB_LANG: "en" });
    const html = adminHtml();
    const m = html.match(/<script type="application\/json" id="xbb-i18n">([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    const parsed = JSON.parse(m![1]!) as Record<string, unknown>;
    expect(Object.keys(parsed).length).toBeGreaterThan(100);
    expect(parsed.kindMemory).toBe("Memories");
    // `<` 必须被转义成 \u003c：否则文案里一旦出现 `</script` 就会提前结束脚本元素
    expect(m![1]!).not.toContain("<");
  });
});

describe("整本英文字典都不许有中文", () => {
  test("除了品牌名，一个汉字都不该有", () => {
    // 这条是兜底网：`admin` 段自己有更细的检查，但 `tray` / `cmd` / `stats` 这些段
    // 一直靠"改造时看一遍"来保证 —— 加一个新段、复制中文包改一半，谁都不会发现。
    // 允许名单里的每一项都要有理由：
    //  · `"小本本服务"` 是 Windows 启动项的**真实注册值名**，翻了启动项就对不上；
    //  · 「小本本」是品牌名，不译（用户报 bug 时贴的就是这行）。
    // 长的写前面：先剥整串，再剥品牌，否则会剩下半截「服务」被误判成漏译。
    const ALLOWED = ['"小本本服务"', "小本本"];
    const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff01-\uff60]/;
    const offenders: string[] = [];
    // 函数型文案要真跑一遍才有意义（跳过等于整段没查）。入参用一个"什么都能当"的代理：
    // 转成字符串是 x、参与三目是真值、`.join()` 返回 x —— 覆盖了字典里那几种写法。
    const anyArg = new Proxy(["x"] as unknown as Record<string | symbol, unknown>, {
      get(_t, p) {
        if (p === "join") return () => "x";
        if (p === "length") return 1;
        if (p === Symbol.toPrimitive || p === "toString") return () => "x";
        return "x";
      },
    });
    const walk = (v: unknown, path: string): void => {
      if (typeof v === "string") {
        let text = v;
        for (const ok of ALLOWED) text = text.split(ok).join("");
        const hit = text.match(CJK);
        if (hit) offenders.push(`${path}: …${text.slice(Math.max(0, hit.index! - 16), hit.index! + 16)}…`);
        return;
      }
      if (typeof v === "function") {
        try {
          const out = (v as (...a: unknown[]) => unknown)(anyArg, anyArg, anyArg);
          // 有几种话术是整块多行（`string[]`），逐行查，别整块跳过
          if (typeof out === "string") walk(out, path + "(…)");
          else if (Array.isArray(out)) out.forEach((line, i) => walk(line, `${path}(…)[${i}]`));
          else offenders.push(`${path}: 函数没有返回字符串，本闸查不到它的措辞`);
        } catch (e) {
          offenders.push(`${path}: 调用抛错 ${(e as Error).message}`);
        }
        return;
      }
      if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, path + "." + k);
      }
    };
    walk(en, "");
    expect(offenders).toEqual([]);
  });

  test("tray 与 admin 的措辞确实换过语言，不是把中文复制过来", () => {
    setEnv({ XBB_LANG: "zh" });
    expect(dict().tray.openWindow).toBe("打开管理窗口");
    expect(dict().tray.autostart(true)).toBe("开机自启：已开");
    expect(dict().admin.html.btnSearch).toBe("搜索");
    setEnv({ XBB_LANG: "en" });
    expect(dict().tray.openWindow).toBe("Open admin window");
    expect(dict().tray.autostart(true)).toBe("Start at login: on");
    expect(dict().admin.html.btnSearch).toBe("Search");
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

describe("refreshLang —— 长期驻留的进程要跟着配置文件走", () => {
  // 这一组守的是「管理窗口能不能热切换」。CLI 每个命令一个新进程，缓存命中不了第二次，
  // 所以它从来不需要这段逻辑；出问题的只有 serve —— 它活几个小时，而用户在这期间
  // 完全可能敲 `xbb lang en` 或者点页面右上角的开关。
  test("配置文件没动：返回 false，字典对象原样复用（不做无谓重建）", () => {
    writeHomeConfig({ lang: "zh" }, "test");
    const first = dict();
    expect(refreshLang()).toBe(false);
    expect(dict()).toBe(first);
  });

  test("别人改了配置：同进程里 dict() 立刻跟上", () => {
    writeHomeConfig({ lang: "zh" }, "test");
    expect(currentLang()).toBe("zh");

    // 模拟「另一个终端敲了 xbb lang en」：直接动文件，不经过本进程任何函数
    writeFileSync(homeConfigPath(), JSON.stringify({ lang: "en" }), "utf8");
    // mtime 精度随文件系统而异，显式推后一秒 —— 否则同一毫秒内两次写会被判成"没变"，
    // 那是测试自己不稳，不是代码错。
    const t = new Date(Date.now() + 1000);
    utimesSync(homeConfigPath(), t, t);

    expect(refreshLang()).toBe(true);
    expect(currentLang()).toBe("en");
  });

  test("配置文件被删掉也要察觉 —— 回落到默认语言", () => {
    // `configKey()` 把"文件不在"记成 absent 而不是空串，就是为了这一条：
    // 从 `{lang:en}` 变成"没有文件"必须算变化。
    writeHomeConfig({ lang: "en" }, "test");
    expect(currentLang()).toBe("en");

    rmSync(homeConfigPath());
    expect(refreshLang()).toBe(true);
    expect(currentLang()).toBe("zh");
  });

  test("刷新过一次之后不会一直返回 true", () => {
    // 假如实现写成"永远 return true"，上面几条全都会绿 —— 它们只检查"变了要跟上"，
    // 没检查"没变别乱动"。这一条补上另一半：否则每个请求都会重建一次字典。
    writeHomeConfig({ lang: "en" }, "test");
    expect(refreshLang()).toBe(true); // 首次：还没解析过
    dict(); // 重新解析并记下新版本
    expect(refreshLang()).toBe(false);
  });
});
