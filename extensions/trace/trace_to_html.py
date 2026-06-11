#!/usr/bin/env python3
"""
把 events.jsonl 渲染成 Langfuse 风格的单文件 HTML trace 视图。
布局：顶栏 + 左树（含节点搜索 + DAG 统计） + 右详情（badges + sections）
用法:
    python3 trace_to_html.py            # 最新 session
    python3 trace_to_html.py <session>
"""
import json, sys, html, re
from pathlib import Path
from collections import defaultdict

TRACES = Path.home() / ".pi" / "agent" / "traces"


def latest_session():
    dirs = [p for p in TRACES.iterdir() if p.is_dir()]
    dirs.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return dirs[0] if dirs else None


def fmt_ms(ms):
    if ms is None: return ""
    if ms < 1000: return f"{ms}ms"
    s = ms / 1000
    if s < 60: return f"{s:.2f}s"
    m = int(s // 60); rs = s - m * 60
    return f"{m}m {rs:.0f}s"


def fmt_money(x):
    if not x: return "$0"
    if x < 0.01: return f"${x:.4f}"
    return f"${x:.3f}"


def build_tree(events):
    interactions = []
    turns = {}     # 复合 key: (epoch, iid, turn_seq) -> turn node。turn_seq 是该 interaction 内 turn 的出现序号
    steps = {}     # 复合 key: (epoch, iid, stepIndex) -> step node
    tools = {}     # toolCallId -> tool node
    interaction_by_id = {}  # (epoch, iid) -> interaction
    cur = None
    cur_iid = None
    cur_turn_key = None
    cur_turn_seq = 0  # 当前 interaction 内 turn 序号
    epoch = 0  # 每遇到 session_start 自增。同一 jsonl 可能记录多次 pi 进程生命周期。
    sm = {"sessionId": None, "cwd": None, "model": None, "start_ts": None, "end_ts": None}

    def ensure_turn(ts, ti):
        """没有显式 turn_start 时也能给 step/tool 找到 turn 父节点。
        如果当前 cur_turn_key 已经设置（最近一次 turn_start 创建的），直接复用——
        因为 pi 的 turnIndex 会重置（429 后框架新 turn 但 index 又是 0），不能信。
        """
        nonlocal cur_turn_key
        if cur_turn_key and cur_turn_key in turns:
            return turns[cur_turn_key]
        # fallback：创建一个新 turn
        return start_turn(ts, ti)

    def start_turn(ts, ti):
        nonlocal cur_turn_key, cur_turn_seq
        if cur is None: return None
        cur_turn_seq += 1
        seq = cur_turn_seq
        key = (epoch, cur_iid, seq)
        turns[key] = {
            "id": f"turn-{epoch}-{cur_iid}-{seq}", "parent_id": cur["id"],
            "type": "turn", "name": f"turn {ti if ti is not None else seq}", "icon": "↔",
            "start": ts, "end": None, "status": "ok",
            "data": {"turnIndex": ti, "turnSeq": seq, "epoch": epoch, "interactionId": cur_iid,
                     "usage": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0}},
            "children": [],
        }
        cur["children"].append(turns[key])
        cur_turn_key = key
        return turns[key]

    for e in events:
        t = e.get("type"); ts = e.get("ts", 0)
        # 任何事件都更新 end_ts —— 兜底没有 session_shutdown 的情况
        if ts:
            if sm.get("start_ts") is None: sm["start_ts"] = ts
            sm["end_ts"] = max(sm.get("end_ts") or 0, ts)
        if t == "session_start":
            sm["sessionId"] = e.get("sessionId"); sm["cwd"] = e.get("cwd")
            sm["model"] = e.get("model")
            epoch += 1
            cur = None
            cur_iid = None
            cur_turn_key = None
        elif t in ("interaction_start", "agent_start_prep"):
            new_prompt = e.get("prompt", "")
            iid = e.get("interactionId") or (len(interactions) + 1)
            ikey = (epoch, iid)
            if cur and (epoch, cur["data"].get("interactionId")) == ikey:
                if new_prompt and not cur["data"].get("prompt"):
                    cur["data"]["prompt"] = new_prompt
                continue
            cur_turn_seq = 0  # 新 interaction 重置 turn 序号
            cur_turn_key = None
            cur = {
                "id": f"int-{epoch}-{iid}", "parent_id": "session",
                "type": "interaction",
                "name": (new_prompt or "(无 prompt)").strip().split("\n")[0][:80] or "interaction",
                "icon": "👤", "start": ts, "end": ts, "status": "ok",
                "data": {
                    "interactionId": iid, "epoch": epoch, "prompt": new_prompt,
                    "imagesCount": e.get("imagesCount", 0),
                    "systemPromptLength": e.get("systemPromptLength"),
                    "skillsLoaded": e.get("skillsLoaded"),
                    "slashCommand": e.get("slashCommand"),
                    "totalUsage": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0},
                    "filesChanged": [], "finalText": "", "model": None,
                },
                "children": [],
            }
            interactions.append(cur)
            interaction_by_id[ikey] = cur
            cur_iid = iid
        elif t == "turn_start":
            ti = e.get("turnIndex", 0)
            start_turn(ts, ti)
        elif t == "step_start":
            si = e["stepIndex"]
            if not cur:
                fb_iid = len(interactions) + 1
                cur = {
                    "id": f"int-fb-{epoch}-{fb_iid}", "parent_id": "session",
                    "type": "interaction", "name": "(未记录的 interaction)",
                    "icon": "👤", "start": ts, "end": ts, "status": "ok",
                    "data": {"interactionId": fb_iid, "epoch": epoch, "prompt": "",
                             "totalUsage": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0},
                             "filesChanged": [], "finalText": "", "model": None},
                    "children": [],
                }
                interactions.append(cur)
                interaction_by_id[(epoch, fb_iid)] = cur
                cur_iid = fb_iid
            ti = e.get("turnIndex")
            turn = ensure_turn(ts, ti)
            parent = turn or cur
            key = (epoch, cur_iid, si)
            steps[key] = {
                "id": f"step-{epoch}-{cur_iid}-{si}", "parent_id": parent["id"],
                "type": "step", "name": f"step {si}", "icon": "🧠",
                "start": ts, "end": None, "status": "in_progress",
                "data": {
                    "stepIndex": si, "turnIndex": ti,
                    "llm_start": None, "llm_end": None, "llm_status": None,
                    "thinking": None, "thinkingRedacted": None,
                    "text": None, "toolCalls": [], "usage": None,
                    "stopReason": None, "errorMessage": None, "diagnostics": None, "model": None,
                    "input": None,
                },
                "children": [],
            }
            parent["children"].append(steps[key])
        elif t == "llm_request":
            si = e.get("stepIndex"); key = (epoch, cur_iid, si)
            if key in steps:
                steps[key]["data"]["llm_start"] = ts
                if e.get("input") is not None:
                    steps[key]["data"]["input"] = e.get("input")
        elif t == "llm_response":
            si = e.get("stepIndex"); key = (epoch, cur_iid, si)
            if key in steps:
                steps[key]["data"]["llm_end"] = ts
                steps[key]["data"]["llm_status"] = e.get("status")
        elif t == "step_end":
            si = e.get("stepIndex"); key = (epoch, cur_iid, si)
            if key in steps:
                s = steps[key]
                s["end"] = ts
                d = s["data"]
                d["thinking"] = e.get("thinking"); d["thinkingRedacted"] = e.get("thinkingRedacted")
                d["text"] = e.get("text"); d["toolCalls"] = e.get("toolCalls", []) or []
                d["usage"] = e.get("usage") or {}; d["stopReason"] = e.get("stopReason")
                d["errorMessage"] = e.get("errorMessage"); d["diagnostics"] = e.get("diagnostics")
                s["name"] = "llm-generation"
                sr = e.get("stopReason")
                # 区分用户取消 (aborted) 和真实错误 (error)
                if sr == "aborted":
                    s["status"] = "aborted"
                elif sr == "error" or e.get("errorMessage"):
                    s["status"] = "error"
                else:
                    s["status"] = "ok"
            ikey = (epoch, cur_iid)
            if ikey in interaction_by_id:
                interaction_by_id[ikey]["end"] = max(interaction_by_id[ikey]["end"], ts)
                # interaction status 不在这里设置——等 finalize 时根据最后一个 turn 决定
        elif t == "tool_start":
            tcid = e["toolCallId"]; si = e.get("stepIndex")
            ti = e.get("turnIndex")
            turn = ensure_turn(ts, ti)
            parent = turn or steps.get((epoch, cur_iid, si)) or cur
            tools[tcid] = {
                "id": f"tool-{tcid}",
                "parent_id": parent["id"] if parent else None,
                "type": "tool", "name": e.get("toolName") or "tool", "icon": "🔧",
                "start": ts, "end": None, "status": "in_progress",
                "data": {
                    "toolName": e.get("toolName"), "toolCallId": tcid,
                    "args": e.get("args"), "result": None, "resultPreview": None,
                    "resultTotalLength": None, "isError": None,
                    "stepIndex": si, "subagent": None,
                },
                "children": [],
            }
            if parent: parent["children"].append(tools[tcid])
        elif t == "tool_end":
            tcid = e.get("toolCallId")
            if tcid in tools:
                tn = tools[tcid]; tn["end"] = ts
                tn["status"] = "error" if e.get("isError") else "ok"
                d = tn["data"]
                d["isError"] = e.get("isError"); d["resultPreview"] = e.get("resultPreview")
                d["resultTotalLength"] = e.get("resultTotalLength")
                sub = e.get("subagent")
                if sub:
                    d["subagent"] = sub
                    tn["icon"] = {"single":"🤖","parallel":"🔀","chain":"⛓️"}.get(sub.get("mode"), "🤖")
                    for idx, sr in enumerate(sub.get("results", []) or [], 1):
                        is_err = (sr.get("exitCode") not in (0, None)) or sr.get("stopReason") in ("error","aborted") or sr.get("errorMessage")
                        sn = {
                            "id": f"{tn['id']}-sub-{idx}", "parent_id": tn["id"],
                            "type": "subagent-result",
                            "name": sr.get("agent") or f"subagent-{idx}",
                            "icon": "❌" if is_err else "🤖",
                            "start": tn["start"], "end": tn["end"],
                            "status": "error" if is_err else "ok",
                            "data": {
                                "agent": sr.get("agent"), "agentSource": sr.get("agentSource"),
                                "task": sr.get("task"), "model": sr.get("model"),
                                "exitCode": sr.get("exitCode"), "stopReason": sr.get("stopReason"),
                                "errorMessage": sr.get("errorMessage"),
                                "finalOutput": sr.get("finalOutput"),
                                "usage": sr.get("usage"), "toolsUsed": sr.get("toolsUsed"),
                                "step": sr.get("step"),
                            },
                            "children": [],
                        }
                        tn["children"].append(sn)
        elif t == "turn_end":
            if cur_turn_key and cur_turn_key in turns:
                turns[cur_turn_key]["end"] = ts
                # 累加 turn 内所有 step 的 usage，找最后一个 step 决定 turn 状态
                tu = turns[cur_turn_key]["data"]["usage"]
                last_step_status = None
                for c in turns[cur_turn_key]["children"]:
                    if c["type"] == "step":
                        u = c["data"].get("usage") or {}
                        for k in tu:
                            tu[k] = (tu.get(k) or 0) + (u.get(k) or 0)
                        last_step_status = c["status"]
                # turn 状态只看最后一个 step（tool error 已被 step.stopReason 反映）：
                # pi 自动 retry 429 后的 step ok → turn ok（即使中间有 error step）
                if last_step_status == "error":
                    turns[cur_turn_key]["status"] = "error"
                elif last_step_status == "aborted":
                    turns[cur_turn_key]["status"] = "aborted"
                elif last_step_status is None:
                    # 空 turn（只有 tool 节点没 step，罕见但合法）
                    pass
            cur_turn_key = None
        elif t == "turn_summary":
            iid = e.get("interactionId")
            inter = interaction_by_id.get((epoch, iid)) or cur
            if inter:
                u = e.get("usage") or {}
                tu = inter["data"]["totalUsage"]
                for k in ("input","output","cacheRead","cacheWrite","cost"):
                    tu[k] = (tu.get(k) or 0) + (u.get(k) or 0)
                inter["data"]["filesChanged"].extend(e.get("filesChanged", []) or [])
                if e.get("finalText"): inter["data"]["finalText"] = e["finalText"]
                if e.get("model"): inter["data"]["model"] = e["model"]
                inter["end"] = max(inter["end"], ts)
        elif t == "session_shutdown":
            sm["end_ts"] = ts

    def finalize(node):
        if node["start"] and node["end"]:
            node["duration_ms"] = node["end"] - node["start"]
        else:
            node["duration_ms"] = None
        for c in node.get("children", []): finalize(c)
        # interaction status：看最后一个 turn —— 自动 retry 的 turn 已在 turn_end 里折算
        # 空 interaction（用户立即取消、agent 启动失败）视为 aborted
        if node["type"] == "interaction":
            turns_under = [c for c in node.get("children", []) if c["type"] == "turn"]
            if turns_under:
                node["status"] = turns_under[-1]["status"]
            else:
                node["status"] = "aborted"

    root = {
        "id": "session", "parent_id": None, "type": "session",
        "name": "Trace", "icon": "📋",
        "start": sm.get("start_ts"), "end": sm.get("end_ts"), "status": "ok",
        "data": {
            "sessionId": sm.get("sessionId"), "cwd": sm.get("cwd"),
            "model": sm.get("model"),
            "interactionCount": len(interactions),
            "totalUsage": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0},
        },
        "children": interactions,
    }
    for inter in interactions:
        for k in ("input","output","cacheRead","cacheWrite","cost"):
            root["data"]["totalUsage"][k] += inter["data"]["totalUsage"].get(k, 0)
    finalize(root)
    return root


def collect_dag_stats(root):
    stats = defaultdict(lambda: {"ok": 0, "err": 0, "abort": 0, "icon": ""})
    def bucket(status):
        if status == "error": return "err"
        if status == "aborted": return "abort"
        return "ok"
    def visit(n):
        if n["type"] == "tool":
            name = n["data"].get("toolName") or n["name"]
            entry = stats[name]
            entry[bucket(n["status"])] += 1
            entry["icon"] = n["icon"]
        elif n["type"] == "step":
            entry = stats["llm-generation"]
            entry[bucket(n["status"])] += 1
            entry["icon"] = "🧠"
        elif n["type"] == "interaction":
            stats["interaction"][bucket(n["status"])] += 1
            stats["interaction"]["icon"] = "👤"
        for c in n.get("children", []): visit(c)
    visit(root)
    return [{"name": k, "ok": v["ok"], "err": v["err"], "abort": v["abort"],
             "total": v["ok"]+v["err"]+v["abort"], "icon": v["icon"]}
            for k, v in stats.items()]


SECRET_KEY_RE = re.compile(r"(password|token|secret|api[_-]?key|authorization|bearer)", re.IGNORECASE)

def sanitize(v, depth=0, max_str=8000):
    if depth > 12: return "…[depth limit]"
    if isinstance(v, str):
        if len(v) > max_str: return v[:max_str] + f"…[truncated {len(v)-max_str} chars]"
        return v
    # NaN / Infinity 在 JSON 里非法，json.dumps 默认 allow_nan=True 会写出裸 NaN/Infinity
    # 浏览器 JS eval 时虽能识别，但前端 JSON.parse / 第三方消费会崩；统一转 None
    if isinstance(v, float):
        import math as _m
        if not _m.isfinite(v): return None
        return v
    if isinstance(v, list): return [sanitize(x, depth+1, max_str) for x in v]
    if isinstance(v, (tuple, set, frozenset)): return [sanitize(x, depth+1, max_str) for x in v]
    if isinstance(v, dict):
        out = {}
        for k, val in v.items():
            if isinstance(k, str) and SECRET_KEY_RE.search(k):
                out[k] = "***REDACTED***"
            else:
                out[k] = sanitize(val, depth+1, max_str)
        return out
    return v


def scrub_tree(n):
    if "data" in n: n["data"] = sanitize(n["data"])
    for c in n.get("children", []): scrub_tree(c)


def main():
    if len(sys.argv) > 1:
        target = sys.argv[1]
        if target in ("-h", "--help"):
            print(__doc__)
            sys.exit(0)
        cand = Path(target)
        if not cand.exists(): cand = TRACES / target
        session = cand
    else:
        session = latest_session()
        if not session:
            print("No session found"); sys.exit(1)
    events_file = session / "events.jsonl"
    if not events_file.exists():
        print(f"events.jsonl not found in {session}"); sys.exit(1)

    events = []
    with open(events_file) as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try: events.append(json.loads(line))
            except: pass

    root = build_tree(events)
    scrub_tree(root)
    dag = collect_dag_stats(root)

    interaction_count = len(root.get("children", []))
    total_cost = root["data"]["totalUsage"].get("cost", 0)
    total_dur = root.get("duration_ms") or 0

    def count(n, t):
        c = 1 if n["type"] == t else 0
        for ch in n.get("children", []): c += count(ch, t)
        return c
    step_count = count(root, "step"); tool_count = count(root, "tool")

    # allow_nan=False 防止写出非法 JSON 字面 NaN/Infinity（sanitize 已转 None，这里是保险）
    data_json = json.dumps(root, ensure_ascii=False, default=str, allow_nan=False)
    dag_json = json.dumps(dag, ensure_ascii=False, default=str, allow_nan=False)

    # 防御 1：trace 数据本身可能含字面占位符（用户对话讨论过源码），先打乱再注入避免被二次替换
    # 防御 2：HTML <script> 体里出现 `</script>` 子串会被解析器提前关闭脚本块，破坏页面 + 潜在 XSS
    # 防御 3：U+2028 / U+2029 在旧 JS 引擎字符串字面量里被当作行终止符
    def _safe(s):
        return (s.replace("/*__DATA__*/", "/*__DATA__ */")
                 .replace("/*__DAG__*/",  "/*__DAG__ */")
                 .replace("</", "<\\/")
                 .replace("\u2028", "\\u2028")
                 .replace("\u2029", "\\u2029"))
    data_json = _safe(data_json)
    dag_json = _safe(dag_json)

    css = ASSETS_CSS
    js = ASSETS_JS.replace("/*__DATA__*/null", data_json, 1).replace("/*__DAG__*/null", dag_json, 1)

    out_html = HTML_TPL.format(
        session_name=html.escape(session.name),
        css=css, js=js,
        interaction_count=interaction_count,
        step_count=step_count, tool_count=tool_count,
        total_cost=fmt_money(total_cost), total_dur=fmt_ms(total_dur),
    )
    output = session / "trace.html"
    output.write_text(out_html, encoding="utf-8")
    print(f"✓ Wrote {output}")
    print(f"  open {output}")


# 资源（CSS/JS/HTML）放在文件最后由 _ASSETS 段加载
_HERE = Path(__file__).parent
ASSETS_CSS = ""
ASSETS_JS = ""
HTML_TPL = ""
try:
    _assets = (_HERE / "viewer" / "assets.json")
    if _assets.exists():
        _a = json.loads(_assets.read_text())
        ASSETS_CSS = _a["css"]; ASSETS_JS = _a["js"]; HTML_TPL = _a["html"]
except Exception:
    pass

if __name__ == "__main__":
    if not ASSETS_CSS or not ASSETS_JS or not HTML_TPL:
        print("missing viewer/assets.json next to script (run viewer/build.py first)", file=sys.stderr)
        sys.exit(1)
    main()
