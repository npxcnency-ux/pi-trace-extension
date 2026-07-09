# pi-trace-extension · Claude 协作指引

## 项目定位

个人使用的本地 pi-agent trace 查看器。**不面向分享/团队**——数据脱敏、云同步、多租户之类的方向不做。

## 开发工作流：四阶段闭环

非平凡功能（新增能力、修改现有行为、多文件改动）**默认走四阶段**。纯 bug fix / typo / 单行调整可跳过。

### 1. 创意
- Explore（子 agent，`subagent_type: "Explore"`）扫代码库找候选或验证假设
- **一次一个** `AskUserQuestion` 磨清关键决策（祖先保留/范围/AND-OR/UI 形态之类）
- 小任务 3-4 个决策就够，别过度问

### 2. 拆解
- 写 spec 到 `docs/specs/YYYY-MM-DD-<topic>.md`
- 必含：**目标 / 非目标 / UI（若有） / 过滤/算法规则 / 实现要点 / 验证步骤 / 边界情况**

### 3. 执行
- 按 spec 施工，改完立即用**真实 session + Playwright headless** 跑一轮实测
- viewer 前端改动改的是 `viewer.{html,css,js}` 或 `dashboard.{html,css,js}` 源文件，**必须跑 `python3 extensions/trace/viewer/build.py` 重建 assets.json**，否则 `trace_to_html.py` 仍用旧模板

### 4. 验证
- 用 `code-review` skill 对着 spec 双轴审（Standards + Spec）
- 修 review 抓到的 bug → 手动过一遍 spec 里"验证"清单

**触发信号**：用户说"帮我加"/"想实现"/"改一下"某个非平凡功能。

## 项目关键约束

- **无新增运行时依赖**：Python stdlib + Node built-ins only
- **无网络调用**：任何新增网络请求必须默认关闭 + README 明确说明
- **附加式演进**：新事件类型对老 viewer 必须降级友好
- **构建产物 `viewer/assets.json` 提交到仓库**：终端用户不跑 build.py

## 常用命令

```bash
# 重建 viewer/dashboard 打包产物
python3 extensions/trace/viewer/build.py

# 渲染单个 session
python3 extensions/trace/trace_to_html.py [<session-id>]

# 跨会话 dashboard
python3 extensions/trace/trace_to_html.py --dashboard
```

## 发版规范（历史约定）

- dev commit 不改 version
- 发版时**单独一个 commit** 改 `package.json` version + 打 `vX.Y.Z` tag
- commit message 首行格式：`X.Y.Z: <一句话总结>`
- push main + tag，然后 `npm publish`

## 已有 spec 参考

- `docs/specs/2026-07-09-only-errors-filter.md` — 树 toggle 过滤开关
- `docs/specs/2026-07-09-cross-session-dashboard.md` — 跨会话 index.html
