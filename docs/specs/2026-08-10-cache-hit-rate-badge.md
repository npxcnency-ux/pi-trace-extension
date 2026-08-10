# 详情页缓存命中率 badge

## 目标

在详情页 usage badge 行加一个**缓存命中率**指标,放在模型 badge 之前,让用户一眼看到这轮请求的 prompt 缓存复用效率。

## 非目标

- 不区分输入/输出——缓存本质只作用于输入,输出永远是现场生成,没有"读输出缓存"一说。单一百分比即可。
- 不改 dashboard(跨会话)——本次只动详情页。dashboard 已有 `totalCacheRead` 聚合,后续需要再单独做。
- 不改树节点行(§4 一眼档)——命中率属于二眼查的细节,放详情页 badge 行。

## 口径(行业标准)

```
缓存命中率 = cacheRead / (input + cacheRead + cacheWrite)
```

- 分母是**总输入 token**。Anthropic 把输入拆成三块:`input`(新输入,1×计费)、`cacheRead`(命中,~0.1×)、`cacheWrite`(写缓存,~1.25×,算 miss 但"有产出的 miss")。
- `cacheWrite` **计入分母**——它是 miss。首轮大量写缓存时命中率应偏低,符合直觉。
- 与 OpenAI `cached_tokens / prompt_tokens` 同源,纯输入侧。

数据字段已核实:`turn_summary` / `step_end` 事件的 `usage` 对象含 `{input, output, cacheRead, cacheWrite, cost}`,三处详情页(turn/step/interaction)数据齐全。

## 实现要点

**文件**:`extensions/trace/viewer/viewer.js`(改完必须跑 `build.py` 重建 assets.json)

1. 加辅助函数 `cacheHitRate(u)`:
   ```js
   function cacheHitRate(u) {
     const denom = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
     if (!denom || !u.cacheRead) return null;  // 无输入或零命中不显示
     return (u.cacheRead / denom) * 100;
   }
   ```
   返回 `null` 时不加 badge(遵循 §2.6 Silence when healthy——没缓存的请求不该冒出个 0%)。

2. 三处详情页,在 `cacheRead` badge 之后、`model` badge 之前插入:
   ```js
   const hr = cacheHitRate(u);
   if (hr != null) addBadge("cacheHit", hr.toFixed(1) + "%");
   ```
   - **turn**(line ~306):`cacheRead` badge 后
   - **step**(line ~314):`cacheRead` badge 后、`stop`/`model` 前
   - **interaction**(line ~326):`cacheRead` badge 后、`model` 前 ← 截图这个

3. 复用现有 `.badge` 默认样式,不新增 CSS 类(§3 视觉语法:命中率是中性统计指标,用默认灰 badge,不抢眼)。

## 验证步骤

1. `python3 extensions/trace/viewer/build.py` 重建
2. `python3 extensions/trace/trace_to_html.py` 渲染有缓存的真实 session
3. Playwright headless 打开,点 interaction/turn/step 节点,确认:
   - badge 行出现 `cacheHit: XX.X%`,位置在 model badge 前
   - 命中率数值 = cacheRead/(input+cacheRead+cacheWrite),手算核对一条
4. 找一条首轮全 cacheWrite 的 step(cacheRead=0)→ 确认**不显示** cacheHit badge

## 边界情况

- `cacheRead=0`(纯首轮/无缓存)→ 不显示 badge,避免噪音
- `input+cacheRead+cacheWrite=0`(异常空 usage)→ denom 为 0,返回 null 不显示
- 老 viewer 兼容:纯新增 badge,不动现有字段,老数据无 cacheWrite 时 `|| 0` 兜底,降级为 `cacheRead/(input+cacheRead)`
