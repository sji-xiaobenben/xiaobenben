// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 管理页的语言开关 —— 端到端。
 *
 * 为什么这条必须起真服务，而不是只测 `refreshLang()`：热切换的成败取决于
 * 「同一个进程、两次请求之间」，单元测试给不了这个现场。曾经有过相反的写法
 * （`const ADMIN_HTML = ...` 把页面钉在模块加载那一刻），它所有单测都能过，
 * 只有真的发两次 HTTP 才看得出来。
 *
 * ⚠️ 这里**必须**是独立 `XBB_HOME`：POST /api/lang 会真的写 config.json，
 * 跑在真实家目录上等于把开发机的语言设置改掉。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalStore } from "../store";
import { startServe } from "../serve";

let dir = "";
let store: PersonalStore;
/** 测试环境原本的 XBB_LANG（预加载脚本钉成 zh），跑完要还原，别污染同进程的其他文件 */
const savedLang = process.env.XBB_LANG;
let server: { port: number; stop: (force?: boolean) => void };
let base = "";

/** 页面里的可见文案（剥掉注释，避免把维护者注释当成漏译） */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ");
}

const postLang = (lang: unknown) =>
  fetch(`${base}/api/lang`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lang }),
  });

describe("语言开关：不重启服务就能换语言", () => {
  beforeAll(async () => {
    process.env.XBB_SEED = "0"; // 不播种默认约束：测试不该往库里写业务数据
    process.env.XBB_WARMUP = "0"; // 预热会去下模型，单元测试要的是不联网
    dir = mkdtempSync(join(tmpdir(), "xbb-langswitch-"));
    process.env.XBB_HOME = dir;
    // ⚠️ 必须摘掉 XBB_LANG：预加载脚本把它钉成 zh（为了让既有中文断言稳定），
    // 但判定链是 env > 配置 —— 留着它，配置文件写什么都无效，热切换永远"看起来没生效"，
    // 而代码其实是对的。这条测试验证的正是"配置驱动"，就得让配置说话。
    delete process.env.XBB_LANG;
    // 起点用配置钉成中文，不依赖跑测试那台机器的系统语言
    writeFileSync(join(dir, "config.json"), JSON.stringify({ lang: "zh" }), "utf8");
    store = PersonalStore.open(join(dir, "memory.db"));
    server = (await startServe(store, 0)) as unknown as { port: number; stop: (f?: boolean) => void };
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    if (savedLang === undefined) delete process.env.XBB_LANG;
    else process.env.XBB_LANG = savedLang;
    try {
      server?.stop(true);
    } catch {
      /* 已停 */
    }
    try {
      store?.db.close();
    } catch {
      /* 已关 */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上 WAL 句柄释放有延迟，目录在临时区，下次自会被清 */
    }
  });

  test("POST /api/lang 之后，同一个进程的 /ui 立刻是新语言", async () => {
    const before = await (await fetch(`${base}/ui`)).text();
    expect(before).toContain('<html lang="zh-CN">'); // 中文页面刻意标区域：同样的字，简繁读法不同
    expect(visibleText(before)).toContain("记忆管理");

    const res = await postLang("en");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, lang: "en" });

    // 没有重启、没有重新打开页面 —— 只是下一次请求
    const after = await (await fetch(`${base}/ui`)).text();
    expect(after).toContain('<html lang="en">');
    expect(visibleText(after)).toContain("Memory admin");
    // 中文页面的标题不该还在：整页是同一个语言，不是拼接出来的
    expect(visibleText(after)).not.toContain("记忆管理");
  });

  test("另一个终端改了配置：刷新页面就跟上，不用重启服务", async () => {
    // 这条**不经过本进程的任何接口** —— 模拟用户在隔壁终端敲 `xbb lang en`。
    // 页面开关那条路径由 POST 里的刷新兜住了，看不出 handleServe 每请求比对的作用；
    // 只有这种"外部改文件"才需要它。第一版漏了这条，变异验证时才发现测试是空的。
    expect((await postLang("zh")).status).toBe(200);
    // **先请求一次**，让本进程真的把 zh 缓存住。
    // 少了这一步，POST 早就把缓存清空了 —— 下一个请求无论如何都会重新解析，
    // 于是"每请求比对配置文件"这行代码删掉测试也是绿的（变异验证抓出来的）。
    await (await fetch(`${base}/ui`)).text();
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, JSON.stringify({ lang: "en" }), "utf8");
    // mtime 精度随文件系统而异，显式推后一秒，否则同一毫秒内两次写会被判成"没变"
    const t = new Date(Date.now() + 1000);
    utimesSync(cfg, t, t);

    const html = await (await fetch(`${base}/ui`)).text();
    expect(html).toContain('<html lang="en">');
  });

  test("写的是配置文件，不是库 —— 换库不该换语言", () => {
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect(cfg.lang).toBe("en");
  });

  test("认不出的语言码被拒，且不改动现有设置", async () => {
    // 自己建立一个已知状态，不依赖上一条测试留下的现场
    expect((await postLang("en")).status).toBe(200);
    const res = await postLang("klingon");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTruthy();

    // 拒绝之后页面还是上一次成功切换的语言，不能被写坏
    const html = await (await fetch(`${base}/ui`)).text();
    expect(html).toContain('<html lang="en">');
  });

  test("区域码也放行 —— 跟 `xbb lang` 的宽容度一致", async () => {
    const res = await postLang("zh-CN");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { lang: string }).lang).toBe("zh");
    const html = await (await fetch(`${base}/ui`)).text();
    expect(html).toContain('<html lang="zh-CN">');
  });

  test("页面上的开关按钮标出了当前语言", async () => {
    // 两个按钮用自指名（中文 / English），当前那个带 aria-pressed="true"。
    // 少了这个标记，用户看不出自己现在在哪种语言下 —— 尤其两种语言都能看懂一部分的时候。
    const html = await (await fetch(`${base}/ui`)).text();
    expect(html).toContain('data-lang="zh" aria-pressed="true"');
    expect(html).toContain('data-lang="en" aria-pressed="false"');
  });

  test("语言名长短一样、文件时间戳又没变：照样得切过去", async () => {
    // 这条守的是「用户点了开关却没反应」那个具体故障：
    //   · `{"lang":"en"}` 与 `{"lang":"zh"}` **字节数完全相同**，size 判不出来；
    //   · 服务自己处理一次点击可能就在同一毫秒里，时间戳粒度不够时也判不出来。
    // 两次都把 mtime 压到同一个整秒值，把“靠文件版本号察觉变化”这条路彻底堵死 ——
    // 此时还能切成功，靠的就是 POST 写完自己失效缓存。
    // （CI 的 Windows 上真红过一次，本地因机器快慢不同恰好没撞上。）
    const cfg = join(dir, "config.json");
    const pinned = new Date("2020-01-01T00:00:00Z"); // 整秒：纳秒位是 0，两次设出来完全一样

    expect((await postLang("en")).status).toBe(200);
    utimesSync(cfg, pinned, pinned);
    expect(await (await fetch(`${base}/ui`)).text()).toContain('<html lang="en">');

    expect((await postLang("zh")).status).toBe(200);
    utimesSync(cfg, pinned, pinned); // 时间戳回到切换前 → 只靠 stat 看不出任何变化

    const html = await (await fetch(`${base}/ui`)).text();
    expect(html).toContain('<html lang="zh-CN">');
  });
});
