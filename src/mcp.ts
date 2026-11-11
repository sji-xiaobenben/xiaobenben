// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * MCP stdio 服务（本地 AI 宿主的接入面）。
 * 工具 description 英文（写入路由靠 AI 宿主意图判断）。
 *
 * 工具面沿用既有设计：
 *   write_memory(合并deliver) / search_memory(合并recall) / recall_topic / recall_timeline /
 *   recall_session / get_memory / get_related / recall_directives / recall_constraints /
 *   reveal_secret ＋ inbox / ack / forget / stats ＋ get_asset（取货）
 * 本地模式全量；云端模式语义降级（write_memory→deliver 透传 / search_memory→recall 词群拼接 /
 * 其余返回结构化 unsupported 提示）。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Backend, CloudStamp } from "./cloud";
import { gen1Unsupported, cloudStamp, bindingDriftMessage, loadCloudConfig } from "./cloud";
import { createHash } from "node:crypto";
import { VERSION } from "./build-meta";
import { localNow } from "./memory-write";
import { MAX_ATTACHMENTS } from "./payloads";
import { prepareNotice, type PendingUpdate } from "./update-notice";

// ── 写入静默检测（引擎唯一可信的"聊嗨未记"信号：
//    只用调用序列+时钟，不接触对话内容。播种的默认约束第 7 条引用 memoryHint 字段。）
//    2026-10-24：两层记忆分开计水位。原话层（log_episodes）本该每轮都动，如果拿它当"写过"就会
//    把摘要层的沉默一起掩盖；反过来，每轮都动会推高 callsSinceWrite，阈值必须放宽，否则变成
//    「每 3 轮骂一次没写摘要」的噪音，反而逼 AI 乱写摘要污染库。──
const sessionState = {
  callsSinceWrite: 0,
  lastWriteAt: Date.now(),
  lastHintAt: -99,
  lastEpAt: Date.now(),
};

function memoryHint(): string | undefined {
  const minutes = Math.floor((Date.now() - sessionState.lastWriteAt) / 60000);
  const gap = sessionState.callsSinceWrite - sessionState.lastHintAt;
  // 每轮通常 2 次调用（search_memory + log_episodes）⇒ 10 次约等于 5 轮
  const triggered = sessionState.callsSinceWrite >= 10 || (sessionState.callsSinceWrite >= 2 && minutes >= 10);
  if (triggered && gap >= 3) {
    sessionState.lastHintAt = sessionState.callsSinceWrite;
    const epSilentMin = Math.floor((Date.now() - sessionState.lastEpAt) / 60000);
    const epNote =
      epSilentMin >= 10
        ? `；另外已 ${epSilentMin} 分钟没有 log_episodes——原话层断档是永久性损失（蒸馏记忆补得出摘要，补不出当时怎么说的），请立刻补上这几轮的用户原话与你的回复。`
        : "";
    return `本会话已 ${sessionState.callsSinceWrite} 次工具交互 / ${minutes} 分钟没有写入蒸馏记忆：请检查本段对话中有无值得记录的决策/承诺/偏好/事实/指令，有则在话题收束时用 write_memory 批量记录；确无可记内容可忽略本提示${epNote}`;
  }
  return undefined;
}

/** MCP initialize 下发的行为契约（含 episodes/向量增补）——
 *  AGENTS.md 只管敲门，真正的行为纪律由引擎随握手自动下发，宿主无关。 */
const MCP_INSTRUCTIONS = `这是用户的本地长期记忆库（小本本）。【启动仪式】新会话开始后先调一次 recall_directives：返回的习惯/叮嘱/约束本会话全程必须遵守，其中的 now 是权威时间（你没有可靠的内部时钟，一切时间判断以它为准），晋升就绪(promotionReady)非空时需询问用户是否把相似叮嘱蒸馏为长期习惯。【记录纪律·两层分工】记忆分两层，**都要，各管各的**：**摘要层**（write_memory）是蒸馏后的事实/决策/偏好，可被检索、喂给未来的自己；**原话层**（log_episodes）是逐句原文，只在需要"当时到底怎么说的"时翻出来。摘要层：出现决策/承诺/偏好/事实/修正时写，话题收束（用户拍板/切换话题/说'先这样'/连续无新信息）时必须检查一遍、有新结论就写、不等会话结束（**没有新结论就不要为凑数而写**）；工具响应里的 memoryHint 是引擎的静默提醒，出现时回头检查本段有无漏写的摘要。原话层：**由引擎自动采集**（见【原话回跳】），你不必每轮上报。两层的关系是——摘要让人找得到，原话让人信得过；任何一层断了，另一层都救不回来。**摘要层只写"原话里翻不到的东西"，判据一句话：这条记忆 3 个月后还有用吗？能从原话层直接翻到的就别写。** 具体说，**禁止复述对话**——"用户问了X/我答了Y/我改了某个文件/用户让我继续"这类流程记录一律不写：原文已在原话层，再写一遍既是重复又污染检索。**必写的是原话里永远不会有一句话明说的三类**：①结论与取舍（定了什么、为什么否掉另一个方案）；②跨会话的规律（同一句叮嘱出现十次才成得了一条习惯）；③采不到的客户端里发生的事（原话层只覆盖本机能读到的客户端，别处的会话只有你写下来才存在）。判断一句话算不算结论，用这个问法：把它单独拎出来，三个月后换一个完全不了解上下文的 AI 看，它能不能直接照做——能，才写。【会话归属】recall_directives 返回的 sessionId 是引擎为本连接自动盖的会话章；若本次对话实际是在继续早前的同一对话（客户端重开/重连/切窗口会换连接），先检索本对话此前聊过的内容，命中记忆的 sessionId 即本对话的真实会话号——可用 recall_session 回看那场对话记录了什么，后续 write_memory 传入它以保持会话归属；全新对话则无需传。【检索·开口前先联想】每一轮回复之前，先调一次 search_memory——这是你开口前的"想一下"，不是等用户指涉过去才查（原先的条件式触发会让记忆只在被点名时出现，等于没有联想）。query 传本轮会话内容：用户这句原话完整放最前，上一轮你自己回复的要点接在后面（向量通道靠它做语义联想；只放半句等于对方话说一半，语义通道就废了）。terms 传扩展词群（词法三路靠它，必须携带当前对话的上下文领域词，不能只传话题名词——引擎靠 IDF 加权消歧）。**不要判断这句话值不值得查**——附和、追问、短句、"嗯"、"继续"一样要查；联想发生在你开口之前，不发生在用户说了什么之后。命中的用得上就用，用不上就正常回答：**绝不为了展示记忆而引用记忆**，也绝不因为查到无关条目就改口风或硬扯关系。**每轮预检查空是常态**——那不代表"库里没有"，只是本轮没对上，正常回答即可，不要向用户播报"没查到记忆"（只有用户明确追问过去的事、且按【查不到就换路】换过入口仍空，才如实说没记到）。具体名词直接调 recall_topic 更快，但 query 仍要继续给——**绝不要把词群塞进 query、也不要把原句塞进 terms**。【查不到就换路】换词重搜仍不中时必须换入口而不是重复同一个工具，按线索挑最贴合的：时间指涉→recall_timeline(from,to)、明确实体→recall_topic、事件来龙去脉→recall_episodes、规矩要求→recall_directives 或 recall_constraints、已有相关条目→get_related；最多换 3 个入口，全不中才如实说没记到。近似条目答不上用户的问题也算没中，绝不拿近似条目凑答案、绝不编造。【产出前查约束】动手写代码/做设计/写文档之前，用任务词群调 recall_constraints，命中域的约束必须遵守。【状态更新】当新信息推翻了旧状态（口味变了/装修完成/方案改了/换了供应商/地址变更），**写入前必须先检索**（search_memory 或 recall_topic）定位旧状态记忆，把它的 id 放进 write_memory 的 supersedeIds——新旧两条**绝不允许各自为链头并存**（回答现状一律以链头为准）。若这次已经漏挂：写入响应的 supersedeCandidates 会列出同空间内词群高度重叠的旧状态记忆，用 supersede 工具补链即可（headId=新的那条、supersededIds=旧的）；**链漏了可以补，但不要靠"再写一条"来覆盖**。【通知同事】用户说"通知/告诉/指派/提醒某人"时，**先调 list_members 取准确的名字或 id**——绝不可凭印象编造同事名字（查无此人会让整笔写入失败，重名则会被要求补 id）。然后把名字放进 write_memory 的 notify[]：这会投递一条**待签收凭证**进对方收件箱（隐含 needsAck）。返回值带 confirmUrl（对方签收页深链）与 hint（建议话术）——你若恰有发消息的能力（宿主挂了钉钉/企微等）可顺手转发；没有就如实告诉用户"已投递，对方下次用自己的 AI 时会看到"，**绝不可谎称已发过消息**。本地模式没有组织成员，notify 会被明确拒绝。【写入】对话中出现决策/承诺/偏好/事实/修正时用 write_memory items[] 批量记录；用户立规矩/叮嘱/强烈品味表态时写指令类（kind=directive 必带 dscope，kind=constraint 必带 domain，kind=habit 由用户确认后写）；状态更新见上文【状态更新】（写入前先检索旧状态、带上 supersedeIds）；terms 必填 5-15 个扩展词，含领域词。【文件】用户说"记住这个文件/这张图"并给了本机路径时，用 write_memory 的 items[].attachments[{ref,mime?,description?,tags?}] 把文件**真正挂上**（ref 必须是本机绝对路径；只有字节没有路径——例如用户粘贴的图——就**先存成文件再传路径**，本工具不收内联字节）。description 要**细述**文件里到底有什么：展开写，不要压成一句话。**用户给的是图片、照片、视频、截图这类有画面的文件时，description 不是"记一句内容"，而是一份能照着复刻的视觉提示词**：此刻你要像一位有二十年好莱坞经验的导演、分镜师兼 AI 视觉提示词专家，精通构图、光影、色彩、画风、风格、字体、镜头语言与动作连贯性，也知道怎么向图像/视频生成模型下精确的控制指令。**摒弃"堆标签词"那套反推法**，改为按【画面结构】逐层拆解：景别与机位（俯/仰/平、焦段感、景深）、主体与画面分割（主体位置、前中后景层次、留白与重心）、光影（光源方向、软硬、色温、明暗反差）、色彩（主色/辅色、影调、饱和度与质感）、画风与介质（写实/胶片/插画/3D，颗粒与噪点）、文字与排版（截图类必须写清界面结构、层级、字体风格与字号落差）；视频再按【时间线】拆：镜头切分、每段的时间区间与动作、运镜（推拉摇移跟）、转场方式、主体动作的连贯与因果。拆完再合成一段可直接下给生成模型的提示词。判断标准只有一条：**另一个 AI 只看这段文字，就能复刻出同一张图/同一段视频**——写不到这个程度就是没写够。附件不进全文索引，这段文字是它**唯一的检索入口**；同字节文件全库只描述一次并共用，所以要独立成文（别写"上面那张图"）。文件挂不上**不会**让记忆写入失败，响应里的 droppedAttachments（云端为 payloadsDropped）会列出没进去的那些，**照实告诉用户哪个文件没进**。**绝不用文字代替文件**：附件被拒时不要拿文件的技术参数（编码/容器/分辨率/时长/体积/EXIF）去填 content 或 description——那既污染记忆（检索不到），又让用户以为文件已经存下了；正确且唯一诚实的做法是直说"这个文件没挂上"然后停手。【取货】检索命中带 payloads[] 提货单（{id,mime,bytes,description,ref,state}，**永不含字节本身**）时，确实要看这份文件、或要把它交出去，才调 get_asset(payloadId, as:'ref'|'inline')；只读 description 够用就别取。state：ok=没变、changed=盘上文件已变、missing=文件没了或挪了、evicted=**云端**专属（长期欠费字节被回收，记忆还在，续费后需重传）。【原话回跳·按需补记】蒸馏记忆是摘要层、episodes 是原话层，**两层缺一不可**：摘要决定"找不找得到"，原话决定"当时到底怎么说的"。**原话层由引擎自动采集**——每 5 分钟从本机客户端库直接读取（opencode / Cursor / WorkBuddy / Claude Code 已覆盖），不需要你逐轮上报，所以**不要为了"记原话"去调 log_episodes**，那只会把同一句话存第二遍。只有两种情形才调：① 用户明确要求把这段对话存档；② 你要给某个话题打标签——采集进来的原话没有 topic，只有打上标签才能按话题追溯。调时带 sessionId（用 recall_directives 返回的那个）与 topic（**优先复用上次响应里 knownTopics 的现成标签**，别自己造同义词）。响应的 sessionTurns 与 lastLine 是你的水位线，可核对这一轮是否已入库。【原话追溯】要找"当初的原话/那次怎么聊的/这个话题从头到尾/某一天聊了什么"，用 recall_transcript，三个轴：sessionId（一场对话）、date（某一天）、topic（一个话题跨天）。**先 mode='outline' 拿目录**（哪几段、各多少句、时间跨度、首句原话），再 mode='turns' 读正文；正文**必须翻页**，一次一页，用 next.cursor+next.direction 往下、prev 往回，看 hasMore 判断两头还有没有。**绝不要试图一次读完一整天或一整个话题**——那是把上下文窗口往死里塞。只记得关键词、想直接命中原话时才用 recall_episodes（FTS 碎片捞）。这套只在本地模式可用（云端无 episodes）。【可见范围】每条记忆**默认只有归属人自己可见**——绝不主动放宽。用户说"这条可以公开/给团队看"时才传 write_memory 的 audience：{org:true}=全组织，{spaces:[{spaceId,includeDescendants}]}=某部门（id 先调 list_spaces 取，只能授权到归属人自己子树内，越界整笔被拒）。指令三类（directive/habit/constraint）不适用可见范围。写入与改档的响应都回带**生效后的**档位（默认档「仅归属人」也回带）——用户问"这条别人能看到吗"一律以它为准，不要凭记忆答。事后要改某条已有记忆的范围用 set_memory_audience（**仅归属人**；非归属人会得到"查无此条"，那是刻意的，别去追问）。【归属辨别】检索命中里的 owner/mine 是归属真相：mine=false 表示这是**别人的**记忆（同事公开出来的），owner.name 就是那个人——转述时必须说清"这是张三记录的"，**绝不能当成用户自己的经历复述**；owner=null 的老记忆是组织级共享条目（无归属），同样不属于用户个人。本地模式没有第二个成员，audience 类入参一律被拒（不是静默忽略）。
【凭据】密码/密钥/token 绝不明文写入：值替换为 [[xbb_secret_value:值]] 标记由引擎自动入箱，召回里只有编号占位符；确需明文先向用户说明用途再调 reveal_secret。【绑定变更】工具响应里出现 bindingChanged 字段时，说明本机云端绑定状态已变化（新绑定/解绑/换组织）而本会话仍跑旧模式——请把该字段要点如实转达用户（当前实际读到写到哪个目标、需重启客户端才会切换），并建议其重启 AI 客户端；不要忽略、也不要含糊带过。`;

/**
 * 附件的参数说明。
 * ⚠️ **这是 MCP 面唯一能施加软约束的地方** —— 「先把文件落盘再传路径」这件事没有别的传达渠道
 * （易漏点：AI 不会用没被说过的能力，也不会猜没在描述里写过的约定）。
 */
// 单条记忆最多挂几个附件：**唯一真源在 `payloads.ts`**（本地 `admitAttachments` 的 limit 用它）。
// 这里再抄一个 10 会漂移出「描述说 10、实际只进 8」这种最难查的不一致 —— 所以是 import 不是 const。
const ATTACHMENTS_DOC = `Files to attach to this memory (max ${MAX_ATTACHMENTS} per item). Each entry: { ref, mime?, description?, tags? }.
ref MUST be an ABSOLUTE path on THIS machine. If the user pasted an image or you otherwise hold only bytes, SAVE IT TO A FILE FIRST and pass that path -- this tool never accepts inline bytes.
description is a DETAILED account of what the file actually contains -- write it out, do not compress it into one line. For visual material (images, photos, video, screenshots) it is NOT a caption but a REPRODUCTION-GRADE visual prompt: work as a film director / storyboard artist / prompt engineer with 20 years of experience -- shot size and camera angle, subject placement and foreground/midground/background layering, light direction, hardness and color temperature, palette, tonal range and texture, medium and style, and for UI shots the layout, hierarchy, typography and type scale; for video also split by shot with time ranges, camera movement, action continuity and transitions. Ban keyword-tag dumps -- decompose by image structure and, for video, by timeline, then merge into one prompt you could hand straight to a generation model. The bar: another AI reading ONLY this text must be able to reproduce the same image or the same clip. Attachments are NOT full-text indexed, so this text is the file's ONLY search entry point: the more specific it is, the better the file is found later. It is stored once per unique file and shared by every memory referencing it, so write it standalone (not "the image above").
How the bytes are kept depends on the mode: local mode registers them BY REFERENCE (sha256) and never copies them -- they stay exactly where they are; cloud mode uploads them to object storage so they survive a machine change. Either way re-attaching the same file costs nothing (content-addressed dedup).
A missing/unreadable path NEVER fails the write: that entry is skipped and listed in droppedAttachments (cloud mode reports the same list under payloadsDropped), and you should tell the user which file did not make it in.
NEVER SUBSTITUTE TEXT FOR A FILE. When an attachment is rejected or unsupported, the write still succeeds without it -- that is the intended outcome. Do NOT "compensate" by dumping the file's technical metadata (codec, container, resolution, duration, encoder version, byte size, EXIF) into content or description: that pollutes the memory with noise nobody can search for, and it makes the user believe the file was stored when it was not. The honest move is to tell the user plainly that the file did not go in, and stop.`;

export function createMcpServer(
  backend: Backend,
  opts: { updateNotice?: PendingUpdate | null; bootStamp?: CloudStamp | null; fault?: string | null } = {},
): McpServer {
  // 更新提示：新会话开头问一句「要不要更新」。
  // 走**握手指令 + recall_directives 响应**双通道：握手指令是 AI 一接入就必然读到的契约，
  // recall_directives 是会话启动仪式必调的工具——任何一条失效，另一条仍能把话带到。
  const notice = opts.updateNotice ?? null;
  // ── 库不可用（降级模式）────────────────────────────────────────────────
  // 打不开库时**不崩溃**：崩了 AI 只会说"工具不可用"，用户完全不知道发生了什么。
  // 照常握手、所有工具返回同一段可读原因，让 AI 在对话里主动转达 —— 记忆缺失必须被说出来。
  const fault = opts.fault ?? null;
  const faultRule = fault
    ? `\n【⚠️ 记忆库不可用 · 本次会话为降级模式】本机记忆库现在打不开，原因原文如下：\n${fault}\n` +
      `这意味着你**既没有历史记忆可用，也存不下任何新记忆**。请这样处理：① 在用户第一次需要记忆（开口前的联想、或问起过去的事）时，**主动如实说明**这件事，把上面这段原文转达给他（含路径与排查命令），不要等他哪天发现"你怎么什么都不记得"；② 绝不假装记得、绝不编造历史、绝不用"我这边没查到"轻描淡写带过；③ 工具会统一返回 ok:false 与同样的错误，那是同一件事，不要反复重试刷错误。`
    : "";
  const updateRule = notice
    ? `\n【更新提示】检测到小本本有新版本 v${notice.latest}（当前 v${notice.current}）。请在本会话的**第一次回复末尾**附带问一句：「发现小本本有新版本 v${notice.latest}，要更新吗？」。用户同意后：优先执行命令 \`xbb update\`；若你没有命令执行能力，就请用户点管理窗口（http://127.0.0.1:17630/ui）或托盘里的「检查更新」。更新文件就位后需重启小本本才生效，别替用户重启。用户说"以后再说/不用了"时本会话不要再提，并告诉他可以在管理窗口点「以后再说」永久关闭该提示。只问一次，不要反复追问。`
    : "";
  // 云端组织上下文（2026-10-04）：此前工具面零处提及组织，AI 无法回答「记忆写到哪个组织了」。
  // 组织名随【握手指令 + 每个工具响应】双通道下发——用户在任意时刻问，AI 都有权威答案。
  const cloud = backend.kind === "cloud" ? (backend as import("./cloud").CloudBackend).org : null;
  const orgRule = cloud
    ? `\n【组织归属】本记忆库绑定云端组织「${cloud.name}」（orgId ${cloud.id}${cloud.kind ? `，kind=${cloud.kind}` : ""}）。所有工具响应的 org 字段是当前组织的权威来源：用户问「我的记忆写到哪个组织了」「是不是写到云端个人空间了」时，直接按该字段回答，不要猜测、不要答不知道。当前为云端模式——检索类工具（recall_topic / recall_timeline / recall_session / get_memory / get_related / recall_directives / recall_constraints）与 write_memory / search_memory / inbox / ack / forget / stats 均由云端服务端直供，正常可用。**仅三类不可用**：情景层 log_episodes / recall_episodes（原话逐字冷存档设计上永不入云）、reveal_secret（云端无保险箱——凭据在写入侧已被抹成占位符，库里不存在明文）。`
    : "";
  const server = new McpServer(
    { name: "xiaobenben", version: VERSION, title: "小本本 —— 你的 AI 记忆库" },
    { instructions: MCP_INSTRUCTIONS + orgRule + updateRule + faultRule },
  );
  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

  // ── 绑定变更检测（2026-10-06 B 方案）──
  // 绑定/解绑由**独立进程**完成（console 的 xubb:// 唤起 → xbb bind，或命令行 xbb bind/unbind），
  // 它只写盘；本进程的 backend（含 isLocal / cloud / gen1 分派）全是**启动期快照**，不会自己变。
  // 两者不一致时本进程会**静默**继续用旧模式——不报错、不异常，记忆照常写，只是写错地方。
  // 这里每次工具调用拿磁盘现状与启动快照比对，不一致就在响应里挂 bindingChanged 让 AI 转达用户。
  // （把 backend 真正换成新的＝热切换，属 C 方案；本批只做"检测 + 告知"，不碰路由。）
  const bootStamp = opts.bootStamp ?? null;
  const bindingDrift = (): string | null => {
    if (!bootStamp) return null;
    try {
      return bindingDriftMessage(bootStamp, cloudStamp());
    } catch {
      return null; // 检测本身永不成为故障源
    }
  };

  const safe = async (fn: () => Promise<unknown>) => {
    try {
      // 对时纪律：每个响应统一回传 now（引擎本机时钟=唯一可信时间源），并附写入静默提醒
      sessionState.callsSinceWrite++;
      const r = (await fn()) as Record<string, unknown> | null;
      const drift = bindingDrift();
      const base = {
        ok: true,
        ...(r ?? {}),
        ...(cloud ? { org: cloud } : {}),
        ...(drift ? { bindingChanged: drift } : {}),
        now: localNow(),
      };
      const hint = memoryHint();
      return text(hint ? { ...base, memoryHint: hint } : base);
    } catch (e) {
      // 失败响应同样带组织上下文：AI 仍能说清「在哪个组织上的操作失败了」
      const drift = bindingDrift();
      return text({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        ...(cloud ? { org: cloud } : {}),
        ...(drift ? { bindingChanged: drift } : {}),
      });
    }
  };
  const local = backend as import("./cloud").LocalBackend & { kind: string };
  const isLocal = backend.kind === "local";
  const db = () => local.db;
  /** 更新提示的统一附加（本地/云端同款）：recall_directives 是本工具面唯一的"启动仪式"入口 */
  const withNotice = (r: object): object =>
    notice
      ? { ...r, update: { current: notice.current, latest: notice.latest, howTo: "xbb update，或管理窗口/托盘的「检查更新」；更新后需重启小本本" } }
      : r;
  /**
   * 工具统一分派：本地直调 memory-tools；云端走 backend 同名方法（服务端直供）。
   * **未提供 cloudFn 的才是真·云端不可用**（情景层两件 + 取密）→ 结构化 unsupported。
   */
  const gen1 = (
    tool: string,
    fn: (d: import("bun:sqlite").Database) => unknown,
    cloudFn?: () => Promise<unknown>,
  ) =>
    safe(async () => {
      if (isLocal) return (await fn(db()) as object);
      return cloudFn ? ((await cloudFn()) as object) : gen1Unsupported(tool);
    });

  // ── 写入（write_memory ⊕ deliver）──
  server.tool(
    "write_memory",
    `Store memories into the user's personal knowledge base (long-term memory across sessions/hosts/AIs).

WHEN: proactively record whenever a durable fact, decision, preference, correction, commitment, gotcha, or open TODO appears — do not wait to be asked. Also record project/topic state changes with [状态·X] prefixes in content.
NOT: never transcribe the conversation itself ("user asked X, I replied Y", "I edited file Z", progress narration). The verbatim layer (episodes) already captures every turn automatically, so a play-by-play entry is pure duplication that pollutes retrieval. Rule of thumb: if a future AI could find it by paging the transcript, don't store it — store what the transcript never says out loud (the conclusion, and the trade-off that killed the alternative).
HOW: batch 3-5 atomic items per turn via the items[] array (one fact each, origin→course→outcome). MUST include 5-15 terms (synonyms/hypernyms/scenario/domain words) — they are the retrieval landing pad. Key numbers (ports/versions/dates/thresholds) and named entities verbatim. Secrets: NEVER store plaintext — put [[xbb_secret_value:value]] marker with a clear purpose label.
TYPES: fact | preference | decision | event | procedure.
SUPERSEDE: when new info updates an old state (changed preference/plan/address), FIRST recall the old entry, then pass its id in supersedeIds — old entries join a chain; the chain head is current truth, history stays queryable. If you wrote one WITHOUT supersedeIds, the response carries supersedeCandidates (same-space, term-overlapping chain heads) — call the supersede tool to repair the chain instead of writing another entry.
LINK: pass links:[{toId,relation}] to tie THIS entry to an entry you have already seen in this session — ids come from recall results, never invent one. Direction is this→that, so read each relation as a sentence about the new entry: elaborates = it adds detail to that one; caused_by = that one is why this happened; contradicts = both stand but cannot both be true; related_to = same subject, none of the above. This is what lets future recall walk sideways: a note about "the pot we cook dinner in" links to last quarter's "rice cooker" note, which links back to the purchase decision before it. Word overlap is precisely what breaks on that path, so vector similarity will not rescue it — the edge is the only thing carrying it. Omitting links is the most common reason multi-hop recall goes quiet, and it fails silently: the entry still reads fine, it just becomes an island. Do NOT link on mere adjacency ("same conversation", "same file", "written right after") — that rebuilds the play-by-play this tool exists to avoid. Link on shared subject matter.
DIRECTIVES: kind=directive requires dscope (session/today/week — engine resolves the window); kind=constraint takes a domain (run recall_directives first to merge). Long-term rules → constraint, not directive.
UNCERTAIN: set needsAck=true rather than silently dropping. Returns id, now (the only trustworthy clock), superseded, supersedeCandidates, vaulted.
ATTACHMENTS: attach files to a memory via attachments:[{ref,mime?,description?,tags?}]. ref MUST be an absolute local path — a pasted image must be saved to a file first. Local mode registers the bytes BY REFERENCE (sha256, never copied); cloud mode UPLOADS them to object storage so they survive a machine change. Either way re-attaching the same file is free (content-addressed dedup). description is a DETAILED account of the file's contents — attachments are NOT full-text indexed, so it is the file's only search entry point. An unreadable path NEVER fails the write: it is reported in droppedAttachments (cloud: payloadsDropped) — tell the user which file did not make it in. NEVER substitute text for a file: if an attachment is rejected, do not dump its codec/resolution/duration/EXIF into content or description.
NOTIFY (cloud org mode only): pass notify:[...] with member names taken from list_members to deliver to a colleague — this implies needsAck, so the item lands in their inbox awaiting their acknowledgement. The response carries confirmUrl + a forwarding hint; never claim you sent someone a message unless you actually did.
VISIBILITY (cloud org mode only): every memory is PRIVATE to its owner by default. Pass audience:{org:true} ONLY when the user asks to share it organization-wide, or audience:{spaces:[{spaceId,includeDescendants}]} to share with specific departments (get ids from list_spaces; the anchor must lie inside the owner's own subtree or the whole write is rejected). Never widen visibility on your own initiative — a memory only becomes visible to colleagues when the user says so. The response always echoes the effective audience, so tell the user plainly when an entry stays owner-only. Not applicable to kind=directive|habit|constraint.`,
    {
      content: z.string().min(1).optional().describe("Single-item shorthand (or use items[] for batch)"),
      items: z.array(z.object({
        content: z.string().min(1),
        type: z.enum(["fact", "preference", "decision", "event", "procedure"]).optional(),
        terms: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        entities: z.array(z.string()).optional(),
        links: z.array(z.object({ toId: z.string(), relation: z.enum(["related_to", "elaborates", "caused_by", "contradicts"]) })).optional().describe("Edges from this entry to ones already seen this session (new→old). Read LINK above before deciding — no link means no sideways recall later."),
        supersedeIds: z.array(z.string()).optional(),
        occurredAt: z.string().optional(),
        occurredPrecision: z.enum(["day", "month", "year"]).optional(),
        sourceRef: z.string().optional(),
        kind: z.enum(["memory", "directive", "habit", "constraint"]).optional(),
        dscope: z.enum(["session", "today", "week", "global"]).optional(),
        domain: z.string().optional(),
        sessionId: z.string().optional(),
        needsAck: z.boolean().optional(),
        notify: z.array(z.string()).optional(),
        audience: z.object({
          org: z.boolean().optional(),
          spaces: z.array(z.object({ spaceId: z.string(), includeDescendants: z.boolean().optional() })).optional(),
        }).optional(),
        attachments: z.array(z.object({
          ref: z.string().min(1),
          mime: z.string().optional(),
          description: z.string().optional(),
          tags: z.array(z.string()).optional(),
        })).max(MAX_ATTACHMENTS).optional().describe(ATTACHMENTS_DOC),
      })).min(1).max(10).optional().describe("Batch write: 3-5 atomic items per turn (批量协议)"),
      type: z.enum(["fact", "preference", "decision", "event", "procedure"]).optional().describe("Memory type (single-item form)"),
      terms: z.array(z.string()).optional().describe("5-15 expansion words: synonyms/hypernyms/scenario/domain terms (retrieval landing pad — REQUIRED for good recall)"),
      tags: z.array(z.string()).optional(),
      entities: z.array(z.string()).optional().describe("Named entities (person/project/concept) — enables recall_topic clustering"),
      links: z.array(z.object({ toId: z.string(), relation: z.enum(["related_to", "elaborates", "caused_by", "contradicts"]) })).optional().describe("Edges from this entry to ones already seen this session (new→old); see LINK in the tool description"),
      supersedeIds: z.array(z.string()).optional().describe("Old memory ids this entry replaces (state-update chain)"),
      occurredAt: z.string().optional().describe("When it happened: YYYY-MM-DD or with time"),
      occurredPrecision: z.enum(["day", "month", "year"]).optional(),
      sourceRef: z.string().optional().describe("Optional source path/URL"),
      kind: z.enum(["memory", "directive", "habit", "constraint"]).optional().describe("directive=short-term reminder (needs dscope), constraint=long-term rule (needs domain)"),
      dscope: z.enum(["session", "today", "week", "global"]).optional().describe("directive window scope — engine resolves absolute times, never compute dates yourself"),
      domain: z.string().optional().describe("constraint domain (check recall_directives first to merge)"),
      sessionId: z.string().optional(),
      needsAck: z.boolean().optional().describe("true = AI suggestion pending user confirmation (goes to inbox)"),
      notify: z.array(z.string()).optional().describe("Recipients to notify: member names or ids from list_members (IMPLIES needsAck — they must acknowledge). Cloud org mode only; local mode rejects it rather than silently dropping."),
      audience: z.object({
        org: z.boolean().optional(),
        spaces: z.array(z.object({ spaceId: z.string(), includeDescendants: z.boolean().optional() })).optional(),
      }).optional().describe(
        "Visible scope. Omit = owner-only (the default; never widen it on your own initiative). {org:true} = whole organization; {spaces:[{spaceId,includeDescendants}]} = specific departments (ids from list_spaces, must be inside your own subtree). kind=memory only. Cloud org mode only; local mode rejects it rather than silently dropping.",
      ),
      attachments: z.array(z.object({
        ref: z.string().min(1),
        mime: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
      })).max(MAX_ATTACHMENTS).optional().describe(ATTACHMENTS_DOC),
    },
    async (a) =>
      safe(async () => {
        if (!isLocal) {
          // ── 文件载荷：云端**已支持** —— 先把字节传到对象存储，再拿 payloadId 挂载 ──
          //
          // 与本地模式的根本差别：本地只记引用（绝对路径 + sha256，字节留在原位置）；
          // 云端必须把字节搬上去，否则换台设备就没了。两段式（prepare → PUT）在云端侧完成，
          // 这里只负责"逐个上传 → 收集 payloadId"。
          //
          // ⚠️ 降级铁律同本地：**附件进不去不让记忆失败**。上传失败的项进 `payloadsDropped`
          //    如实回执，绝不静默，也绝不因为一个附件挂不上就让整条记忆写不进去。
          const uploadAll = async (
            atts?: { ref: string; mime?: string; description?: string; tags?: string[] }[],
          ): Promise<{ ids: string[]; dropped: { ref: string; reason: string }[] }> => {
            const ids: string[] = [];
            const dropped: { ref: string; reason: string }[] = [];
            for (const [i, att] of (atts ?? []).entries()) {
              if (i >= MAX_ATTACHMENTS) {
                dropped.push({ ref: att.ref, reason: "too_many" });
                continue;
              }
              try {
                const up = await backend.uploadPayload({ ref: att.ref, mime: att.mime, description: att.description, tags: att.tags });
                ids.push(up.payloadId);
              } catch (err) {
                dropped.push({ ref: att.ref, reason: err instanceof Error ? err.message : "upload_failed" });
              }
            }
            return { ids, dropped };
          };

          // 云端**全量元数据透传**：type/terms/entities/links/supersedeIds 等
          // 原样交给服务端落库（此前是把 terms 编成 `term:` 前缀塞进 tags 的权宜之计，现已取消）。
          if (a.items?.length) {
            const results = [];
            for (const it of a.items) {
              const up = await uploadAll(it.attachments);
              const rec = await backend.deliver({ ...it, ...(up.ids.length ? { payloadIds: up.ids } : {}) });
              results.push({
                ...rec,
                ...(up.ids.length ? { payloadsAttached: up.ids.length } : {}),
                ...(up.dropped.length ? { payloadsDropped: up.dropped } : {}),
              });
            }
            return { results };
          }
          const up = await uploadAll(a.attachments);
          const rec = await backend.deliver({
            content: a.content!,
            type: a.type,
            terms: a.terms,
            tags: a.tags,
            entities: a.entities,
            occurredAt: a.occurredAt,
            occurredPrecision: a.occurredPrecision,
            sourceRef: a.sourceRef,
            kind: a.kind,
            dscope: a.dscope,
            domain: a.domain,
            sessionId: a.sessionId,
            links: a.links,
            supersedeIds: a.supersedeIds,
            needsAck: a.needsAck,
            notify: a.notify,
            audience: a.audience,
            ...(up.ids.length ? { payloadIds: up.ids } : {}),
          });
          return {
            ...rec,
            ...(up.ids.length ? { payloadsAttached: up.ids.length } : {}),
            ...(up.dropped.length ? { payloadsDropped: up.dropped } : {}),
          };
        }
        // notify（指定收件人）在本地无意义：单机个人库没有第二个成员。
        // **显式拒绝而非静默丢弃**——静默丢弃会让 AI 以为"通知已发出"，而对方什么都收不到。
        const notifyCount =
          (a.notify?.length ?? 0) + (a.items ?? []).reduce((n, it) => n + (it.notify?.length ?? 0), 0);
        if (notifyCount > 0) {
          throw new Error(
            "notify（指定收件人）只在云端组织模式下可用：本地是单机个人记忆库，没有其他成员。请先 `xbb cloud bind` 并重启 AI 客户端，或在云端控制台的记忆库里投递。",
          );
        }
        // 可见范围同理，但**只拒"放宽"**：`{org:true}` 与带空间锚的都是放宽语义（本地做不到）；
        // `{org:false, spaces:[]}` 是"恢复仅归属人"，本地本来就是这个状态 → 幂等放行，不无谓报错。
        const widens = (x?: { org?: boolean; spaces?: unknown[] }) =>
          x?.org === true || (x?.spaces?.length ?? 0) > 0;
        const audienceWidenCount =
          (widens(a.audience) ? 1 : 0) + (a.items ?? []).reduce((n, it) => n + (widens(it.audience) ? 1 : 0), 0);
        if (audienceWidenCount > 0) {
          throw new Error(
            "audience（可见范围）只在云端组织模式下可用：本地是单机个人记忆库，没有其他成员能读到它，公开无对象。请先 `xbb cloud bind` 并重启 AI 客户端。",
          );
        }
        const { writeMemory } = await import("./memory-write");
        const store = (backend as import("./cloud").LocalBackend).personalStore;
        if (a.items?.length) {
          if (a.content) return { ok: false, error: "content 与 items 二选一，不要混用" };
          const results = [];
          for (const it of a.items) {
            results.push(await writeMemory(store, it as never, {}));
          }
          // 写入后清零静默计数（memoryHint 状态机）
          sessionState.callsSinceWrite = 0;
          sessionState.lastWriteAt = Date.now();
          const fresh = results.filter((r) => !r.deduped).length;
          const rejected = results.flatMap((r) => r.supersedeRejected ?? []);
          const vaulted = results.flatMap((r) => r.vaulted ?? []);
          const cands = results.flatMap((r) => r.supersedeCandidates ?? []);
          const summary = `写入 ${fresh} 条新记忆，${results.length - fresh} 条去重合并`
            + (results.some((r) => (r.superseded ?? []).length) ? `，延续生效：${results.flatMap((r) => r.superseded ?? []).join(",")}` : "")
            + (vaulted.length ? `；凭据已入保险箱：${vaulted.join(",")}（文案已换成编号占位符）` : "")
            + (cands.length ? `；发现 ${cands.length} 条同话题的旧记忆（候选链头 ${cands.map((c) => c.id).join(",")}）——若其中有本条推翻的旧状态，用 supersede 补链（headId=本条 id）` : "")
            + (rejected.length ? `；${rejected.length} 条延续被拒（${rejected.map((x) => `#${x.id}: ${x.reason}`).join("；")}）——状态更新请改挂链头，新事实请用 links 关联` : "");
          return { results, summary, ids: results.map((r) => r.id), now: results[0]?.now ?? new Date().toISOString(), count: results.length };
        }
        sessionState.callsSinceWrite = 0;
        sessionState.lastWriteAt = Date.now();
        return (await writeMemory(store, a as never, {})) as object;
      }),
  );

  // ── 检索（search_memory ⊕ recall）──
  server.tool(
    "search_memory",
    `Search past memories. Call this ONCE BEFORE EVERY REPLY — not only when the user refers to previous conversations ("what did I say about..."), but also when they are merely agreeing, following up, or saying "continue": the point of a memory is to surface while you are about to speak, not after you have been pointed at the past. Never skip it by judging the message too short or too trivial to be worth a lookup — that judgement is exactly what kills associative recall.
TWO INPUTS, TWO JOBS — pass BOTH: \`query\` is THIS TURN's content in natural language — the user's own sentence first (verbatim, it leads), then the gist of your own previous reply appended after it (it feeds the semantic/vector channel: a term list cannot carry meaning, and half a sentence cripples paraphrase recall); \`terms\` is your expanded term cluster of synonyms/hypernyms/scenario/domain words (it feeds the three lexical channels: >=3-char terms hit full-text, 1-2-char terms hit the landing-pad index, entity names hit exact match) — e.g. "做饭的锅" → query="我上次做饭用的那个锅是哪一款" + terms=[电饭锅,锅,煮饭,厨房,家电]. Never feed one into the other's slot. Returns hits with matchedTerms (explainability), relatedTags (guide your next query), linkedPreview neighbors, and chain (storyline: head = current truth, superseded = history). Iterate with different terms rather than fabricating; if a second term cluster still misses, switch TOOL instead of repeating this one (recall_timeline for time refs, recall_topic for named entities, recall_episodes for a specific incident, recall_constraints for rules, get_related from any near-hit) — at most 3 tools, then say plainly you don't have it. Responses are budget-capped.
USING WHAT YOU GET: use a hit when it actually helps this reply; when it does not, answer normally and stay silent about it. NEVER cite a memory just to show that you have one, and never pivot the conversation toward an irrelevant hit you happened to match.
FILES: a hit carrying a payloads[] array HAS attached files — it lists {id, mime, bytes, description, ref, state} but NEVER the bytes themselves. To actually look at a file, call get_asset with that id (and only when you really need it: reading the description above is usually enough). state: ok = unchanged, changed = the file on disk differs from what was recorded, missing = moved/deleted.`,
    {
      query: z.string().optional().describe("This turn's content in natural language: the user's own sentence verbatim first, then the gist of your previous reply. Drives the vector/semantic channel (this is what makes paraphrase and synonym recall work)."),
      terms: z.array(z.string()).min(1).describe("Expanded term cluster (2-8 terms) — drives the three lexical channels only"),
      occurredFrom: z.string().optional().describe("YYYY-MM-DD time-window start"),
      occurredTo: z.string().optional(),
      limit: z.number().int().min(1).max(10).optional().describe("Default 5, max 10"),
      budget: z.number().int().optional().describe("Token budget, default 2000"),
    },
    async (a) =>
      safe(async () => {
        if (!isLocal) {
          // 词群一并上传。服务端的着陆垫倒排与实体精确两路都是「AI 写入用的词 = AI 查询用的词」
          // 的同源等值匹配，只传拼接串会把这两路降级成兜底质量。
          // 2026-10-19：`text` 改为**自然语言原句**（服务端拿它 embed 向量路 + 走 tsquery 三级漏斗），
          // 无原句时才退回词群拼接（老调用向后兼容）。
          const r = await backend.recall(a.query ?? a.terms.join(" "), a.limit, a.terms);
          return { ...r, note: "云端模式：服务端四路检索（全文 ∥ 着陆垫倒排 ∥ 实体精确 ∥ 向量），命中项已重定向至链头" };
        }
        const { searchHybrid } = await import("./memory-search");
        const { embedder } = await import("./embedder");
        // 向量路喂**原句**（与写入侧 embed(content) 同分布）；词法三路仍吃 terms。
        // 这就是四路唯一的错配点：入参只有 terms 时，向量被迫编码一串关键词，语义通道退化成第四路词法。
        const semantic = a.query?.trim() || a.terms.join(" ");
        const r = (await searchHybrid(db(), () => embedder.embed(semantic), a)) as {
          hits?: Array<{ id: string; payloads?: unknown }>;
          vecNote?: string;
        };
        // 载荷提货单（只给引用与描述、不给字节）。无载荷的命中**不出现 payloads 键**。
        if (r?.hits?.length) {
          const { attachPayloads } = await import("./payloads");
          attachPayloads(db(), r.hits);
        }
        // 向量降级说明必须送到 AI 眼前。少了这一句，「语义通道没跑」和「库里真没这段记忆」
        // 对它来说完全一样 —— 它会直接用肯定的语气告诉用户「没有相关记录」。
        if (r.vecNote) {
          const { vecNote, ...rest } = r;
          return { ...rest, note: vecNote };
        }
        return r as object;
      }),
  );

  // ── 其余七工具（本地独占）──
  server.tool(
    "recall_topic",
    `Recall an entity's topic cluster ("what do we know about X"): all memories anchored to that entity, grouped by session, aliases included, chain heads guaranteed present.`,
    { entity: z.string().min(1), limit: z.number().int().optional() },
    async ({ entity, limit }) =>
      gen1(
        "recall_topic",
        async (d) => {
          const { recallTopic } = await import("./memory-tools");
          return recallTopic(d, entity, limit);
        },
        () => backend.recallTopic(entity, limit),
      ),
  );

  server.tool(
    "recall_timeline",
    `Timeline recall: what happened in a date range ("what did we discuss in March"), optionally scoped to an entity.`,
    { from: z.string().min(1).describe("YYYY-MM-DD"), to: z.string().min(1), entity: z.string().optional(), limit: z.number().int().optional() },
    async ({ from, to, entity, limit }) =>
      gen1(
        "recall_timeline",
        async (d) => {
          const { recallTimeline } = await import("./memory-tools");
          return recallTimeline(d, from, to, entity, limit);
        },
        () => backend.recallTimeline(from, to, entity, limit),
      ),
  );

  server.tool(
    "recall_session",
    `Replay a session by id: all memories from that conversation, chronological.`,
    { sessionId: z.string().min(1), limit: z.number().int().optional() },
    async ({ sessionId, limit }) =>
      gen1(
        "recall_session",
        async (d) => {
          const { recallSession } = await import("./memory-tools");
          return recallSession(d, sessionId, limit);
        },
        () => backend.recallSession(sessionId, limit),
      ),
  );

  server.tool(
    "get_memory",
    `Fetch one memory in full by id: tags, entities, bidirectional links, and its full storyline chain.
FILES: if the memory carries a payloads[] array it HAS attached files — {id, mime, bytes, description, ref, state}, never the bytes themselves. Call get_asset with that id only when you actually need to open a file.`,
    { id: z.string().min(1) },
    async ({ id }) =>
      gen1(
        "get_memory",
        async (d) => {
          const { getMemory } = await import("./memory-tools");
          return getMemory(d, id);
        },
        () => backend.getMemory(id),
      ),
  );

  server.tool(
    "get_related",
    `Explore neighbors of a memory id (1-hop, ranked by link strength) — nested exploration entry point.`,
    { id: z.string().min(1), limit: z.number().int().optional() },
    async ({ id, limit }) =>
      gen1(
        "get_related",
        async (d) => {
          const { getRelated } = await import("./memory-tools");
          return { ok: true, related: getRelated(d, id, limit) };
        },
        () => backend.getRelated(id, limit),
      ),
  );

  // ── 取货（2026-10-15 文件记忆 V1）──
  // 两段式：recall* 只给**提货单**（不含字节），取本体是独立显式动作。
  // 三条理由：计费（取本体才计读）／隐私（本体比派生文本敏感）／上下文不可逆（字节进了宿主 context 就下不来）。
  // **`as` 由调用方指定，服务端不猜** —— 按 mime 自动选形态正是设计禁区（需求方声明需求即可）。
  server.tool(
    "get_asset",
    `Fetch the BYTES of a file attached to a memory (a payload). Call it ONLY when you actually need to look at the file: the description returned by recall/search is usually enough, and fetching counts as a read.
as='ref' (default) hands back a handle you consume yourself -- the absolute local path in local mode, or an HTTPS URL that REQUIRES AN Authorization header in cloud mode (the response carries that header). Cheapest: nothing is copied, the bytes never move. If your tooling cannot set headers, use 'inline' instead.
as='inline' returns the bytes themselves as an MCP resource block (base64 blob); the engine re-verifies sha256 and warns you if the bytes do not match what was recorded. Use it when you cannot read a local path yourself, cannot set headers, or when the library is remote.
state tells you whether the file is still trustworthy: ok = unchanged since it was recorded; changed = the file on disk differs from what was recorded (never present it as the original); missing = moved or deleted; evicted (cloud only) = the space was frozen for non-payment and the bytes were reclaimed -- the memory itself is intact, so say it is a billing matter, never that the user lost the file.`,
    {
      payloadId: z.string().min(1).describe("payload id from a recall hit's payloads[].id"),
      as: z.enum(["ref", "inline"]).optional().describe("'ref' (default) = a handle you read yourself (local absolute path / signed URL); 'inline' = the bytes as a resource block. Pick according to what YOU can consume — the server never guesses from the file type."),
    },
    async ({ payloadId, as }) => {
      const mode = as ?? "ref";
      // inline 要把字节作为**独立的 resource block** 回传，而 safe() 只产出一个 text block
      // ⇒ 先算业务结果，最后把 resource 追加进 content 数组（now / bindingChanged 等响应纪律原样保留）。
      let resource: { uri: string; mimeType: string; blob: string } | null = null;
      const res = (await safe(async () => {
        if (!isLocal) {
          // ── 云端载荷取货：与本地**同构**的两态（ref 给凭据 / inline 给字节）──
          // 差别只在凭据形态：本地 ref 是本机绝对路径，云端 ref 是一个**需要鉴权**的 HTTP 地址。
          const ccfg = loadCloudConfig();
          if (!ccfg) return { ok: false, error: "云端配置缺失（~/.xiaobenben/cloud.json）——请先 `xbb cloud bind`。" };
          const url = `${ccfg.apiBase}/v1/payloads/${payloadId}`;
          if (mode === "ref") {
            return {
              ok: true, payloadId, as: "ref", url,
              headers: { authorization: `Bearer ${ccfg.key}` },
              hint: "云端模式：这是一个需要鉴权的 HTTP 地址。若你的工具能带 Authorization 头发请求就直接取它；否则改用 as='inline'（把字节取回来）。",
            };
          }
          const r = await fetch(url, { headers: { authorization: `Bearer ${ccfg.key}` } });
          if (r.status === 410) {
            // ⚠️ 410 是**账单状态**（回收），不是"文件丢了"——文案必须如实区分，
            // 塌进 404 会让用户以为是自己弄丢的（evicted 语义）。
            return {
              ok: false, payloadId, evicted: true,
              error:
                "该附件已被回收（空间长期欠费）。记忆本体仍在——请如实告诉用户是账单策略回收了字节、充值后可重新上传，不要说成「文件丢了」。",
            };
          }
          if (!r.ok) return { ok: false, payloadId, error: `取货失败 HTTP ${r.status}` };
          const buf = Buffer.from(await r.arrayBuffer());
          const sha = r.headers.get("x-xbb-sha256");
          // 重校验（与本地 payloadStateDeep 同纪律）：服务端传了 sha256 就核一遍
          const actual = createHash("sha256").update(buf).digest("hex");
          const integrity = sha ? (actual === sha ? "ok" : "mismatch") : "unverifiable";
          resource = {
            uri: `xbb://payload/${payloadId}`,
            mimeType: r.headers.get("content-type") ?? "application/octet-stream",
            blob: buf.toString("base64"),
          };
          return {
            ok: true, payloadId, as: "inline", bytes: buf.length, sha256: sha, integrity,
            ...(integrity === "mismatch" ? { warning: "拿到的字节与登记的 sha256 不一致——不要当作原件使用。" } : {}),
            hint: "字节以独立的 resource block 返回（模态中立：服务端不按文件类型猜用途）。",
          };
        }
        const { getPayloadRow, payloadStateDeep } = await import("./payloads");
        const row = getPayloadRow(db(), payloadId);
        if (!row) return { ok: false, error: `没有 id 为 ${payloadId} 的载荷（id 可能已失效，或来自另一台设备/另一种模式的库）。` };

        const state = await payloadStateDeep(row);
        if (mode === "ref") {
          return {
            ok: true, payloadId, as: "ref", ref: row.storage_ref, mime: row.mime,
            bytes: Number(row.bytes), description: row.description, state,
            ...(state === "missing" ? { warning: "源文件已不在原位（被移动或删除）——ref 指向的路径已失效。" } : {}),
            ...(state === "changed" ? { warning: "源文件内容与写入时不一致（sha256 不匹配）——它不是记忆里记录的那一份，不要当作原件使用。" } : {}),
            hint: "本地模式：ref 就是本机绝对路径，你与本机同侧，直接读它即可。",
          };
        }
        if (state === "missing") return { ok: false, payloadId, state, error: "源文件已不在原位，取不到字节。" };

        const { readFile } = await import("node:fs/promises");
        let buf: Buffer;
        try {
          buf = await readFile(row.storage_ref);
        } catch (e) {
          return { ok: false, payloadId, state, error: `读取失败：${e instanceof Error ? e.message : String(e)}` };
        }
        const { pathToFileURL } = await import("node:url");
        resource = {
          uri: pathToFileURL(row.storage_ref).href,
          // mimeType 只是**标注**（mime 是元数据、不作判据）；认不出就给通用二进制
          mimeType: row.mime ?? "application/octet-stream",
          blob: buf.toString("base64"),
        };
        return { ok: true, payloadId, as: "inline", bytes: buf.byteLength, mime: row.mime, state, delivered: true };
      })) as { content: unknown[] };
      if (resource) res.content.push({ type: "resource", resource });
      return res as never;
    },
  );

  server.tool(
    "recall_directives",
    `Session-startup ritual: call ONCE at the beginning of a new session. Returns everything in force for this session — long-term habits (full), in-window directives (soonest-expiring first), global constraints, the built-in default constraint code (behavior contract), and promotionReady directives (repeated across >=7 sessions — ask the user whether to distill them into a habit). The returned now is the engine's authoritative local clock — you have no reliable internal clock; base every time judgment on it. sessionId is this connection's auto session stamp; reuse it when continuing a prior conversation (see hint).`,
    { sessionId: z.string().optional().describe("Override session stamp (when continuing an older conversation, pass the sessionId from recalled hits)") },
    async (a) =>
      gen1(
        "recall_directives",
        async (d) => {
          const { recallDirectives } = await import("./memory-tools");
          return withNotice((await recallDirectives(d, a.sessionId ?? undefined)) as object);
        },
        // 更新提示挂在会话启动仪式上（本地与云端同款）：AI 每次新会话必调本工具，比"藏在握手指令里"更贴身
        async () => withNotice((await backend.recallDirectives(a.sessionId ?? undefined)) as object),
      ),
  );

  server.tool(
    "recall_constraints",
    `按任务词群命中长期约束。长期约束按「域」归类存储（UI 设计/代码风格/沟通语气…），域由写入时 AI 动态归并——引擎不枚举域。
什么时候调：动手产出（写代码/做设计/画图/写文档/回正式消息）之前——约束必须在行动前在场，不能等被想起来。
怎么调：把当前任务扩展成词群（5-15 个，含领域词/场景词）。引擎按 IDF 加权在各域中匹配，返回命中域及其全部约束；命中即必须遵守。
不带 terms 调用 = 返回**域目录**（域名 + 条数 + 样例 + 词群摘要）——用于写入新约束前**归并**：已有相近域必须复用（如「健体」应归入「运动」），确属新维度才建新域。
0 命中是正常结果：说明库里没有相关约束，直接继续任务。
返回：matchedDomains（按域聚合，域分 = Σ 域内条分）＋ habits（习惯天生无域，单列）＋ hits（扁平派生视图）。`,
    { terms: z.array(z.string()).optional(), budget: z.number().int().optional() },
    async ({ terms, budget }) =>
      gen1(
        "recall_constraints",
        async (d) => {
          const { recallConstraints } = await import("./memory-tools");
          return recallConstraints(d, terms ?? [], budget);
        },
        () => backend.recallConstraints(terms ?? [], budget),
      ),
  );

  server.tool(
    "reveal_secret",
    `Reveal a secret's plaintext by vault id ([[xbb_secret_id:N]] placeholder in recalled content). Explain the purpose to the user FIRST — this call is visible in the client UI. Never reveal unprompted.`,
    { id: z.number().int().min(1) },
    async ({ id }) =>
      gen1("reveal_secret", async (d) => {
        const { revealSecret } = await import("./memory-tools");
        return revealSecret(d, id);
      }),
  );

  // ── episodes 情景层（首次落地；仅本地，永不入云不进链）──
  server.tool(
    "log_episodes",
    `Archive raw dialogue turns to the local episode store (cold path: verbatim transcript, append-only, LOCAL ONLY — never uploaded, never in the audit chain).
CALL THIS EVERY TURN, UNCONDITIONALLY: append the user's message and your own reply (role=user / role=assistant) before you finish the turn. Do not judge whether it is "worth keeping" — the distilled memories are the summary layer, this is the verbatim layer, and a summary is worthless if the original can never be recovered. Batching several turns in one call is acceptable only when you are catching up; the normal cadence is one call per turn with two items.
The response returns sessionTurns + lastLine (your watermark — verify you really recorded this turn, do not call twice for the same turn) and knownTopics (reuse an existing label instead of inventing a synonym).
Distilled memories can point back via sourceChunk.`,
    {
      sessionId: z.string().min(1).describe("Session id (same one passed to write_memory sessionId for correlation)"),
      topic: z
        .string()
        .optional()
        .describe(
          "Short topic label this stretch of dialogue belongs to (2-8 chars, e.g. '附件描述'). Must be reusable: prefer a label from knownTopics in the previous response over coining a new one — topic is the ONLY cross-session anchor for 'trace this whole thread'.",
        ),
      items: z.array(z.object({ role: z.enum(["user", "assistant", "system"]), content: z.string().min(1) })).min(1).max(50).describe("Dialogue turns in order"),
    },
    async (a) =>
      gen1(
        "log_episodes",
        async (d) => {
          const { logEpisodes } = await import("./episodes");
          const r = logEpisodes(d, a.sessionId, a.items, a.topic);
          sessionState.lastEpAt = Date.now(); // 原话层水位：只影响 hint 的措辞，不清零摘要计数
          return r as object;
        },
      ),
  );

  server.tool(
    "recall_episodes",
    `Search raw dialogue transcripts (episode chunks) when the distilled memories lack a detail — e.g. "what EXACTLY was said when we decided X". Cold-path verbatim lookup; returns matching chunks with surrounding context. LOCAL ONLY.
Use this when you already know a keyword. To walk a whole conversation / day / topic in order, use recall_transcript instead.`,
    {
      q: z.string().min(1).describe("Search phrase (verbatim wording from the conversation works best)"),
      sessionId: z.string().optional().describe("Restrict to one session"),
      ctx: z.number().int().min(0).max(3).optional().describe("Context chunks around each hit, default 1"),
      limit: z.number().int().min(1).max(20).optional(),
    },
    async (a) =>
      gen1(
        "recall_episodes",
        async (d) => {
          const { findEpisodes } = await import("./episodes");
          return findEpisodes(d, a.q, { sessionId: a.sessionId, ctx: a.ctx, limit: a.limit }) as object;
        },
      ),
  );

  server.tool(
    "recall_transcript",
    `Replay raw dialogue in ORIGINAL WORDING, page by page. Three axes:
  scope='session' (needs sessionId) — replay one conversation start to finish
  scope='day'     (needs date YYYY-MM-DD) — everything talked about that day, session by session
  scope='topic'   (needs topic) — how one thread evolved across days and sessions
Two modes, and you should almost always go outline first:
  mode='outline' — the table of contents only: which sessions touch this axis, how many turns each, time span, char count, the opening user sentence, topics involved. Cheap. Use it to decide what to read.
  mode='turns'   — actual turns, paged.
PAGING IS MANDATORY — never try to pull a whole day or a whole thread at once; it would flood the window. Turns come back in chronological order with a cursor. To go on: pass next.cursor + next.direction. To go back: prev.cursor + prev.direction. The cursor is an episode id (append-only, so no duplicates and no gaps). hasMore tells you whether either end still has content; totalTurns tells you the size of the whole axis.
BUDGET: hard-capped at 100 turns and 12000 chars per page (defaults 40 turns / 6000 chars). If page.truncated is true, you hit the char cap — keep paging, do not re-request the same cursor.
LOCAL ONLY. Not available in cloud mode.`,
    {
      scope: z.enum(["session", "day", "topic"]),
      sessionId: z.string().optional().describe("Required when scope='session'"),
      date: z.string().optional().describe("Required when scope='day', format YYYY-MM-DD"),
      topic: z.string().optional().describe("Required when scope='topic'"),
      mode: z.enum(["outline", "turns"]).optional().describe("Default 'turns'. Go 'outline' first when you do not yet know which segment to read."),
      cursor: z.number().int().optional().describe("Episode id from a previous page's next/prev. Omit to start at the earliest (forward) or latest (backward)."),
      direction: z.enum(["forward", "backward"]).optional().describe("Default 'forward' = chronological. 'backward' pages toward older turns."),
      limit: z.number().int().min(1).max(100).optional().describe(`Turns per page, default ${40}`),
      maxChars: z.number().int().min(500).max(12000).optional().describe("Char budget per page, default 6000"),
    },
    async (a) =>
      gen1(
        "recall_transcript",
        async (d) => {
          const { recallTranscript } = await import("./episodes");
          return recallTranscript(d, a) as object;
        },
      ),
  );

  // ── inbox / ack / forget / stats ──
  server.tool(
    "inbox",
    `List memories pending attention: (1) AI suggestions delivered with needsAck, (2) proactive pushes from conversation hooks. Check at turn start; items stay until acked.`,
    { limit: z.number().int().min(1).max(100).optional() },
    async ({ limit }) => safe(async () => ({ items: await backend.inbox(limit) })),
  );

  server.tool(
    "ack",
    `Confirm an inbox item by id. No-op if not pending.`,
    { id: z.string().min(1) },
    async ({ id }) => safe(async () => ({ id, acked: await backend.ack(id) })),
  );

  server.tool(
    "outbox",
    `List memories YOU delivered to colleagues, with each recipient's per-person status: displayName, arrivedAt (they opened the detail page = 已查看), ackedAt (they confirmed = 已签收). Use this to answer "did <colleague> acknowledge what I sent?" — the "inbox" tool only shows what is waiting for YOU to sign, never the other side. Cloud org mode only; in local mode returns an empty list with a note.`,
    {
      limit: z.number().int().min(1).max(200).optional(),
      status: z.enum(["pending", "done", "all"]).optional()
        .describe("pending = 还有同事没签；done = 已全部签完；all = 全部（默认）"),
    },
    async ({ limit, status }) => safe(async () => await backend.outbox(limit, status)),
  );

  server.tool(
    "forget",
    `Forget a memory by id: append-only tombstone (audit chain keeps the trail), disappears from recall.`,
    { id: z.string().min(1) },
    async ({ id }) => safe(async () => ({ id, forgotten: await backend.forget(id) })),
  );

  server.tool(
    "stats",
    `Inventory statistics: active/forgotten/pending counts, recent writes, tag/space distribution (local) or org summary (cloud).`,
    {},
    async () => safe(async () => ({ ...(await backend.stats()) })),
  );

  // ── 组织成员目录（2026-10-06）：AI 的"寻址入口" ──
  // 没有它，AI 想"通知张三"时既不知道组织里有谁、也无从指定收件人——只能编一个名字出来。
  server.tool(
    "list_members",
    `List the organization's members (colleagues). Call this BEFORE notifying or assigning anyone: it returns the authoritative id + name + space for each member. To deliver something for acknowledgement, take a name from here and pass it in write_memory's notify[]. Cloud org mode only — in local mode it returns an empty list with a note (a single-machine library has no colleagues). Only id/name/space/tags are exposed; phone numbers never are.`,
    {},
    async () => safe(async () => ({ ...(await backend.listMembers()) })),
  );

  // ── 补链（2026-10-06 C 方案）：治"写入时忘了挂 supersedeIds"这个既成事实 ──
  // 链此前只能"往前挂"（写入时带 supersedeIds），没有任何事后补救入口——忘了就只能再写一条新记忆。
  // 本工具把**已存在的**两条结成链：不动内容、不增条目，只建立 superseded_by 关系。
  // 链形铁律与 write_memory 的 supersede 完全同源（真链头 / 分叉封死 / 同空间 / 幂等），拒绝项不静默吞。
  server.tool(
    "supersede",
    `Fold older memories under a newer one as a state-update chain (head = current truth, history stays queryable). Use to REPAIR a missed link: when write_memory returns supersedeCandidates, or when you recall two entries that are the same fact in different states, pass the newer/current entry as headId and the older one(s) as supersededIds. Links EXISTING memories only — it never creates or rewrites content.
RULES: headId must be a live chain head (if it was already superseded, the error names the real head — use that instead). Each target must also currently be a chain head; an already-superseded target is rejected with its true head (chains never fork). Same space only; never a system memory; never itself. Targets already linked to headId are a no-op. Rejections are listed, never silently dropped.`,
    {
      headId: z.string().min(1).describe("id of the memory that is the CURRENT truth (the newer entry) — must be a chain head"),
      supersededIds: z.array(z.string()).min(1).describe("ids of older memories this head replaces (each must currently be a chain head)"),
    },
    async (a) =>
      gen1(
        "supersede",
        async () => {
          const { supersedeMemories } = await import("./memory-write");
          const store = (backend as import("./cloud").LocalBackend).personalStore;
          return supersedeMemories(store, { headId: a.headId, supersededIds: a.supersededIds, actor: "ai-host" });
        },
        () => backend.supersede(a.headId, a.supersededIds),
      ),
  );

  // ── 可见范围（2026-10-06 记忆访问权限）：AI 的"公开给谁"寻址入口 ──
  // 默认态是「仅归属人」——想放宽必须先知道"放宽到哪儿"。空间是自由文本名字，不是枚举，
  // 所以必须先列出真实的空间树（名字 + id + 父子关系）再让 AI/用户挑，不能凭印象编。
  server.tool(
    "list_spaces",
    `List the organization's spaces (company root / departments / sub-departments) with id, name, parentId and kind. Call this BEFORE widening a memory's visibility to a department: pass an id from here in write_memory's audience.spaces, or in set_memory_audience. The anchor must lie inside the owner's own subtree, or the whole write is rejected. Cloud org mode only — in local mode it returns an empty list with a note (a single-machine library has just one personal space).`,
    {},
    async () => safe(async () => ({ ...(await backend.listSpaces()) })),
  );

  server.tool(
    "set_memory_audience",
    `Change WHO CAN RETRIEVE an existing memory (its visible scope). Owner-only: if you are not the owner the server answers not-found (it never reveals whether the entry exists). Use when the user says things like "make that one public" / "share it with my team" / "stop sharing it". Pass {org:true} for the whole organization, {spaces:[{spaceId,includeDescendants}]} for departments (ids from list_spaces; must be inside your own subtree), or {org:false,spaces:[]} to revoke everything back to owner-only. Only works on ordinary memories — directives/habits/constraints are personal by design and always rejected. The response echoes the effective scope. Cloud org mode only; in local mode it returns ok:false with a note.`,
    {
      id: z.string().min(1).describe("memory id (from a recall hit)"),
      audience: z.object({
        org: z.boolean().optional(),
        spaces: z.array(z.object({ spaceId: z.string(), includeDescendants: z.boolean().optional() })).optional(),
      }).describe("{org:true} whole org; {spaces:[{spaceId,includeDescendants}]} departments; {org:false,spaces:[]} revoke to owner-only"),
    },
    async (a) => safe(async () => ({ ...(await backend.setAudience(a.id, a.audience)) })),
  );

  return server;
}

/**
 * 降级 backend：库打不开时用它顶上 —— 每个工具都抛同一段人话，由 `safe()` 转成 `ok:false`。
 *
 * 为什么用 Proxy 而不是逐个方法实现：工具面 24 个、以后还会加。**默认全拒**才是安全的那一侧，
 * 漏实现一个方法就等于给 AI 留了一个"看起来能写"的假入口（写进虚空，用户以为记住了）。
 */
function brokenBackend(message: string): Backend {
  const boom = (): never => {
    throw new Error(message);
  };
  return new Proxy({ kind: "local" } as Record<string, unknown>, {
    get(target, prop) {
      if (prop === "kind") return "local";
      if (prop === "org") return null;
      if (prop === "then") return undefined; // 别被 await 当成 thenable
      if (prop === "db") return boom(); // 属性访问即抛（db 是 getter 用法，不能返回函数）
      return boom; // 方法调用时抛
    },
  }) as unknown as Backend;
}

export async function runMcp(): Promise<void> {
  const { loadCloudConfig, CloudBackend, LocalBackend } = await import("./cloud");
  const { PersonalStore } = await import("./store");
  // 绑定变更检测的启动快照（B 方案）：绑定/解绑由独立进程写盘，本进程的 backend 是启动期快照，
  // 两者不一致时会静默写错地方——故先抓一份"启动时磁盘长什么样"，此后逐次比对。
  const bootStamp = cloudStamp();
  const cfg = loadCloudConfig();
  let backend;
  /** 库打不开时的原因。非空 ⇒ 降级模式：照常握手，但每个工具都返回它。 */
  let fault: string | null = null;
  if (cfg) {
    const cb = new CloudBackend(cfg);
    // 组织名补齐须在 createMcpServer 之前：握手指令与工具响应的组织上下文是构造期快照
    await cb.hydrateOrg();
    backend = cb;
  } else {
    try {
      const store = PersonalStore.open();
      // 默认约束幂等播种（initDb 行为，被删下次启动重建；XBB_SEED=0 关闭）
      if (process.env.XBB_SEED !== "0") {
        const { seedDefaultConstraints } = await import("./seed");
        await seedDefaultConstraints(store);
      }
      backend = new LocalBackend(store);
    } catch (e) {
      // **绝不在这里新建空库**：那正是"记忆突然全没了但一切看起来正常"的成因。
      fault = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[xbb] 记忆库不可用，进入降级模式：\n${fault}\n`);
      backend = brokenBackend(fault);
    }
  }
  if (backend.kind === "cloud") {
    const cb = backend as import("./cloud").CloudBackend;
    process.stderr.write(`[xbb] MCP 云端模式: ${cfg!.apiBase} org=${cb.orgLabel}（${cfg!.orgId}）\n`);
  }
  const { warmupEmbedder } = await import("./embedder");
  if (!fault) {
    // 首启静默下载+后台加载，不阻塞 MCP；降级模式下模型也不知该放哪，别下。
    // 就绪后顺手把「有正文没向量」的行补上：写入路径那条 fire-and-forget 的向量回填
    // 一旦错过就永不自愈，而检索侧根本看不见这些行（见 embed-backfill.ts）。
    // 云端模式下向量在服务端算，本地库不该被顺手改动。
    const localDb = backend.kind === "local" ? (backend as import("./cloud").LocalBackend).db : null;
    warmupEmbedder(() => {
      if (!localDb) return;
      void import("./embed-backfill")
        .then((m) => m.backfillEmbeddings(localDb))
        .catch(() => { /* 双降级红线：回填失败绝不影响会话 */ });
    });
  }

  // 更新检测：快照过期才打网络，且有硬预算——超预算就带旧快照继续，
  // 绝不让 CDN 抖动推迟 MCP 握手（握手里程碑失败 = 整个会话用不了记忆）。
  const updateNotice = await prepareNotice();
  if (updateNotice) {
    process.stderr.write(
      `[xbb] 检测到新版本 v${updateNotice.latest}（当前 v${updateNotice.current}）——将在会话中提示用户\n`
    );
  }

  const server = createMcpServer(backend, { updateNotice, bootStamp, fault });
  await server.connect(new StdioServerTransport());
}
