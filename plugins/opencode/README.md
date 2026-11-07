# 小本本 × opencode 适配器

一句话安装：把 `xbb-push.js` 复制到 opencode 插件目录即可（零依赖、零配置）：

```bash
# 全局（所有项目生效）
mkdir -p ~/.config/opencode/plugins && cp xbb-push.js ~/.config/opencode/plugins/

# 或项目级
mkdir -p .opencode/plugins && cp xbb-push.js .opencode/plugins/
```

前提：本机跑着 `xbb serve`（监听 127.0.0.1:17630）。

行为：每回合对话文本（去抖 2s）POST 到 `http://127.0.0.1:17630/hooks/turn`，
小本本内存检索命中即推入 inbox（去重，同一记忆绝不重复打扰）。

红线：
- 文本只发往 **127.0.0.1 回环**，不出网；小本本侧只做内存检索，永不落盘
- serve 不在 / 超时 → 静默忽略，**opencode 零感知**

自定义端点：环境变量 `XBB_HOOK_URL`。
