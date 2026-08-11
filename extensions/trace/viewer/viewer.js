const TRACE_DATA = /*__DATA__*/null;
const DAG_STATS = /*__DAG__*/null;

function fmtMs(ms) { if (ms == null) return ""; if (ms < 1000) return ms + "ms"; const s = ms/1000; if (s < 60) return s.toFixed(2)+"s"; const m = Math.floor(s/60); return m+"m "+Math.round(s-m*60)+"s"; }
function fmtMoney(x) {
  if (x && typeof x === "object") x = x.total ?? x.value ?? 0;
  if (typeof x !== "number" || !x) return "$0";
  if (x < 0.01) return "$"+x.toFixed(4);
  return "$"+x.toFixed(3);
}
function fmtInt(n) { if (n == null) return "0"; return Number(n).toLocaleString(); }
// 缓存命中率 = cacheRead / 总输入(input+cacheRead+cacheWrite)。cacheWrite 是 miss，计入分母。
// 纯输入侧指标（输出永远现场生成，无缓存概念）。零命中显示 0%（表示查过没命中）；无输入数据才返回 null。
function cacheHitRate(u) {
  if (!u) return null;
  const denom = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
  if (!denom) return null;
  return (u.cacheRead / denom) * 100;
}
// hover 文案：把命中率口径带实际数字摊开，解释这个百分比怎么来的
function cacheHitTitle(u) {
  const i = u.input || 0, cr = u.cacheRead || 0, cw = u.cacheWrite || 0;
  return "命中率 = cacheRead / (input + cacheRead + cacheWrite)\n= " +
    fmtInt(cr) + " / (" + fmtInt(i) + " + " + fmtInt(cr) + " + " + fmtInt(cw) + ") = " + fmtInt(i + cr + cw) +
    "\ncacheWrite 是本步新写入缓存的内容（算 miss），会拉低命中率";
}
function fmtIso(ms) { if (!ms) return ""; const d = new Date(ms); const p=(n,w)=>String(n).padStart(w||2,"0"); return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds())+"."+p(d.getMilliseconds(),3); }

function setText(el, s) { el.textContent = s == null ? "" : String(s); }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function span(cls, text) { return el("span", cls, text); }

const NODE_INDEX = {};
(function index(n) { NODE_INDEX[n.id] = n; (n.children || []).forEach(index); })(TRACE_DATA);

function nodeStatusClass(n) { return "status-" + (n.status || "ok"); }

function nodeTotalTokens(n) {
  if (n.type === "session") return 0;
  const d = n.data || {};
  const u = d.usage || d.totalUsage;
  if (!u) return 0;
  return (u.input || 0) + (u.cacheRead || 0) + (u.output || 0);
}

function fmtTokens(n) {
  if (!n || n < 1) return "";
  if (n < 1000) return "~" + n + " tok";
  if (n < 10000) return "~" + (n / 1000).toFixed(1) + "k tok";
  return "~" + Math.round(n / 1000) + "k tok";
}

function renderNodeRow(n, depth) {
  const hasChildren = (n.children && n.children.length > 0);
  const statusIcon = n.status === "error" ? "❌" : (n.status === "aborted" ? "⏹" : (n.status === "in_progress" ? "⏳" : (n.icon || "·")));
  const dur = n.duration_ms != null ? fmtMs(n.duration_ms) : "";
  const totalTok = nodeTotalTokens(n);
  const tokStr = totalTok >= 1000 ? fmtTokens(totalTok) : "";
  const wrap = el("div");
  const row = el("div", "node-row " + nodeStatusClass(n) + (hasChildren ? "" : " leaf"));
  row.dataset.nodeId = n.id;
  row.style.paddingLeft = (depth * 14 + 8) + "px";

  const tog = el("span", "node-toggle", "▼");
  const ic = el("span", "node-icon", statusIcon);
  const nm = el("span", "node-name", n.name || "");
  nm.title = n.name || "";
  const tk = el("span", "node-tokens", tokStr);
  const du = el("span", "node-duration", dur);
  row.appendChild(tog); row.appendChild(ic); row.appendChild(nm); row.appendChild(tk); row.appendChild(du);
  wrap.appendChild(row);

  if (hasChildren) {
    const cwrap = el("div", "node-children");
    n.children.forEach(c => cwrap.appendChild(renderNodeRow(c, depth + 1)));
    wrap.appendChild(cwrap);
    tog.addEventListener("click", (e) => {
      e.stopPropagation();
      row.classList.toggle("collapsed");
      cwrap.classList.toggle("hidden");
    });
  }
  row.addEventListener("click", () => selectNode(n.id));
  return wrap;
}

function selectNode(id) {
  document.querySelectorAll(".node-row.active").forEach(r => r.classList.remove("active"));
  const row = document.querySelector('.node-row[data-node-id="' + CSS.escape(id) + '"]');
  if (row) { row.classList.add("active"); row.scrollIntoView({block: "nearest"}); }
  renderDetail(NODE_INDEX[id]);
}

function applySearch(q) {
  filterState.query = (q || "").toLowerCase().trim();
  applyFilters();
}

// 页面级过滤状态
const filterState = { query: "", onlyErrors: false };

function isErrLike(n) { return n && (n.status === "error" || n.status === "aborted"); }

function nodeMatchesQuery(n, q) {
  if (!q) return true;
  const hay = ((n.name||"") + " " + (n.data && n.data.toolName || "") + " " + (n.data && n.data.prompt || "") + " " + n.type).toLowerCase();
  return hay.includes(q);
}

// 自底向上标记 keep：自身命中 OR 后代有命中
function markKeep(n, q, onlyErrors) {
  const selfHit = nodeMatchesQuery(n, q) && (!onlyErrors || isErrLike(n));
  let childHit = false;
  (n.children || []).forEach(c => { if (markKeep(c, q, onlyErrors)) childHit = true; });
  const keep = selfHit || childHit;
  n._keep = keep;
  return keep;
}

function applyFilters() {
  const q = filterState.query;
  const onlyErr = filterState.onlyErrors;
  // 无任何过滤时直接全显，省一次 DFS
  if (!q && !onlyErr) {
    document.querySelectorAll(".node-row").forEach(row => { row.style.display = ""; });
    return;
  }
  markKeep(TRACE_DATA, q, onlyErr);
  document.querySelectorAll(".node-row").forEach(row => {
    const n = NODE_INDEX[row.dataset.nodeId];
    row.style.display = (n && n._keep) ? "" : "none";
  });
}

function hasAnyErrors(n) {
  if (isErrLike(n)) return true;
  return (n.children || []).some(hasAnyErrors);
}

let __jsonLine = 0;
function renderJsonRoot(value) {
  __jsonLine = 0;
  const root = el("div", "json-tree");
  renderJsonValue(value, root, 0, null);
  return root;
}
function jsonRow(indent) {
  __jsonLine += 1;
  const row = el("div", "json-row");
  row.appendChild(el("span", "json-line-num", String(__jsonLine)));
  const content = el("span", "json-content");
  for (let i = 0; i < indent; i++) content.appendChild(el("span", "json-indent"));
  row.appendChild(content);
  return {row, content};
}
function appendKey(content, key) {
  if (key != null) {
    content.appendChild(span("json-key", key));
    content.appendChild(document.createTextNode(": "));
  }
}
function renderJsonValue(value, container, indent, key) {
  if (value === null || value === undefined) {
    const {row, content} = jsonRow(indent);
    appendKey(content, key);
    content.appendChild(span("json-null", "null"));
    container.appendChild(row); return;
  }
  if (typeof value === "boolean") {
    const {row, content} = jsonRow(indent);
    appendKey(content, key);
    content.appendChild(span("json-bool", String(value)));
    container.appendChild(row); return;
  }
  if (typeof value === "number") {
    const {row, content} = jsonRow(indent);
    appendKey(content, key);
    content.appendChild(span("json-number", String(value)));
    container.appendChild(row); return;
  }
  if (typeof value === "string") {
    if (value.length > 120 || value.includes("\n")) {
      const {row, content} = jsonRow(indent);
      appendKey(content, key);
      const tog = span("json-toggle", "▼");
      content.appendChild(tog);
      content.appendChild(span("json-string", '"…"'));
      content.appendChild(span("json-meta", value.length + " chars"));
      container.appendChild(row);
      const {row: row2, content: c2} = jsonRow(indent + 1);
      const sw = el("span", "json-string");
      const inner = el("span", "json-string-content");
      setText(inner, '"' + value + '"');
      sw.appendChild(inner);
      c2.appendChild(sw);
      container.appendChild(row2);
      tog.addEventListener("click", (e) => {
        e.stopPropagation();
        row2.style.display = row2.style.display === "none" ? "" : "none";
        tog.textContent = row2.style.display === "none" ? "▶" : "▼";
      });
      return;
    }
    const {row, content} = jsonRow(indent);
    appendKey(content, key);
    const sw = span("json-string", '"' + value + '"');
    content.appendChild(sw);
    container.appendChild(row); return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      const {row, content} = jsonRow(indent);
      appendKey(content, key);
      content.appendChild(span("json-bracket", "[]"));
      container.appendChild(row); return;
    }
    const {row, content} = jsonRow(indent);
    appendKey(content, key);
    const tog = span("json-toggle", "▼");
    content.appendChild(tog);
    content.appendChild(span("json-bracket", "["));
    content.appendChild(span("json-meta", "Array(" + value.length + ")"));
    container.appendChild(row);
    const childWrap = el("div", "json-children");
    value.forEach((v, i) => renderJsonValue(v, childWrap, indent + 1, String(i)));
    container.appendChild(childWrap);
    const {row: r2, content: c2} = jsonRow(indent);
    c2.appendChild(span("json-bracket", "]"));
    container.appendChild(r2);
    tog.addEventListener("click", (e) => {
      e.stopPropagation();
      childWrap.classList.toggle("collapsed");
      tog.textContent = childWrap.classList.contains("collapsed") ? "▶" : "▼";
    });
    return;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      const {row, content} = jsonRow(indent);
      appendKey(content, key);
      content.appendChild(span("json-bracket", "{}"));
      container.appendChild(row); return;
    }
    const {row, content} = jsonRow(indent);
    appendKey(content, key);
    const tog = span("json-toggle", "▼");
    content.appendChild(tog);
    content.appendChild(span("json-bracket", "{"));
    content.appendChild(span("json-meta", "{" + keys.length + " keys}"));
    container.appendChild(row);
    const childWrap = el("div", "json-children");
    keys.forEach(k => renderJsonValue(value[k], childWrap, indent + 1, k));
    container.appendChild(childWrap);
    const {row: r2, content: c2} = jsonRow(indent);
    c2.appendChild(span("json-bracket", "}"));
    container.appendChild(r2);
    tog.addEventListener("click", (e) => {
      e.stopPropagation();
      childWrap.classList.toggle("collapsed");
      tog.textContent = childWrap.classList.contains("collapsed") ? "▶" : "▼";
    });
  }
}

function makeBadge(label, value, cls, title) {
  const b = el("span", "badge" + (cls ? " " + cls : ""));
  if (title) b.title = title;
  if (label) {
    b.appendChild(span("badge-key", label + ":"));
    b.appendChild(document.createTextNode(" " + value));
  } else {
    b.textContent = value;
  }
  return b;
}

function renderThinkingList(changes) {
  // 复用 model changes 的 fc-list 样式：一行一次切换
  const wrap = el("div", "fc-list");
  changes.forEach((tc) => {
    const row = el("div");
    const tsStr = fmtIso(tc.ts);
    const prev = tc.previousLevel || "?";
    const nxt = tc.level || "?";
    setText(row, `${tsStr}  ${prev}  →  ${nxt}`);
    wrap.appendChild(row);
  });
  return wrap;
}

function renderDetail(node) {
  const pane = document.getElementById("detail-pane");
  pane.innerHTML = "";
  if (!node) {
    pane.appendChild(el("div", "detail-empty", "从左侧选择节点查看详情"));
    return;
  }
  const t = node.type;

  // Header
  const hdr = el("div", "detail-header");
  const titleRow = el("div", "detail-title");
  const titleSpan = el("span", null, (node.icon || "·") + " " + (node.name || ""));
  titleRow.appendChild(titleSpan);
  const typeTag = span("tag tag-purple", t);
  titleRow.appendChild(typeTag);
  if (node.status === "error") titleRow.appendChild(span("tag tag-error", "error"));
  else if (node.status === "aborted") titleRow.appendChild(span("tag tag-warn", "aborted"));
  hdr.appendChild(titleRow);
  const time = el("div", "detail-time", fmtIso(node.start) + (node.end ? "  →  " + fmtIso(node.end) : ""));
  hdr.appendChild(time);

  const badges = el("div", "badges");
  function addBadge(label, value, cls, title) { badges.appendChild(makeBadge(label, value, cls, title)); }

  if (node.duration_ms != null) addBadge("Latency", fmtMs(node.duration_ms));

  if (t === "turn") {
    const u = node.data.usage || {};
    if (u.input || u.output) addBadge(null, fmtInt(u.input) + " prompt → " + fmtInt(u.output) + " completion");
    if (u.cacheRead) addBadge("cacheRead", fmtInt(u.cacheRead));
    if (u.cacheWrite) addBadge("cacheWrite", fmtInt(u.cacheWrite));
    { const hr = cacheHitRate(u); if (hr != null) addBadge("cacheHit", hr.toFixed(1) + "%", null, cacheHitTitle(u)); }
    if (u.cost) addBadge("cost", fmtMoney(u.cost));
  } else if (t === "step") {
    const d = node.data;
    const llmDur = (d.llm_start && d.llm_end) ? (d.llm_end - d.llm_start) : null;
    if (llmDur != null) addBadge("LLM", fmtMs(llmDur));
    const u = d.usage || {};
    if (u.input != null) addBadge(null, fmtInt(u.input) + " prompt → " + fmtInt(u.output||0) + " completion (Σ " + fmtInt((u.input||0)+(u.cacheRead||0)+(u.output||0)) + ")");
    if (u.cacheRead) addBadge("cacheRead", fmtInt(u.cacheRead));
    if (u.cacheWrite) addBadge("cacheWrite", fmtInt(u.cacheWrite));
    { const hr = cacheHitRate(u); if (hr != null) addBadge("cacheHit", hr.toFixed(1) + "%", null, cacheHitTitle(u)); }
    if (u.cost) addBadge("cost", fmtMoney(u.cost));
    if (d.stopReason) addBadge("stop", d.stopReason);
    if (d.model) addBadge(null, d.model, "badge-model");
  } else if (t === "tool") {
    const d = node.data;
    if (d.toolName) addBadge("tool", d.toolName);
    if (d.isError) addBadge(null, "FAILED", "badge-error");
    if (d.resultTotalLength) addBadge("result", fmtInt(d.resultTotalLength) + " chars");
  } else if (t === "interaction") {
    const u = node.data.totalUsage || {};
    if (u.input || u.output) addBadge(null, fmtInt(u.input) + " prompt → " + fmtInt(u.output) + " completion");
    if (u.cacheRead) addBadge("cacheRead", fmtInt(u.cacheRead));
    if (u.cacheWrite) addBadge("cacheWrite", fmtInt(u.cacheWrite));
    { const hr = cacheHitRate(u); if (hr != null) addBadge("cacheHit", hr.toFixed(1) + "%", null, cacheHitTitle(u)); }
    if (u.cost) addBadge("cost", fmtMoney(u.cost));
    if (node.data.model) addBadge(null, node.data.model, "badge-model");
    if (node.data.slashCommand) addBadge(null, "/" + node.data.slashCommand, "badge-model");
  } else if (t === "subagent-result") {
    const d = node.data;
    if (d.model) addBadge(null, d.model, "badge-model");
    if (d.usage) {
      addBadge(null, fmtInt(d.usage.input) + " prompt → " + fmtInt(d.usage.output) + " completion");
      if (d.usage.cost) addBadge("cost", fmtMoney(d.usage.cost));
      if (d.usage.turns) addBadge("turns", String(d.usage.turns));
    }
    if (d.exitCode != null && d.exitCode !== 0) addBadge(null, "exit " + d.exitCode, "badge-error");
  } else if (t === "session") {
    const u = node.data.totalUsage || {};
    if (u.input || u.output) addBadge(null, fmtInt(u.input) + " prompt → " + fmtInt(u.output) + " completion");
    if (u.cost) addBadge("total cost", fmtMoney(u.cost));
    addBadge("interactions", String(node.data.interactionCount));
  }
  hdr.appendChild(badges);
  pane.appendChild(hdr);

  const body = el("div", "detail-body");
  pane.appendChild(body);

  const jumps = [];
  function section(id, label, contentEl, count) {
    const sec = el("div", "section"); sec.id = "sec-" + id;
    const t = el("div", "section-title");
    t.appendChild(document.createTextNode(label));
    if (count != null) { const c = el("span", "count", " (" + count + ")"); t.appendChild(c); }
    sec.appendChild(t);
    sec.appendChild(contentEl);
    body.appendChild(sec);
    jumps.push({id, label});
  }
  function textBlock(s, kind) {
    // kind: true|"error" -> 红框, "warn" -> 黄框, 其他 -> 普通
    let cls = "text-block";
    if (kind === true || kind === "error") cls += " error";
    else if (kind === "warn") cls += " warn";
    const e = el("div", cls);
    setText(e, s || ""); return e;
  }

  if (t === "session") {
    // model 切换历史
    if (node.data.modelChanges && node.data.modelChanges.length) {
      const wrap = el("div", "fc-list");
      node.data.modelChanges.forEach((mc) => {
        const row = el("div");
        const tsStr = fmtIso(mc.ts);
        const txt = mc.previousModel
          ? `${tsStr}  ${mc.previousModel}  →  ${mc.model}` + (mc.source ? ` (${mc.source})` : "")
          : `${tsStr}  → ${mc.model}` + (mc.source ? ` (${mc.source})` : "");
        setText(row, txt);
        wrap.appendChild(row);
      });
      section("models", "Model Changes", wrap, node.data.modelChanges.length);
    }
    // thinking level 切换历史
    if (node.data.thinkingChanges && node.data.thinkingChanges.length) {
      section("thinking", "Thinking Changes",
        renderThinkingList(node.data.thinkingChanges),
        node.data.thinkingChanges.length);
    }
    section("metadata", "Metadata", renderJsonRoot({
      sessionId: node.data.sessionId, cwd: node.data.cwd, model: node.data.model,
      duration: fmtMs(node.duration_ms),
      interactions: node.data.interactionCount,
      totalUsage: node.data.totalUsage,
    }));
  } else if (t === "interaction") {
    if (node.data.prompt) section("input", "User Input", textBlock(node.data.prompt));
    if (node.data.finalText) section("output", "Final Output", textBlock(node.data.finalText));
    if (node.data.filesChanged && node.data.filesChanged.length) {
      const wrap = el("div", "fc-list");
      const seen = new Map();
      node.data.filesChanged.forEach(f => {
        if (!f.path) return;
        if (!seen.has(f.path)) seen.set(f.path, {ops: new Set(), count: 0});
        seen.get(f.path).ops.add(f.op);
        seen.get(f.path).count += f.count || 1;
      });
      seen.forEach((v, p) => {
        const row = el("div");
        const c = el("code"); setText(c, p); row.appendChild(c);
        row.appendChild(document.createTextNode(" "));
        const m = el("span"); m.style.color = "var(--muted)";
        setText(m, [...v.ops].join("/") + " × " + v.count);
        row.appendChild(m);
        wrap.appendChild(row);
      });
      section("files", "Files Changed", wrap, seen.size);
    }
    if (node.data.skillsLoaded && node.data.skillsLoaded.length) {
      const wrap = el("div", "skill-list");
      node.data.skillsLoaded.slice(0, 50).forEach(s => {
        const row = el("div");
        const c = el("code"); setText(c, s.name); row.appendChild(c);
        if (s.scope) {
          row.appendChild(document.createTextNode(" "));
          row.appendChild(span("tag tag-purple", s.scope));
        }
        if (s.description) { row.appendChild(document.createTextNode(" — " + s.description)); }
        wrap.appendChild(row);
      });
      if (node.data.skillsLoaded.length > 50) {
        const m = el("div", "no-data", "... 还有 " + (node.data.skillsLoaded.length - 50) + " 个");
        wrap.appendChild(m);
      }
      section("skills", "Skills Loaded", wrap, node.data.skillsLoaded.length);
    }
    if (node.data.modelChanges && node.data.modelChanges.length) {
      const wrap = el("div", "fc-list");
      node.data.modelChanges.forEach((mc) => {
        const row = el("div");
        const tsStr = fmtIso(mc.ts);
        const txt = mc.previousModel
          ? `${tsStr}  ${mc.previousModel}  →  ${mc.model}` + (mc.source ? ` (${mc.source})` : "")
          : `${tsStr}  → ${mc.model}` + (mc.source ? ` (${mc.source})` : "");
        setText(row, txt);
        wrap.appendChild(row);
      });
      section("models", "Model Changes", wrap, node.data.modelChanges.length);
    }
    if (node.data.thinkingChanges && node.data.thinkingChanges.length) {
      section("thinking", "Thinking Changes",
        renderThinkingList(node.data.thinkingChanges),
        node.data.thinkingChanges.length);
    }
    section("metadata", "Metadata", renderJsonRoot({
      interactionId: node.data.interactionId,
      systemPromptLength: node.data.systemPromptLength,
      imagesCount: node.data.imagesCount,
      slashCommand: node.data.slashCommand,
      totalUsage: node.data.totalUsage,
    }));
  } else if (t === "turn") {
    if (node.data.modelChanges && node.data.modelChanges.length) {
      const wrap = el("div", "fc-list");
      node.data.modelChanges.forEach((mc) => {
        const row = el("div");
        const tsStr = fmtIso(mc.ts);
        const txt = mc.previousModel
          ? `${tsStr}  ${mc.previousModel}  →  ${mc.model}`
          : `${tsStr}  → ${mc.model}`;
        setText(row, txt);
        wrap.appendChild(row);
      });
      section("models", "Model Changes (this turn)", wrap, node.data.modelChanges.length);
    }
    if (node.data.thinkingChanges && node.data.thinkingChanges.length) {
      section("thinking", "Thinking Changes (this turn)",
        renderThinkingList(node.data.thinkingChanges),
        node.data.thinkingChanges.length);
    }
    section("metadata", "Metadata", renderJsonRoot({
      turnIndex: node.data.turnIndex,
      epoch: node.data.epoch,
      interactionId: node.data.interactionId,
      usage: node.data.usage,
      childCount: (node.children || []).length,
    }));
  } else if (t === "step") {
    const d = node.data;
    if (d.errorMessage || d.stopReason === "error" || d.stopReason === "aborted") {
      const isAborted = d.stopReason === "aborted";
      const label = isAborted ? "Aborted" : "Error";
      section("error", label, textBlock(d.errorMessage || ("(no message; stopReason=" + d.stopReason + ")"), isAborted ? "warn" : "error"));
      if (d.diagnostics) section("diagnostics", "Diagnostics", renderJsonRoot(d.diagnostics));
    }
    if (d.input) {
      // input 是发给 LLM 的完整 payload (model + messages + tools)
      const inputCount = d.input.messages ? `${d.input.messages.length} msgs` : "";
      section("input", "Input" + (inputCount ? ` (${inputCount})` : ""), renderJsonRoot(d.input));
    }
    if (d.thinking) {
      const e = el("div", "thinking-block"); setText(e, d.thinking);
      section("thinking", "Thinking", e);
    } else if (d.thinkingRedacted) {
      section("thinking", "Thinking", textBlock("(已加密，模型推理了但内容不可读)"));
    }
    if (d.text) section("output", "Output", textBlock(d.text));
    if (d.toolCalls && d.toolCalls.length) {
      const wrap = el("div");
      d.toolCalls.forEach(tc => {
        const item = el("div", "tc-item");
        const nm = el("div", "tc-name"); setText(nm, tc.name); item.appendChild(nm);
        const ar = el("div", "tc-args");
        let s = ""; try { s = JSON.stringify(tc.args, null, 2); } catch { s = String(tc.args); }
        setText(ar, s); item.appendChild(ar);
        wrap.appendChild(item);
      });
      section("tools", "Tool Calls", wrap, d.toolCalls.length);
    }
    section("metadata", "Metadata", renderJsonRoot({
      stepIndex: d.stepIndex, turnIndex: d.turnIndex,
      stopReason: d.stopReason,
      // llm_status: 主 agent 是 HTTP 状态码；subagent-derived step 从子 trace 取（有则显示）
      llm_status: d.llm_status,
      usage: d.usage,
      thinkingSource: d.thinkingSource,
      thinkingDeltaCount: d.thinkingDeltaCount,
      thinkingRedacted: d.thinkingRedacted,
      subagentDerived: d._subagentDerived,
    }));
  } else if (t === "tool") {
    const d = node.data;
    section("input", "Args", renderJsonRoot(d.args || {}));
    if (d.subagent) section("subagent", "Subagent Detail", renderJsonRoot(d.subagent));

    // 解析 result：标准 pi tool result 形如 {content:[{type:"text",text:"..."}], details:{}}
    let parsed = null;
    if (d.resultPreview) { try { parsed = JSON.parse(d.resultPreview); } catch {} }
    function extractText(p) {
      if (!p) return null;
      if (typeof p === "string") return p;
      if (Array.isArray(p?.content)) {
        return p.content.filter(x => x && (x.type === "text" || x.type === "error_text"))
                        .map(x => x.text || "").filter(Boolean).join("\n");
      }
      return null;
    }

    // tool error：把可读的错误文本顶到 Error section 红框里
    if (d.isError) {
      const errText = extractText(parsed) || d.resultPreview || "(no error message)";
      section("error", "Error", textBlock(errText, true));
    }

    if (d.resultPreview) {
      if (parsed && typeof parsed === "object") section("output", "Result", renderJsonRoot(parsed));
      else section("output", "Result", textBlock(d.resultPreview, d.isError));
    }
    section("metadata", "Metadata", renderJsonRoot({
      toolName: d.toolName, toolCallId: d.toolCallId, isError: d.isError,
      resultTotalLength: d.resultTotalLength, stepIndex: d.stepIndex,
    }));
  } else if (t === "subagent-result") {
    const d = node.data;
    if (d.task) section("input", "Task", textBlock(d.task));
    if (d.errorMessage) section("error", "Error", textBlock(d.errorMessage, true));
    if (d.finalOutput) section("output", "Final Output", textBlock(d.finalOutput));
    if (d.toolsUsed && d.toolsUsed.length) {
      const counts = {}, errs = {};
      d.toolsUsed.forEach(u => { const n = u.name || "?"; counts[n] = (counts[n]||0)+1; if (u.isError) errs[n] = (errs[n]||0)+1; });
      const wrap = el("div", "fc-list");
      Object.entries(counts).sort((a,b)=>b[1]-a[1]).forEach(([n, c]) => {
        const row = el("div");
        const code = el("code"); setText(code, n); row.appendChild(code);
        row.appendChild(document.createTextNode(" × " + c));
        if (errs[n]) {
          const e = el("span"); e.style.color = "var(--err)";
          setText(e, " (" + errs[n] + " 错)"); row.appendChild(e);
        }
        wrap.appendChild(row);
      });
      section("tools", "Tools Used", wrap, d.toolsUsed.length);
    }
    // Child trace 链接：包到 section 里，避免破坏 .section:first-child 等 CSS 假设
    if (d.childTraceId) {
      const wrap = el("div");
      const btn = el("a", "tag tag-purple");
      btn.style.cursor = "pointer";
      btn.style.display = "inline-block";
      btn.style.textDecoration = "none";
      setText(btn, "↗ Open child trace");
      btn.addEventListener("click", () => {
        // 用 new URL 解析当前页 + 相对路径，避免手写 regex 漏掉 ?query/#fragment
        // childTraceId 可能含特殊字符（例如 sessionId 里的冒号），encodeURIComponent 防御
        try {
          const childUrl = new URL("subagents/" + encodeURIComponent(d.childTraceId) + "/trace.html", window.location.href);
          window.open(childUrl.href, "_blank");
        } catch {
          /* ignore */
        }
      });
      wrap.appendChild(btn);
      section("childTrace", "Child Trace", wrap);
    }
    section("metadata", "Metadata", renderJsonRoot({
      agent: d.agent, agentSource: d.agentSource, model: d.model,
      exitCode: d.exitCode, stopReason: d.stopReason, step: d.step, usage: d.usage,
      childTraceId: d.childTraceId,
    }));
  } else if (t === "compact") {
    const d = node.data || {};
    // compactionEntry 通常是字符串（Python 端 str() 序列化过），也可能是 dict
    const entry = d.compactionEntry;
    if (entry) {
      if (typeof entry === "string") {
        section("entry", "Compaction Entry", textBlock(entry));
      } else {
        section("entry", "Compaction Entry", renderJsonRoot(entry));
      }
    }
    section("metadata", "Metadata", renderJsonRoot({
      turnIndex: d.turnIndex,
      fromExtension: d.fromExtension,
    }));
  }

  if (jumps.length > 1) {
    const jb = el("div", "jump-bar");
    jb.appendChild(document.createTextNode("Jump to: "));
    jumps.forEach((j, i) => {
      if (i > 0) jb.appendChild(document.createTextNode(", "));
      const a = el("a", null, j.label); a.dataset.target = "sec-" + j.id;
      a.addEventListener("click", () => {
        const t = document.getElementById(a.dataset.target);
        if (t) t.scrollIntoView({behavior: "smooth", block: "start"});
      });
      jb.appendChild(a);
    });
    body.insertBefore(jb, body.firstChild);
  }
}

function renderDag() {
  const e = document.getElementById("dag-grid");
  e.innerHTML = "";
  DAG_STATS.sort((a,b) => b.total - a.total).forEach(s => {
    const cls = "dag-node" + (s.err > 0 ? " has-err" : (s.abort > 0 ? " has-abort" : ""));
    const node = el("div", cls);
    if (s.icon) { const i = el("span"); setText(i, s.icon); node.appendChild(i); }
    const c = el("code"); setText(c, s.name); node.appendChild(c);
    const cnt = el("span", "dag-node-count");
    // ok/total，再可选拼上 abort 数
    let txt = s.ok + "/" + s.total;
    if (s.abort > 0) txt += " · " + s.abort + " ⏹";
    setText(cnt, txt);
    node.appendChild(cnt);
    e.appendChild(node);
  });
}

window.addEventListener("DOMContentLoaded", () => {
  const treeEl = document.getElementById("tree-list");
  treeEl.appendChild(renderNodeRow(TRACE_DATA, 0));
  renderDag();

  document.getElementById("tree-search").addEventListener("input", (e) => applySearch(e.target.value));
  document.getElementById("expand-all").addEventListener("click", () => {
    document.querySelectorAll(".node-children").forEach(c => c.classList.remove("hidden"));
    document.querySelectorAll(".node-row").forEach(r => r.classList.remove("collapsed"));
  });
  document.getElementById("collapse-all").addEventListener("click", () => {
    document.querySelectorAll(".node-children").forEach((c, i) => { if (i > 0) c.classList.add("hidden"); });
    document.querySelectorAll(".node-row").forEach((r, i) => { if (i > 0 && !r.classList.contains("leaf")) r.classList.add("collapsed"); });
  });

  const onlyErrBtn = document.getElementById("only-errors");
  if (!hasAnyErrors(TRACE_DATA)) {
    onlyErrBtn.disabled = true;
    onlyErrBtn.title = "此 trace 无错误节点";
  } else {
    onlyErrBtn.addEventListener("click", () => {
      filterState.onlyErrors = !filterState.onlyErrors;
      onlyErrBtn.classList.toggle("active", filterState.onlyErrors);
      // 打开时强制全展开，避免折叠住的错误节点被 display:none 掩盖
      if (filterState.onlyErrors) {
        document.querySelectorAll(".node-children").forEach(c => c.classList.remove("hidden"));
        document.querySelectorAll(".node-row").forEach(r => r.classList.remove("collapsed"));
      }
      applyFilters();
    });
  }

  const cid = document.getElementById("copy-id");
  cid.addEventListener("click", (e) => {
    const txt = e.target.textContent.trim();
    if (navigator.clipboard) navigator.clipboard.writeText(txt);
    const orig = e.target.textContent;
    e.target.textContent = "✓ copied";
    setTimeout(() => { e.target.textContent = orig; }, 1000);
  });

  const firstInter = TRACE_DATA.children && TRACE_DATA.children[0];
  selectNode((firstInter || TRACE_DATA).id);
});
