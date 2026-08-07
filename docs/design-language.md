# pi-trace-extension 设计语言

一份收敛已经做出的取舍。**规则**在这里，**为什么**也在这里；实现细节留在代码里，历史留在 git。

代码里可以引用 `// 见 design-language.md §3.1`；PR 评审可以引用 `违反 §4——thinking_change 属于高频流式，不应进树`。

---

## §1 · 定位

**给谁**：Pi CLI 用户，把 session 结束后想回头看一眼的场景当刚需的人。

**做什么**：把 pi lifecycle 事件重组成 Langfuse 风格的执行树，本地生成一个自包含的 HTML 查看器（`trace.html`）+ 跨会话账本（`index.html`）。

**跟谁互补，不跟谁重叠**：

| 生态位 | 谁 | 用户价值 |
|---|---|---|
| 实时终端反馈 | [pine-of-glass](https://www.npmjs.com/package/pine-of-glass) | 会话进行中的即时可见性 |
| 云同步 | [observal-pi](https://www.npmjs.com/package/observal-pi) | 跨设备、团队访问 |
| **本地事后 replay** | **pi-trace-extension** | 事后 debug、跨会话账本 |

这三者不是竞争关系。想要哪种能力就装哪个扩展，或者三个都装。

---

## §2 · 六大原则

### §2.1 · Fail-open first
宿主 pi 稳定性 > 本扩展数据完整性。任何 I/O 异常、任何 handler 抛错，扩展进入 `disabled` 单向门，静默丢事件，pi 主进程不受影响。**永远不能因为 trace 让 pi 崩**。

**但 fail-open ≠ 静默吞异常。** 这条只约束 `pi.on` handler 那条**宿主链路**——那里"别崩"压倒一切。离线工具脚本（`trace_to_html.py` / `build.py`）不在宿主进程里，崩了也伤不到 pi，它们的异常**必须暴露真实错误**，绝不能 `except: pass` 吞掉后抛一个误导性兜底信息。反例见 [#1](https://github.com/npxcnency-ux/pi-trace-extension/issues/1)：`assets.json` 读取因 Windows 编码抛 `UnicodeDecodeError` 被静默吞，伪装成"文件缺失"，用户反复 `build.py`、挪文件都无解，因为真正的错被藏起来了。判断法：**这段代码崩了会不会连累 pi？不会 → 让它把真实异常喊出来。**

### §2.2 · Local-first
无网络调用。用户 prompt、tool args、tool 输出、模型响应全部只写本地磁盘。任何新增网络请求必须默认关闭且 README 明确说明。

### §2.3 · Additive only
新事件类型不能破坏老 viewer。新增字段用 `optional`，删除字段前先在 viewer 里做 `?.` 兜底一版。events.jsonl 是 append-only 追加流，历史 session 永远能被新版 viewer 打开。

### §2.4 · Everything in one file
`trace.html` 是自包含单文件。CSS/JS 打包进 `viewer/assets.json`、注入 HTML；不加载 CDN、不加载字体、不发起任何网络请求。`file://` 双击就能打开。

### §2.5 · Skimmable first, drillable second
一眼扫（顶栏 KPI、颜色态、图标）；二眼查（点开 tree node → 右侧详情 → Metadata 段）。信息不是一次全铺开，是分层揭示。

### §2.6 · Silence when healthy
无异常时无干扰。DAG 统计里 `has-err` 才描红边框，正常节点保持中性色。dashboard 色条软化以避免"一片红"警报感。视觉上让健康 session 看起来就是安静的。

---

## §3 · 视觉语法

### §3.1 · 色板

两套 severity 色，**警报感与场景匹配**：

| 场景 | 变量 | 说明 |
|---|---|---|
| trace viewer（单会话调试）| `--err / --warn / --ok` | 醒目色，帮助一眼定位失败点 |
| dashboard（跨会话账本）| `--dash-err-soft / --dash-abort-soft / --dash-ok-soft` | 软化色（琥珀/淡橄榄/浅灰），避免"一片红"的警报感 |

**为什么两套**：debug 一个失败 session 时你需要红色抓你的眼；扫 60 个历史 session 时全屏红色反而信息为零。

### §3.2 · 图标语义

同一符号语义全项目一致。加新事件类型前，先看是否能复用现有图标：

| 符号 | 含义 | 类别 |
|---|---|---|
| `❌` | error | status |
| `⏹` | aborted (user cancel) | status |
| `⏳` | in_progress | status |
| `📋` | session | event kind |
| `👤` | interaction (user 提问) | event kind |
| `↔` | turn (一次模型调用轮次) | event kind |
| `🧠` | step (LLM call in turn) | event kind |
| `💾` | compact (上下文压缩) | event kind |

**status 符号 vs event kind 符号可以叠加**：一个 step 节点默认 `🧠`，如果失败会被 `❌` 覆盖。

### §3.3 · 数字格式

所有跨模块显示的数字**必须**用现成 `fmt*` 函数，不要自己写 `.toFixed` 或字符串拼接。

| 函数 | 场景 | 例子 |
|---|---|---|
| `fmtTokens(n)` | tokens 数量 | `1.2k` / `340k` / `12.3M` |
| `fmtMs(ms)` | 时长 | `230ms` / `2.4s` / `1m 34s` / `2h 15m` |
| `fmtMoney(x)` | USD 成本 | `$0` / `$0.0032` / `$1.240` |
| `fmtInt(n)` | 计数 | `1,234` |

**为什么强制统一**：不同函数格式导致同一份数据在不同视图里看起来不一样，用户会以为是 bug。

---

## §4 · 信息密度三档

**决策 heuristic**：加一类新数据前，先判断它属于哪档，再决定放哪里。

| 密度 | 位置 | 典型例子 | 反面例子 |
|---|---|---|---|
| 稀疏、一次性 | **左侧树节点** | `compact`（一个 session 出现 0-3 次）| `thinking_change` 不合适——测试时会一分钟切几十次 |
| 高频、流式、易泛滥 | **右侧详情面板 section** | `thinking_change`、`model_change` | 不适合放树里被稀释 |
| 跨会话聚合 | **dashboard KPI 卡 或表格列** | 本周 tokens、tool errors 总数 | 具体某次 turn 的 stop_reason 不合适（属单 session 数据）|

**教训 case**（真实故事）：`thinking_change` 首版进树，一个测试 session 里有 36 个节点堆在一个 interaction 下，把有效信息全挤出屏幕。修法：改进详情 section。见 [docs/specs/2026-07-09-render-hidden-events.md](specs/2026-07-09-render-hidden-events.md) 的"展示形态"pivot 记录。

**判断准则**：如果这类事件**极端场景下**可能一个 session 里出现 20+ 次，直接扔详情 section；如果通常 &lt;5 次，进树。

---

## §5 · 不做 X

明确画出边界，为将来拒绝不合适的 feature request 提供依据。

### §5.1 · 不做实时 TUI 反馈

现在或将来都不做"pi 跑一半就更新 trace"、"侧边栏实时 tokens"、"终端里的进度条"。

**为什么**：那是 [pine-of-glass](https://www.npmjs.com/package/pine-of-glass) 的领域，它做得已经很成熟。本扩展如果同时做实时 + 事后，两个定位都会稀释。**工具应互补，不重叠**。

### §5.2 · 不做云同步

现在或将来都不做"把 events.jsonl 推到远程服务器"、"跨设备同步 trace"、"账号系统"。

**为什么**：违反 §2.2 · Local-first。用户下载本扩展的隐含约定是"数据不出机器"。想上云用 [observal-pi](https://www.npmjs.com/package/observal-pi)。加了云同步就把这个信任拿掉了。

### §5.3 · 不做多用户 dashboard

现在或将来都不做团队协作 dashboard、多账号视图、权限系统。

**为什么**：面向个人使用（YAGNI）。真需要多人共享 trace 数据的场景，[Langfuse self-hosted](https://langfuse.com) 是自然的升级路径——数据模型刻意设计成兼容它。

### §5.4 · 不做自动脱敏

不写 CLI scrubber 之类的"发布前脱敏工具"。

**为什么**：定位是"服务个人"（见 §1），无分享场景 = 无信任缺口 = 无脱敏需求。如果未来定位变了，可以放开这条。

---

## 引用规范

- 代码里引用文档：`// 见 design-language.md §3.1`
- PR 评审引用：`违反 §4——xxx 属于高频流式，不应进树`
- 新增章节时保留原编号，只往后追加子节（比如 §5.5）；避免历史引用失效

历史：本文档演化在 git 里；每次修订应能通过 `git log docs/design-language.md` 追溯背后的 spec。
