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

	// 状态跟踪
	let currentTurn = 0;
	let currentStep = 0; // 全局递增的 step 索引
	let turnStartTime = 0;
	let turnStartStep = 0;
	let stepStartTime = 0;
	let providerRequestStart = 0;

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
	}> = [];

	const writeEvent = (event: TraceEvent) => {
		if (!writeStream) return;
		try {
			writeStream.write(JSON.stringify(event) + "\n");
		} catch (err) {
			console.error("[trace] write error:", err);
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
		text: string;
		toolCalls: Array<{ id: string; name: string; args: unknown }>;
	} => {
		const out = { thinking: "", text: "", toolCalls: [] as any[] };
		const content = message?.content;
		if (!Array.isArray(content)) return out;

		const thinkingParts: string[] = [];
		const textParts: string[] = [];

		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const t = part.type;
			if (t === "think" || t === "thinking") {
				thinkingParts.push(part.think ?? part.thinking ?? "");
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
				if (pt === "thinking" || pt === "think") {
					return { type: "thinking", text: truncStr(p.text ?? p.thinking ?? p.think) };
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

	pi.on("session_start", (event, ctx) => {
		const ev = event as any;
		// 使用 pi 官方的 session ID（跟 session jsonl 文件名一致）
		// 优先从 sessionFile 提取完整文件名（带时间戳前缀），这样在文件系统里能按时间排序
		let derivedId: string | undefined;
		try {
			const sessionFile = ctx.sessionManager?.getSessionFile?.();
			if (sessionFile) {
				// 从路径抽出文件名（不带 .jsonl）
				const base = path.basename(sessionFile, ".jsonl");
				derivedId = base;
			} else {
				derivedId = ctx.sessionManager?.getSessionId?.();
			}
		} catch {
			// ignore
		}
		sessionId = derivedId || ev.sessionId || `${Date.now()}`;

		sessionDir = path.join(TRACE_DIR, sessionId);
		fs.mkdirSync(sessionDir, { recursive: true });
		traceFile = path.join(sessionDir, "events.jsonl");
		writeStream = fs.createWriteStream(traceFile, { flags: "a" });

		writeEvent(baseEvent({
			type: "session_start",
			cwd: ctx.cwd,
			reason: ev.reason,
			sessionFile: ctx.sessionManager?.getSessionFile?.(),
			model: ev.model,
		}));
	});

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
	pi.registerCommand("trace", {
		description: "Render this session's events.jsonl into trace.html and open it in browser",
		handler: async (_args, ctx) => {
			const r = renderHtml({ open: true, sync: true });
			if (r.ok) ctx.ui.notify(`✓ trace.html → ${r.output}`, "info");
			else ctx.ui.notify(`✗ trace render failed: ${r.error}`, "error");
		},
	});

	pi.on("session_shutdown", () => {
		writeEvent(baseEvent({ type: "session_shutdown" }));
		// end() 是异步 flush，回调里再置 null 保证最后几条事件落盘
		writeStream?.end(() => { writeStream = null; });
		// 兜底：session 退出时同步生成一次 HTML（不打开浏览器）
		try { renderHtml({ open: false, sync: true }); } catch { /* silent */ }
	});

	// 把上游 event 对象展开但保护 baseEvent 设的关键字段（type/ts/sessionId/turnIndex/stepIndex）
	const spreadEvent = (e: any): Record<string, unknown> => {
		if (!e || typeof e !== "object") return {};
		const { type, ts, sessionId, turnIndex, stepIndex, ...rest } = e;
		return rest;
	};

	pi.on("model_change", (event) => {
		writeEvent(baseEvent({ type: "model_change", ...spreadEvent(event) }));
	});

	pi.on("thinking_level_select", (event) => {
		writeEvent(baseEvent({ type: "thinking_change", ...spreadEvent(event) }));
	});

	pi.on("session_compact", (event) => {
		writeEvent(baseEvent({ type: "compact", ...spreadEvent(event) }));
	});

	// ========================================================================
	// Turn lifecycle
	// ========================================================================

	pi.on("turn_start", (event) => {
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
	});

	pi.on("before_agent_start", (event) => {
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
	});

	pi.on("turn_end", (event) => {
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
	});

	// ========================================================================
	// Step lifecycle (一个 step = 一次 LLM 调用 + 它触发的工具)
	// ========================================================================

	pi.on("before_provider_request", (event) => {
		// step 开始
		stepStartTime = Date.now();
		providerRequestStart = stepStartTime;
		currentStep += 1;

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
	});

	pi.on("after_provider_response", (event) => {
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
	});

	pi.on("message_end", (event) => {
		const message = event.message as any;
		// 只关心 assistant 消息（user/toolResult 不是一个推理 step）
		if (message?.role !== "assistant") return;

		const parts = extractParts(message);
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
	});

	// ========================================================================
	// Tool execution (在 step 内部)
	// ========================================================================

	pi.on("tool_execution_start", (event) => {
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
	});

	pi.on("tool_execution_end", (event) => {
		const now = Date.now();
		const start = toolStartTimes.get(event.toolCallId);
		toolStartTimes.delete(event.toolCallId);
		const durationMs = start ? now - start : 0;
		const stepIdx = toolCallToStep.get(event.toolCallId) ?? currentStep;
		toolCallToStep.delete(event.toolCallId);

		// 记录文件变更（聚合到 turn 级别）
		recordFileChange(event.toolName, event.args, event.isError);
		trackToolUsage(event.toolName, durationMs, event.isError);

		// 提取结果摘要
		// 提取结果摘要：错误时多保留些信息以便诊断
		let resultPreview: string | undefined;
		let resultFullLength = 0;
		try {
			const r = JSON.stringify(event.result);
			resultFullLength = r?.length ?? 0;
			const maxLen = event.isError ? 3000 : 500; // 错误保留 3000，成功保留 500
			resultPreview = r && r.length > maxLen ? r.slice(0, maxLen) + "...[truncated]" : r;
		} catch {
			resultPreview = "[non-serializable]";
		}

		// subagent 工具特殊处理：提取子任务结构化信息
		let subagentInfo: any;
		if (event.toolName === "subagent" && event.result && typeof event.result === "object") {
			const details = (event.result as any).details;
			if (details) {
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
	});

	console.log(`[pi-trace] extension loaded → ${TRACE_DIR} · use /trace to render HTML`);
}
