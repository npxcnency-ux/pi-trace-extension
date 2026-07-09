# Trace Viewer：`只看错误` 过滤开关

## 背景

`trace.html` 目前用颜色区分 `ok / error / aborted` 三态。session 长时（几百节点）虽然肉眼能看到红黄，但定位失败点仍要滚动 + 搜索文本。加一个显式的"只看错误"过滤开关，让 debug 场景一次点击就聚焦。

## 目标

- 单击工具栏按钮，树里只保留 `error / aborted` 节点及其从根到叶的完整祖先路径
- 与已有标题搜索框叠加（AND）
- 无错误时按钮不可用（disabled），避免用户困惑"点了没反应"

## 非目标

- 不修改 DAG 面板（保持全局聚合视角）
- 不跨 sub-agent trace（sub-agent 有自己的 trace.html，各自独立）
- 不加键盘快捷键（YAGNI，等有需要再加）
- 不做 `All | Errors | Aborted` 分段控件（当前 error/aborted 合起来看足够，分开是过度设计）

## UI

**位置**：`viewer.html` 里 `.tree-toolbar` 内，紧接 `折叠全部` 按钮之后。

**形态**：toggle 按钮，样式与旁边两个按钮对齐。

- 未激活：`❌ 只看错误`，普通按钮样式
- 激活：pressed 状态（背景加深，同现有 pressed 视觉约定；如无则加 `.toolbar-btn.active` 样式）
- 不可用：整棵 trace 无 `error / aborted` 节点时 `disabled`，鼠标 hover 显示 tooltip `此 trace 无错误节点`

## 过滤规则

给定条件 `onlyErrors: boolean` 和 `query: string`：

1. **节点自身是否命中**：
   - `onlyErrors=false`：视 `query` 是否匹配当前节点文本
   - `onlyErrors=true`：`status ∈ {error, aborted}` **且** `query` 匹配（空 query 视为匹配全部）
2. **祖先保留**：一次自底向上 DFS，若节点自身命中，或其任一后代命中，则该节点 `keep=true`
3. **应用**：`keep=false` 的节点行 `display: none`

祖先保留是核心——保留 `session → interaction → turn → step` 的路径感，debug 时才知道错误出自哪个 turn。

## 实现要点

**改动文件**：
- `extensions/trace/viewer/viewer.html`：加按钮
- `extensions/trace/viewer/viewer.js`：抽出统一 filter pipeline
- `extensions/trace/viewer/viewer.css`：按钮 active/disabled 样式（如缺）

**JS 关键改造**：
- 现有 `applySearch()` 只按 query 过滤。抽出 `applyFilters(query, onlyErrors)` 承担 AND 逻辑
- 提供 `hasAnyErrors()` 一次性扫描，用于初始化按钮 disabled 状态
- 页面级状态：`state = { query, onlyErrors }`，两个输入源都调 `applyFilters(state.query, state.onlyErrors)`

**算法**：一次 DFS 标记 keep。
```
function markKeep(node):
    selfHit = matchQuery(node, query) && (!onlyErrors || isErrLike(node))
    childHit = any(markKeep(c) for c in children)
    node.keep = selfHit || childHit
    return node.keep
```

节点行 `display` 直接由 `node.keep` 决定；开关**打开**时强制一次 expand-all，防止用户预折叠的分支把祖先 `display:none` 掩盖过滤结果。关闭时不恢复原折叠状态（保持简单，用户可再点「折叠全部」）。

## 验证

1. **有错误 session**：找一个包含 `error/aborted` 的 session（0.1.5 之后应有留档），勾选后：
   - 手动数树里红/黄行的数量 = 剩余可见的 error/aborted 节点数
   - 每个可见错误节点向上追溯，祖先全部可见
2. **叠加 search**：勾选 + search "http"，只应剩下"错误 且 包含 http"的节点及其祖先
3. **纯净 session**：找一个无错误 session，按钮应为 disabled
4. **切换回**：再次点击按钮，恢复原状（所有节点可见）

## 边界情况

- **query 与 onlyErrors 都空/false**：等于当前默认行为，所有节点可见
- **query 匹配错误节点的祖先文本，但节点本身非错误**：`onlyErrors=true` 下，该祖先不算命中；但若其后代含 error 命中，仍会因祖先保留而可见——这是想要的行为
- **retry 场景**（0.1.5 引入）：如果 retry 前是 error 后是 ok，是否算错误？——按当前 status 字段值来，写入 events 时它是什么就是什么，本 spec 不做特殊处理
