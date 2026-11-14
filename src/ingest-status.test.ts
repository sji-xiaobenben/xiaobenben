// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 「原话层有没有人在采」这件事的判定与话术。
 *
 * 这一组的价值不在"新代码上绿"，而在于**把它放回 0.4.54 的代码上一定红**：
 * 那时握手指令对所有宿主都说同一句「原话层由引擎自动采集，你不要去调 log_episodes」，
 * 而 npx 用户根本没有常驻服务 ⇒ 原话层永远空、零报错。
 *
 * 特别注意：握手里这句话出现了**两次**（记录纪律段 + 原话回跳段），
 * 只替换一处会留下"两套相反指令"，AI 会挑轻松的执行 —— 所以下面成对断言。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  EPISODE_RULE_AUTO,
  EPISODE_RULE_AUTO_SHORT,
  applyIngestMode,
  episodeRule,
  probeIngestMode,
  type IngestMode,
} from "./ingest-status";

const mpSrc = readFileSync(new URL("./mcp.ts", import.meta.url), "utf8");

/** 一份"两处锚点都在"的样本，最接近真实握手指令的形状 */
const FULL = `开头${EPISODE_RULE_AUTO}中间${EPISODE_RULE_AUTO_SHORT}调时带 sessionId…`;

/** 任何形态的"引擎自动采集"表述都算残留 */
const AUTO_CLAIM = "由引擎自动采集";

describe("握手指令按事实下发", () => {
  test("auto 是逐字节原样返回：默认路径一个字符都不许动", () => {
    expect(applyIngestMode(FULL, "auto")).toBe(FULL);
  });

  test("absent：两处都改掉，且首尾内容不被吃掉", () => {
    const out = applyIngestMode(FULL, "absent");
    expect(out).not.toContain(AUTO_CLAIM); // 长锚点和短锚点都必须消失
    expect(out).toContain("必须每轮调 log_episodes");
    expect(out).toContain("你必须每轮上报");
    expect(out).toContain("开头");
    expect(out).toContain("中间");
    expect(out).toContain("调时带 sessionId…"); // 后半句必须接得上
    expect(out).not.toContain("覆盖上文"); // 两处都命中，不该触发降级
  });

  test("paused：不拿 log_episodes 绕用户的开关", () => {
    const out = applyIngestMode(FULL, "paused");
    expect(out).not.toContain(AUTO_CLAIM);
    expect(out).toContain("被用户关掉");
    expect(out).not.toContain("必须每轮调 log_episodes");
    expect(out).toContain("不要主动上报");
  });

  test("三态话术两两不同（合并任何两态 = 把一类用户当另一类）", () => {
    const seen = new Set<string>();
    for (const m of ["auto", "paused", "absent"] as IngestMode[]) {
      const r = episodeRule(m);
      expect(seen.has(r)).toBe(false);
      seen.add(r);
    }
    expect(seen.size).toBe(3);
  });

  test("只缺短锚点也降级 —— 不许只改一半就收工", () => {
    const half = `开头${EPISODE_RULE_AUTO}结尾`;
    const out = applyIngestMode(half, "absent");
    expect(out).toContain("覆盖上文");
    expect(out).toContain("必须每轮调 log_episodes");
  });

  test("文案整体漂移时追加覆盖段，而不是抛错炸掉握手", () => {
    const drifted = "锚点被改掉了，这句话找不到了";
    const out = applyIngestMode(drifted, "absent");
    expect(out.startsWith(drifted)).toBe(true);
    expect(out).toContain("覆盖上文");
    expect(out).toContain("必须每轮调 log_episodes");
  });
});

describe("锚点与 mcp.ts 保持逐字一致（防止静默失效）", () => {
  test("两个锚点在 mcp.ts 里各出现且只出现一次", () => {
    expect(mpSrc.split(EPISODE_RULE_AUTO).length - 1).toBe(1);
    expect(mpSrc.split(EPISODE_RULE_AUTO_SHORT).length - 1).toBe(1);
  });

  test("createMcpServer 确实经过 applyIngestMode（调用被删则这里红）", () => {
    expect(mpSrc).toContain("applyIngestMode(MCP_INSTRUCTIONS");
  });
});

describe("probeIngestMode 三态判定", () => {
  test("没有常驻服务 → absent", async () => {
    const s = await probeIngestMode({ serveAlive: async () => false, enabled: () => true });
    expect(s.mode).toBe("absent");
    expect(s.detail.length).toBeGreaterThan(0);
  });

  test("服务在跑 + 采集开 → auto", async () => {
    const s = await probeIngestMode({ serveAlive: async () => true, enabled: () => true });
    expect(s.mode).toBe("auto");
  });

  test("服务在跑 + 用户关了采集 → paused", async () => {
    const s = await probeIngestMode({ serveAlive: async () => true, enabled: () => false });
    expect(s.mode).toBe("paused");
  });

  test("探测抛错 → absent（保守方向是让 AI 多报，不是少报）", async () => {
    const s = await probeIngestMode({
      serveAlive: async () => {
        throw new Error("端口探不通");
      },
      enabled: () => true,
    });
    expect(s.mode).toBe("absent");
  });

  test("读开关抛错 → 按默认开（与 ingest-job 口径一致）", async () => {
    const s = await probeIngestMode({
      serveAlive: async () => true,
      enabled: () => {
        throw new Error("ingest.json 是半截 JSON");
      },
    });
    expect(s.mode).toBe("auto");
  });
});
