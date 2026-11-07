# 小本本钩子适配器（主动记忆推送）

`xbb-hook.mjs` 是六宿主通用的零依赖适配器：监听宿主的回合事件，把回合文本转发给本地
小本本服务（`POST /hooks/turn`，serve 17630），命中的记忆作为**候选**进 inbox——AI 在
回合开始时通过 MCP `inbox` 工具自行决定用不用，**绝不直接注入上下文**。

## 行为红线

1. **对话原文永不落盘**：内存匹配完即弃，适配器与服务端均零持久化
2. **候选不注入**：脚本 stdout 恒为空（Trae 等宿主会把 stdout 当上下文注入，故什么都不打印）
3. **fail-open**：服务未起/超时/任何异常 → 静默退出 0，宿主回合绝不受阻

## 前置

小本本本地服务在跑（`xbb serve`，端口 17630）。脚本路径在下面配置里全部用**绝对路径**
（Windows 也用正斜杠，node 接受）。

## 各宿主接入

### 1. opencode（已内置专用适配器，无需本脚本）

`plugins/opencode/xbb-push.js` 已随插件目录安装，见该目录 README。

### 2. Claude Code

`~/.claude/settings.json`：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node C:/path/to/xbb-hook.mjs" }] }
    ]
  }
}
```

### 3. Cursor

方式 A（零配置）：Cursor 设置 → Agents → Third-Party Imports 开启
「Include Third-Party Plugins, Skills, and Other Configs」，上面的 Claude Code hooks
会被直接导入（`UserPromptSubmit` → `beforeSubmitPrompt` 官方映射）。

方式 B（原生格式），`~/.cursor/hooks.json`：

```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [
      { "command": "node C:/path/to/xbb-hook.mjs", "timeout": 5 }
    ]
  }
}
```

### 4. Trae

设置 → Hooks → 创建全局 Hook → `hooks.json`：

```json
{
  "version": 1,
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node C:/path/to/xbb-hook.mjs", "timeout": 5 }] }
    ]
  }
}
```

注意保持「沙箱运行」模式下脚本可访问；若沙箱内访问不到本地端口，改「本地自动运行」。

### 5. WorkBuddy

`~/.workbuddy/settings.json`（Windows 上 hook 命令在 Git Bash 执行，node 正常可用）：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node C:/path/to/xbb-hook.mjs" }] }
    ]
  }
}
```

### 6. Codex CLI

`~/.codex/config.toml`（notify 钩子，JSON 走命令行参数，脚本自动识别）：

```toml
notify = ["node", "C:/path/to/xbb-hook.mjs"]
```

转发内容 = `input-messages`（用户消息）+ `last-assistant-message`（助手输出），回合完成时触发。

### 7. 豆包（不支持推送，MCP 兜底）

豆包桌面版目前**没有任何钩子/插件机制**，无法被动监听回合文本。兜底路径：用 MCP stdio
接入小本本（五个工具照常可用），AI 在对话里主动 `recall` / 查 `inbox`——拉模式替代推模式。
待官方开放钩子后按本 README 模式补一节即可。

## 验证

```bash
echo '{"prompt":"小本本钩子冒烟 hooksmokeTEST001"}' | node plugins/hooks/xbb-hook.mjs
curl http://127.0.0.1:17630/stats   # pendingAck 应 +1（命中进 inbox）
```

自动化冒烟：`bun run tools/hooks-smoke.ts`（拉起隔离 serve → 种子记忆 → stdin/argv
两形态真跑适配器 → 验证 inbox 收到推送）。

## 端点覆盖

联调时可设 `XBB_HOOK_URL` 环境变量指向其他端口，如 `http://127.0.0.1:17799/hooks/turn`。
