# 工具调用失败分析

> viewer 详情页左栏「节点统计」下方新增「工具调用失败分析」区块：按工具聚合失败次数，每次失败用**规则分类**打上原因标签（模型侧/环境侧/目标侧），可展开查看错误摘要并跳转到对应树节点。

## 目标

- 解决的真痛点：session 结束后**快速定位失败原因**——是工具调用格式错（模型侧）、还是执行环境问题（环境侧）、还是命令本身失败（目标侧）。
- 用**确定性规则分类**（正则/关键词匹配错误文本），不用 LLM。规则透明、结果稳定可解释、零 token、零依赖、可自维护。
- 纯前端实现，复用已注入的 `TRACE_DATA`（完整树）与现有 `selectNode` 跳转能力，**不改 Python 采集/统计端、不改 index.ts**。

## 非目标

- 不用 LLM 归因（准确率不可控、烧 token、违背项目 local-first/克制调性；agent 失败本就高度模式化，规则足够覆盖）。
- 不改 `index.ts` 采集端、不改 `trace_to_html.py` 的 `collect_dag_stats`。
- 不统计 `aborted`（用户中断）——那是主动取消，不是工具出错。
- 不做跨会话失败统计（dashboard 不动）、不做趋势/聚类。
- 不做「可重试/不可重试」等附加标签（后续可加）。

## 失败范围（已定）

- 只算 `status === "error"`，**不含 aborted**。
- **含 subagent 子树**的失败（子树节点已内联进 `TRACE_DATA`，DFS 天然遍历到）。
- **全算，不过滤假失败**：`grep`/`test`/`(no output)` 等「非零退出但语义上不是错误」的调用，只要 `isError` 标了就纳入——忠于采集端，不自作主张判断。这类归到「非零退出」类别（见下），与真错误视觉区分但都显示。

## 原因分类表（基于真实 session 样本）

`resultPreview` 是 JSON 字符串，格式 `{"content":[{"type":"text","text":"<真正的错误>"}],"details":{}}`。**分类前先解析出 `.content[].text` 拼接成 `errText`**；解析失败则退回原始字符串。分类按下表**从上到下首次命中**（顺序即优先级，特征强的在前）：

| 类别 (key) | 展示名 | 归属 | 匹配规则（对 errText，大小写不敏感） |
|---|---|---|---|
| `param_schema` | 参数格式错 | 模型侧 | `Validation failed for tool` |
| `edit_mismatch` | 前置不匹配 | 模型侧 | `Could not find` + (`oldText`\|`old text`) ／ `must match exactly` ／ `replacement produced identical` ／ `No changes made` |
| `not_found` | 文件/路径缺失 | 环境侧 | `No such file or directory` ／ `EISDIR` ／ `beyond end of file` ／ `command not found` |
| `dep_missing` | 依赖缺失 | 环境侧 | `ModuleNotFoundError` ／ `ImportError` ／ `No module named` |
| `timeout` | 超时 | 环境侧 | `timed out` ／ `curl: (28)` ／ `Operation timed out` |
| `permission` | 权限/拒绝 | 环境侧 | `Permission denied` ／ `EACCES` ／ `not permitted` |
| `script_error` | 脚本异常 | 目标侧 | `Traceback (most recent call last)` ／ `SyntaxError` ／ `Error:` ／ 其它语言异常关键词 |
| `nonzero_exit` | 非零退出 | 目标侧 | `Command exited with code` ／ `exited with code`（**兜底在真错误之后**——很多是 grep/test 假失败） |
| `other` | 其他/需人工 | — | 以上都不命中 |

规则表在 `viewer.js` 里以数组常量维护（`FAIL_RULES = [{key, label, side, test}]`），**新增类别只加一行**，符合 §2.3 additive。

- 归属（`side`）三色：模型侧 `--accent`（蓝，你的锅可优化）、环境侧 `--warn`（黄）、目标侧 `--muted`（灰，常常是符合预期的失败）。
- `other` 用中性灰，提示用户「规则没覆盖，看原文」。

## UI

位置：`viewer.html` 的 `.dag-pane`（节点统计）之后，新增同级 `.fail-pane`，仍在 `.tree-pane` 内。

主维度**按工具聚合**，原因类别作为每条 item 的标签：

```
┌─ 工具调用失败分析 ──────────────┐   ← .fail-title（无失败时也在）
│ 🔧 bash   ✕8   ▾               │   ← .fail-tool（聚合行，可点击展开）
│   ⟦超时·环境⟧ curl: (28) Ope…↗ │   ← .fail-item：⟦类别标签⟧ + 错误摘要 + ↗跳转
│   ⟦脚本异常·目标⟧ Traceback…  ↗ │
│ 🔧 edit   ✕5   ▸               │
│ 🔧 read   ✕3   ▸               │
└─────────────────────────────────┘
```

零失败态：`.fail-title` + 一行中性小字「✓ 无工具失败」（`.fail-empty`，`--muted` 色，不用绿色，遵循 §2.6 健康时安静）。

交互：
- 聚合行默认折叠（`▸`）。点击整行切换展开（`▾`），展示该工具下每次失败的 `.fail-item`。
- `.fail-item` = 类别标签 pill（`.fail-tag`，按 `side` 着色）+ 错误摘要（`errText` 首行/前 ~120 字符，单行 ellipsis 截断）+ 尾部 `↗`（`.fail-jump`）。
- `.fail-jump` 点击调用 `selectNode(nodeId)`——复用现有高亮+滚动逻辑（`viewer.js:87-90`），并 `e.stopPropagation()` 防止触发折叠切换。

## 过滤/算法规则

**数据源**：`TRACE_DATA`（完整树，含 subagent 子树），前端 DFS 遍历。

**失败节点判定**：`node.type === "tool" && node.status === "error"`。（`status` 唯一来源是采集端 `isError` 布尔；不看文本判失败。）

**聚合键**：`node.data.toolName || node.name`（与 `collect_dag_stats` 口径一致，`trace_to_html.py:791`）。

**每个失败节点提取**：
- `nodeId` = `node.id`（用于 `selectNode` 跳转）
- `errText` = 解析 `node.data.resultPreview` 的 `.content[].text`（解析失败退回原串；空则「（无错误详情）」）
- `category` = 对 `errText` 跑 `FAIL_RULES` 首次命中（空文本直接 `other`）

**聚合结构**（前端内存，不落 JSON）：
```
[{ toolName, icon, count, items: [{nodeId, errText, category}] }, ...]
```
外层按 `count` 降序（与节点统计排序一致）。

**图标**：工具节点统一 `🔧`。

## 实现要点

改动文件：`viewer.html`、`viewer.css`、`viewer.js`。改完 **必须跑 `python3 extensions/trace/viewer/build.py`** 重建 `assets.json`，否则 `trace_to_html.py` 仍用旧模板。

1. **viewer.html**：在 `.dag-pane` 闭合（`:33`）后加：
   ```html
   <div class="fail-pane">
     <div class="fail-title">工具调用失败分析</div>
     <div class="fail-list" id="fail-list"></div>
   </div>
   ```

2. **viewer.js**：
   - `FAIL_RULES` 常量数组（上表），每项 `{key, label, side, test:(s)=>bool}`。
   - `parseErrText(resultPreview)`：解析 JSON 取 `.content[].text` 拼接；`try/catch` 退回原串。
   - `classifyFailure(errText)`：空→`other`；否则遍历 `FAIL_RULES` 首次命中返回 `{key,label,side}`。
   - `collectToolFailures(root)`：DFS 遍历（可遍历现有 `NODE_INDEX` 值，`viewer.js:130`），收集失败节点并聚合成上述结构。
   - `renderToolFailures()`：读 `#fail-list`，无失败渲染 `.fail-empty`；有失败渲染聚合行 + 折叠详情。DOM 用现有 `el()`/`setText()` helper（与 `renderDag` 同风格）。
   - **错误文本一律 `setText`（非 `innerHTML`）**——`resultPreview` 是工具原始输出，防 HTML/脚本注入。
   - `DOMContentLoaded`（`:688` `renderDag()` 旁）调用 `renderToolFailures()`。

3. **viewer.css**：新增 `.fail-pane`（沿用 `.dag-pane` 的 `border-top`/`padding`/`max-height`/`overflow-y`）、`.fail-title`（同 `.dag-title`）、`.fail-tool`（聚合行，`cursor:pointer`，`✕N` 用 `--err` 色）、`.fail-item`（缩进、flex、单行 ellipsis）、`.fail-tag`（pill，`side` 三色：`--accent`/`--warn`/`--muted`）、`.fail-jump`（`↗`，hover 变色）、`.fail-empty`（`--muted`）。折叠态复用 `.collapsed`/`.hidden` class 约定。

## 验证步骤

1. 跑 `build.py` 重建 assets，`trace_to_html.py <session>` 渲染真实 session（本机 `~/.pi/agent/traces` 有含大量 bash/edit 失败的真实样本）。
2. Playwright headless 打开 trace.html：
   - 有失败 session：区块在节点统计下方；聚合行失败数正确；展开每条带正确类别标签；点 `↗` 跳转并高亮对应树节点。
   - 抽查分类正确性：`Validation failed`→参数格式错、`Could not find…oldText`→前置不匹配、`curl: (28)`→超时、`Traceback`→脚本异常、`grep` 假失败→非零退出。
   - 零失败 session：显示「✓ 无工具失败」中性态，不描红。
   - 含 subagent 失败 session：子 agent 内部工具失败被纳入。
3. 核对各工具失败总数与「节点统计」里同名工具的 `err` 数一致（同口径自洽）。

## 边界情况

- **resultPreview 为空/非预期 JSON**：`parseErrText` 退回原串或空占位「（无错误详情）」，分类 `other`，不崩。
- **同名工具多次失败**：聚合一行，count 累加，items 列全部（各自带自己的类别）。
- **一个工具多种失败原因**：正常——聚合行是工具维度，展开后每条 item 各自带类别标签（如 bash 既有超时又有脚本异常）。
- **subagent 派生 tool 节点**（`_subagentDerived`）：同样按 `status==="error"` 判定并分类。
- **失败节点在折叠树枝里**：`selectNode` 滚动到 `.node-row`；若父节点折叠致不可见，属现有 `selectNode` 行为，本功能不额外展开父链（列 What's next）。
- **老 session（无 resultPreview）**：`?.` 兜底，errText 空占位，分类 `other`，遵循 §2.3 additive。
- **XSS 防御**：错误文本一律 `setText`，绝不 `innerHTML`。

## What's next（不在本次范围）

- 跳转时自动展开失败节点的父链（当前依赖用户已展开）。
- 「可重试/不可重试/需人工」附加标签。
- `other` 类别占比过高时提示「补充规则」——用真实数据迭代分类表。
