/**
 * Trace Extension v2 - Save agent execution trajectory for observability
 *
 * Events tree:
 *   session_start
 *     model_change / thinking_change
 *     turn_start
 *       step_start (一次 LLM 调用)
 *         llm_request
 *         llm_response
 *         step_end (含 thinking + text + toolCalls + usage)
 *         tool_start / tool_end (一个 step 可能包含多个 tool)
 *       file_change (聚合的文件变更)
 *       compact (上下文压缩)
 *       turn_summary (本轮摘要：files, tools, finalText)
 *       turn_end
 *     session_shutdown
 *
 * Output: ~/.pi/agent/traces/<session-id>/events.jsonl
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TRACE_DIR = path.join(os.homedir(), ".pi", "agent", "traces");
// 当前文件所在目录（扩展自己的目录），用于定位 trace_to_html.py
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_SCRIPT = path.join(EXTENSION_DIR, "trace_to_html.py");
const PYTHON_BIN = process.env.PI_TRACE_PYTHON || "python3";

// 读文件的第一行而不读整个文件（child events.jsonl 可能很大；只看 session_start.ts）
function readFirstLine(file: string, maxBytes = 8192): string {
	let fd: number | null = null;
	try {
		fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(maxBytes);
		const n = fs.readSync(fd, buf, 0, maxBytes, 0);
		if (n <= 0) return "";
		const slice = buf.slice(0, n).toString("utf-8");
		const nl = slice.indexOf("\n");
		return nl >= 0 ? slice.slice(0, nl) : slice;
	} catch {
		return "";
	} finally {
		if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
	}
}

interface TraceEvent {
	ts: number;
	sessionId: string;
	turnIndex?: number;
	stepIndex?: number;
	type: string;
	[key: string]: unknown;
}

interface FileChange {
	path: string;
	op: "write" | "edit" | "delete";
	count: number; // 累计操作次数
	preview?: string;
}

export default function (pi: ExtensionAPI) {
	let sessionId = "";
	let traceFile = "";
	let sessionDir = "";
	let writeStream: fs.WriteStream | null = null;

	// ─── Fail-open 基础设施 ──────────────────────────────────────────────────
	// disabled 是单向门。进入后本进程不再尝试恢复。
	// 理由：trace 组件的可用性 < 宿主 pi 稳定性。误伤一个 session 的 trace 数据，
	// 比"引入重试 → 引入新崩溃路径"更可接受。任何 handler 抛错或 stream 出错，
	// 都会走 markDisabled 进入终态，之后所有事件静默丢弃，pi 主进程不受影响。
	let disabled = false;

	function markDisabled(reason: string, err: unknown): void {
		if (disabled) return;             // 只降级一次
		disabled = true;
		// 用 destroy 而不是 end：已经在错误路径，不再尝试 flush（flush 会再触发 error 事件）
		try { writeStream?.destroy(); } catch { /* ignore */ }
		writeStream = null;
		// 内层 try 防 console.error 本身抛（罕见但存在，例如恶意 Proxy）
		try {
			console.error(`[pi-trace] disabled: ${reason}`, err);
		} catch { /* ignore */ }
	}

	// 统一包裹每一个 pi.on handler：
	// - 同步 throw 被 try 抓住 → markDisabled
	// - async handler 返回的 Promise reject → .catch 兜住 → markDisabled
	//   （TS 允许 async () => void 传给 () => void 类型，类型漏检时运行时兜底）
	function safeHandler<T>(name: string, fn: (e: T, ctx?: any) => void | Promise<void>) {
		return (e: T, ctx?: any) => {
			if (disabled) return;
			try {
				const ret = fn(e, ctx);
				if (ret && typeof (ret as any).then === "function") {
					(ret as Promise<void>).catch(rejErr =>
						markDisabled(`async handler ${name} rejected`, rejErr));
				}
			} catch (err) {
				markDisabled(`handler ${name} threw`, err);
			}
		};
	}
	// ─────────────────────────────────────────────────────────────────────────

	// 状态跟踪
	let currentTurn = 0;
	let currentStep = 0; // 全局递增的 step 索引
	let turnStartTime = 0;
	let turnStartStep = 0;
	let stepStartTime = 0;
	let providerRequestStart = 0;

	// message_update 流式事件里可能有明文 thinking，但最终 message_end 可能只剩签名。
	// 按 step 缓存一次，message_end 时回填到 step_end。
	let streamThinkingStep = 0;
	let streamThinking = "";
	let streamThinkingRedacted = false;
	let streamThinkingDeltaCount = 0;

	// “Interaction” = 一次用户输入到 agent 完成任务的完整过程
	// 可能跨多个 pi turn（pi 的 turn 按 LLM 调用拆分）
	let interactionId = 0;
	let interactionStartTime = 0;
	let currentUserPrompt = "";

	// 工具开始时间，用于算耗时
	const toolStartTimes = new Map<string, number>();
	// 工具调用 → 当前 step 的映射
	const toolCallToStep = new Map<string, number>();

	// 本轮聚合数据
	let filesThisTurn = new Map<string, FileChange>();
	let toolsThisTurn = new Map<string, { count: number; errors: number; totalMs: number }>();
	let finalAssistantText = "";
	let userPromptThisTurn = "";
	let stepsThisTurn: Array<{
		stepIndex: number;
		durationMs?: number;
		thinking?: string;
		thinkingRedacted?: boolean;
		text?: string;
		toolCalls?: Array<{ name: string; args: unknown }>;
		thinkingSource?: "message" | "stream";
		thinkingDeltaCount?: number;
	}> = [];

	const writeEvent = (event: TraceEvent) => {
		if (disabled || !writeStream) return;
		try {
			writeStream.write(JSON.stringify(event) + "\n");
		} catch (err) {
			// write 通常异步，但 JSON.stringify 可能同步抛（循环引用等）。
			// 任一失败都进入 disabled 终态。
			markDisabled("writeEvent threw", err);
		}
	};

	const baseEvent = (extra: Partial<TraceEvent>): TraceEvent => ({
		ts: Date.now(),
		sessionId,
		turnIndex: currentTurn,
		...extra,
	} as TraceEvent);

	// ========================================================================
	// Helpers: 提取 message 中的 content parts
	// ========================================================================

	const extractParts = (message: any): {
		thinking: string;
		thinkingRedacted: boolean;
		text: string;
		toolCalls: Array<{ id: string; name: string; args: unknown }>;
	} => {
		const out = { thinking: "", thinkingRedacted: false, text: "", toolCalls: [] as any[] };
		const content = message?.content;
		if (!Array.isArray(content)) return out;

		const thinkingParts: string[] = [];
		const textParts: string[] = [];

		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const t = part.type;
			if (t === "think" || t === "thinking" || t === "redacted_thinking") {
				const thinking = part.text ?? part.think ?? part.thinking ?? "";
				if (thinking) thinkingParts.push(thinking);

				// Some Claude/Bedrock responses only expose an encrypted/signature payload.
				// The trace can show that thinking happened, but cannot recover plaintext.
				const hasSignature = typeof part.thinkingSignature === "string" && part.thinkingSignature.trim().length > 0;
				const hasRedactedPayload = typeof part.data === "string" && part.data.trim().length > 0;
				if (part.redacted || t === "redacted_thinking" || (!thinking && (hasSignature || hasRedactedPayload))) {
					out.thinkingRedacted = true;
				}
			} else if (t === "text") {
				textParts.push(part.text ?? "");
			} else if (t === "toolCall" || t === "tool_call" || t === "tool_use") {
				out.toolCalls.push({
					id: part.id ?? part.toolCallId ?? part.tool_use_id ?? "",
					name: part.name ?? part.toolName ?? "",
					args: part.arguments ?? part.args ?? part.input,
				});
			}
		}
		out.thinking = thinkingParts.join("\n");
		out.text = textParts.join("\n");
		return out;
	};

	// 识别文件操作工具
	const FILE_TOOLS = new Set(["read", "write", "edit", "ls", "find", "grep"]);
	const MUTATING_FILE_TOOLS = new Set(["write", "edit"]);

	// 截断长字符串避免单事件过大
	const TRUNCATE_STR = 8000;
	const truncStr = (s: any): any => {
		if (typeof s !== "string") return s;
		return s.length > TRUNCATE_STR ? s.slice(0, TRUNCATE_STR) + `…[truncated ${s.length - TRUNCATE_STR}]` : s;
	};

	// 简化 LLM provider payload：保留语义字段，截断长内容
	const summarizePayload = (payload: any): any => {
		if (!payload || typeof payload !== "object") return payload;
		const out: any = {};
		// 顶层关键字段（model / temperature / max_tokens / system / tools / messages 等）
		for (const k of Object.keys(payload)) {
			const v = payload[k];
			if (k === "messages" && Array.isArray(v)) {
				out.messages = v.map(summarizeMessage);
			} else if (k === "tools" && Array.isArray(v)) {
				// 只保留工具名 + 描述，不保留完整 schema（schema 一般固定，体积大）
				out.tools = v.map((t: any) => ({
					name: t?.function?.name ?? t?.name,
					description: truncStr(t?.function?.description ?? t?.description),
					// 参数 schema 太大，单独截断 JSON
					parameters: t?.function?.parameters ?? t?.parameters,
				}));
			} else if (k === "system" || k === "system_prompt") {
				out[k] = truncStr(v);
			} else {
				out[k] = v;
			}
		}
		return out;
	};

	const summarizeMessage = (m: any): any => {
		if (!m || typeof m !== "object") return m;
		const out: any = { role: m.role };
		// content 可能是 string 或 array of parts
		if (typeof m.content === "string") {
			out.content = truncStr(m.content);
		} else if (Array.isArray(m.content)) {
			out.content = m.content.map((p: any) => {
				if (!p || typeof p !== "object") return p;
				const pt = p.type;
				if (pt === "text") return { type: "text", text: truncStr(p.text) };
				if (pt === "tool_use" || pt === "toolCall" || pt === "tool_call") {
					return {
						type: "tool_call",
						id: p.id ?? p.tool_call_id ?? p.toolCallId,
						name: p.name ?? p.toolName,
						input: p.input ?? p.args ?? p.arguments,
					};
				}
				if (pt === "tool_result" || pt === "toolResult") {
					const c = Array.isArray(p.content) ? p.content : [p.content];
					return {
						type: "tool_result",
						tool_call_id: p.tool_use_id ?? p.toolCallId ?? p.tool_call_id,
						content: c.map((cc: any) => typeof cc === "string" ? truncStr(cc)
							: cc?.type === "text" ? { type: "text", text: truncStr(cc.text) }
							: cc),
						is_error: p.is_error ?? p.isError,
					};
				}
				if (pt === "thinking" || pt === "think" || pt === "redacted_thinking") {
					const thinking = p.text ?? p.thinking ?? p.think;
					const hasSignature = typeof p.thinkingSignature === "string" && p.thinkingSignature.trim().length > 0;
					const hasRedactedPayload = typeof p.data === "string" && p.data.trim().length > 0;
					const outPart: any = { type: "thinking" };
					if (thinking) outPart.text = truncStr(thinking);
					if (p.redacted || pt === "redacted_thinking" || (!thinking && (hasSignature || hasRedactedPayload))) {
						outPart.redacted = true;
					}
					return outPart;
				}
				return p;
			});
		} else {
			out.content = m.content;
		}
		// 顶层 reasoning_content（DeepSeek/Claude 的思考）
		if (m.reasoning_content) out.reasoning_content = truncStr(m.reasoning_content);
		if (m.tool_calls) out.tool_calls = m.tool_calls;
		if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
		if (m.name) out.name = m.name;
		// assistant message 字段
		if (m.model) out.model = m.model;
		if (m.stopReason) out.stopReason = m.stopReason;
		if (m.errorMessage) out.errorMessage = m.errorMessage;
		// toolResult 顶层字段
		if (m.role === "toolResult") {
			if (m.toolCallId) out.toolCallId = m.toolCallId;
			if (m.toolName) out.toolName = m.toolName;
			if (typeof m.isError === "boolean") out.isError = m.isError;
		}
		// 透传 timestamp（pi 在 message 上记录了，给 trace 重建子 agent 时间轴用）
		if (m.timestamp) out.timestamp = m.timestamp;
		// 单条 message 的 usage（如果有），按 step 拆 token 用
		if (m.usage) out.usage = m.usage;
		return out;
	};

	// 从子 agent 的 messages 中提取最后一条 assistant text作为最终输出
	const extractSubagentFinalText = (messages: any[]): string | undefined => {
		if (!Array.isArray(messages)) return undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m?.role !== "assistant") continue;
			const content = m.content;
			if (!Array.isArray(content)) continue;
			const textParts: string[] = [];
			for (const p of content) {
				if (p?.type === "text") textParts.push(p.text ?? "");
			}
			if (textParts.length > 0) {
				const joined = textParts.join("\n");
				return joined.length > 1500 ? joined.slice(0, 1500) + "...[truncated]" : joined;
			}
		}
		return undefined;
	};

	// 从子 agent 的 messages 中提取调过的工具（仅名字与是否错误，不含 args）
	const extractSubagentTools = (messages: any[]): Array<{ name: string; isError?: boolean }> => {
		if (!Array.isArray(messages)) return [];
		const toolCallIdToName = new Map<string, string>();
		const tools: Array<{ name: string; isError?: boolean }> = [];
		for (const m of messages) {
			if (m?.role === "assistant" && Array.isArray(m.content)) {
				for (const p of m.content) {
					if (p?.type === "toolCall") {
						const name = p.name ?? p.toolName ?? "?";
						const id = p.id ?? p.toolCallId ?? "";
						if (id) toolCallIdToName.set(id, name);
						tools.push({ name });
					}
				}
			} else if (m?.role === "toolResult") {
				// 补上 isError
				const tcid = m.toolCallId ?? m.tool_call_id;
				const name = tcid ? toolCallIdToName.get(tcid) : undefined;
				if (name) {
					const last = tools.findLast?.((t) => t.name === name && t.isError === undefined);
					if (last) last.isError = !!m.isError;
				}
			}
		}
		return tools;
	};

	const recordFileChange = (toolName: string, args: any, isError: boolean) => {
		if (isError) return;
		if (!MUTATING_FILE_TOOLS.has(toolName)) return;

		const filePath: string =
			args?.file_path ?? args?.path ?? args?.filePath ?? "";
		if (!filePath) return;

		const op: FileChange["op"] = toolName === "write" ? "write" : "edit";
		const existing = filesThisTurn.get(filePath);
		if (existing) {
			existing.count += 1;
		} else {
			const fc: FileChange = { path: filePath, op, count: 1 };
			if (toolName === "write" && typeof args?.content === "string") {
				const lines = args.content.split("\n").length;
				fc.preview = `wrote ${lines} lines`;
			}
			filesThisTurn.set(filePath, fc);
		}
	};

	const trackToolUsage = (toolName: string, durationMs: number, isError: boolean) => {
		const stat = toolsThisTurn.get(toolName) ?? { count: 0, errors: 0, totalMs: 0 };
		stat.count += 1;
		if (isError) stat.errors += 1;
		stat.totalMs += durationMs;
		toolsThisTurn.set(toolName, stat);
	};

	// ========================================================================
	// ========================================================================
	// Session lifecycle
	// ========================================================================

	pi.on("session_start", safeHandler("session_start", (event: any, ctx: any) => {
		const ev = event as any;
		// 检测是否为 subagent 进程：subagent 的 sessionFile == null（因为 --no-session）
		const sessionFile = ctx.sessionManager?.getSessionFile?.();
		const isSubagent = !sessionFile;

		if (isSubagent) {
			// 子 agent 进程：写到父 session 的 subagents/ 子目录，而不是顶层 traces/
			// 父目录通过环境变量 PI_TRACE_PARENT_DIR 传入（父进程的 session_start 里设置）
			const parentDir = process.env.PI_TRACE_PARENT_DIR;
			if (!parentDir) {
				// 没有父目录信息（老版本父进程 / 手动跑），静默跳过
				return;
			}
			const childId = ev.sessionId || `sub-${Date.now()}`;
			sessionId = childId;
			sessionDir = path.join(parentDir, "subagents", childId);
			fs.mkdirSync(sessionDir, { recursive: true });
			traceFile = path.join(sessionDir, "events.jsonl");
			writeStream = fs.createWriteStream(traceFile, { flags: "a" });
			// 关键：装 error listener，否则异步写盘错误会变 uncaughtException 崩 pi
			writeStream.on("error", (err) => markDisabled("stream error (subagent)", err));
			// 子 agent 自己也可能再 spawn 子 agent —— 把环境变量更新到自己的目录，
			// 否则孙子 agent 会读到祖父的 parentDir，写到顶层 subagents/ 同级而非嵌套
			process.env.PI_TRACE_PARENT_DIR = sessionDir;
		} else {
			// 主 agent 进程：正常写到顶层 traces/<sessionId>/
			const derivedId = path.basename(sessionFile, ".jsonl");
			sessionId = derivedId || ev.sessionId || `${Date.now()}`;
			sessionDir = path.join(TRACE_DIR, sessionId);
			fs.mkdirSync(sessionDir, { recursive: true });
			traceFile = path.join(sessionDir, "events.jsonl");
			writeStream = fs.createWriteStream(traceFile, { flags: "a" });
			writeStream.on("error", (err) => markDisabled("stream error", err));
			// 通过环境变量让子进程知道父 session 目录
			// （spawn subagent 时会 inherit env，子 agent trace 扩展读此变量写子目录）
			process.env.PI_TRACE_PARENT_DIR = sessionDir;
		}

		writeEvent(baseEvent({
			type: "session_start",
			cwd: ctx.cwd,
			reason: ev.reason,
			sessionFile: sessionFile ?? null,
			model: ev.model,
			isSubagent: isSubagent || undefined,
			parentDir: isSubagent ? process.env.PI_TRACE_PARENT_DIR : undefined,
		}));
	}));

	// ========================================================================
	// HTML 渲染：spawn python3 trace_to_html.py，把 events.jsonl 转成可视化 HTML
	// ========================================================================

	const renderHtml = (opts: { open: boolean; sync?: boolean }): { ok: boolean; output?: string; error?: string } => {
		if (!sessionDir) return { ok: false, error: "no active session" };
		if (!fs.existsSync(PYTHON_SCRIPT)) {
			return { ok: false, error: `trace_to_html.py not found at ${PYTHON_SCRIPT}` };
		}
		const args = [PYTHON_SCRIPT, sessionDir];
		try {
			if (opts.sync) {
				const r = spawnSync(PYTHON_BIN, args, { encoding: "utf-8", timeout: 30000 });
				if (r.status !== 0) return { ok: false, error: r.stderr || r.stdout || `exit ${r.status}` };
			} else {
				const child = spawn(PYTHON_BIN, args, { stdio: "ignore", detached: true });
				child.unref();
			}
			const output = path.join(sessionDir, "trace.html");
			if (opts.open) openInBrowser(output);
			return { ok: true, output };
		} catch (err: any) {
			return { ok: false, error: err?.message || String(err) };
		}
	};

	// 跨会话 dashboard：spawn python3 trace_to_html.py --dashboard
	// 与 renderHtml 对称，扫描 ~/.pi/agent/traces/ 下所有 session 生成 index.html
	const renderDashboard = (opts: { open: boolean; sync?: boolean }): { ok: boolean; output?: string; error?: string } => {
		if (!fs.existsSync(PYTHON_SCRIPT)) {
			return { ok: false, error: `trace_to_html.py not found at ${PYTHON_SCRIPT}` };
		}
		const args = [PYTHON_SCRIPT, "--dashboard"];
		try {
			if (opts.sync) {
				const r = spawnSync(PYTHON_BIN, args, { encoding: "utf-8", timeout: 30000 });
				if (r.status !== 0) return { ok: false, error: r.stderr || r.stdout || `exit ${r.status}` };
			} else {
				const child = spawn(PYTHON_BIN, args, { stdio: "ignore", detached: true });
				child.unref();
			}
			const output = path.join(TRACE_DIR, "index.html");
			if (opts.open) openInBrowser(output);
			return { ok: true, output };
		} catch (err: any) {
			return { ok: false, error: err?.message || String(err) };
		}
	};

	const openInBrowser = (filePath: string) => {
		const platform = process.platform;
		const cmd = platform === "darwin" ? "open"
			: platform === "win32" ? "start"
			: "xdg-open";
		try {
			spawn(cmd, [filePath], { stdio: "ignore", detached: true, shell: platform === "win32" }).unref();
		} catch {
			// 静默失败：用户可手动打开
		}
	};

	// /trace 命令：立刻渲染并打开
	//   /trace       → 当前 session 的 trace.html
	//   /trace all   → 跨会话 dashboard（~/.pi/agent/traces/index.html）
	pi.registerCommand("trace", {
		description: "Render trace.html for this session, or /trace all for the cross-session dashboard",
		handler: async (args, ctx) => {
			const sub = (args || "").trim().toLowerCase();
			if (sub === "") {
				const r = renderHtml({ open: true, sync: true });
				if (r.ok) ctx.ui.notify(`✓ trace.html → ${r.output}`, "info");
				else ctx.ui.notify(`✗ trace render failed: ${r.error}`, "error");
			} else if (sub === "all") {
				const r = renderDashboard({ open: true, sync: true });
				if (r.ok) ctx.ui.notify(`✓ dashboard → ${r.output}`, "info");
				else ctx.ui.notify(`✗ dashboard render failed: ${r.error}`, "error");
			} else {
				ctx.ui.notify("Usage: /trace [all]", "info");
			}
		},
	});

	pi.on("session_shutdown", safeHandler("session_shutdown", () => {
		writeEvent(baseEvent({ type: "session_shutdown" }));
		// H1 修复：立即置 null 屏蔽后续写入，避免 renderHtml(sync) 阻塞期间被
		// 其他 handler（如未收尾的 tool_end）写到已 end() 的 stream 上触发
		// ERR_STREAM_WRITE_AFTER_END → uncaughtException 崩 pi
		const stream = writeStream;
		writeStream = null;
		try { stream?.end(); } catch { /* ignore */ }
		// 兜底：session 退出时同步生成一次 HTML（不打开浏览器）
		try { renderHtml({ open: false, sync: true }); } catch { /* silent */ }
	}));

	// 把上游 event 对象展开但保护 baseEvent 设的关键字段（type/ts/sessionId/turnIndex/stepIndex）
	const spreadEvent = (e: any): Record<string, unknown> => {
		if (!e || typeof e !== "object") return {};
		const { type, ts, sessionId, turnIndex, stepIndex, ...rest } = e;
		return rest;
	};

	// pi 的扩展事件名是 "model_select"（不是 "model_change"——后者是 session.jsonl 里的持久化类型）
	pi.on("model_select", safeHandler("model_select", (event: any) => {
		writeEvent(baseEvent({ type: "model_change", ...spreadEvent(event) }));
	}));

	pi.on("thinking_level_select", safeHandler("thinking_level_select", (event: any) => {
		writeEvent(baseEvent({ type: "thinking_change", ...spreadEvent(event) }));
	}));

	pi.on("session_compact", safeHandler("session_compact", (event: any) => {
		writeEvent(baseEvent({ type: "compact", ...spreadEvent(event) }));
	}));

	// ========================================================================
	// Turn lifecycle
	// ========================================================================

	pi.on("turn_start", safeHandler("turn_start", (event: any) => {
		currentTurn = event.turnIndex;
		turnStartTime = Date.now();
		turnStartStep = currentStep;
		filesThisTurn = new Map();
		toolsThisTurn = new Map();
		finalAssistantText = "";
		// 同 interaction 内 prompt 保持不变
		userPromptThisTurn = currentUserPrompt;
		stepsThisTurn = [];

		writeEvent(baseEvent({
			ts: turnStartTime,
			type: "turn_start",
			interactionId,
		}));
	}));

	pi.on("before_agent_start", safeHandler("before_agent_start", (event: any) => {
		// 这是“新 interaction 开始”的信号
		interactionId += 1;
		interactionStartTime = Date.now();
		currentUserPrompt = event.prompt ?? "";
		userPromptThisTurn = currentUserPrompt;

		// 提取加载的 skill 列表（指 pi 本轮能看到的 skill，不是“被调用的”）
		const skillsLoaded = (event.systemPromptOptions as any)?.skills as
			| Array<{
					name: string;
					description: string;
					filePath?: string;
					baseDir?: string;
					sourceInfo?: { path?: string; source?: string; scope?: string; origin?: string };
					disableModelInvocation?: boolean;
			  }>
			| undefined;
		const skillsInfo = skillsLoaded?.map((s) => ({
			name: s.name,
			description: typeof s.description === "string" ? s.description.slice(0, 200) : undefined,
			disableModelInvocation: !!s.disableModelInvocation,
			scope: s.sourceInfo?.scope,           // user / project / path
			origin: s.sourceInfo?.origin,         // 来源类别
			filePath: s.filePath,                 // 实际加载的文件路径
		}));

		// 启发式识别 slash 命令（很多 skill 以 /name 触发）
		const trimmed = currentUserPrompt.trim();
		let slashCommand: string | undefined;
		if (trimmed.startsWith("/")) {
			const firstToken = trimmed.split(/\s+/)[0];
			// 只认 /[a-zA-Z][\w-]* 这种格式（避免误判路径、URL）
			if (/^\/[a-zA-Z][\w-]*$/.test(firstToken)) {
				slashCommand = firstToken.slice(1);
			}
		}

		writeEvent(baseEvent({
			type: "interaction_start",
			interactionId,
			prompt: currentUserPrompt,
			imagesCount: event.images?.length ?? 0,
			systemPromptLength: event.systemPrompt?.length ?? 0,
			skillsLoaded: skillsInfo && skillsInfo.length > 0 ? skillsInfo : undefined,
			slashCommand,
		}));
	}));

	pi.on("turn_end", safeHandler("turn_end", (event: any) => {
		const now = Date.now();
		const message = event.message as any;
		const stepCount = currentStep - turnStartStep;

		// 提取最终文本
		const parts = extractParts(message);
		if (parts.text) finalAssistantText = parts.text;

		const summary = {
			turnIndex: event.turnIndex,
			stepCount,
			durationMs: now - turnStartTime,
			model: message?.model,
			stopReason: message?.stopReason,
			usage: message?.usage
				? {
						input: message.usage.input ?? 0,
						output: message.usage.output ?? 0,
						cacheRead: message.usage.cacheRead ?? 0,
						cacheWrite: message.usage.cacheWrite ?? 0,
						cost: message.usage.cost?.total ?? 0,
					}
				: undefined,
			filesChanged: Array.from(filesThisTurn.values()),
			toolsUsed: Array.from(toolsThisTurn.entries()).map(([name, stat]) => ({
				name,
				...stat,
			})),
			userPrompt: userPromptThisTurn,
			finalText: finalAssistantText,
			steps: stepsThisTurn,
			toolResultCount: event.toolResults?.length ?? 0,
		};

		// 写 turn_summary 事件（聚合视图）
		writeEvent(baseEvent({
			ts: now,
			type: "turn_summary",
			interactionId,
			...summary,
		}));

		// 写 turn_end 事件（结束标记）
		writeEvent(baseEvent({
			ts: now,
			type: "turn_end",
			durationMs: now - turnStartTime,
		}));
	}));

	// ========================================================================
	// Step lifecycle (一个 step = 一次 LLM 调用 + 它触发的工具)
	// ========================================================================

	pi.on("before_provider_request", safeHandler("before_provider_request", (event: any) => {
		// step 开始
		stepStartTime = Date.now();
		providerRequestStart = stepStartTime;
		currentStep += 1;
		streamThinkingStep = currentStep;
		streamThinking = "";
		streamThinkingRedacted = false;
		streamThinkingDeltaCount = 0;

		writeEvent(baseEvent({
			ts: stepStartTime,
			stepIndex: currentStep,
			type: "step_start",
		}));

		// 采集发给 LLM 的完整 payload（model + 全量 messages + tools schema）
		// 用于 Langfuse 风格的 Input 视图
		const payload = (event as any)?.payload;
		const inputPayload = payload ? summarizePayload(payload) : undefined;

		writeEvent(baseEvent({
			ts: providerRequestStart,
			stepIndex: currentStep,
			type: "llm_request",
			input: inputPayload,
		}));

	}));

	pi.on("after_provider_response", safeHandler("after_provider_response", (event: any) => {
		const now = Date.now();
		writeEvent(baseEvent({
			ts: now,
			stepIndex: currentStep,
			type: "llm_response",
			durationMs: now - providerRequestStart,
			status: event.status,
			isError: event.status >= 400,
			rateLimit: event.headers?.["x-ratelimit-remaining-requests"],
		}));
	}));

	const rememberStreamThinking = (candidate: unknown) => {
		if (typeof candidate !== "string" || candidate.length === 0) return;
		// partial/message snapshots are cumulative; keep the most complete copy.
		if (candidate.length >= streamThinking.length) streamThinking = candidate;
	};

	pi.on("message_update", safeHandler("message_update", (event: any) => {
		const assistantEvent = (event as any).assistantMessageEvent;
		if (!assistantEvent || typeof assistantEvent !== "object") return;
		const eventType = assistantEvent.type;
		if (eventType !== "thinking_start" && eventType !== "thinking_delta" && eventType !== "thinking_end") return;

		if (streamThinkingStep !== currentStep) {
			streamThinkingStep = currentStep;
			streamThinking = "";
			streamThinkingRedacted = false;
			streamThinkingDeltaCount = 0;
		}

		if (eventType === "thinking_delta") {
			if (typeof assistantEvent.delta === "string" && assistantEvent.delta.length > 0) {
				streamThinking += assistantEvent.delta;
				streamThinkingDeltaCount += 1;
			}
		} else if (eventType === "thinking_end") {
			rememberStreamThinking(assistantEvent.content);
		}

		// event.message / event.partial are cumulative snapshots. They cover providers that
		// put thinking text on the partial block without a separate delta payload.
		for (const candidate of [(event as any).message, assistantEvent.partial]) {
			const parts = extractParts(candidate);
			rememberStreamThinking(parts.thinking);
			if (parts.thinkingRedacted) streamThinkingRedacted = true;
		}
	}));

	pi.on("message_end", safeHandler("message_end", (event: any) => {
		const message = event.message as any;
		// 只关心 assistant 消息（user/toolResult 不是一个推理 step）
		if (message?.role !== "assistant") return;

		const parts = extractParts(message);
		const hasStreamThinking = streamThinkingStep === currentStep && streamThinking.length > 0;
		if (!parts.thinking && hasStreamThinking) {
			parts.thinking = streamThinking;
		}
		if (streamThinkingStep === currentStep && streamThinkingRedacted && !parts.thinking) {
			parts.thinkingRedacted = true;
		}
		const thinkingSource = parts.thinking
			? (hasStreamThinking && parts.thinking === streamThinking ? "stream" : "message")
			: undefined;
		const thinkingDeltaCount = streamThinkingStep === currentStep && streamThinkingDeltaCount > 0
			? streamThinkingDeltaCount
			: undefined;
		const now = Date.now();

		// 关联接下来的 tool_call → 当前 step
		for (const tc of parts.toolCalls) {
			if (tc.id) toolCallToStep.set(tc.id, currentStep);
		}

		// stopReason="toolUse" 也要记录 text（pi 的 turn 是按 LLM 调用拆分的，最后一次带文本输出的就是 final）
		// 总是覆盖：如果这一轮有 text，它比上一轮的 text 更新
		if (parts.text) {
			finalAssistantText = parts.text;
		}

		// 记录本 step 用于 turn 结束时生成 markdown 轨迹
		stepsThisTurn.push({
			stepIndex: currentStep,
			durationMs: now - stepStartTime,
			thinking: parts.thinking || undefined,
			thinkingRedacted: parts.thinkingRedacted || undefined,
			thinkingSource,
			thinkingDeltaCount,
			text: parts.text || undefined,
			toolCalls: parts.toolCalls.length
				? parts.toolCalls.map((tc) => ({ name: tc.name, args: tc.args }))
				: undefined,
		});

		writeEvent(baseEvent({
			ts: now,
			stepIndex: currentStep,
			type: "step_end",
			durationMs: now - stepStartTime,
			thinking: parts.thinking || undefined,
			thinkingRedacted: parts.thinkingRedacted || undefined,
			thinkingSource,
			thinkingDeltaCount,
			text: parts.text || undefined,
			toolCalls: parts.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })),
			toolCallCount: parts.toolCalls.length,
			usage: message.usage
				? {
						input: message.usage.input ?? 0,
						output: message.usage.output ?? 0,
						cacheRead: message.usage.cacheRead ?? 0,
						cacheWrite: message.usage.cacheWrite ?? 0,
						cost: message.usage.cost?.total ?? 0,
					}
				: undefined,
			stopReason: message.stopReason,
			errorMessage: message.errorMessage || undefined,
			diagnostics: message.diagnostics || undefined,
		}));
	}));

	// ========================================================================
	// Tool execution (在 step 内部)
	// ========================================================================

	pi.on("tool_execution_start", safeHandler("tool_execution_start", (event: any) => {
		const now = Date.now();
		toolStartTimes.set(event.toolCallId, now);
		const stepIdx = toolCallToStep.get(event.toolCallId) ?? currentStep;

		writeEvent(baseEvent({
			ts: now,
			stepIndex: stepIdx,
			type: "tool_start",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
		}));
	}));

	pi.on("tool_execution_end", safeHandler("tool_execution_end", (event: any) => {
		const now = Date.now();
		const start = toolStartTimes.get(event.toolCallId);
		toolStartTimes.delete(event.toolCallId);
		const durationMs = start ? now - start : 0;
		const stepIdx = toolCallToStep.get(event.toolCallId) ?? currentStep;
		toolCallToStep.delete(event.toolCallId);

		// 记录文件变更（聚合到 turn 级别）
		recordFileChange(event.toolName, event.args, event.isError);
		trackToolUsage(event.toolName, durationMs, event.isError);

		// 提取结果摘要：subagent / 错误情况下保留更多信息以便诊断
		let resultPreview: string | undefined;
		let resultFullLength = 0;
		try {
			const r = JSON.stringify(event.result);
			resultFullLength = r?.length ?? 0;
			// subagent 工具：即使 isError=false，子 agent 也可能失败（pi 不冒泡到 isError），
			// 而失败信息恰恰在 result.content 里 —— 所以 subagent 的 preview 给大额度
			const isSubagent = event.toolName === "subagent";
			const maxLen = isSubagent ? 8000 : (event.isError ? 3000 : 500);
			resultPreview = r && r.length > maxLen ? r.slice(0, maxLen) + "...[truncated]" : r;
		} catch {
			resultPreview = "[non-serializable]";
		}

		// subagent 工具特殊处理：提取子任务结构化信息
		let subagentInfo: any;
		if (event.toolName === "subagent" && event.result && typeof event.result === "object") {
			const details = (event.result as any).details;
			if (details) {
				// 扫描 subagents/ 子目录，找出在本次 tool_start ~ tool_end 时间窗内启动的子 trace
				// 注意：toolStartTimes.delete 已在上面执行，这里复用本地 start 变量（line 769）
				const toolStartTs = start ?? now;
				const subagentDir = sessionDir ? path.join(sessionDir, "subagents") : null;
				const childTraces: { id: string; dir: string; startTs: number }[] = [];
				// C3 修复：TOCTOU 保护——existsSync 到 readdirSync 之间目录可能被删/权限变更。
				// 局部 try/catch 让子目录扫描失败时只丢这次 subagent 结构信息，
				// 而不是升级到 markDisabled 让整个 session 后续事件全丢。
				try {
					if (subagentDir && fs.existsSync(subagentDir)) {
						for (const childId of fs.readdirSync(subagentDir)) {
							const childEventsFile = path.join(subagentDir, childId, "events.jsonl");
							if (!fs.existsSync(childEventsFile)) continue;
							const firstLine = readFirstLine(childEventsFile);
							if (!firstLine) continue;
							try {
								const firstEvent = JSON.parse(firstLine);
								const childTs = firstEvent?.ts ?? 0;
								if (childTs >= toolStartTs && childTs <= now) {
									childTraces.push({ id: childId, dir: path.join(subagentDir, childId), startTs: childTs });
								}
							} catch { /* ignore parse errors */ }
						}
						childTraces.sort((a, b) => a.startTs - b.startTs);
					}
				} catch (err) {
					// TOCTOU 或权限异常：接受结果不完整，childTraces 保持已扫到的部分
					try { console.error("[pi-trace] subagent scan partial failure:", err); } catch { /* ignore */ }
				}

				// 子 trace 按 ID 匹配（如果 result 里有 sessionId/childSessionId），否则按
				// 启动时间序号兜底（parallel 模式下序号匹配不可靠，但比没有强）
				const usedChildIds = new Set<string>();
				const matchChildTraceId = (r: any): string | undefined => {
					const explicitId = r?.sessionId ?? r?.childSessionId ?? r?.session_id;
					if (typeof explicitId === "string" && explicitId) {
						const hit = childTraces.find(c => c.id === explicitId);
						if (hit) { usedChildIds.add(hit.id); return hit.id; }
						// 显式 ID 提供但未匹配 —— 不要跌入 FIFO 兜底，否则会偷下一个本不属于自己的子 trace
						return undefined;
					}
					// 兜底：按启动时间序号取下一个未被占用的（parallel 模式下顺序不可靠，仅当无显式 ID 时启用）
					for (const c of childTraces) {
						if (!usedChildIds.has(c.id)) { usedChildIds.add(c.id); return c.id; }
					}
					return undefined;
				};

				subagentInfo = {
					mode: details.mode,                  // single / parallel / chain
					agentScope: details.agentScope,
					results: (details.results || []).map((r: any) => ({
						agent: r.agent,
						agentSource: r.agentSource,
						task: typeof r.task === "string" ? r.task.slice(0, 500) : undefined,
						exitCode: r.exitCode,
						stopReason: r.stopReason,
						errorMessage: r.errorMessage,
						model: r.model,
						step: r.step,
						// 优先按 result 携带的 sessionId 匹配，否则按时间序号
						childTraceId: matchChildTraceId(r),
						usage: r.usage
							? {
									input: r.usage.input ?? 0,
									output: r.usage.output ?? 0,
									cacheRead: r.usage.cacheRead ?? 0,
									cacheWrite: r.usage.cacheWrite ?? 0,
									cost: r.usage.cost ?? 0,
									turns: r.usage.turns ?? 0,
									contextTokens: r.usage.contextTokens ?? 0,
								}
							: undefined,
						// 子 agent 的最终输出文本（从 messages 里提取最后一条 assistant text）
						finalOutput: extractSubagentFinalText(r.messages),
						// 子 agent 调过的工具（只记名字+是否错误，不包含 args）
						toolsUsed: extractSubagentTools(r.messages),
						// 完整 messages（每条 message 单独 summarize+截断），用于在 trace.html 里
						// 把子 agent 的内部步骤展开成 llm-generation + tool 子节点
						messages: Array.isArray(r.messages)
							? r.messages.map(summarizeMessage)
							: undefined,
					})),
				};
			}
		}

		writeEvent(baseEvent({
			ts: now,
			stepIndex: stepIdx,
			type: "tool_end",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			durationMs,
			isError: event.isError,
			resultPreview,
			resultTotalLength: resultFullLength || undefined,
			subagent: subagentInfo,
		}));

		// 写 file_change 事件（如果是文件变更）
		if (!event.isError && MUTATING_FILE_TOOLS.has(event.toolName)) {
			const filePath = event.args?.file_path ?? event.args?.path ?? "";
			if (filePath) {
				writeEvent(baseEvent({
					ts: now,
					stepIndex: stepIdx,
					type: "file_change",
					path: filePath,
					op: event.toolName === "write" ? "write" : "edit",
					toolName: event.toolName,
				}));
			}
		}
	}));

	console.log(`[pi-trace] extension loaded → ${TRACE_DIR} · use /trace to render HTML`);
}
