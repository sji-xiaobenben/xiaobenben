// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 数据位置：判定闸、锚点、迁移。
 *
 * 这组测试守的是**一句话**：库不在预期位置时，程序必须**起不来**，而不是造一个空库继续跑。
 * 那条错误路径没有用户会发现——因为一切"看起来正常"，直到他某天问起半年前的事。
 */
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import * as H from "./home";
import { PersonalStore } from "./store";

const cleanups: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}
afterAll(
  () => {
    for (const d of cleanups) rmSync(d, { recursive: true, force: true });
  },
  // 显式放宽。这个文件是唯一会累积**几十个**临时目录的（`tmp()` 被调 41 次，每个里都有
  // 一个 SQLite 库），而 Windows 删刚写完的库要等 WAL/SHM 句柄释放、还要过一遍 Defender，
  // 单目录几十毫秒 × 41 就压在 bun hook 默认的 5s 线上。干净环境实测 5.7s，失败信息是
  // 「a beforeEach/afterEach hook timed out」，看起来像测试坏了，实际是清理慢。
  //   耗时由机器（磁盘、Defender 策略、句柄释放延迟）决定，不由本仓代码决定 —— 和上面
  //   `runningProcs` 那条同样的理由：给它单独的预算，而不是让默认值去猜。
  30_000,
);

/** 把进程环境切到某个 XBB_HOME（home.ts 全是调用时读 env，所以切了立刻生效） */
function useHome(dir: string): void {
  process.env.XBB_HOME = dir;
  delete process.env.XBB_DATA_DIR;
}

/** 造一个有库的目录（显式路径 ⇒ 绕开闸门，正是"老用户已有的库"那种形态） */
async function makeDb(path: string, contents: string[] = []): Promise<void> {
  const store = PersonalStore.open(path);
  for (const c of contents) await store.deliver({ spaceId: "sp-1", actor: "ai-host", content: c, tags: [] });
  store.db.close();
}

const IDLE = { procs: () => [], locked: () => false };

describe("判定闸：绝不静默新建空库", () => {
  test("首次安装（无配置、无库）→ 允许建库", () => {
    const home = tmp("xbb-home-first-");
    useHome(home);
    const gate = H.openGate();
    expect(gate.firstRun).toBe(true);
    expect(gate.dbPath).toBe(join(home, "memory.db"));
    expect(existsSync(gate.dbPath)).toBe(false); // 闸门本身不建任何东西
  });

  test("老用户（无配置、默认位置有库）→ 正常打开，且零感知向后兼容", async () => {
    const home = tmp("xbb-home-legacy-");
    useHome(home);
    await makeDb(join(home, "memory.db"), ["用户偏好低饱和插画风格"]);
    const gate = H.openGate();
    expect(gate.existed).toBe(true);
    expect(gate.source).toBe("default");
    const store = PersonalStore.open();
    expect(store.search("低饱和插画").length).toBe(1);
    store.db.close();
  });

  test("配置指向有库的位置 → 正常打开", async () => {
    const home = tmp("xbb-home-cfg-ok-");
    const data = tmp("xbb-data-ok-");
    useHome(home);
    await makeDb(join(data, "memory.db"), ["记在别的盘上的一句话"]);
    H.writeHomeConfig({ dataDir: data }, "test");
    const gate = H.openGate();
    expect(gate.source).toBe("config");
    expect(gate.dbPath).toBe(join(data, "memory.db"));
  });

  test("★ 配置指向空目录、默认位置有库 → 抛错，且**不新建空库**", async () => {
    const home = tmp("xbb-home-trap-");
    const data = tmp("xbb-data-empty-");
    useHome(home);
    await makeDb(join(home, "memory.db"), ["这条记忆绝不能被一个空库顶掉"]);
    H.writeHomeConfig({ dataDir: data }, "test");

    let caught: unknown = null;
    try {
      PersonalStore.open();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(H.DbMissingError);
    const err = caught as H.DbMissingError;
    expect(err.detail.kind).toBe("configured-missing-but-legacy-exists");
    expect(err.message).toContain("这不是首次运行"); // 必须说清"库还在、只是路走错了"
    // 最关键的一条断言：目标目录里**没有**被造出 memory.db
    expect(existsSync(join(data, "memory.db"))).toBe(false);
    // 老库原封不动
    expect(existsSync(join(home, "memory.db"))).toBe(true);
  });

  test("环境变量指向空目录 → 抛错（env 优先级最高，且不写盘）", async () => {
    const home = tmp("xbb-home-env-");
    const data = tmp("xbb-data-env-");
    useHome(home);
    await makeDb(join(home, "memory.db"));
    process.env.XBB_DATA_DIR = data;
    expect(() => H.openGate()).toThrow(H.DbMissingError);
    expect(existsSync(join(data, "memory.db"))).toBe(false);
    delete process.env.XBB_DATA_DIR;
  });

  test("★ 默认位置有安装痕迹但没有库 → 拒绝启动（这不可能是首次安装）", () => {
    const home = tmp("xbb-home-trace-");
    useHome(home);
    // 模拟"这套安装用过"：bin/ 里有 exe、下过模型、跑过服务
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", "xbb.exe"), "fake");
    mkdirSync(join(home, "models"), { recursive: true });
    writeFileSync(join(home, "notify-state.json"), "{}");

    let caught: unknown = null;
    try {
      PersonalStore.open();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(H.DbMissingError);
    expect((caught as H.DbMissingError).detail.kind).toBe("default-missing-but-installed");
    expect((caught as H.DbMissingError).message).toContain("不是首次运行");
    // 关键：没有偷偷建库
    expect(existsSync(join(home, "memory.db"))).toBe(false);
    // 只有显式 --force 才建
    const store = PersonalStore.open(undefined, { force: true });
    store.db.close();
    expect(existsSync(join(home, "memory.db"))).toBe(true);
  });

  test("force 才允许在配置位置建库（init --force 的唯一通道）", () => {
    const home = tmp("xbb-home-force-");
    const data = tmp("xbb-data-force-");
    useHome(home);
    H.writeHomeConfig({ dataDir: data }, "test");
    expect(() => H.openGate()).toThrow();
    const gate = H.openGate({ force: true });
    expect(gate.firstRun).toBe(true);
    expect(gate.dbPath).toBe(join(data, "memory.db"));
  });
});

describe("锚点：配置跟着程序走，不跟着库走", () => {
  test("配置文件落在程序目录，与库目录无关", () => {
    const home = tmp("xbb-home-anchor-");
    const data = tmp("xbb-data-anchor-");
    useHome(home);
    H.writeHomeConfig({ dataDir: data }, "test");
    expect(H.homeConfigPath()).toBe(join(home, "config.json"));
    expect(existsSync(join(data, "config.json"))).toBe(false); // 绝不写进库目录
  });

  test("库没了，锚点还在 —— 这是可检测的异常，而不是「首次运行」", async () => {
    const home = tmp("xbb-home-anchor2-");
    const data = tmp("xbb-data-anchor2-");
    useHome(home);
    await makeDb(join(home, "memory.db"));
    H.writeHomeConfig({ dataDir: data }, "test");
    rmSync(join(home, "memory.db")); // 模拟"库被移走 / 盘没挂上"
    expect(existsSync(join(data, "memory.db"))).toBe(false);
    expect(H.readHomeConfig()?.dataDir).toBe(data); // 锚点仍在
    expect(() => H.openGate()).toThrow(H.DbMissingError);
  });

  test("坏 JSON 不让程序起不来（回落到默认位置）", () => {
    const home = tmp("xbb-home-badjson-");
    useHome(home);
    writeFileSync(join(home, "config.json"), "{ 这不是 json", "utf8");
    expect(H.readHomeConfig()).toBeNull();
    expect(H.resolveDataDirWithSource().source).toBe("default");
  });

  test("clearDataDir 真的删掉字段（不是被合并写掩盖）", () => {
    const home = tmp("xbb-home-clear-");
    useHome(home);
    H.writeHomeConfig({ dataDir: "D:\\somewhere" }, "test");
    H.clearDataDir("test");
    expect(H.readHomeConfig()?.dataDir).toBeUndefined();
    expect(readFileSync(H.homeConfigPath(), "utf8")).not.toContain("dataDir");
    expect(H.resolveDataDirWithSource().source).toBe("default");
  });

  test("相对路径按程序目录解析（配置可手写，但不能含糊）", () => {
    const home = tmp("xbb-home-rel-");
    useHome(home);
    H.writeHomeConfig({ dataDir: "data" }, "test");
    expect(H.resolveDataDir()).toBe(join(home, "data"));
  });
});

describe("页面计数口径：readRowCounts 跳过完整性校验", () => {
  test("计数与 readDbCounts 完全一致，但不返回 integrity（不走全库逐页校验）", async () => {
    const home = tmp("xbb-home-rows-");
    useHome(home);
    await makeDb(join(home, "memory.db"), ["第一条", "第二条", "第三条"]);

    const full = H.readDbCounts(join(home, "memory.db"));
    const light = H.readRowCounts(join(home, "memory.db"));

    expect(light.memories).toBe(full.memories);
    expect(light.episodes).toBe(full.episodes);
    expect(light.events).toBe(full.events);
    // 结构上没有 integrity 字段 —— 页面路径不该付 integrity_check 的代价（110MB 库实测 1.5~7 秒）
    expect("integrity" in light).toBe(false);
  });
});

describe("账本口径：被用过的才叫资产", () => {
  test("memories / used / hits / links 是四个不同的数，不能互为解释", async () => {
    const home = tmp("xbb-home-ledger-");
    useHome(home);
    const p = join(home, "memory.db");
    await makeDb(p, ["甲", "乙", "丙"]);
    const store = PersonalStore.open(p);
    // 直接改计数列：这里测的是**口径**，不是召回链路（链路有 links.test.ts 守着）
    store.db.prepare("UPDATE memories SET hit_count = 3 WHERE content = ?").run("甲");
    store.db.prepare("UPDATE memories SET hit_count = 1 WHERE content = ?").run("乙");
    store.db.close();

    const u = H.readUsageCounts(p);
    expect(u.memories).toBe(3); // 分母
    expect(u.used).toBe(2); // 丙 从未被召回
    expect(u.hits).toBe(4); // 3+1：一次召回命中多条会各 +1，所以它不是"召回次数"
    expect(u.links).toBe(0); // 没有 AI 显式声明的边
    expect(u.episodes).toBe(0); // 这个库没写过原话
    expect(u.sessions).toBe(0);
  });

  test("原话按行数、会话按 distinct —— 两者不能互相替代", async () => {
    const home = tmp("xbb-home-ledger-ep-");
    useHome(home);
    const p = join(home, "memory.db");
    await makeDb(p, ["甲"]);
    const store = PersonalStore.open(p);
    const ins = store.db.prepare(
      "INSERT INTO episodes(session_id, role, content, recorded_at) VALUES (?,?,?,?)",
    );
    const at = new Date().toISOString();
    ins.run("s1", "user", "一", at);
    ins.run("s1", "assistant", "二", at);
    ins.run("s2", "user", "三", at);
    ins.run("", "user", "没有会话号的孤儿行", at); // 空 id 不能算作一个会话
    store.db.close();

    const u = H.readUsageCounts(p);
    expect(u.episodes).toBe(4); // 原话是**行数**
    expect(u.sessions).toBe(2); // 会话是 distinct(session_id)，且空 id 被排除
  });

  test("空库给 0；缺表给 -1 —— 0 是结论（一条没用过），-1 只是读不到", async () => {
    const home = tmp("xbb-home-ledger-empty-");
    useHome(home);
    const p = join(home, "memory.db");
    await makeDb(p, []);
    expect(H.readUsageCounts(p)).toEqual({
      memories: 0, used: 0, hits: 0, links: 0, episodes: 0, sessions: 0,
    });

    // 裸库（只有一张无关的表）：六个数都必须 -1。
    // 若这里返回 0，管理页就会对老库用户说"你一条都没用上"——那是在编结论。
    const bare = join(tmp("xbb-ledger-bare-"), "bare.db");
    const raw = new Database(bare);
    raw.exec("CREATE TABLE unrelated(x)");
    raw.close();
    expect(H.readUsageCounts(bare)).toEqual({
      memories: -1, used: -1, hits: -1, links: -1, episodes: -1, sessions: -1,
    });
  });
});

describe("迁移：复制 → 校验 → 才切配置", () => {
  test("搬完能读到旧库的内容，配置指向新位置", async () => {
    const home = tmp("xbb-home-move-");
    const to = tmp("xbb-data-move-");
    useHome(home);
    await makeDb(join(home, "memory.db"), ["迁移前写的一条记忆", "迁移前写的第二条"]);
    const before = H.readDbCounts(join(home, "memory.db"));

    const r = H.moveDataDir(to, IDLE);
    expect(r.verify?.memories).toBe(before.memories);
    expect(r.verify?.episodes).toBe(before.episodes);
    expect(r.verify?.integrity).toBe("ok");
    expect(H.readHomeConfig()?.dataDir).toBe(to);

    const store = PersonalStore.open();
    expect(store.search("迁移前写的").length).toBe(2);
    store.db.close();
    // 默认不删旧数据：用户确认新位置能用之后自己删
    expect(existsSync(join(home, "memory.db"))).toBe(true);
  });

  test("目标已有库 → 拒绝覆盖（那是别人的记忆，不是可覆盖的文件）", async () => {
    const home = tmp("xbb-home-move2-");
    const to = tmp("xbb-data-move2-");
    useHome(home);
    await makeDb(join(home, "memory.db"), ["源库"]);
    await makeDb(join(to, "memory.db"), ["目标库里已有的东西"]);
    expect(() => H.moveDataDir(to, IDLE)).toThrow(/已有库/);
  });

  test("目标就是当前位置 → 拒绝", () => {
    const home = tmp("xbb-home-move3-");
    useHome(home);
    expect(() => H.moveDataDir(home, IDLE)).toThrow(/目标就是当前位置/);
  });

  test("有进程占用时拒绝迁移（WAL 里未落盘的写入会丢）", () => {
    const home = tmp("xbb-home-move4-");
    const to = tmp("xbb-data-move4-");
    useHome(home);
    expect(() =>
      H.moveDataDir(to, { procs: () => [{ pid: 4321, name: "xbb.exe", cmd: "xbb.exe serve" }], locked: () => false }),
    ).toThrow(/还有 xbb 进程在跑/);
  });

  test("校验不过就不切配置（行数不一致 ⇒ 抛错且锚点不变）", async () => {
    const home = tmp("xbb-home-move5-");
    useHome(home);
    await makeDb(join(home, "memory.db"), ["原始库的一条"]);
    expect(() => H.verifyCopy(join(home, "memory.db"), join(home, "nope.db"))).toThrow(/不存在/);
    expect(H.readHomeConfig()?.dataDir).toBeUndefined();
  });

  test("--cleanup 才删旧位置的数据", async () => {
    const home = tmp("xbb-home-move6-");
    const to = tmp("xbb-data-move6-");
    useHome(home);
    await makeDb(join(home, "memory.db"), ["这条搬完就该从旧位置消失"]);
    H.moveDataDir(to, { ...IDLE, cleanup: true });
    expect(existsSync(join(home, "memory.db"))).toBe(false);
    expect(existsSync(join(to, "memory.db"))).toBe(true);
  });
});

describe("find：忘了放哪时的救命绳", () => {
  test("能在树里找到库，并按记忆条数排序（空库不能顶掉真库）", async () => {
    const root = tmp("xbb-find-");
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(root, "b", "c"), { recursive: true });
    await makeDb(join(root, "a", "memory.db"), ["真库里的记忆一", "真库里的记忆二"]);
    await makeDb(join(root, "b", "c", "memory.db")); // 同名空库
    const found = H.findDatabases({ roots: [root], budgetMs: 8000 });
    const inRoot = found.filter((f) => f.path.startsWith(root));
    expect(inRoot.length).toBe(2);
    const real = inRoot.find((f) => f.path.includes(join("a", "memory.db")));
    expect(real?.memories).toBe(2);
    // 排序：条数多的在前
    expect(inRoot[0]!.memories ?? 0).toBeGreaterThanOrEqual(inRoot[1]!.memories ?? 0);
  });
});

/**
 * 占用检测：**不注入、真打开**。
 *
 * 这一组是 v0.4.44 事故的回归锁（2026-11-04 用户实测反馈）：
 * 上面所有 move 测试都注入 `IDLE.locked = () => false`，于是真实的 `dbLocked`
 * **一次都没被执行过**——而它里面写的是 `new Database(path, { readonly: false })`，
 * Bun 对这个值直接抛 `SQLITE_MISUSE`，再被 `catch { return true }` 吞成「被占用」。
 * 结果：`xbb home move` 只要库存在就 100% 失败，测试全绿。
 *
 * 教训一句话：**被测代码里最容易错的那一层，恰好是被 mock 掉的那一层。**
 */
describe("占用检测：真实打开（不注入 mock）", () => {
  test("无人占用 → 判定为空闲（v0.4.44 在这里全量误报）", async () => {
    const home = tmp("xbb-lock-free-");
    useHome(home);
    await makeDb(join(home, "memory.db"), ["一条真实的记忆"]);
    expect(H.dbLocked(join(home, "memory.db"))).toBe(false);
  });

  test("别的连接拿着写事务 → 判定为占用", async () => {
    const home = tmp("xbb-lock-held-");
    useHome(home);
    const p = join(home, "memory.db");
    await makeDb(p, ["一条真实的记忆"]);

    const { Database } = await import("bun:sqlite");
    const holder = new Database(p, { readwrite: true });
    try {
      holder.exec("BEGIN IMMEDIATE");
      expect(H.dbLocked(p)).toBe(true);
      holder.exec("COMMIT");
    } finally {
      holder.close();
    }
    // 释放之后必须恢复空闲——否则就成了"一次占用永久占用"
    expect(H.dbLocked(p)).toBe(false);
  });

  test("文件不是数据库 → 抛出真实原因，不伪装成「被占用」", () => {
    const home = tmp("xbb-lock-garbage-");
    useHome(home);
    const p = join(home, "memory.db");
    writeFileSync(p, "这不是一个 SQLite 文件");
    // 关键：必须是 throw，不能静默 return true。
    // 把编码错误伪装成环境问题，用户会按提示去关进程，关到天荒地老也没用。
    expect(() => H.dbLocked(p)).toThrow();
  });

  test("--force 跳过占用检查，但校验照做", async () => {
    const home = tmp("xbb-lock-force-");
    const to = tmp("xbb-lock-force-to-");
    useHome(home);
    await makeDb(join(home, "memory.db"), ["force 也要搬对"]);
    const r = H.moveDataDir(to, {
      procs: () => [],
      locked: () => true, // 假装被占用
      force: true,
    });
    expect(r.verify?.memories).toBe(1);
    expect(existsSync(join(to, "memory.db"))).toBe(true);
  });

  test("不给 force 时仍按占用拦住", async () => {
    const home = tmp("xbb-lock-blocked-");
    const to = tmp("xbb-lock-blocked-to-");
    useHome(home);
    await makeDb(join(home, "memory.db"), ["这条不许被搬"]);
    expect(() => H.moveDataDir(to, { procs: () => [], locked: () => true })).toThrow();
    expect(existsSync(join(to, "memory.db"))).toBe(false);
  });
});

describe("换目录时模型跟着走", () => {
  test("目标没有 models → 从当前数据目录复制过去", () => {
    const home = tmp("xbb-models-src-");
    const to = tmp("xbb-models-dst-");
    useHome(home);
    // 造一个假的模型目录（真实的是 24MB bge-small-zh，测试不需要真权重）
    mkdirSync(join(home, "models", "bge-small-zh"), { recursive: true });
    writeFileSync(join(home, "models", "bge-small-zh", "model.onnx"), "fake-weights");

    const r = H.copyModelsInto(to);
    expect(r.copied).toBe(true);
    expect(existsSync(join(to, "models", "bge-small-zh", "model.onnx"))).toBe(true);
    // 幂等：已经有了就不再复制
    expect(H.copyModelsInto(to).copied).toBe(false);
  });

  test("set 的顺序陷阱：源目录必须在写配置之前取", () => {
    const prog = tmp("xbb-models-order-prog-");
    const data = tmp("xbb-models-order-data-");
    const to = tmp("xbb-models-order-to-");
    useHome(prog);
    // 真实形态：程序在 C 盘、库在 D 盘，两者分开（合成一个目录反而测不出问题，
    // 因为 fallback 的 programDir 恰好会命中源）
    H.writeHomeConfig({ dataDir: data }, "setup");
    mkdirSync(join(data, "models", "bge-small-zh"), { recursive: true });
    writeFileSync(join(data, "models", "bge-small-zh", "model.onnx"), "fake-weights");

    const src = H.resolveDataDir(); // ← 必须在写配置前取，此时 = data
    expect(src).toBe(join(data));
    H.writeHomeConfig({ dataDir: to }, "test");

    // 写完之后再靠 resolveDataDir() 现取，拿到的是 to；programDir 也没有 models
    // ⇒ 复制静默不做事。这就是 2026-11-04 端到端实测漏掉的那一拍：
    // 命令回了一句「找不到可复制的副本」，而源目录明明就在 data 里。
    expect(H.copyModelsInto(to).copied).toBe(false);
    expect(H.copyModelsInto(to, src).copied).toBe(true);
    expect(existsSync(join(to, "models", "bge-small-zh", "model.onnx"))).toBe(true);
  });
});

/**
 * 进程枚举与 `--keep-mcp` 的边界（2026-11-04 用户反馈）。
 *
 * 这组守两件事：
 *  ① `stop --keep-mcp` 必须**只**留下 mcp —— 杀错 mcp 的代价是当前会话的记忆工具立刻失效。
 *  ② 判据不能是"命令行里出现过 xbb"：那样 `xbb stop` 会去杀正在打开 xbb 源码的编辑器。
 *  ③ Unix 那条分支（`ps -Ao pid=,command=`）在本机跑不到，靠纯字符串断言兜住 ——
 *     上一版用的是 `pgrep -af`，而 macOS 的 pgrep 没有 `-a`，于是整条保护在 Mac 上静默失效。
 */
describe("进程枚举：跨平台与 --keep-mcp", () => {
  const P = (pid: number, cmd: string) => ({ pid, name: "xbb.exe", cmd });

  test("Unix 命令行：首 token 是 xbb 才算（含 dev 形态）", () => {
    expect(H.isXbbCommand("/home/u/.xiaobenben/bin/xbb serve")).toBe(true);
    expect(H.isXbbCommand("/home/u/.xiaobenben/bin/xbb mcp")).toBe(true);
    expect(H.isXbbCommand("/Applications/xbb serve --detach")).toBe(true);
    // dev：bun 拉起源码
    expect(H.isXbbCommand("bun src/index.ts serve")).toBe(true);
    expect(H.isXbbCommand("/usr/local/bin/bun /w/xbb/cli/src/index.ts mcp")).toBe(true);
    // 只是"打开/看着"这些东西的进程，不是 xbb 本体
    expect(H.isXbbCommand("vim /home/u/.xiaobenben/xbb/cli/src/index.ts")).toBe(false);
    expect(H.isXbbCommand("/usr/bin/code /Users/u/.xiaobenben")).toBe(false);
    expect(H.isXbbCommand("tail -f /Users/u/.xiaobenben/logs/serve.log")).toBe(false);
  });

  test("mcp 判据只看独立 token，路径里带 mcp 不算", () => {
    expect(H.isMcpCommand("xbb.exe mcp")).toBe(true);
    expect(H.isMcpCommand("xbb.exe serve --root /opt/mcp-tools")).toBe(false);
  });

  test("不加 --keep-mcp：全停（含 mcp）", () => {
    const r = H.classifyProcs([P(1, "xbb.exe serve"), P(2, "xbb.exe mcp")]);
    expect(r.kill.map((p) => p.pid)).toEqual([1, 2]);
    expect(r.keep).toEqual([]);
  });

  test("--keep-mcp：只留 mcp，serve 照停", () => {
    const r = H.classifyProcs([P(1, "xbb.exe serve"), P(2, "xbb.exe mcp")], { keepMcp: true });
    expect(r.kill.map((p) => p.pid)).toEqual([1]);
    expect(r.keep.map((p) => p.pid)).toEqual([2]);
  });

  test("--keep-mcp + 拿不到命令行：保守跳过，并如实报告为 undecidable", () => {
    const r = H.classifyProcs([{ pid: 3, name: "xbb.exe", cmd: "" }], { keepMcp: true });
    expect(r.kill).toEqual([]);
    expect(r.undecidable.map((p) => p.pid)).toEqual([3]);
  });

  test("真实 runningProcs 不注入也能跑：不抛、不算上自己", () => {
    // 上一轮的教训：move 的测试全部注入 IDLE，真实 dbLocked 一次没跑过 ⇒ 测试全绿功能全废。
    // 这条就是"至少真实实现被调用过一次"的锁。
    const procs = H.runningProcs();
    expect(Array.isArray(procs)).toBe(true);
    expect(procs.some((p) => p.pid === process.pid)).toBe(false);
  }, 30_000);
  // ↑ 显式放宽到 30s。这条跑的是**真实**进程枚举：Windows 走 PowerShell 的
  //   Get-CimInstance（WMI 查询，冷启动本身就要 1-3s），在 github 的 windows-latest 上
  //   叠加负载后实测 5.4s，正好压在 bun 默认的 5s 线上——于是它偶发超时、rerun 即绿，
  //   而失败信息看起来像"功能坏了"。耗时由机器上有多少进程和 WMI 健康度决定，不由本仓
  //   代码决定，所以给它单独的预算，而不是让默认值去猜。
  //   真要压这个耗时得换掉 CIM 查询，但 `--keep-mcp` 靠命令行区分进程，tasklist 给不出
  //   命令行——那是另一个取舍，不该在这道测试里顺手改。
});
