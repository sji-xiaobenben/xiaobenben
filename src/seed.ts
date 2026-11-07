// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * 默认约束播种（代际合并补遗）。
 *
 * initDb 启动时幂等播种 11 条 system=1 默认约束（AI 行为纪律）：
 * - 逐条判定：内容精确相同 或 terms 集合重合过半（用户可在管理台编辑措辞——
 *   content 会变、terms 不变；只按内容匹配会误判缺失而重复播种）
 * - 走 writeMemory 管线保证哈希/FTS/着陆垫一致；raw=true 跳过密钥标记解析
 *   （约束文本里含 [[xbb_secret_value:]] 字面示例，不可被自己的管线处理）
 * - 删除后下次启动重建（管理台 system=1 删除保护之上的最终兜底）
 *
 * 接线点：runMcp 本地分支 + startServe（云端模式不播种；XBB_SEED=0 关闭）。
 * 不放 PersonalStore.open()——单测直接开库，不该被播种干扰。
 */
import type { Database } from "bun:sqlite";
import type { PersonalStore } from "./store";
import { writeMemory } from "./memory-write";

export const DEFAULT_DOMAIN = "小本本默认约束";

export const DEFAULT_CONSTRAINTS: { content: string; terms: string[] }[] = [
  { content: "你没有可靠的内部时钟：涉及当前时间的判断（几点了、是否过期、是否在窗口内），一律以最近一次工具响应中的 now 字段为准，禁止凭上下文推测当前时间。", terms: ["时间", "现在", "几点", "时钟", "now", "当前时间"] },
  { content: "写叮嘱（directive）时窗口只用 scope 枚举（session/today/week）交给引擎换算，禁止自行计算日期或传猜测的绝对时间。", terms: ["叮嘱", "directive", "scope", "窗口", "有效期", "日期"] },
  { content: "动手产出（写代码/做设计/画图/写文档/回正式消息）之前，先生成任务词群调用 recall_constraints 查相关长期约束，命中则必须遵守。", terms: ["约束", "constraint", "动手", "产出", "词群", "任务"] },
  { content: "检索时扩展词必须携带上下文领域词，不能只传话题名词（聊钓鱼时问'那下雨天呢'要带钓鱼/出钓/打窝）。", terms: ["检索", "search", "词群", "领域词", "消歧"] },
  { content: "写记忆必须带 5-15 个 terms（同义词/上位词/场景词/领域词）和 tags；召回后在回答里自然带上时间锚（'去年3月我们聊过…'）。", terms: ["写入", "write", "terms", "tags", "时间锚"] },
  { content: "检索一轮不中先按 relatedTags 换词重搜；换词仍不中必须换入口再查，按线索挑最贴合的：有时间指涉→recall_timeline(from,to)、有明确实体→recall_topic、问某件事的来龙去脉→recall_episodes、问规矩/要求→recall_directives 或 recall_constraints、已捞到相关条目→get_related 沿边扩散。最多换 3 个入口，全部不中才如实说没记到。命中条目答不上用户的问题同样算没中，继续换入口，绝不拿近似条目凑答案，绝不编造记忆内容，绝不假装记得。", terms: ["编造", "换词", "换入口", "重查", "诚实", "兜底"] },
  { content: "主动记录纪律：对话中出现结论拍板/承诺约定/偏好表态/重要事实/修正时，以及话题收束（切换话题、用户说'先这样'、连续几轮无新信息）或响应中出现 memoryHint 提醒时，立即用 write_memory 批量记录，禁止等会话结束再补——聊得再投入也不能漏记。", terms: ["记录", "写入", "收束", "总结", "蒸馏", "memoryHint", "主动", "遗忘"] },
  { content: "检索路由：用户提到以前/上次/之前/去年等时序指涉的事，或当前话题可能与历史记忆相关时，先 search_memory 再回答；用户问的是明确实体（具体的人/物/项目）则直接 recall_topic 更快。", terms: ["检索", "以前", "上次", "历史", "召回", "路由"] },
  { content: "用户想查看/整理/删除记忆时，主动帮忙启动管理后台：在终端运行安装目录下的可执行文件加 serve 参数（Windows 示例：\"$env:USERPROFILE\\.xiaobenben\\bin\\xbb.exe\" serve；macOS/Linux：~/.xiaobenben/bin/xbb serve），让用户在浏览器打开 http://localhost:17630；告知用户关闭终端即停止，该服务与 MCP 互不影响。", terms: ["后台", "管理", "serve", "端口", "查看", "整理"] },
  { content: "记忆延续纪律：新记忆是对已有记忆的状态更新（装修完成/离职/搬家/口味变了等，旧状态当时为真、现在过时）而非全新事实时，先检索找到旧状态记忆，写入时用 supersedeIds 挂延续——引擎会把旧记忆标记为已延续，并在召回时把整条故事链随结果返回；回答现状类问题以链头（最新状态）为准，链上历史用于对比叙事；用户陈述命中链上旧状态与现状矛盾时，按时间线温和纠正（\"当时确实是X，但后来不是说了Y吗\"），不硬顶也不假装旧状态不存在。", terms: ["延续", "状态", "更新", "supersede", "旧记忆", "链", "装修", "现状", "变化"] },
  { content: "凭据纪律：密码/密钥/token 等凭据绝不以明文写入记忆——写入时把值替换为 [[xbb_secret_value:值]] 标记（文案写清用途，如\"服务器 SSH 密码\"），引擎自动摘出入箱换成编号；召回结果里只会有编号占位符，任务确需明文时先向用户说明用途，再调 reveal_secret 取用；不小心带出编号占位符时禁止顺手查询保险箱。", terms: ["密码", "密钥", "token", "凭据", "secret", "保险箱", "reveal", "脱敏", "账号"] },
];

/** 播种判定（逐条）：返回库中尚不存在的默认约束 */
export function missingDefaultConstraints(db: Database): typeof DEFAULT_CONSTRAINTS {
  const rows = db.prepare(`
    SELECT GROUP_CONCAT(t.term) AS terms
    FROM memories m JOIN memory_terms t ON t.memory_id = m.id
    WHERE m.system = 1 AND m.deleted_at IS NULL
    GROUP BY m.id
  `).all() as Array<{ terms: string | null }>;
  return DEFAULT_CONSTRAINTS.filter((c) => {
    const wanted = new Set(c.terms);
    const exists = rows.some((r) => {
      const have = new Set(String(r.terms || "").split(","));
      let shared = 0;
      for (const t of wanted) if (have.has(t)) shared++;
      return shared >= Math.ceil(wanted.size / 2);
    });
    return !exists;
  });
}

/** 幂等播种：只补缺失条目；返回补种条数 */
export async function seedDefaultConstraints(store: PersonalStore): Promise<number> {
  const missing = missingDefaultConstraints(store.db);
  for (const c of missing) {
    const r = await writeMemory(
      store,
      {
        content: c.content,
        type: "procedure",
        kind: "constraint",
        domain: DEFAULT_DOMAIN,
        terms: c.terms,
        tags: ["小本本默认约束"],
        raw: true,
      },
      { actor: "xiaobenben@engine" },
    );
    store.db.prepare("UPDATE memories SET system = 1 WHERE id = ?").run(r.id);
  }
  return missing.length;
}
