const SUMMARIES = /*__SUMMARIES__*/[];

const state = {
  query: "",
  project: null,       // null = All
  sortKey: "startedAt",
  sortDir: "desc",     // asc | desc
};

function fmtDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n, w) => String(n).padStart(w || 2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}
function fmtMs(ms) {
  if (!ms) return "";
  if (ms < 1000) return ms + "ms";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s - m * 60) + "s";
  const h = Math.floor(m / 60);
  return h + "h " + (m - h * 60) + "m";
}
function fmtTokens(n) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  if (n < 1000000) return Math.round(n / 1000) + "k";
  return (n / 1000000).toFixed(1) + "M";
}
function fmtMoney(x) {
  if (!x) return "$0";
  if (x < 0.01) return "$" + x.toFixed(4);
  return "$" + x.toFixed(3);
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function statusClass(s) {
  if (s.errorCount > 0) return "has-err";
  if (s.abortedCount > 0) return "has-abort";
  return "all-ok";
}
function totalTokens(s) { return (s.totalInput || 0) + (s.totalOutput || 0) + (s.totalCacheRead || 0); }

// session dir 名格式: <timestamp>_<uuid>，展示 uuid 前 8 位比时间前 8 位更能区分
function shortId(id) {
  if (!id) return "";
  const i = id.indexOf("_");
  return (i >= 0 ? id.slice(i + 1, i + 9) : id.slice(0, 8));
}

// —— 项目 chip：只列 ≥ 3 的项目，其余归 Others
function buildChips() {
  const counts = {};
  SUMMARIES.forEach(s => { const k = s.cwdName || "(unknown)"; counts[k] = (counts[k] || 0) + 1; });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const shown = entries.filter(([, n]) => n >= 3);
  const otherCount = entries.filter(([, n]) => n < 3).reduce((a, [, n]) => a + n, 0);

  const wrap = document.getElementById("chips");
  const mk = (label, key, count) => {
    const c = el("span", "chip");
    c.dataset.project = key == null ? "" : key;
    c.appendChild(document.createTextNode(label));
    if (count != null) c.appendChild(el("span", "chip-count", "· " + count));
    if (state.project === key) c.classList.add("active");
    c.addEventListener("click", () => {
      state.project = state.project === key ? null : key;
      // 用一个具有 hasOthers 的 key 作为特殊值 "__others__"
      render();
    });
    return c;
  };
  wrap.innerHTML = "";
  wrap.appendChild(mk("All", null, SUMMARIES.length));
  shown.forEach(([k, n]) => wrap.appendChild(mk(k, k, n)));
  if (otherCount > 0) wrap.appendChild(mk("Others", "__others__", otherCount));
}

function matchProject(s) {
  if (state.project == null) return true;
  const name = s.cwdName || "(unknown)";
  if (state.project === "__others__") {
    // Others = 出现次数 < 3 的项目
    const counts = {};
    SUMMARIES.forEach(x => { const k = x.cwdName || "(unknown)"; counts[k] = (counts[k] || 0) + 1; });
    return counts[name] < 3;
  }
  return name === state.project;
}

function matchQuery(s) {
  const q = state.query;
  if (!q) return true;
  const hay = ((s.firstPrompt || "") + " " + (s.id || "") + " " + (s.cwdName || "")).toLowerCase();
  return hay.includes(q);
}

function sortKeyValue(s, key) {
  if (key === "tokens") return totalTokens(s);
  if (key === "cost") return s.totalCost || 0;
  if (key === "dur") return s.durationMs || 0;
  if (key === "id") return s.id || "";
  if (key === "cwdName") return s.cwdName || "";
  return s.startedAt || 0;
}

function renderRow(s) {
  const tr = el("tr", statusClass(s));
  tr.appendChild(el("td", "col-status"));
  tr.appendChild(el("td", "col-time", fmtDate(s.startedAt)));

  const idTd = el("td", "col-id");
  const a = el("a", null, shortId(s.id));
  a.href = "./" + s.id + "/trace.html";
  a.title = s.id;
  idTd.appendChild(a);
  tr.appendChild(idTd);

  const prompt = s.firstPrompt || "";
  const promptTd = el("td", "col-prompt" + (prompt ? "" : " empty"), prompt || "(no prompt)");
  promptTd.title = prompt;
  tr.appendChild(promptTd);

  tr.appendChild(el("td", "col-cwd", s.cwdName || "(unknown)"));

  const scaleTd = el("td", "col-scale");
  scaleTd.appendChild(document.createTextNode(s.interactionCount || 0));
  scaleTd.appendChild(el("span", "scale-sep", "·"));
  scaleTd.appendChild(document.createTextNode(s.turnCount || 0));
  scaleTd.appendChild(el("span", "scale-sep", "·"));
  scaleTd.appendChild(document.createTextNode(s.toolCount || 0));
  tr.appendChild(scaleTd);

  tr.appendChild(el("td", "num", fmtTokens(totalTokens(s))));
  tr.appendChild(el("td", "num", fmtMoney(s.totalCost)));
  tr.appendChild(el("td", "num", fmtMs(s.durationMs)));
  return tr;
}

function render() {
  // 更新 chips 激活态
  document.querySelectorAll("#chips .chip").forEach(c => {
    const key = c.dataset.project === "" ? null : c.dataset.project;
    c.classList.toggle("active", key === state.project);
  });

  // 排序指示
  document.querySelectorAll(".dash-table th.sortable").forEach(th => {
    if (th.dataset.sort === state.sortKey) {
      th.dataset.dir = state.sortDir;
      const ind = th.querySelector(".sort-ind");
      if (ind) ind.textContent = state.sortDir === "asc" ? "↑" : "↓";
    } else {
      delete th.dataset.dir;
      const ind = th.querySelector(".sort-ind");
      if (ind) ind.textContent = "↕";
    }
  });

  let rows = SUMMARIES.filter(s => matchProject(s) && matchQuery(s));
  rows.sort((a, b) => {
    const av = sortKeyValue(a, state.sortKey);
    const bv = sortKeyValue(b, state.sortKey);
    if (av < bv) return state.sortDir === "asc" ? -1 : 1;
    if (av > bv) return state.sortDir === "asc" ? 1 : -1;
    return 0;
  });

  const tbody = document.getElementById("dash-tbody");
  tbody.innerHTML = "";
  rows.forEach(s => tbody.appendChild(renderRow(s)));

  document.getElementById("dash-empty").style.display = rows.length ? "none" : "";
}

window.addEventListener("DOMContentLoaded", () => {
  buildChips();

  document.getElementById("dash-search").addEventListener("input", (e) => {
    state.query = e.target.value.toLowerCase().trim();
    render();
  });

  document.querySelectorAll(".dash-table th.sortable").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (state.sortKey === k) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = k;
        // 数值列默认 desc，字母列默认 asc
        state.sortDir = th.classList.contains("num") ? "desc" : "asc";
      }
      render();
    });
  });

  render();
});
