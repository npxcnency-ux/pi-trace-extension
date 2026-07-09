# Trace Viewer：补齐 compact / thinking_change 事件的可视化

## 背景

`index.ts` 采集了 `compact` 和 `thinking_change` 两类事件（`extensions/trace/index.ts:483, 486`），但 `trace_to_html.py` 从未处理它们——数据白采。

- **compact**（`pi.on("session_compact")`）：pi 静默压缩上下文历史，出问题时肉眼看不见发生了什么
- **thinking_change**（`pi.on("thinking_level_select")`）：模型思考深度切换（off / low / medium / high），影响后续 turn 的行为但界面无痕

## 目标

在左侧树里显式化这两类事件，让 debug 会话时能一眼看到它们发生的时机和上下文。

## 非目标

- 不做 retry 汇总（下一个闭环再考虑）
- 不改 dashboard（这两类事件的**跨 session 聚合**价值低，个人使用几乎不用）
- 不改采集层（数据已就位）

## 展示形态

**compact** 事件 → 左侧树节点（发生频率低，作为独立节点合理）。

**thinking_change** 事件 → 右侧详情面板（session/interaction/turn 层）的 `Thinking Changes` section，与 `Model Changes` 同风格。**不进树**——用户测试时可能一个 interaction 内切几十次，进树会淹没有效信息。

### compact 节点

**位置**：左侧树，作为树节点插入到**事件时间戳所处的层级**。

**归属规则**（按事件顺序流式处理，维护当前 interaction / turn 游标）：

1. 事件带 `turnIndex` 且当前 turn 游标匹配 → 挂在当前 turn 下作为兄弟节点
2. 事件带 `turnIndex` 但不匹配任何已开始的 turn → 挂在当前 interaction 下
3. 无 `turnIndex` 或没有活跃 interaction → 挂在 session 根下

**节点样式**：

| 事件 | icon | name |
|---|---|---|
| compact | 💾 | `compact` |

### thinking_change：右侧详情 section

- **数据流**：`build_tree` 收集所有 `thinking_change` 到全局 `thinking_changes` 列表，冒泡到当前 turn / interaction 的 `data.thinkingChanges`
- **UI**：`Thinking Changes` section 出现在 session / interaction / turn 详情里，与 `Model Changes` 同格式（每行 `ts  prev → new`）

**节点属性**：
- `type`: `"compact"` / `"thinking_change"`
- `status`: `"ok"`（不参与错误统计）
- `start` = `end` = 事件 `ts`
- `duration_ms`: null（点事件，viewer 已支持 null）
- 无 children

**右侧详情**：新增 case 分支渲染 metadata：
- compact：显示 `compactionEntry` JSON、`fromExtension` 布尔
- thinking_change：显示 `previousLevel → level`、`turnIndex`

## 实现要点

**修改文件**：
- `extensions/trace/trace_to_html.py`：
  - `build_tree` 加两个 elif 分支处理 `compact` / `thinking_change`
  - 需要一个"挂载游标"辅助函数：`attach_point(ev, tree_state) -> parent_node`
- `extensions/trace/viewer/viewer.js`：
  - `renderDetail` 加 `else if (t === "compact")` / `else if (t === "thinking_change")` 分支
  - 现有 status/name/toggle 逻辑（`renderNodeRow`）无需改动，新 type 自然复用

**归属游标算法**：
```
在 build_tree 遍历事件时维护：
- current_interaction: 最新未闭合的 interaction 节点
- current_turn: 最新未闭合的 turn 节点

遇到 compact / thinking_change：
    p = None
    if ev.turnIndex is not None and current_turn and current_turn.turnIndex == ev.turnIndex:
        p = current_turn
    elif current_interaction:
        p = current_interaction
    else:
        p = root
    p.children.append(new_node)
```

**节点识别**：viewer 那边 `renderNodeRow` 的 `statusIcon` 会用 `n.icon`（如提供）覆盖 status icon——直接给节点写 `icon: "💾"` / `icon: "🧠"` 即可，无需改 CSS 或图标逻辑。

## 验证

1. **有 compact 的 session**：找 `2026-06-11T07-36-31-...`（已知有 compact 事件），渲染后：
   - 树里能看到 💾 节点
   - 归属层级正确（挂在对应 turn/interaction 下）
   - 点开节点显示 compactionEntry
2. **有 thinking_change 的 session**：同一 session（已知有 `off → high` 切换）
3. **无这两类事件的 session**：找一个纯净的，验证树里无幽灵节点，也无 JS 错误
4. **只看错误 filter**：确认 compact / thinking_change 节点默认过滤掉（它们 status=ok）

## 边界情况

- **compact 事件在 session_start 之前**（几乎不可能，但保险）：挂 session 根
- **thinking_change 早于第一个 interaction**：挂 session 根
- **compact 携带的 compactionEntry 是字符串还是 dict**：从样本看是字符串（Python 端序列化），viewer 显示时用 textBlock 而非 renderJsonRoot
- **多个 compact 事件在同一个 turn 里**：都作为兄弟节点挂，顺序保留
- **sub-agent trace 里的这两类事件**：独立处理，不跨 trace 冒泡（sub-agent 已有独立 trace.html）
