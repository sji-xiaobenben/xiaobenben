/**
 * 通用结构嗅探器冒烟（V9）。
 *
 * 这个测试的存在理由：嗅探器是「上游改字段名不再致命」的唯一依靠，
 * 它一旦悄悄失效，采集会退化成"每源一份手写 extract"，而且失效是静默的。
 * 所以这里不测"能不能跑"，只测两件要命的事：
 *   ① 认得出（各种壳都能命中，包括没见过的字段名）
 *   ② 不乱认（工具参数、元信息、type:'text' 的裸块都不能被当成对话）
 *
 * 用法：bun run tools/sniff-smoke.ts
 */
import { applyDescriptor, looksLikeMessage, roleOfValue, sniffMessage, structureFingerprint, textOfValue } from "../src/sniff";
import type { FormatDescriptor } from "../src/sniff";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`);
  }
}

console.log("① 角色归一：认语义，不认拼写");
{
  check("标准 user", roleOfValue("user") === "user");
  check("human 也算 user", roleOfValue("human") === "user");
  check("大写照样认", roleOfValue("USER") === "user");
  check("agent 算 assistant", roleOfValue("agent") === "assistant");
  check("model 算 assistant", roleOfValue("model") === "assistant");
  check("复合词 user_message", roleOfValue("user_message") === "user");
  check("复合词 agent_message", roleOfValue("agent_message") === "assistant");
  check("tool_result 不是角色", roleOfValue("tool_result") === null);
  check("reasoning 不是角色", roleOfValue("reasoning") === null);
  check("裸 message 不是角色", roleOfValue("message") === null);
  check("数字/空值不炸", roleOfValue(123) === null && roleOfValue(null) === null);
}

console.log("② 正文提取：工具块与思考块必须被排除");
{
  check("纯字符串", textOfValue("你好") === "你好");
  check(
    "多段合并",
    textOfValue([
      { type: "text", text: "第一段" },
      { type: "text", text: "第二段" },
    ]) === "第一段\n第二段",
  );
  check(
    "tool_use 被跳过",
    textOfValue([
      { type: "text", text: "正文" },
      { type: "tool_use", input: { cmd: "rm -rf /" } },
    ]) === "正文",
  );
  check("thinking 被跳过", textOfValue([{ type: "thinking", text: "内心" }]) === "");
  check("单对象 {text}", textOfValue({ text: "对象里的正文" }) === "对象里的正文");
  check("数字返回空串", textOfValue(42) === "");
}

console.log("③ 嗅探：各种壳都要命中");
{
  const flat = sniffMessage({ role: "user", content: "扁平结构" });
  check("扁平 role+content", flat?.role === "user" && flat.text === "扁平结构", flat);

  const claude = sniffMessage({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "Claude projects 壳" }] },
  });
  check("type + message 双层壳", claude?.role === "user" && claude.text === "Claude projects 壳", claude);

  const codex = sniffMessage({ payload: { type: "user_message", message: "Codex 的 rollout" } });
  check("payload 壳 + user_message", codex?.role === "user" && codex.text === "Codex 的 rollout", codex);

  const author = sniffMessage({ author: "human", body: "从没见过的字段名" });
  check("没见过的字段名（author/body）也能认", author?.role === "user" && author.text === "从没见过的字段名", author);

  const sender = sniffMessage({ sender: "assistant", text: "sender/text 组合" });
  check("sender/text 组合", sender?.role === "assistant" && sender.text === "sender/text 组合", sender);
}

console.log("④ 嗅探：不该认的必须不认");
{
  check("opencode 的裸 part（无 role）不认", sniffMessage({ type: "text", text: "无角色" }) === null);
  check("只有 role 没有正文不认", sniffMessage({ role: "user" }) === null);
  check("空正文不认", sniffMessage({ role: "user", content: "   " }) === null);
  check("纯工具调用不认", sniffMessage({ role: "user", content: [{ type: "tool_use", input: { a: 1 } }] }) === null);
  check(
    "嵌套超过一层的假对话不认（防误采主闸）",
    sniffMessage({ role: "user", content: "外层", extra: { deep: { role: "assistant", content: "内层假货" } } })?.text === "外层",
  );
  check(
    "无角色字段的普通元信息不认",
    sniffMessage({ type: "session-meta", sessionId: "x", timestamp: 1 }) === null,
  );
}

console.log("⑤ 结构指纹：稳定、且对改版敏感");
{
  const a = structureFingerprint([
    ["content", "role", "type"],
    ["content", "role", "type"],
  ]);
  const b = structureFingerprint([["content", "role", "type"]]);
  check("重复消息不会改变指纹", a === b, { a, b });

  const c = structureFingerprint([["body", "role", "type"]]);
  check("字段名变了指纹就变", a !== c, { a, c });

  const d = structureFingerprint([["role", "type", "content"]]);
  check("键顺序无关", structureFingerprint([["content", "role", "type"]]) === d);

  check("空输入返回空串", structureFingerprint([]) === "");
  check("指纹是定长 16 位", structureFingerprint([["a"]]).length === 16);
}

console.log("⑥ 疑似消息判定：让 unparsed 有信噪比");
{
  check("有 role 的算疑似", looksLikeMessage({ role: "user", content: "x" }));
  check("type:user 算疑似", looksLikeMessage({ type: "user", content: "x" }));
  check("payload 里的 type 也算", looksLikeMessage({ payload: { type: "agent_message", message: "x" } }));
  check("message 壳里的 role 也算", looksLikeMessage({ type: "x", message: { role: "user" } }));
  check("session-meta 不算", !looksLikeMessage({ type: "session-meta", sessionId: "x" }));
  check("tool_use 不算", !looksLikeMessage({ type: "tool_use", tool_name: "bash" }));
  check("空对象不算", !looksLikeMessage({}));
}

console.log("⑦ descriptor：把适配写成数据");
{
  const d: FormatDescriptor = {
    id: "demo/v1",
    match: { keys: ["author", "body", "session_id", "ts"] },
    role: { field: "author", map: { human: "user", ai: "assistant" } },
    text: { field: "body" },
    sessionField: "session_id",
    timeField: "ts",
  };
  const ok = applyDescriptor(
    { author: "human", body: "descriptor 命中", session_id: "s1", ts: 1_760_000_000_000 },
    d,
  );
  check("键集合匹配则命中", ok?.role === "user" && ok.text === "descriptor 命中", ok);
  check("session 与时间被取出", ok?.sessionId === "s1" && ok?.atMs === 1_760_000_000_000, ok);

  const miss = applyDescriptor({ author: "human", body: "多了一个键", session_id: "s1", ts: 1, extra: 1 }, d);
  check("键集合不匹配则不套用（避免误配新格式）", miss === null, miss);

  const customMap: FormatDescriptor = {
    id: "demo/v2",
    match: { keys: ["author", "body"] },
    role: { field: "author", map: { human: "user", ai: "assistant" } },
    text: { field: "body" },
  };
  check(
    "自定义 map 生效（human→user）",
    applyDescriptor({ author: "human", body: "x" }, customMap)?.role === "user",
  );
  check(
    "map 未覆盖时回落通用词表",
    applyDescriptor({ author: "assistant", body: "x" }, customMap)?.role === "assistant",
  );
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
