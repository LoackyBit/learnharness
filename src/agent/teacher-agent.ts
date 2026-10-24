import type {
	AgentMessage,
	AssistantMessage,
	Usage,
} from "../core/contracts/messages.ts";
import type { AgentTool, AgentToolResult } from "./tool-execute.ts";
import { invalidInputResult, questionResult } from "./tool-execute.ts";
import { providerEventObserver, type ProviderEventObserver } from "./provider-events.ts";
import { PATHS } from "../../config.ts";
import { APP_IDENTITY, piEngineFor, type PiEngine } from "./models.ts";
import { effectivePromptSegments } from "./prompt-segments.ts";
import {
	askUserQuestionTool,
	createProberTools,
	createTeacherTools,
	type ProbeDoneContext,
	type ProberToolContext,
	type TeacherToolContext,
} from "./tools.ts";
import { practiceTools, type PracticeToolContext } from "./tools/practice.ts";
import { healToolRecord } from "./tools/heal.ts";
import { quizInputObject, quizInputProblems } from "../core/question-core.ts";
import { QUESTION_TOOLS, type EnabledTools } from "../core/pending.ts";
import { toLlmMessages } from "../core/native-messages.ts";
import { runAgyStream } from "../server/antigravity/runner.ts";
import { extractStructuredTools } from "../server/antigravity/stream-bridge.ts";

/**
 * The teaching-side agents (docs/probe-teach-split.md): PROBER, TEACHER, and
 * PRACTITIONER. Same transcript, different prompts and tool sets; the
 * chat-handler constructs ONE per request off the transcript's seam
 * (probe_done = teacher; kind: "practice" = practice) — the STATELESS
 * per-turn engine (docs/pi-engine-swap.md §2): the persisted record is the
 * source of truth, the agent is rebuilt from it every POST and discarded
 * at turn end.
 *
 * Engines are injectable so tests can pass a scripted faux engine and drive
 * deterministic lessons (see tests/chat-flow.test.ts and tests/practice-flow.test.ts).
 *
 * System prompts are COMPOSED per agent: system-prompt.md (the shared base:
 * agent, voice, philosophy, accuracy) + every numeric-prefix fragment in
 * that agent's directory (src/agent/prompts/prober/, teacher/, or practice/),
 * in sorted filename order, then the shared/ fragments as a trailing appendix.
 */

/** Which agent's prompt directory to compose. Practice composes ONLY its own directory. */
export type AgentKind = "prober" | "teacher" | "practice";

/** Exported for tests: assert what composes into the model's prompt. */
export function composeInstructions(kind: AgentKind, switches?: Record<string, boolean>): string {
	const segments = effectivePromptSegments(kind, switches ?? {});
	return segments
		.map((s) => (s.enabled ? s.overrideText! : s.sourceText))
		.map((t) => t.trim())
		.filter(Boolean)
		.join("\n\n---\n\n");
}

// The switch-free source composition, cached per kind (module-load once).
const composedInstructions: Record<AgentKind, string> = {
	prober: composeInstructions("prober"),
	teacher: composeInstructions("teacher"),
	practice: composeInstructions("practice"),
};

/** Usage collector hook for model invocations. */
export type StepUsageCollector = (usage: Usage) => void;

/** Per-request construction options (the handler wires all of these). */
export interface AgentBuildOptions {
	/** Model + stream function — tests inject a scripted faux engine. */
	engine?: PiEngine;
	/** The initial transcript, as native messages (the record IS agent state). */
	messages?: AgentMessage[];
	/** Money channel: one call per model request. */
	onUsage?: StepUsageCollector;
	/** Tests may pass a bare tool registry to drive deterministic flows. */
	tools?: Record<string, AgentTool<any>>;
	/** The resolved per-user tool toggles. */
	toolToggles?: EnabledTools;
	/** Per-segment system-prompt override switches. */
	promptSwitches?: Record<string, boolean>;
	/** Native conversation identity. */
	chatId?: string;
}

/**
 * The turn's question-stop rule: a question tool call (quiz /
 * ask_user_question) that RESOLVED — its synthetic "question posed" result
 * is not an error — ends the run: the learner's answer arrives as the next
 * POST. A call that FAILED authoring validation (error result) must NOT
 * stop the run — the model retries within the same turn.
 */
function makeQuestionStopper() {
	return (context: {
		message: { content: Array<{ type: string; id?: string; name?: string }> };
		toolResults: Array<{ toolCallId: string; isError?: boolean }>;
	}): boolean => {
		const called = new Set(
			context.message.content
				.filter((c) => c.type === "toolCall" && c.name !== undefined && (QUESTION_TOOLS as readonly string[]).includes(c.name!))
				.map((c) => c.id!),
		);
		if (called.size === 0) return false;
		// Stop only when every question call of this turn resolved cleanly.
		for (const result of context.toolResults) {
			if (called.has(result.toolCallId) && result.isError) return false;
		}
		return true;
	};
}

/** Supported agent lifecycle events emitted to subscribers. */
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "turn_start" }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
	| { type: "turn_end"; message: AgentMessage }
	| { type: "agent_end"; messages: AgentMessage[] };

/**
 * Computes structured tool definitions for the turn runner based on agent kind.
 */
export function structuredToolsForKind(kind: AgentKind, _tools?: AgentTool<any, any>[]): readonly string[] {
	if (kind === "practice") {
		return ["problem", "conclude", "spawn_research", "spawn_demo", "spawn_visual"];
	}
	if (kind === "prober") {
		return ["quiz", "ask_user_question", "probe_done", "spawn_research", "spawn_demo", "spawn_visual"];
	}
	return ["quiz", "ask_user_question", "plan_init", "plan_update", "spawn_research", "spawn_demo", "spawn_visual"];
}

/**
 * Complete specification of a teaching-side agent (prober, teacher, practice).
 * Encapsulates the agent's kind, composed systemPrompt, executable tool suite,
 * and structured tool block definitions for the turn runner.
 */
export interface AgentSpecification {
	/** Which agent role/doctrine this specification represents. */
	kind: AgentKind;
	/** Composed system instructions for the model (produced via composeInstructions). */
	systemPrompt: string;
	/** Executable native tools registered for this agent. */
	tools: AgentTool<any, any>[];
	/** Structured tool names (:::tool_name) supported by this agent in Antigravity output. */
	structuredTools: readonly string[];
	/** The resolved execution engine (model, thinking level, streamFn). */
	engine: PiEngine;
	/** Initial conversation transcript as native messages. */
	messages: AgentMessage[];
	/** Native chat ID for persistence and provider events logging. */
	chatId?: string;
	/** Stopper determining turn termination upon question/problem calls. */
	stopper?: (context: {
		message: { content: Array<{ type: string; id?: string; name?: string }> };
		toolResults: Array<{ toolCallId: string; isError?: boolean }>;
	}) => boolean;
}

/**
 * Produces an AgentSpecification for a teaching-side agent kind.
 */
export function createAgentSpecification(
	kind: AgentKind,
	tools: AgentTool<any, any>[] | Record<string, AgentTool<any, any>>,
	opts: AgentBuildOptions = {},
): AgentSpecification {
	const toolList = Array.isArray(tools) ? tools : Object.values(tools);
	const engine = opts.engine ?? piEngineFor(kind as "prober" | "teacher");
	const systemPrompt = opts.promptSwitches
		? composeInstructions(kind, opts.promptSwitches)
		: composedInstructions[kind]!;
	const structuredTools = structuredToolsForKind(kind, toolList);
	const stopper = makeQuestionStopper();

	return {
		kind,
		systemPrompt,
		tools: toolList,
		structuredTools,
		engine,
		messages: opts.messages ? [...opts.messages] : [],
		chatId: opts.chatId,
		stopper,
	};
}

export class TeachingAgent {
	readonly kind: AgentKind;
	readonly specification: AgentSpecification;
	readonly engine: PiEngine;
	readonly sessionId?: string;
	readonly identity = APP_IDENTITY;
	readonly getApiKey = undefined;
	readonly convertToLlm = toLlmMessages;
	readonly streamFunction?: any;
	readonly transport = "auto";
	readonly toolExecution = "parallel";

	transformContext?: any;
	beforeToolCall?: any;
	afterToolCall?: any;
	finishTurn?: any;
	prepareRequest?: any;
	prepareNextTurn?: any;
	prepareNextTurnWithContext?: any;
	thinkingBudgets?: any;
	maxRetryDelayMs?: any;
	onPayload?: any;
	onResponse?: any;
	onProviderStreamEvent?: any;

	private _state: {
		systemPrompt: string;
		model: unknown;
		thinkingLevel: unknown;
		tools: AgentTool<any, any>[];
		messages: AgentMessage[];
		isStreaming: boolean;
		streamingMessage?: AssistantMessage;
		pendingToolCalls: Set<string>;
		errorMessage?: string;
	};

	private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
	private readonly steeringQueue: AgentMessage[] = [];
	private readonly followUpQueue: AgentMessage[] = [];
	private activeRun?: { abortController: AbortController; promise: Promise<void> };
	private _steeringMode: "one-at-a-time" | "all" = "all";
	private _followUpMode: "one-at-a-time" | "all" = "all";
	private readonly providerEvents?: ProviderEventObserver;
	private readonly stopper: (context: {
		message: { content: Array<{ type: string; id?: string; name?: string }> };
		toolResults: Array<{ toolCallId: string; isError?: boolean }>;
	}) => boolean;

	constructor(spec: AgentSpecification, opts: AgentBuildOptions = {}) {
		this.kind = spec.kind;
		this.specification = spec;
		this.engine = spec.engine;
		this.streamFunction = spec.engine.streamFn;
		this.sessionId = opts.chatId ?? spec.chatId;
		this.stopper = spec.stopper ?? makeQuestionStopper();
		this.providerEvents = this.sessionId ? providerEventObserver(this.sessionId, spec.kind) : undefined;

		let toolsCopy = spec.tools.slice();
		let messagesCopy = (opts.messages ?? spec.messages ?? []).slice();

		this._state = {
			systemPrompt: spec.systemPrompt,
			model: spec.engine.model,
			thinkingLevel: spec.engine.level ?? "off",
			get tools() {
				return toolsCopy;
			},
			set tools(next: AgentTool<any, any>[]) {
				toolsCopy = next.slice();
			},
			get messages() {
				return messagesCopy;
			},
			set messages(next: AgentMessage[]) {
				messagesCopy = next.slice();
			},
			isStreaming: false,
			streamingMessage: undefined,
			pendingToolCalls: new Set(),
			errorMessage: undefined,
		};

		if (opts.onUsage) {
			this.subscribe((event: AgentEvent) => {
				if (
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					"usage" in event.message &&
					event.message.usage
				) {
					if (event.message.stopReason === "aborted") return;
					opts.onUsage!(event.message.usage as Usage);
				}
			});
		}
	}

	get state() {
		return this._state;
	}

	get spec(): AgentSpecification {
		return this.specification;
	}

	get steeringMode(): "one-at-a-time" | "all" {
		return this._steeringMode;
	}

	set steeringMode(mode: "one-at-a-time" | "all") {
		this._steeringMode = mode;
	}

	get followUpMode(): "one-at-a-time" | "all" {
		return this._followUpMode;
	}

	set followUpMode(mode: "one-at-a-time" | "all") {
		this._followUpMode = mode;
	}

	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	steer(message: AgentMessage): void {
		this.steeringQueue.push(message);
	}

	followUp(message: AgentMessage): void {
		this.followUpQueue.push(message);
	}

	clearSteeringQueue(): void {
		this.steeringQueue.length = 0;
	}

	clearFollowUpQueue(): void {
		this.followUpQueue.length = 0;
	}

	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}

	hasQueuedMessages(): boolean {
		return this.steeringQueue.length > 0 || this.followUpQueue.length > 0;
	}

	peekQueuedMessages(): AgentMessage[] {
		if (this.steeringQueue.length > 0) {
			return this._steeringMode === "all" ? [...this.steeringQueue] : [this.steeringQueue[0]!];
		}
		if (this.followUpQueue.length > 0) {
			return this._followUpMode === "all" ? [...this.followUpQueue] : [this.followUpQueue[0]!];
		}
		return [];
	}

	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	abort(): void {
		this.activeRun?.abortController.abort();
	}

	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	reset(): void {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before resetting.");
		}
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set();
		this._state.errorMessage = undefined;
		this.clearAllQueues();
	}

	normalizePromptInput(input: string | AgentMessage | AgentMessage[], images?: unknown[]): AgentMessage[] {
		if (Array.isArray(input)) return input;
		if (typeof input !== "string") return [input];
		const content: any[] = [{ type: "text", text: input }];
		if (images && images.length > 0) content.push(...images);
		return [{ role: "user", content, timestamp: Date.now() }];
	}

	async runPromptMessages(messages: AgentMessage[], _options?: unknown): Promise<void> {
		this._state.messages = [...this._state.messages, ...messages];
		await this.continue();
	}

	async runContinuation(): Promise<void> {
		await this.continue();
	}

	async prompt(input: string | AgentMessage | AgentMessage[], images?: unknown[]): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion.");
		}
		const msgs = this.normalizePromptInput(input, images);
		this._state.messages = [...this._state.messages, ...msgs];
		await this.continue();
	}

	async continue(): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		const abortController = new AbortController();
		const runPromise = (async () => {
			try {
				await this.runLoop(abortController);
			} finally {
				this.activeRun = undefined;
			}
		})();

		this.activeRun = { abortController, promise: runPromise };
		await runPromise;
	}

	private async emit(event: AgentEvent, signal: AbortSignal): Promise<void> {
		for (const listener of Array.from(this.listeners)) {
			await listener(event, signal);
		}
	}

	private async executeModelTurn(signal: AbortSignal): Promise<AssistantMessage> {
		const turnStartTime = Date.now();
		const llmMessages = toLlmMessages(this._state.messages);

		if (typeof this.engine.streamFn === "function" && this.engine.streamFn.length > 0) {
			const context = {
				messages: llmMessages,
				systemPrompt: this.specification.systemPrompt,
				tools: this._state.tools,
			};

			let res: any;
			try {
				const stream = this.engine.streamFn(this.engine.model, context, {
					sessionId: this.sessionId,
					identity: this.identity,
					signal,
					apiKey: undefined,
					onProviderStreamEvent: this.providerEvents,
				});

				res = await (stream && typeof stream.result === "function" ? stream.result() : stream);
			} catch (err: any) {
				return {
					role: "assistant",
					content: [],
					api: (this.engine.model as any)?.api ?? "antigravity",
					provider: (this.engine.model as any)?.provider ?? "antigravity",
					model: (this.engine.model as any)?.id ?? "gemini-3.8-flash-high",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "error",
					errorMessage: err?.message ?? String(err),
					durationMs: Date.now() - turnStartTime,
					timestamp: Date.now(),
				};
			}

			const usage: Usage = res.usage ?? {
				input: 10,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 20,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};

			return {
				role: "assistant",
				content: res.content ?? [],
				api: (this.engine.model as any)?.api ?? "antigravity",
				provider: (this.engine.model as any)?.provider ?? "antigravity",
				model: (this.engine.model as any)?.id ?? "gemini-3.8-flash-high",
				usage,
				stopReason: res.stopReason ?? (res.content?.some((c: any) => c.type === "toolCall") ? "toolUse" : "stop"),
				durationMs: res.durationMs ?? (Date.now() - turnStartTime),
				timestamp: Date.now(),
			};
		}

		// Subprocess agy runner branch
		const prompt = [
			this.specification.systemPrompt,
			toLlmMessages(this._state.messages).map((m) => {
				const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
				return `${m.role}: ${text}`;
			}).join("\n\n"),
		].join("\n\n---\n\n");

		let textAcc = "";
		let usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		const agyStream = runAgyStream({
			prompt,
			model: (this.engine.model as any)?.id ?? "gemini-3.8-flash-high",
			effort: (this.engine.level as any) !== "off" ? (this.engine.level as any) : undefined,
			abortSignal: signal,
		});

		for await (const ev of agyStream) {
			if (signal.aborted) break;
			if (ev.type === "text_delta") {
				textAcc += ev.text;
			} else if (ev.type === "result" && ev.usage) {
				usage = {
					input: ev.usage.input_tokens,
					output: ev.usage.output_tokens,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: ev.usage.total_tokens,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
			}
		}

		const { cleanText, tools } = extractStructuredTools(textAcc);
		const content: any[] = [];
		if (cleanText) {
			content.push({ type: "text", text: cleanText });
		}
		for (let i = 0; i < tools.length; i++) {
			const t = tools[i]!;
			content.push({
				type: "toolCall",
				id: `call_${t.name}_${i + 1}_${Date.now()}`,
				name: t.name,
				arguments: t.args,
			});
		}

		return {
			role: "assistant",
			content,
			api: "antigravity",
			provider: "antigravity",
			model: (this.engine.model as any)?.id ?? "gemini-3.8-flash-high",
			usage,
			stopReason: tools.length > 0 ? "toolUse" : "stop",
			durationMs: Date.now() - turnStartTime,
			timestamp: Date.now(),
		};
	}

	private async runLoop(abortController: AbortController): Promise<void> {
		const signal = abortController.signal;
		await this.emit({ type: "agent_start" }, signal);

		// Drain steering queue if any
		if (this.steeringQueue.length > 0) {
			const steered = this.steeringMode === "all"
				? this.steeringQueue.splice(0, this.steeringQueue.length)
				: this.steeringQueue.splice(0, 1);
			this._state.messages = [...this._state.messages, ...steered];
		}

		let shouldStop = false;

		while (!shouldStop && !signal.aborted) {
			await this.emit({ type: "turn_start" }, signal);

			const currentMessages = this._state.messages;
			const lastMsg = currentMessages[currentMessages.length - 1];
			if (lastMsg && lastMsg.role === "assistant" && (!("content" in lastMsg) || !lastMsg.content?.some((c: any) => c.type === "toolCall"))) {
				break;
			}

			const assistantMessage = await this.executeModelTurn(signal);
			if (signal.aborted) {
				assistantMessage.stopReason = "aborted";
			}

			this._state.messages = [...this._state.messages, assistantMessage];
			await this.emit({ type: "message_start", message: assistantMessage }, signal);
			await this.emit({ type: "message_update", message: assistantMessage }, signal);
			await this.emit({ type: "message_end", message: assistantMessage }, signal);

			if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
				await this.emit({ type: "turn_end", message: assistantMessage }, signal);
				break;
			}

			const toolCalls = assistantMessage.content?.filter((c: any) => c.type === "toolCall") ?? [];
			const toolResults: Array<{ toolCallId: string; isError?: boolean }> = [];

			if (toolCalls.length > 0) {
				for (const call of toolCalls) {
					if (signal.aborted) break;
					const toolCallId = (call as any).id;
					const toolName = (call as any).name;
					const toolArgs = (call as any).arguments;

					await this.emit({
						type: "tool_execution_start",
						toolCallId,
						toolName,
						args: toolArgs,
					}, signal);

					const tool = this._state.tools.find((t) => t.name === toolName);
					let toolRes: AgentToolResult;

					if (!tool) {
						toolRes = {
							content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
							details: null,
							isError: true,
						};
					} else {
						try {
							const preparedArgs = tool.prepareArguments ? tool.prepareArguments(toolArgs) : toolArgs;
							toolRes = await tool.execute(toolCallId, preparedArgs, signal);
						} catch (err: any) {
							toolRes = {
								content: [{ type: "text", text: err?.message ?? String(err) }],
								details: null,
								isError: true,
							};
						}
					}

					toolResults.push({ toolCallId, isError: toolRes.isError });

					await this.emit({
						type: "tool_execution_end",
						toolCallId,
						toolName,
						result: toolRes,
						isError: toolRes.isError,
					}, signal);

					const toolResultMsg: AgentMessage = {
						role: "toolResult",
						toolCallId,
						toolName,
						content: toolRes.content,
						details: toolRes.details,
						isError: Boolean(toolRes.isError),
						timestamp: Date.now(),
					};

					this._state.messages = [...this._state.messages, toolResultMsg];
					await this.emit({ type: "message_start", message: toolResultMsg }, signal);
					await this.emit({ type: "message_end", message: toolResultMsg }, signal);

					if (toolRes.terminate) {
						shouldStop = true;
					}
				}
			}

			await this.emit({ type: "turn_end", message: assistantMessage }, signal);

			if (this.stopper({
				message: { content: assistantMessage.content ?? [] },
				toolResults,
			})) {
				shouldStop = true;
			}

			if (toolCalls.length === 0) {
				shouldStop = true;
			}

			if (this.steeringQueue.length > 0) {
				const steered = this.steeringMode === "all"
					? this.steeringQueue.splice(0, this.steeringQueue.length)
					: this.steeringQueue.splice(0, 1);
				this._state.messages = [...this._state.messages, ...steered];
				shouldStop = false;
			}
		}

		await this.emit({ type: "agent_end", messages: this._state.messages }, signal);
	}
}

function baseAgentOptions(kind: AgentKind, opts: AgentBuildOptions, tools: AgentTool<any, any>[]): TeachingAgent {
	const spec = createAgentSpecification(kind, tools, opts);
	return new TeachingAgent(spec, opts);
}

/**
 * The PROBER (agent A): the quizzing tool (quiz, or explain under free
 * recall — no nodeId either way) + ask + probe_done, lean on
 * probing doctrine.
 */
export function createProberAgent(ctx: ProberToolContext, opts: AgentBuildOptions = {}): TeachingAgent {
	return baseAgentOptions("prober", opts, Object.values(createProberTools(ctx, opts.toolToggles)));
}

/**
 * The TEACHER (agent B): enters at planning, owns plan_init and the
 * full toolset (teach questions with validated nodeId, the map, research,
 * demos).
 */
export function createTeacherAgent(
	ctx?: TeacherToolContext,
	opts: AgentBuildOptions = {},
): TeachingAgent {
	const tools = opts.tools ?? (ctx ? createTeacherTools(ctx, opts.toolToggles) : bareQuestionTools());
	return baseAgentOptions("teacher", opts, Object.values(tools));
}

/** The bare teach question set (tests, bare agents). */
export function bareQuestionTools(): Record<string, AgentTool<any>> {
	const quiz: AgentTool<typeof quizInputObject> = {
		name: "quiz",
		label: "quiz",
		description: "Ask the learner a graded question.",
		parameters: quizInputObject,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems = quizInputProblems(input);
			if (problems.length > 0) return invalidInputResult("quiz", problems);
			return questionResult();
		},
	};
	return healToolRecord({
		quiz,
		ask_user_question: askUserQuestionTool,
	});
}

/**
 * The PRACTITIONER (practice sessions): built from turn 1 of a
 * kind:"practice" session — problem + conclude tools.
 */
export function createPracticeAgent(ctx: PracticeToolContext, opts: AgentBuildOptions = {}): TeachingAgent {
	const tools = opts.tools ?? practiceTools(ctx);
	return baseAgentOptions("practice", opts, Object.values(tools));
}

export type ProberAgent = TeachingAgent;
export type TeacherAgent = TeachingAgent;
export type PracticeAgent = TeachingAgent;

/** Backward-compatibility alias for TeachingAgent */
export { TeachingAgent as Agent };
