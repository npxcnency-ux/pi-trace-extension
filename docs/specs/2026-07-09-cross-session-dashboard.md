# Trace Viewer：跨会话 Dashboard

## 背景

每次 pi session 结束会在 `~/.pi/agent/traces/<session-id>/` 下留 `events.jsonl` + `trace.html`。截止 2026-07-09 已经 89 个 session。想回答"本周花了多少 token""上次那个失败的 session 在哪"这类全局问题时，只能翻目录。

## 目标

- `python3 trace_to_html.py --dashboard` 生成 `~/.pi/agent/traces/index.html`
- 一屏看清：本周概况、历史全局账、每个 session 点进去能跳到已有 trace.html

## 非目标

- 不自动生成（不改 `index.ts` 扩展代码，不在 session 结束时更新）
- 不做增量索引缓存（89 session 全量扫描性能可接受，加缓存徒增删除同步的复杂度）
- 不做 metadata 摘要预写入（同上）

## 触发

**命令**：`python3 trace_to_html.py --dashboard`

- 扫描 `~/.pi/agent/traces/*/events.jsonl`
- 每个 session 线性读一次，提取汇总字段（不构建完整 tree）
- 汇总写入 `~/.pi/agent/traces/index.html`
- 输出终端提示：`✓ Wrote index.html (89 sessions)  →  open ~/.pi/agent/traces/index.html`

## 页面结构

### 顶栏 KPI（双行）

**Row 1 — 本周（近 7 天，以本地时区当前时刻回溯）**：
- Sessions（数量）
- Cost（USD 累计）
- Duration（本周实际会话总时长）

**Row 2 — 全局**：
- Sessions（历史总数）
- Cost（历史总 USD）

### 表格（每行一个 session，8 列）

| 列 | 内容 | 排序键 |
|---|---|---|
| 时间 | `YYYY-MM-DD HH:mm`（本地时区） | timestamp |
| Session | id 前 8 位，`<a href="./{sid}/trace.html">` | id 字母序 |
| 提问预览 | 首个 `interaction_start.prompt` 前 60 字符 + `…` | prompt 字母序 |
| 项目 | `session_start.cwd` 的 basename | 字母序 |
| 规模 | `{interactions} · {turns} · {tools}`（三段紧凑显示） | tools 数 |
| Tokens | 总 tokens（input + output + cacheRead，人性化 `1.2k` / `340k`） | 数值 |
| Cost | `$0.032` / `$1.24`（保留 3 位） | 数值 |
| 时长 | `2m 34s` / `1h 12m` | 数值 |

**状态指示**：每行最左边一个 4px 竖条：
- 有 error → 红色 (`--err`)
- 有 aborted 但无 error → 黄色 (`--warn`)
- 全 ok → 绿色 (`--ok`)

**默认排序**：时间倒序（新在上）

### 交互

**搜索框**（顶栏右侧）：
- 单个 input，实时过滤（同 viewer 的 `input` 事件模式）
- 匹配任一：prompt 预览、session id、项目名（大小写不敏感）

**列头点击排序**：
- 每个可排序列头带一个 sort indicator (`↕` / `↑` / `↓`)
- 点一次升序，再点降序，再点回默认（时间倒序）
- 单列排序（不做多列）

**项目 chip 过滤**：
- 表格上方一行 chip：`All | project-a (23) | project-b (15) | ...`
- 只列 session 数 ≥3 的项目，其余归到 `Others`
- 点击某 chip = 只显示该项目的 session
- 与搜索/排序叠加

## 数据提取

**每个 session 的 SessionSummary**：
```python
{
  "id": str,           # 从目录名或 session_start.sessionId
  "startedAt": int,    # session_start.ts (ms)
  "endedAt": int,      # 最后一条事件的 ts
  "durationMs": int,
  "cwd": str,          # session_start.cwd
  "cwdName": str,      # basename(cwd)
  "firstPrompt": str,  # 第一条 interaction_start.prompt (截断 60 字符)
  "interactionCount": int,
  "turnCount": int,
  "toolCount": int,
  "errorCount": int,   # tool_end isError=true + step 里 stopReason=error
  "abortedCount": int, # stopReason=aborted
  "totalInput": int,
  "totalOutput": int,
  "totalCacheRead": int,
  "totalCost": float,
  "models": [str, ...]  # 出现过的模型（去重，可能后期展示）
}
```

**扫描规则**：
- 只读 events.jsonl 首末尾 + 逐行累加：不 build tree
- 遇到 ghost session（0 事件 or 只有 session_start）→ 跳过，不入表

## 实现要点

**新增文件**：
- `extensions/trace/viewer/dashboard.html`（模板）
- `extensions/trace/viewer/dashboard.js`（表格交互）
- `extensions/trace/viewer/dashboard.css`（复用大部分 viewer.css 变量，只加表格特定样式）

**修改文件**：
- `extensions/trace/trace_to_html.py`：
  - 加 `argparse`：`--dashboard` 触发新分支，无参 = 沿用现有 latest session 行为
  - 新增 `extract_summary(session_dir) -> SessionSummary` 函数
  - 新增 `render_dashboard(summaries: list) -> str`
  - `build.py` 更新：把 `dashboard.html/js/css` 也打进 `assets.json`

**注入方式**（与 trace.html 一致）：
- `dashboard.html` 有 `{{SUMMARIES}}` / `{{KPI}}` / `{{CSS}}` / `{{JS}}` 占位符
- Python 端一次性 replace，输出自包含单文件

## 验证

1. **完整性**：`ls ~/.pi/agent/traces/ | wc -l` = dashboard 行数（排除 ghost）
2. **本周 KPI**：手动 `find ~/.pi/agent/traces -maxdepth 1 -type d -mtime -7 | wc -l` 应与 KPI 中的 sessions 数一致
3. **点击跳转**：随便点一行 → 打开对应 session 的 trace.html
4. **搜索**：搜项目名，只留该项目 session；清空后恢复全部
5. **排序**：点 Cost 列头 → 降序按成本排；再点 → 升序；再点 → 时间倒序
6. **项目筛选**：点 chip → 只留该项目；点 All 恢复
7. **状态指示**：找一个有错误的 session（比如 0.1.5 之后），左边应为红条

## 边界情况

- **ghost session**（events.jsonl 为空或只有 session_start）：跳过，不入表
- **进行中 session**（在你 dashboard 生成时还没结束）：仍显示，但 endedAt = 最后事件 ts，durationMs 会偏短——可接受
- **prompt 缺失**：显示 `(no prompt)`
- **cwd 缺失**：显示 `(unknown)`，chip 归到 `Others`
- **单个 session 的 events.jsonl 损坏**：try/except 跳过该 session，不阻断其余
- **传统 `<session>` 位置参数与 `--dashboard` 互斥**：`--dashboard` 时忽略位置参数
