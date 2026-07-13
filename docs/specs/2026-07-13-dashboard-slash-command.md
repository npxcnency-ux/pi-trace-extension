# Spec: `/trace all` 子命令——跨会话 dashboard 进入命令面

## 背景

`0.1.7` 引入了跨会话 dashboard，但触发方式是命令行 `python3 trace_to_html.py --dashboard`——用户装完扩展后要看历史账本还得记住这个长命令。

`/trace` 已经把"渲染当前 session"命令化了。`/dashboard` 应该同样命令化。

## 目标

在 pi 会话里输入 `/trace all` 就能生成 `~/.pi/agent/traces/index.html` 并自动打开浏览器，一步到位。

## 非目标

- 不删 `python3 trace_to_html.py --dashboard` 兼容路径（脚本/CI 场景仍需要）
- 不做实时刷新（`--follow` 模式属于后续话题）
- 不做 `/trace` 命令的其他扩展（保持只有 `all` 一个子命令）

## 命令语义

| 输入 | 行为 |
|---|---|
| `/trace` | 渲染当前 session 的 `trace.html` 并打开浏览器（**保持原行为**）|
| `/trace all` | 生成 `~/.pi/agent/traces/index.html` 并打开浏览器 |
| `/trace <其他>` | notify 用法提示：`Usage: /trace [all]` |

大小写不敏感（`/trace ALL` 也 work），前后空格 trim。

## 实现要点

**修改文件**：`extensions/trace/index.ts` 一处。

**新增**：`renderDashboard(opts: { open: boolean; sync?: boolean })` 辅助函数——对称于现有 `renderHtml`：
- spawn `python3 trace_to_html.py --dashboard`
- 30s timeout（与 renderHtml 一致，将来一起改）
- 成功后返回 `~/.pi/agent/traces/index.html` 路径
- `opts.open` 走 `openInBrowser(path)`

**改造** `pi.registerCommand("trace", ...)` handler：

```ts
handler: async (args, ctx) => {
    const sub = (args || "").trim().toLowerCase();
    if (sub === "" ) {
        const r = renderHtml({ open: true, sync: true });
        if (r.ok) ctx.ui.notify(`✓ trace.html → ${r.output}`, "info");
        else ctx.ui.notify(`✗ trace render failed: ${r.error}`, "error");
    } else if (sub === "all") {
        const r = renderDashboard({ open: true, sync: true });
        if (r.ok) ctx.ui.notify(`✓ dashboard → ${r.output}`, "info");
        else ctx.ui.notify(`✗ dashboard render failed: ${r.error}`, "error");
    } else {
        ctx.ui.notify("Usage: /trace [all]", "info");
    }
},
```

**description 更新**：
```
Render trace.html for this session, or /trace all for the cross-session dashboard.
```

## 验证

1. **`/trace` 保持原行为**：渲染当前 session、打开浏览器
2. **`/trace all` 生成 dashboard**：`~/.pi/agent/traces/index.html` 更新、浏览器打开、内容与 `python3 trace_to_html.py --dashboard` 一致
3. **`/trace ALL` 大小写不敏感**
4. **`/trace unknown` 显示 usage 提示**
5. **`renderDashboard` 出错**（例如 TRACES 目录不存在）时 pi 不崩、notify error

## 边界情况

- **无历史 session**：`trace_to_html.py --dashboard` 已处理（空表格 + 0 sessions），pi 端只 notify 路径即可
- **PYTHON_SCRIPT 不存在**：与 `/trace` 现有分支同样返回错误
- **30s timeout 触发**：89 个 session 全量扫实测约 5-10 秒；timeout 主要是 python 起动失败兜底
- **未来加 `--follow` 或 `/trace all --refresh`**：延后到下个闭环，本轮不实现

## 后续文档同步

- `CLAUDE.md` 的"常用命令"段增加一行
- `README.md` + `README.zh.md` 的 Usage 段：现有 `/trace` 说明后加 `/trace all` 一句、`python3 ... --dashboard` CLI 兼容保留
- `design-language.md` 无需改（不涉及视觉/信息密度）
