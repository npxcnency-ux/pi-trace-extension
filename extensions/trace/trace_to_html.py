#!/usr/bin/env python3
"""
把 events.jsonl 渲染成 Langfuse 风格的单文件 HTML trace 视图。
布局：顶栏 + 左树（含节点搜索 + DAG 统计） + 右详情（badges + sections）
用法:
    python3 trace_to_html.py            # 最新 session
    python3 trace_to_html.py <session>
    python3 trace_to_html.py --dashboard  # 生成跨会话 dashboard
"""
import json, sys, html, re, time
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


def fmt_tokens(n):
    if not n: return "0"
    if n < 1000: return str(n)
    if n < 10000: return f"{n/1000:.1f}k"
    if n < 1_000_000: return f"{round(n/1000)}k"
    return f"{n/1_000_000:.1f}M"


def _find_child_traces_for_tool(session_dir, tool_start_ts, tool_end_ts):
    """在 subagents/ 目录里按时间窗口找属于这次 subagent 工具调用的子 trace。

    子 trace session_start.ts 落在 [tool_start_ts, tool_end_ts] 内即匹配。
    返回按 session_start.ts 排序的目录路径列表。
    渲染时调用（子进程已结束，文件写完），比采集时可靠。
    """
    if not session_dir:
        return []
    subagents_dir = Path(session_dir) / "subagents"
    if not subagents_dir.is_dir():
        return []
    matches = []
    for child_dir in subagents_dir.iterdir():
        child_f = child_dir / "events.jsonl"
        if not child_f.exists():
            continue
        try:
            with open(child_f, encoding="utf-8") as fh:
                first_line = fh.readline().strip()
            if not first_line:
                continue
            first_ev = json.loads(first_line)
        except Exception:
            continue
        child_ts = first_ev.get("ts") or 0
        if tool_start_ts <= child_ts <= tool_end_ts:
            matches.append((child_ts, str(child_dir)))
    matches.sort(key=lambda x: x[0])
    return [m[1] for m in matches]


def _load_child_trace_steps(child_trace_dir):
    """子 trace events.jsonl → 按出现顺序的 step 信息列表。

    每条 step 对应子 agent 内一次 LLM 调用，包含：
    turnIndex / stopReason / llm_status / llm_start / llm_end
    按 step_start 出现的时间顺序排列，与 messages 里 assistant message 的顺序一致。
    """
    f = Path(child_trace_dir) / "events.jsonl"
    if not f.exists():
        return []
    steps_by_si = {}   # stepIndex → partial info
    step_order = []    # step_start 出现的 stepIndex 序列（currentStep 单调递增，无重复）
    with open(f, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except Exception:
                # 单行损坏（例如 crash 时的半截最后行）不应丢失整文件已解析的步骤
                continue
            t = e.get("type")
            si = e.get("stepIndex")
            if si is None:
                continue
            if t == "step_start":
                steps_by_si.setdefault(si, {})
                step_order.append(si)
            elif t == "llm_request":
                steps_by_si.setdefault(si, {})["llm_start"] = e.get("ts")
                # 完整发给 LLM 的 payload（model + messages + tools），用于 Input 视图
                if e.get("input") is not None:
                    steps_by_si[si]["input"] = e.get("input")
            elif t == "llm_response":
                steps_by_si.setdefault(si, {})["llm_end"] = e.get("ts")
                steps_by_si[si]["llm_status"] = e.get("status")
            elif t == "step_end":
                steps_by_si.setdefault(si, {}).update({
                    "turnIndex": e.get("turnIndex"),
                    "stopReason": e.get("stopReason"),
                    "errorMessage": e.get("errorMessage"),
                    "model": e.get("model"),
                })
    return [steps_by_si[si] for si in step_order if si in steps_by_si]


def _build_subagent_subtree(messages, parent_id, child_steps=None):
    """Rebuild subagent messages into llm-generation/tool child nodes.

    child_steps: list of per-step info from the child trace (optional).
    When provided, fields like turnIndex / stopReason / llm_status are filled
    from the actual child trace rather than left null.
    """
    if not isinstance(messages, list) or not messages:
        return []

    pending_results = [
        m for m in messages
        if isinstance(m, dict) and m.get("role") == "toolResult"
    ]
    pending_results.reverse()

    out = []
    step_seq = 0
    for m in messages:
        if not isinstance(m, dict) or m.get("role") != "assistant":
            continue
        content = m.get("content")
        if not isinstance(content, list):
            continue

        text_parts = []
        thinking_parts = []
        tool_calls = []
        thinking_redacted = False
        thinking_source = None

        for part in content:
            if not isinstance(part, dict):
                continue
            part_type = part.get("type")
            if part_type == "text":
                text_parts.append(part.get("text") or "")
            elif part_type == "thinking":
                thinking_text = part.get("text") or part.get("thinking") or ""
                if thinking_text:
                    thinking_parts.append(thinking_text)
                    thinking_source = thinking_source or part.get("source") or "message"
            elif part_type == "redacted_thinking":
                thinking_redacted = True
                thinking_source = thinking_source or "redacted_thinking"
            elif part_type == "tool_call":
                tool_calls.append(part)

        step_seq += 1
        ts = m.get("timestamp")
        usage = m.get("usage") or {}
        thinking = "\n".join(t for t in thinking_parts if t) or None

        # 从子 trace 补全 step 信息（按出现序号一一对应）
        cs = child_steps[step_seq - 1] if child_steps and step_seq - 1 < len(child_steps) else {}

        # llm_start / llm_end 来自子 trace；fallback 到 message.timestamp
        llm_start = cs.get("llm_start") or ts
        llm_end = cs.get("llm_end") or ts

        # status: 优先看子 trace（cs），其次看 message 自身字段，避免子 trace 缺失时
        # detail 区显示了 errorMessage / stopReason 但树节点仍显示绿色的不一致
        eff_stop = cs.get("stopReason") or m.get("stopReason")
        eff_err = cs.get("errorMessage") or m.get("errorMessage")
        if eff_stop == "aborted":
            step_status = "aborted"
        elif eff_stop == "error" or eff_err:
            step_status = "error"
        else:
            step_status = "ok"

        step_node = {
            "id": f"{parent_id}-llm-{step_seq}",
            "parent_id": parent_id,
            "type": "step",
            "name": "llm-generation",
            "icon": "🧠",
            "start": llm_start,
            "end": llm_end,
            "status": step_status,
            "data": {
                "stepIndex": step_seq,
                # turnIndex 只能从子 trace 的 step_end 里取
                "turnIndex": cs.get("turnIndex"),
                "llm_start": llm_start,
                "llm_end": llm_end,
                "llm_status": cs.get("llm_status"),
                "thinking": thinking,
                "thinkingRedacted": thinking_redacted or None,
                "thinkingSource": thinking_source,
                "text": "\n".join(text_parts) or None,
                "toolCalls": [
                    {"id": tc.get("id"), "name": tc.get("name"), "args": tc.get("input")}
                    for tc in tool_calls
                ],
                "usage": usage if usage else None,
                # stopReason / model / errorMessage：优先从子 trace，fallback 到 message
                "stopReason": eff_stop,
                "errorMessage": eff_err,
                "model": cs.get("model") or m.get("model"),
                # 子 trace 的 llm_request.input（完整 LLM payload）；老格式无子 trace 时为 None
                "input": cs.get("input"),
                "_subagentDerived": True,
            },
            "children": [],
        }
        out.append(step_node)

        for tc in tool_calls:
            tr_msg = pending_results.pop() if pending_results else None
            tr_ts = tr_msg.get("timestamp") if tr_msg else ts
            result_text = ""
            if tr_msg:
                result_content = tr_msg.get("content")
                if isinstance(result_content, list):
                    parts_txt = []
                    for item in result_content:
                        if isinstance(item, str):
                            parts_txt.append(item)
                        elif isinstance(item, dict) and item.get("type") == "text":
                            parts_txt.append(item.get("text") or "")
                    result_text = "\n".join(parts_txt)
                elif isinstance(result_content, str):
                    result_text = result_content

            tcid = tc.get("id")
            tool_node = {
                "id": f"{parent_id}-tool-{tcid or step_seq}-{len(out)}",
                "parent_id": parent_id,
                "type": "tool",
                "name": tc.get("name") or "tool",
                "icon": "🔧",
                "start": ts,
                "end": tr_ts,
                "status": "ok",
                "data": {
                    "toolName": tc.get("name"),
                    "toolCallId": tcid,
                    "args": tc.get("input"),
                    "resultPreview": result_text or None,
                    "resultTotalLength": len(result_text) if result_text else None,
                    # tr_msg.isError 现在由 summarizeMessage 透传（之前一直是 None）
                    "isError": tr_msg.get("isError") if tr_msg else None,
                    "stepIndex": step_seq,
                    "subagent": None,
                    "_subagentDerived": True,
                },
                "children": [],
            }
            # 根据 isError 更新 status
            if tool_node["data"]["isError"]:
                tool_node["status"] = "error"
            out.append(tool_node)

    # 后处理：按 step.data.turnIndex 把扁平 step+tool 列表聚成 turn 子节点
    # （子 agent 没有独立的 turn_start 事件，turnIndex 只挂在 step 上）
    # tool 节点跟随最近一个有 turnIndex 的 step；turnIndex 全缺失时退回扁平结构
    has_any_turn = any(n.get("type") == "step" and n["data"].get("turnIndex") is not None for n in out)
    if not has_any_turn:
        return out

    turns_by_ti = {}      # turnIndex → turn node
    turn_order = []       # 出现顺序
    cur_ti = None         # tool 节点跟随的 turnIndex

    def _get_or_make_turn(key, name, ti_val):
        if key not in turns_by_ti:
            turns_by_ti[key] = {
                "id": f"{parent_id}-turn-{key}",
                "parent_id": parent_id,
                "type": "turn", "name": name, "icon": "↔",
                "start": None, "end": None, "status": "ok",
                "data": {"turnIndex": ti_val, "_subagentDerived": True},
                "children": [],
            }
            turn_order.append(key)
        return turns_by_ti[key]

    def _extend(tn, n):
        n["parent_id"] = tn["id"]
        tn["children"].append(n)
        ns, ne = n.get("start"), n.get("end")
        if ns is not None and (tn["start"] is None or ns < tn["start"]):
            tn["start"] = ns
        if ne is not None and (tn["end"] is None or ne > tn["end"]):
            tn["end"] = ne
        if n.get("status") == "error":
            tn["status"] = "error"
        elif n.get("status") == "aborted" and tn["status"] != "error":
            tn["status"] = "aborted"

    for n in out:
        if n.get("type") == "step":
            ti = n["data"].get("turnIndex")
            if ti is not None:
                cur_ti = ti
        ti = cur_ti
        if ti is None:
            tn = _get_or_make_turn("flat", "turn ?", None)
        else:
            tn = _get_or_make_turn(ti, f"turn {ti}", ti)
        _extend(tn, n)

    return [turns_by_ti[k] for k in turn_order]


def _extract_subagent_failures(result_preview):
    """Extract per-subagent failure messages from a subagent tool result."""
    out = {}
    if not isinstance(result_preview, str):
        return out

    text = result_preview
    try:
        parsed = json.loads(result_preview)
        if isinstance(parsed, dict):
            content = parsed.get("content") or []
            if content and isinstance(content[0], dict) and content[0].get("type") == "text":
                text = content[0].get("text", "") or text
    except Exception:
        text = result_preview.replace("\\n", "\n").replace('\\"', '"')

    pattern = re.compile(r"###\s*\[([^\]]+)\]\s*failed\s*\n\s*(.*?)(?=\n\s*(?:###|---)|\Z)", re.DOTALL)
    for idx, match in enumerate(pattern.finditer(text)):
        name = match.group(1).strip()
        msg = match.group(2).strip()
        out.setdefault(name, msg)
        out[f"_idx_{idx}"] = msg
    return out

def build_tree(events, session_dir=None):
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
    current_model = None  # 当前选中的模型（model_change 事件维护）
    # session_dir 用于定位子 trace 目录（subagents/<childTraceId>/）
    sessionDir = session_dir  # noqa: N806 —— 与 TS 代码变量名对齐方便阅读
    model_changes = []  # 全局 model_change 历史，每条 {ts, model, previousModel, source}
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
        # 检测 retry：同一 interaction 里相同 turnIndex 出现第二次以上
        ti_count = sum(1 for k, v in turns.items()
                       if k[0] == epoch and k[1] == cur_iid
                       and v["data"].get("turnIndex") == ti)
        if ti_count > 0 and ti is not None:
            name = f"turn {ti} (retry #{ti_count})"
        else:
            name = f"turn {ti if ti is not None else seq}"
        turns[key] = {
            "id": f"turn-{epoch}-{cur_iid}-{seq}", "parent_id": cur["id"],
            "type": "turn", "name": name, "icon": "↔",
            "start": ts, "end": None, "status": "ok",
            "data": {"turnIndex": ti, "turnSeq": seq, "epoch": epoch, "interactionId": cur_iid,
                     "isRetry": ti_count > 0 and ti is not None,
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
                    "stopReason": None, "errorMessage": None, "diagnostics": None,
                    "model": current_model,  # 当前 model_change 已设的模型
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
                    mode = sub.get("mode") or "single"
                    tn["icon"] = {"single":"🤖","parallel":"🔀","chain":"⛓️"}.get(mode, "🤖")
                    sub_results = sub.get("results", []) or []
                    # 从 resultPreview 里挑出每个失败子 agent 的错误文本，作为 errorMessage 回填
                    # pi 的 subagent 输出格式：### [agent] failed\n\n<msg>\n\n---\n\n
                    failure_msgs = _extract_subagent_failures(d.get("resultPreview"))
                    # 给外层 subagent 节点更友好的名字
                    if mode == "single" and sub_results:
                        tn["name"] = f"subagent → {sub_results[0].get('agent') or '?'}"
                    elif mode in ("parallel", "chain"):
                        tn["name"] = f"subagent[{mode}×{len(sub_results)}]"
                    # 子 agent 中只要有一个失败，外层节点也标红
                    any_sub_err = False
                    for idx, sr in enumerate(sub_results):
                        # 多重判定：exitCode != 0、stopReason 是 error/aborted、原 errorMessage 非空、或 resultPreview 抽出的失败信息
                        agent_name = sr.get("agent") or f"subagent-{idx}"
                        msg_from_preview = failure_msgs.get(agent_name) or failure_msgs.get(f"_idx_{idx}")
                        is_err = (
                            (sr.get("exitCode") not in (0, None))
                            or sr.get("stopReason") in ("error", "aborted")
                            or bool(sr.get("errorMessage"))
                            or bool(msg_from_preview)
                        )
                        if is_err:
                            any_sub_err = True
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
                                "errorMessage": sr.get("errorMessage") or msg_from_preview,
                                "finalOutput": sr.get("finalOutput"),
                                "usage": sr.get("usage"), "toolsUsed": sr.get("toolsUsed"),
                                "step": sr.get("step"),
                                "childTraceId": sr.get("childTraceId"),  # 关联子 trace
                            },
                            "children": [],
                        }
                        # 把子 agent 的 messages 重建成 step + tool 子节点
                        # 优先用 TS 已 sessionId 匹配的 childTraceId 直接定位子 trace 目录，
                        # 缺失时（老 trace / TS 没拿到 sessionId）退回时间窗扫描兜底
                        sub_messages = sr.get("messages")
                        if sub_messages:
                            child_steps = []
                            child_dir = None
                            if sessionDir:
                                explicit_id = sr.get("childTraceId")
                                if explicit_id:
                                    cand = Path(sessionDir) / "subagents" / explicit_id
                                    if cand.is_dir():
                                        child_dir = str(cand)
                                if not child_dir:
                                    # 兜底：按 tool 时间窗 + result 顺序定位（parallel 模式不可靠）
                                    tool_start_ts = tn["start"] or 0
                                    tool_end_ts = ts  # 当前 tool_end 时间
                                    child_dirs = _find_child_traces_for_tool(
                                        sessionDir, tool_start_ts, tool_end_ts
                                    )
                                    child_dir = child_dirs[idx] if idx < len(child_dirs) else None
                                if child_dir:
                                    child_steps = _load_child_trace_steps(child_dir)
                                    # 回填 childTraceId 供 UI 跳转按钮使用（兜底路径才会改写）
                                    sn["data"]["childTraceId"] = Path(child_dir).name
                            sn["children"] = _build_subagent_subtree(sub_messages, sn["id"], child_steps)
                        tn["children"].append(sn)
                    # 外层 subagent 节点状态：任一子 agent 失败就染红
                    if any_sub_err:
                        tn["status"] = "error"
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
        elif t == "model_change":
            # 维护当前模型，把每个 step 都标记上"当时用的模型"
            new_model = (e.get("model") or {}).get("id") or e.get("modelId") or e.get("id")
            prev_model = current_model
            if new_model:
                current_model = new_model
                entry = {
                    "ts": ts, "model": new_model, "previousModel": prev_model,
                    "source": e.get("source"),
                }
                model_changes.append(entry)
                # 把当前 turn 标记为 "model 切换发生过"——便于 UI 显示
                if cur_turn_key and cur_turn_key in turns:
                    turns[cur_turn_key]["data"].setdefault("modelChanges", []).append(entry)
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
            "modelChanges": model_changes,  # 全局 model 切换历史
            "totalUsage": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0},
        },
        "children": interactions,
    }
    for inter in interactions:
        for k in ("input","output","cacheRead","cacheWrite","cost"):
            root["data"]["totalUsage"][k] += inter["data"]["totalUsage"].get(k, 0)
    # 把 model_changes 归属到对应 interaction：
    # - 落在 [start, end) 内 → 归属该 interaction
    # - 落在两个 interaction 之间的"间隙"（用户切了模型还没发消息）→ 归属下一个 interaction
    # - 第一个 interaction 之前的切换 → 归属第一个 interaction
    if model_changes and interactions:
        sorted_inters = sorted(interactions, key=lambda i: i.get("start") or 0)
        for mc in model_changes:
            ts = mc.get("ts")
            if not ts: continue
            target = None
            for inter in sorted_inters:
                i_start = inter.get("start") or 0
                i_end = inter.get("end") or i_start
                if i_start <= ts < i_end:
                    target = inter; break
                if ts < i_start:
                    target = inter; break  # 落在间隙或第一个之前 → 下一个
            if target is None:
                target = sorted_inters[-1]  # 落在最后一个之后 → 最后一个
            target["data"].setdefault("modelChanges", []).append(mc)
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


# ————————————————————— Dashboard —————————————————————

def extract_summary(session_dir: Path):
    """线性扫一遍 events.jsonl，提取 dashboard 需要的最小字段。不 build tree。"""
    ev_file = session_dir / "events.jsonl"
    if not ev_file.exists():
        return None
    started_at = None
    ended_at = None
    cwd = None
    first_prompt = None
    interactions = turns = tools = 0
    tool_errors = 0    # tool_end.isError=true
    step_errors = 0    # step stopReason=error
    aborted = 0
    total_input = total_output = total_cache_read = 0
    total_cost = 0.0
    models = set()
    try:
        with open(ev_file) as f:
            for line in f:
                line = line.strip()
                if not line: continue
                try: ev = json.loads(line)
                except Exception: continue
                ts = ev.get("ts")
                if ts:
                    if started_at is None: started_at = ts
                    ended_at = ts
                t = ev.get("type")
                if t == "session_start":
                    cwd = ev.get("cwd") or cwd
                elif t == "interaction_start":
                    interactions += 1
                    if first_prompt is None:
                        p = ev.get("prompt") or ""
                        first_prompt = p[:60] + ("…" if len(p) > 60 else "")
                elif t == "turn_start":
                    turns += 1
                elif t == "tool_start" or t == "tool_execution_start":
                    tools += 1
                elif t == "tool_end" or t == "tool_execution_end":
                    if ev.get("isError"):
                        tool_errors += 1
                elif t in ("step_end", "message_end", "llm_completion"):
                    usage = ev.get("usage") or {}
                    total_input += int(usage.get("input") or usage.get("inputTokens") or 0)
                    total_output += int(usage.get("output") or usage.get("outputTokens") or 0)
                    total_cache_read += int(usage.get("cacheRead") or usage.get("cacheReadTokens") or 0)
                    cost_field = usage.get("cost")
                    if isinstance(cost_field, dict):
                        total_cost += float(cost_field.get("total") or 0)
                    elif isinstance(cost_field, (int, float)):
                        total_cost += float(cost_field)
                    model = ev.get("model")
                    if model: models.add(model)
                    sr = ev.get("stopReason")
                    if sr == "error": step_errors += 1
                    elif sr == "aborted": aborted += 1
    except Exception:
        return None

    # ghost session: 零事件或只有 session_start
    if started_at is None or interactions == 0:
        return None

    # session id 优先取目录名（session_start 里 sessionId 可能带前缀）
    sid = session_dir.name
    cwd_name = Path(cwd).name if cwd else None

    return {
        "id": sid,
        "startedAt": started_at,
        "endedAt": ended_at,
        "durationMs": max(0, (ended_at or started_at) - started_at),
        "cwd": cwd,
        "cwdName": cwd_name,
        "firstPrompt": first_prompt or "",
        "interactionCount": interactions,
        "turnCount": turns,
        "toolCount": tools,
        "errorCount": tool_errors + step_errors,   # 兼容旧字段：色条判定用总错误
        "toolErrorCount": tool_errors,             # 新增：只统计 tool 失败
        "stepErrorCount": step_errors,
        "abortedCount": aborted,
        "totalInput": total_input,
        "totalOutput": total_output,
        "totalCacheRead": total_cache_read,
        "totalCost": total_cost,
        "models": sorted(models),
    }


def render_dashboard(summaries: list) -> str:
    """把 summaries 塞进 dashboard.html 模板。"""
    now_ms = int(time.time() * 1000)
    week_ago_ms = now_ms - 7 * 24 * 3600 * 1000
    week = [s for s in summaries if (s["startedAt"] or 0) >= week_ago_ms]
    def tokens_of(s): return (s.get("totalInput") or 0) + (s.get("totalOutput") or 0) + (s.get("totalCacheRead") or 0)
    week_sessions = len(week)
    week_cost = sum(s["totalCost"] for s in week)
    week_dur = sum(s["durationMs"] for s in week)
    week_prompts = sum(s["interactionCount"] for s in week)
    week_tool_errs = sum(s.get("toolErrorCount", 0) for s in week)
    week_tokens = sum(tokens_of(s) for s in week)
    all_sessions = len(summaries)
    all_cost = sum(s["totalCost"] for s in summaries)
    all_prompts = sum(s["interactionCount"] for s in summaries)
    all_tool_errs = sum(s.get("toolErrorCount", 0) for s in summaries)
    all_tokens = sum(tokens_of(s) for s in summaries)

    summaries_json = json.dumps(summaries, ensure_ascii=False, default=str, allow_nan=False)
    # 与 trace.html 相同的 script 体防御
    def _safe(s):
        return (s.replace("/*__SUMMARIES__*/", "/*__SUMMARIES__ */")
                 .replace("</", "<\\/")
                 .replace(" ", "\\u2028")
                 .replace(" ", "\\u2029"))
    summaries_json = _safe(summaries_json)

    js = ASSETS_DASH_JS.replace("/*__SUMMARIES__*/[]", summaries_json, 1)

    # dashboard.html 里的 css/js 内容大量含 `{` `}`，用 replace 而非 format 避免冲突
    out = ASSETS_DASH_HTML
    for k, v in [
        ("{css}", ASSETS_DASH_CSS),
        ("{js}", js),
        ("{week_sessions}", str(week_sessions)),
        ("{week_prompts}", str(week_prompts)),
        ("{week_tool_errs}", str(week_tool_errs)),
        ("{week_tokens}", fmt_tokens(week_tokens)),
        ("{week_cost}", fmt_money(week_cost)),
        ("{week_dur}", fmt_ms(week_dur) or "0s"),
        ("{all_sessions}", str(all_sessions)),
        ("{all_prompts}", str(all_prompts)),
        ("{all_tool_errs}", str(all_tool_errs)),
        ("{all_tokens}", fmt_tokens(all_tokens)),
        ("{all_cost}", fmt_money(all_cost)),
    ]:
        out = out.replace(k, v)
    return out


def dashboard_main():
    if not TRACES.exists():
        print(f"traces dir not found: {TRACES}", file=sys.stderr); sys.exit(1)
    session_dirs = [p for p in TRACES.iterdir() if p.is_dir()]
    summaries = []
    for d in session_dirs:
        s = extract_summary(d)
        if s: summaries.append(s)
    # 按时间倒序（前端会再排一次，但初始序好看点）
    summaries.sort(key=lambda x: x["startedAt"] or 0, reverse=True)
    out = TRACES / "index.html"
    out.write_text(render_dashboard(summaries), encoding="utf-8")
    print(f"✓ Wrote {out} ({len(summaries)} sessions)")
    print(f"  open {out}")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--dashboard":
        dashboard_main()
        return
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

    root = build_tree(events, session_dir=str(session))
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
ASSETS_DASH_CSS = ""
ASSETS_DASH_JS = ""
ASSETS_DASH_HTML = ""
try:
    _assets = (_HERE / "viewer" / "assets.json")
    if _assets.exists():
        _a = json.loads(_assets.read_text())
        ASSETS_CSS = _a["css"]; ASSETS_JS = _a["js"]; HTML_TPL = _a["html"]
        ASSETS_DASH_CSS = _a.get("dash_css", "")
        ASSETS_DASH_JS = _a.get("dash_js", "")
        ASSETS_DASH_HTML = _a.get("dash_html", "")
except Exception:
    pass

if __name__ == "__main__":
    if not ASSETS_CSS or not ASSETS_JS or not HTML_TPL:
        print("missing viewer/assets.json next to script (run viewer/build.py first)", file=sys.stderr)
        sys.exit(1)
    main()
