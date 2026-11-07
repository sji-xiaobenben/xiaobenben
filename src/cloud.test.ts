import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  bindingDriftMessage,
  clearCloudConfig,
  cloudStamp,
  consoleBase,
  loadCloudConfig,
  loadCloudConfigRaw,
  resolveRecipients,
  saveCloudConfig,
  setCloudEnabled,
  type CloudConfig,
  type CloudStamp,
  type MemberInfo,
} from "./cloud";

// 隔离到临时 XBB_HOME：cloud.json 的路径由该 env 决定（configPath() 每次调用时读取）
const dir = mkdtempSync(join(tmpdir(), "xbb-cloud-test-"));
const prevHome = process.env.XBB_HOME;
process.env.XBB_HOME = dir;

afterAll(() => {
  // 注意：赋 undefined 会变成字符串 "undefined"，必须 delete
  if (prevHome === undefined) delete process.env.XBB_HOME;
  else process.env.XBB_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

const cfg = (over: Partial<CloudConfig> = {}): CloudConfig => ({
  apiBase: "https://api.example.test",
  key: "xbb_live_aaaaaaaabbbbbbbb",
  orgId: "org-aaaa",
  orgName: "个人空间",
  orgKind: "personal",
  spaceId: null,
  deviceName: "test-device",
  boundAt: "2026-10-06T00:00:00.000Z",
  ...over,
});

/** 「启动时」的未绑定快照 */
const UNBOUND: CloudStamp = { bound: false, sig: "", orgLabel: "", orgId: "", apiBase: "", mtimeMs: 0, size: 0 };

describe("模式软开关 (enabled)：本地/云端一键切换", () => {
  const raw = () => JSON.parse(readFileSync(join(dir, "cloud.json"), "utf8")) as CloudConfig;

  test("老配置没有该字段 ⇒ 视为云端模式（向后兼容，不能把存量用户踢回本地）", () => {
    clearCloudConfig();
    saveCloudConfig(cfg());
    expect(raw().enabled).toBeUndefined();
    expect(loadCloudConfig()?.key).toBe(cfg().key);
  });

  test("软关后 loadCloudConfig() 返回 null ⇒ 消费方自动回落本地模式", () => {
    saveCloudConfig(cfg());
    expect(setCloudEnabled(false)).toBe(true);
    expect(loadCloudConfig()).toBeNull();
    expect(loadCloudConfigRaw()?.key).toBe(cfg().key); // raw 仍读得到，供管理页展示
  });

  test("软关不删密钥：文件在、key 原样 —— 这是与 xbb unbind 的实质分野", () => {
    saveCloudConfig(cfg());
    setCloudEnabled(false);
    expect(raw().key).toBe(cfg().key);
    expect(raw().enabled).toBe(false);
    // 切回来 key 还在 ⇒ 不必回控制台重新生成 ticket（"便捷切换"成立的前提）
    expect(setCloudEnabled(true)).toBe(true);
    expect(loadCloudConfig()?.key).toBe(cfg().key);
  });

  test("软关时 cloudStamp 视为未绑定（否则在跑的 MCP 会以为还在云端）", () => {
    saveCloudConfig(cfg());
    setCloudEnabled(false);
    const s = cloudStamp();
    expect(s.bound).toBe(false);
    expect(s.sig).toBe("");
  });

  test("软关 → 再启用：sig 与原来完全一致，不误报「绑定已变化」", () => {
    saveCloudConfig(cfg());
    const before = cloudStamp().sig;
    setCloudEnabled(false);
    setCloudEnabled(true);
    expect(cloudStamp().sig).toBe(before);
  });

  test("无配置时返回 false（调用方据此引导先绑定，而不是静默假装切换成功）", () => {
    clearCloudConfig();
    expect(setCloudEnabled(false)).toBe(false);
    expect(setCloudEnabled(true)).toBe(false);
  });

  test("orgId 允许为空串（手动填 key 的降级形态）也照样生效", () => {
    saveCloudConfig(cfg({ orgId: "" }));
    expect(loadCloudConfig()).not.toBeNull();
    expect(cloudStamp().bound).toBe(true);
  });

  test("漂移提示：软关时点明「仍以云端模式运行」，且 orgId 为空不印空括号", () => {
    saveCloudConfig(cfg({ orgId: "" }));
    const boot = cloudStamp();
    setCloudEnabled(false);
    const msg = bindingDriftMessage(boot, cloudStamp());
    expect(msg).toBeTruthy();
    expect(msg!).toContain("仍以【云端模式】运行");
    expect(msg!).not.toContain("（）");
  });
});

describe("cloudStamp（绑定判定性指纹）", () => {
  test("未绑定 → bound=false / sig 空", () => {
    clearCloudConfig();
    const s = cloudStamp();
    expect(s.bound).toBe(false);
    expect(s.sig).toBe("");
  });

  test("绑定后 bound=true，同内容 sig 稳定（可做相等性比对）", () => {
    saveCloudConfig(cfg());
    const a = cloudStamp();
    const b = cloudStamp();
    expect(a.bound).toBe(true);
    expect(a.sig).not.toBe("");
    expect(a.sig).toBe(b.sig);
    expect(a.orgLabel).toBe("个人空间");
    expect(a.orgId).toBe("org-aaaa");
  });

  test("换 key → sig 变化（同一组织换凭据也算变更）", () => {
    saveCloudConfig(cfg());
    const before = cloudStamp();
    saveCloudConfig(cfg({ key: "xbb_live_ccccccccdddddddd" }));
    expect(cloudStamp().sig).not.toBe(before.sig);
  });

  test("换组织 → sig 变化", () => {
    saveCloudConfig(cfg({ orgId: "org-aaaa" }));
    const before = cloudStamp();
    saveCloudConfig(cfg({ orgId: "org-bbbb" }));
    expect(cloudStamp().sig).not.toBe(before.sig);
  });

  test("sig 不泄露 key 明文（只出摘要）", () => {
    saveCloudConfig(cfg());
    const s = cloudStamp();
    expect(s.sig).not.toContain("xbb_live");
    expect(s.sig).not.toContain("aaaaaaaabbbbbbbb");
    expect(s.sig.length).toBe(16);
  });
});

describe("bindingDriftMessage（给 AI 的变更提示）", () => {
  test("一致 → 无提示", () => {
    saveCloudConfig(cfg());
    const boot = cloudStamp();
    expect(bindingDriftMessage(boot, cloudStamp())).toBeNull();
  });

  test("一直未绑定 → 无提示", () => {
    clearCloudConfig();
    expect(bindingDriftMessage(UNBOUND, cloudStamp())).toBeNull();
  });

  test("未绑 → 已绑：点明仍在本地模式 + 要重启", () => {
    clearCloudConfig();
    saveCloudConfig(cfg({ orgId: "org-aaaa" }));
    const msg = bindingDriftMessage(UNBOUND, cloudStamp());
    expect(msg).toBeTruthy();
    expect(msg!).toContain("仍以【本地模式】运行");
    expect(msg!).toContain("不会同步到云端组织");
    expect(msg!).toContain("重启 AI 客户端");
  });

  test("已绑 → 解绑：点明仍在云端模式", () => {
    saveCloudConfig(cfg());
    const boot = cloudStamp();
    clearCloudConfig();
    const msg = bindingDriftMessage(boot, cloudStamp());
    expect(msg!).toContain("仍以【云端模式】运行");
    expect(msg!).toContain("重启 AI 客户端");
  });

  test("换组织：点明仍连着旧组织（不是新组织），且新旧可区分", () => {
    saveCloudConfig(cfg({ orgId: "org-aaaa" }));
    const boot = cloudStamp();
    saveCloudConfig(cfg({ orgId: "org-bbbb" }));
    const msg = bindingDriftMessage(boot, cloudStamp());
    // 展示名可能被 orgDisplayName 归一（personal → 「个人空间」），故 id 必须在新旧两处都出现
    expect(msg!).toContain("切换到");
    expect(msg!).toContain("旧组织");
    expect(msg!).toContain("org-aaaa");
    expect(msg!).toContain("org-bbbb");
  });

  test("解绑后重新绑回同一组织 → 视为一致，不提示", () => {
    saveCloudConfig(cfg());
    const boot = cloudStamp();
    clearCloudConfig();
    saveCloudConfig(cfg());
    expect(bindingDriftMessage(boot, cloudStamp())).toBeNull();
  });
});

describe("consoleBase（confirm_url 的站点推导）", () => {
  test("api.X → console.X（保留协议）", () => {
    delete process.env.XBB_CONSOLE_BASE;
    expect(consoleBase("https://api.xiaobenben.net")).toBe("https://console.xiaobenben.net");
    expect(consoleBase("http://api.example.test")).toBe("http://console.example.test");
  });

  test("推不出 console 域名 → null（宁可不给链接，也绝不伪造点不开的地址）", () => {
    delete process.env.XBB_CONSOLE_BASE;
    expect(consoleBase("https://example.test/api")).toBeNull();
    expect(consoleBase("http://localhost:8787")).toBeNull();
    expect(consoleBase("not-a-url")).toBeNull();
  });

  test("XBB_CONSOLE_BASE 覆盖（自建部署），且去掉尾部斜杠", () => {
    process.env.XBB_CONSOLE_BASE = "http://localhost:5174/";
    try {
      expect(consoleBase("https://api.xiaobenben.net")).toBe("http://localhost:5174");
    } finally {
      delete process.env.XBB_CONSOLE_BASE;
    }
  });
});

// 成员目录夹具：刻意放两位同名「张三」——同名同事只能靠空间名区分，这正是最易出错的一处
const MEMBERS: MemberInfo[] = [
  { id: "0198a7de-0000-9000-0000-0000000000a1", name: "张三", space: "研发部", tags: ["dev"] },
  { id: "0198a7de-0000-9000-0000-0000000000b2", name: "张三", space: "市场部", tags: [] },
  { id: "0198a7de-0000-9000-0000-0000000000c3", name: "李四", space: "研发部", tags: [] },
];

describe("resolveRecipients（名字 / uuid → 确定的成员身份）", () => {
  test("uuid 直通（命中目录）", () => {
    expect(resolveRecipients([MEMBERS[2].id], MEMBERS)).toEqual([{ id: MEMBERS[2].id, name: "李四" }]);
  });

  test("uuid 不在目录 → 报错（不猜、不静默）", () => {
    expect(() => resolveRecipients(["0198a7de-0000-9000-0000-0000000000ff"], MEMBERS)).toThrow(
      /不在本组织在职成员/,
    );
  });

  test("名字唯一命中", () => {
    expect(resolveRecipients(["李四"], MEMBERS)).toEqual([{ id: MEMBERS[2].id, name: "李四" }]);
  });

  test("重名 → 拒绝，并把候选（含空间名与 id）全列出来让 AI 自己选", () => {
    let msg = "";
    try {
      resolveRecipients(["张三"], MEMBERS);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("2 位同名");
    expect(msg).toContain("研发部");
    expect(msg).toContain("市场部");
    expect(msg).toContain(MEMBERS[0].id);
  });

  test("查无此人 → 报错（绝不猜一个最像的）", () => {
    expect(() => resolveRecipients(["王五"], MEMBERS)).toThrow(/没有叫「王五」/);
  });

  test("同一人（名字 + id 混写）只收一次", () => {
    expect(resolveRecipients(["李四", MEMBERS[2].id], MEMBERS)).toHaveLength(1);
  });

  test("空串 / 空白项忽略", () => {
    expect(resolveRecipients(["", "   "], MEMBERS)).toEqual([]);
  });
});
