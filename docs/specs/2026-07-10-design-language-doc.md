# Spec: 写 docs/design-language.md

## 背景

项目已发布 0.1.10，npm 下载 ~1200/月，作者准备长期维护。CLAUDE.md 里已有 UI 决策规则的 10 行摘要，但正式的设计语言文档还没写。散落的决策依据分布在 3 份 spec + git history + 3 次 pivot 经验里，需要收敛。

参考：pine-of-glass 的 [design-language.md](https://github.com/tmustier/pine-of-glass/blob/main/docs/design-language.md) 定义了很好的骨架——**规则 + 为什么** 分开，实现细节留在代码里。

## 目标

产出 `docs/design-language.md`，让未来自己和 AI 协作者能：
- 在改 UI 前先对齐**已有的取舍**
- 在审 PR 时能引用 `§N.M` 具体规则
- 在收到不合适的 feature request 时能引用"不做 X"节回复

## 非目标

- 不是使用教程（README 承担）
- 不是 API 参考（events schema 单独文档）
- 不是完整的开源贡献指南（暂无需求）
- 不写实现细节（那属于代码注释 + git history）

## 结构（5 节，~150 行）

### §1 · 定位（~10 行）

三句话说清：
- 谁用（Pi CLI 用户，个人复盘场景）
- 什么场景（事后回看 session、debug、跨会话账本）
- 和谁互补（pine-of-glass = 实时仪表盘，observal-pi = 云同步；本项目 = 本地黑匣子）

### §2 · 6 大原则（~30 行）

每条一句原则 + 1-2 句解释：

1. **Fail-open first**：宿主 pi 稳定性 > 数据完整性
2. **Local-first**：无网络调用，用户数据不出机器
3. **Additive only**：新事件类型不能破坏老 viewer
4. **Everything in one file**：单 HTML、零外部资产、file:// 直接打开
5. **Skimmable first, drillable second**：一眼扫，二眼查
6. **Silence when healthy**：无异常时无干扰

### §3 · 视觉语法（~35 行）

- **§3.1 色板**：`--err/--warn/--ok` (viewer 醒目) vs `--dash-err-soft/--dash-abort-soft/--dash-ok-soft` (dashboard 软化)。规则：警报感与场景匹配
- **§3.2 图标语义表**：Markdown 表格
  | 符号 | 含义 | 使用位置 |
  |---|---|---|
  | `❌` | error | status |
  | `⏹` | aborted | status |
  | `⏳` | in_progress | status |
  | `💾` | compact | event |
  | `↔` | turn | event |
  | `🧠` | step (LLM call) | event |
  | `👤` | interaction | event |
  | `📋` | session | event |
- **§3.3 数字格式**：所有跨模块数字必须用 `fmt*` 系列函数。规则表 `fmtTokens/fmtMs/fmtMoney/fmtInt` 的场景归属

### §4 · 信息密度三档（~30 行）

**决策 heuristic**：新加一类数据前先判断它属于哪档。

| 密度 | 位置 | 例子 | 反例 |
|---|---|---|---|
| 稀疏一次性 | 左侧树节点 | compact 事件 | thinking_change（会泛滥）|
| 高频/流式 | 右侧详情 section | thinking_change、model_change | ⛔ tool_end（每个都进树才对）|
| 跨会话聚合 | dashboard KPI/表格列 | 本周 tokens、tool errors | ⛔ 具体某次 turn 的 stop_reason |

**规则 + 反面例子** 让读者知道边界。

### §5 · 不做 X（~25 行）

3 条 + 各 3-5 行理由：

- **不做实时 TUI**：那是 pine-of-glass 的地盘；如果加，会稀释本项目"事后 replay"定位；工具应互补不重叠
- **不做云同步**：违反 `--local-first`；observal-pi 已经填了这个坑；用户想上云用它
- **不做多用户 dashboard**：YAGNI；面向个人使用；如果真需要多人协作，Langfuse self-hosted 是自然升级路径

## 引用规范

代码引用文档：注释里写 `// 见 design-language.md §3.1`。PR 评审引用：`违反 §4——thinking_change 属于高频流式，不应进树`。

## 实现要点

- 先落到 `docs/design-language.md`，README 顶部加一行链接
- 每条原则尽量引用具体 spec 或 commit（比如 §4 的反例可以链到 `docs/specs/2026-07-09-render-hidden-events.md`）
- CLAUDE.md 里现有的"UI 决策规则"一节 → 缩为 3 行引用到 design-language.md，避免双向同步维护
- 完成后：`git log` 里能看到最初写作 commit，未来变更保留在 git history

## 验证

- **规则明确性**：每条能不能用来审 PR？（"违反 §X.Y"能引得起来）
- **无实现细节泄漏**：不出现具体 CSS class 名、TS 函数签名——那些在代码里
- **无内容重复**：CLAUDE.md 缩为引用、README 不重复原则

## 边界情况

- **CLAUDE.md 里的"UI 决策规则"重复**：写完 design-language.md 后 CLAUDE.md 里那段改为 "详见 docs/design-language.md §3-§4"，避免两处维护
- **未来加新事件类型**：应先决定它属于 §4 哪档，spec 里显式引用
- **未来加"不做 X"**：直接扩 §5，加时间戳标注决策日期
