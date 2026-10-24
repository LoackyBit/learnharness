import {
	normalizeOptions,
	normalizeQuizType,
	parseOptionsIfString,
	resolveCorrect,
	type QuestionData,
	type QuizOption,
} from "../../core/question-core.ts";
import type { AgyStreamEvent, AgyUsage } from "./runner.ts";

/**
 * Recognized structured tool names that can appear in Antigravity model output
 * wrapped in :::tool_name ... ::: blocks.
 */
export const STRUCTURED_TOOL_NAMES = [
	"quiz",
	"ask_user_question",
	"plan_init",
	"plan_update",
	"probe_done",
	"problem",
	"conclude",
	"spawn_research",
	"spawn_demo",
	"spawn_visual",
] as const;

export type StructuredToolName = (typeof STRUCTURED_TOOL_NAMES)[number];

/**
 * Tools that terminate the assistant's speaking turn and wait for learner or system input.
 */
export const TERMINATING_TOOL_NAMES = new Set<StructuredToolName>([
	"quiz",
	"ask_user_question",
	"problem",
]);

/**
 * Checks whether a tool name is a client-interactive question tool.
 */
export function isQuestionTool(name: string): boolean {
	return name === "quiz" || name === "ask_user_question";
}

/**
 * Checks whether a tool name terminates the assistant turn upon invocation.
 */
export function isTerminatingTool(name: string): boolean {
	return TERMINATING_TOOL_NAMES.has(name as StructuredToolName);
}

/**
 * Result of validating quiz tool arguments against QuestionData shapes.
 */
export interface QuizValidationResult {
	valid: boolean;
	errors?: string[];
	questionData?: QuestionData;
}

/**
 * A detected tool call extracted from text or streaming deltas.
 */
export interface DetectedToolCall {
	name: StructuredToolName;
	args: Record<string, any>;
	raw: string;
	validation?: QuizValidationResult;
}

/**
 * Assistant message representation carried by TurnWireEvent.
 */
export interface WireTextMessage {
	role: "assistant";
	content: Array<
		| { type: "text"; text: string }
		| { type: "toolCall"; id: string; name: string; arguments: any }
		| { type: "thinking"; thinking: string }
	>;
	id?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: AgyUsage;
}

/**
 * LearnHarness wire event stream representation (compatible with UI subscribers).
 */
export type TurnWireEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: WireTextMessage[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message?: WireTextMessage; toolResults?: any[] }
	| { type: "message_start"; message: WireTextMessage }
	| { type: "message_update"; message: WireTextMessage }
	| { type: "message_end"; message: WireTextMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult?: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean; durationMs?: number }
	| { type: "error"; errorText: string }
	| { type: "turn-settled" };

/**
 * Regex matching any of the 10 recognized tool blocks:
 * :::(quiz|ask_user_question|...)\s*([\s\S]*?):::
 */
const TOOL_BLOCK_REGEX = new RegExp(
	`:::(${STRUCTURED_TOOL_NAMES.join("|")})\\s*([\\s\\S]*?):::`,
	"g"
);

/**
 * Cleanly validates raw quiz arguments against QuestionData shapes.
 * Handles string-array options, object options, answer index or value,
 * multiSelect, and cross-field consistency.
 *
 * @param args - Raw arguments payload from tool JSON
 * @param toolCallId - Optional call identifier to stamp on QuestionData
 * @returns QuizValidationResult with errors or normalized QuestionData
 */
export function validateQuizArgs(args: unknown, toolCallId?: string): QuizValidationResult {
	const errors: string[] = [];

	if (!args || typeof args !== "object") {
		return { valid: false, errors: ["Quiz arguments must be an object."] };
	}

	const raw = args as Record<string, unknown>;

	// 1. Validate question text
	const question = typeof raw.question === "string" ? raw.question.trim() : "";
	if (!question) {
		errors.push("question is required and must be a non-empty string.");
	}

	// 2. Validate options
	const rawOptions =
		typeof raw.options === "string" || Array.isArray(raw.options)
			? parseOptionsIfString(raw.options)
			: undefined;
	if (!Array.isArray(rawOptions)) {
		errors.push("options is required and must be an array of at least 2 options.");
		return { valid: false, errors };
	}

	const optionObjects: Array<{ label: string; value?: string; description?: string }> = [];
	for (let i = 0; i < rawOptions.length; i++) {
		const opt = rawOptions[i];
		if (typeof opt === "string") {
			const trimmed = opt.trim();
			optionObjects.push({ label: trimmed, value: trimmed });
		} else if (opt && typeof opt === "object") {
			const o = opt as Record<string, unknown>;
			const label = typeof o.label === "string" ? o.label.trim() : "";
			const value = typeof o.value === "string" ? o.value.trim() : label;
			const description = typeof o.description === "string" ? o.description.trim() : undefined;
			optionObjects.push({ label, value, description });
		} else {
			errors.push(`options[${i}] must be a string or an option object.`);
		}
	}

	if (optionObjects.length < 2) {
		errors.push("options must contain at least 2 items.");
	}

	let normalizedOptions: QuizOption[] = [];
	try {
		normalizedOptions = normalizeOptions(optionObjects);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		errors.push(msg);
	}

	// 3. Resolve correct answer
	const multiSelect = raw.multiSelect === true;
	let correctAnswerCandidate: string | string[] | undefined = undefined;

	if (raw.correctAnswer !== undefined) {
		if (typeof raw.correctAnswer === "string") {
			correctAnswerCandidate = raw.correctAnswer;
		} else if (Array.isArray(raw.correctAnswer)) {
			correctAnswerCandidate = raw.correctAnswer.map((x) => String(x).trim());
		}
	} else if (raw.answer !== undefined) {
		if (typeof raw.answer === "number") {
			// Convert numeric index to option value (0-based index or 1-based fallback)
			if (raw.answer >= 0 && raw.answer < normalizedOptions.length) {
				correctAnswerCandidate = normalizedOptions[raw.answer]?.value;
			} else if (raw.answer === normalizedOptions.length && raw.answer >= 1) {
				correctAnswerCandidate = normalizedOptions[raw.answer - 1]?.value;
			} else {
				errors.push(`answer index ${raw.answer} is out of bounds for options length ${normalizedOptions.length}.`);
			}
		} else if (typeof raw.answer === "string") {
			correctAnswerCandidate = raw.answer;
		} else if (Array.isArray(raw.answer)) {
			const values: string[] = [];
			for (const ans of raw.answer) {
				if (typeof ans === "number" && ans >= 0 && ans < normalizedOptions.length) {
					values.push(normalizedOptions[ans]!.value);
				} else if (typeof ans === "string") {
					values.push(ans.trim());
				}
			}
			correctAnswerCandidate = values;
		}
	} else if (raw.correctIndices !== undefined && Array.isArray(raw.correctIndices)) {
		const values: string[] = [];
		for (const idx of raw.correctIndices) {
			if (typeof idx === "number" && idx >= 1 && idx <= normalizedOptions.length) {
				values.push(normalizedOptions[idx - 1]!.value);
			}
		}
		correctAnswerCandidate = values;
	}

	let resolvedIndices: number[] | undefined = undefined;
	if (correctAnswerCandidate !== undefined && normalizedOptions.length >= 2) {
		const resolved = resolveCorrect(correctAnswerCandidate, normalizedOptions);
		if (resolved.error) {
			errors.push(resolved.error);
		} else {
			resolvedIndices = resolved.indices;
			if (resolvedIndices.length > 1 && !multiSelect) {
				errors.push(`Multiple correct answers specified (${resolvedIndices.length}) but multiSelect is not true.`);
			}
		}
	} else if (!errors.some((e) => e.includes("answer"))) {
		errors.push("correctAnswer or answer is required.");
	}

	if (errors.length > 0) {
		return { valid: false, errors };
	}

	const id = toolCallId || `call_quiz_${Date.now()}`;
	const questionData: QuestionData = {
		id,
		kind: "quiz",
		questionType: normalizeQuizType(raw.type),
		question,
		context:
			typeof raw.details === "string"
				? raw.details
				: typeof raw.context === "string"
					? raw.context
					: undefined,
		mode: multiSelect ? "multi-select" : "single-select",
		options: normalizedOptions,
		correctIndices: resolvedIndices,
		explanation: typeof raw.explanation === "string" ? raw.explanation : undefined,
		createdAt: new Date().toISOString(),
	};

	return {
		valid: true,
		questionData,
	};
}

/**
 * Extracts structured tool blocks (:::quiz, :::plan_init, etc.) from raw model text.
 * Strips tool block markup from cleanText. If a terminating tool (quiz, ask_user_question, problem)
 * is encountered, truncates subsequent text that would violate the one-question-per-turn doctrine.
 *
 * @param rawText - Raw text output from model
 * @returns Object containing cleanText and array of DetectedToolCall objects
 */
export function extractStructuredTools(rawText: string): { cleanText: string; tools: DetectedToolCall[] } {
	const tools: DetectedToolCall[] = [];
	let firstTerminatingMatchIndex = -1;

	TOOL_BLOCK_REGEX.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = TOOL_BLOCK_REGEX.exec(rawText)) !== null) {
		const toolName = match[1] as StructuredToolName;
		const rawBlock = match[0];
		const body = match[2]?.trim() ?? "";

		let jsonStr = body;
		if (jsonStr.startsWith("```")) {
			jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
		}

		let args: any = {};
		let parseSuccess = false;
		if (!jsonStr) {
			args = {};
			parseSuccess = true;
		} else {
			try {
				args = JSON.parse(jsonStr);
				parseSuccess = true;
			} catch {
				parseSuccess = false;
			}
		}

		if (parseSuccess) {
			const detected: DetectedToolCall = {
				name: toolName,
				args,
				raw: rawBlock,
			};
			if (toolName === "quiz") {
				detected.validation = validateQuizArgs(args);
			}
			tools.push(detected);

			if (isTerminatingTool(toolName) && firstTerminatingMatchIndex === -1) {
				firstTerminatingMatchIndex = match.index;
			}
		}
	}

	let cleanText: string;
	if (firstTerminatingMatchIndex !== -1) {
		const beforeTerminal = rawText.slice(0, firstTerminatingMatchIndex);
		cleanText = beforeTerminal.replace(TOOL_BLOCK_REGEX, "").trim();
	} else {
		cleanText = rawText.replace(TOOL_BLOCK_REGEX, "").trim();
	}

	cleanText = cleanText.replace(/\n{3,}/g, "\n\n");

	return { cleanText, tools };
}

/**
 * Options for configuring AgyStreamBridge.
 */
export interface AgyStreamBridgeOptions {
	messageId?: string;
	toolCallIdGenerator?: (toolName: string) => string;
	onToolDetected?: (tool: DetectedToolCall, toolCallId: string) => void;
}

/**
 * Manages real-time delimiter buffering and translates Antigravity stream events
 * or text deltas into TurnWireEvent items for SSE transmission.
 */
export class AgyStreamBridge {
	private readonly options: AgyStreamBridgeOptions;
	private readonly messageId: string;
	private started = false;
	private ended = false;
	private isTerminated = false;
	private buffer = "";
	private cleanText = "";
	private lastEmittedCleanText = "";
	private toolCalls: Array<{ id: string; name: StructuredToolName; args: any }> = [];
	private toolCallCounter = 0;

	constructor(options: AgyStreamBridgeOptions = {}) {
		this.options = options;
		this.messageId =
			options.messageId ?? `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	}

	private generateToolCallId(toolName: string): string {
		this.toolCallCounter++;
		if (this.options.toolCallIdGenerator) {
			return this.options.toolCallIdGenerator(toolName);
		}
		return `call_${toolName}_${this.toolCallCounter}`;
	}

	private buildContent(): WireTextMessage["content"] {
		const content: WireTextMessage["content"] = [];
		if (this.cleanText.length > 0) {
			content.push({ type: "text", text: this.cleanText });
		}
		for (const tc of this.toolCalls) {
			content.push({
				type: "toolCall",
				id: tc.id,
				name: tc.name,
				arguments: tc.args,
			});
		}
		if (content.length === 0) {
			content.push({ type: "text", text: "" });
		}
		return content;
	}

	private maybeEmitMessageUpdate(events: TurnWireEvent[]): void {
		if (this.cleanText !== this.lastEmittedCleanText) {
			this.lastEmittedCleanText = this.cleanText;
			events.push({
				type: "message_update",
				message: {
					role: "assistant",
					id: this.messageId,
					content: this.buildContent(),
				},
			});
		}
	}

	/**
	 * Ingests a text delta chunk, buffering incomplete delimiters (e.g. partial ":::" or in-flight tool blocks).
	 * Emits synthesized TurnWireEvent items as clean text and completed tool calls emerge.
	 *
	 * @param chunk - Text chunk from streaming provider
	 * @returns Array of synthesized TurnWireEvent items
	 */
	public processChunk(chunk: string): TurnWireEvent[] {
		if (this.ended || this.isTerminated) {
			return [];
		}

		const events: TurnWireEvent[] = [];

		if (!this.started) {
			events.push({
				type: "message_start",
				message: {
					role: "assistant",
					id: this.messageId,
					content: [{ type: "text", text: "" }],
				},
			});
			this.started = true;
		}

		this.buffer += chunk;

		while (this.buffer.length > 0) {
			const colonIdx = this.buffer.indexOf(":::");

			if (colonIdx === -1) {
				// No full ":::" found. Check if the buffer ends with partial ":" or "::"
				let safeEnd = this.buffer.length;
				if (this.buffer.endsWith("::")) {
					safeEnd = this.buffer.length - 2;
				} else if (this.buffer.endsWith(":")) {
					safeEnd = this.buffer.length - 1;
				}

				if (safeEnd > 0) {
					const textToEmit = this.buffer.slice(0, safeEnd);
					this.cleanText += textToEmit;
					this.buffer = this.buffer.slice(safeEnd);
					this.maybeEmitMessageUpdate(events);
				}
				// Remainder (1 or 2 colons) stays buffered
				break;
			}

			// Buffer contains ":::" at colonIdx.
			// Any text before colonIdx is proven plain text.
			if (colonIdx > 0) {
				const textToEmit = this.buffer.slice(0, colonIdx);
				this.cleanText += textToEmit;
				this.buffer = this.buffer.slice(colonIdx);
				this.maybeEmitMessageUpdate(events);
			}

			// Buffer now starts with ":::"
			const afterColons = this.buffer.slice(3);

			if (afterColons.length === 0) {
				// Waiting for characters following ":::"
				break;
			}

			const firstWordMatch = afterColons.match(/^([a-zA-Z0-9_]*)/);
			const candidateName = firstWordMatch ? firstWordMatch[1]! : "";

			const matchingTools = STRUCTURED_TOOL_NAMES.filter((t) => t.startsWith(candidateName));
			const exactTool = STRUCTURED_TOOL_NAMES.find((t) => t === candidateName);

			if (matchingTools.length === 0) {
				// Not a known tool name (e.g. ":::warning" or "::: 123") -> proven plain text!
				this.cleanText += ":::";
				this.buffer = afterColons;
				this.maybeEmitMessageUpdate(events);
				continue;
			}

			// Candidate is a prefix of a tool name.
			// If not yet an exact tool and no delimiter/whitespace has followed, wait for more chunks.
			if (!exactTool && afterColons === candidateName) {
				break;
			}

			if (!exactTool) {
				// Candidate had extra non-matching characters (e.g. ":::quizxyz")
				this.cleanText += ":::";
				this.buffer = afterColons;
				this.maybeEmitMessageUpdate(events);
				continue;
			}

			// exactTool found (e.g. "quiz").
			const afterToolName = afterColons.slice(exactTool.length);
			if (afterToolName.length === 0) {
				// Incomplete block header (e.g. ":::quiz") -> wait for newline/whitespace
				break;
			}

			if (
				!/^\s/.test(afterToolName) &&
				!afterToolName.startsWith("{") &&
				!afterToolName.startsWith(":")
			) {
				// Suffix invalidates tool name (e.g. ":::quiz9")
				this.cleanText += ":::";
				this.buffer = afterColons;
				this.maybeEmitMessageUpdate(events);
				continue;
			}

			// Valid tool header confirmed. Look for closing delimiter ":::"
			const closingIdx = this.buffer.indexOf(":::", 3 + exactTool.length);
			if (closingIdx === -1) {
				// Tool body still streaming in. Keep buffered.
				break;
			}

			// Tool block complete!
			const rawBlock = this.buffer.slice(0, closingIdx + 3);
			const body = this.buffer.slice(3 + exactTool.length, closingIdx).trim();

			let jsonStr = body;
			if (jsonStr.startsWith("```")) {
				jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
			}

			let args: any = {};
			try {
				args = jsonStr ? JSON.parse(jsonStr) : {};
			} catch {
				args = {};
			}

			const toolCallId = this.generateToolCallId(exactTool);
			const toolCall: DetectedToolCall = {
				name: exactTool,
				args,
				raw: rawBlock,
			};

			let isError = false;
			let errorMessage = "Validation failed";
			if (exactTool === "quiz") {
				const val = validateQuizArgs(args, toolCallId);
				toolCall.validation = val;
				if (!val.valid) {
					isError = true;
					errorMessage = val.errors?.join("; ") ?? "Quiz validation failed";
				}
			}

			this.toolCalls.push({ id: toolCallId, name: exactTool, args });
			this.options.onToolDetected?.(toolCall, toolCallId);

			// Emit message_update with toolCall partial BEFORE tool_execution_start
			// (protocol pin for 'Writing a question...' shimmer)
			events.push({
				type: "message_update",
				message: {
					role: "assistant",
					id: this.messageId,
					content: this.buildContent(),
				},
			});

			// Synthesize tool_execution_start
			events.push({
				type: "tool_execution_start",
				toolCallId,
				toolName: exactTool,
				args,
			});

			// Synthesize tool_execution_end
			events.push({
				type: "tool_execution_end",
				toolCallId,
				toolName: exactTool,
				result: {
					content: [
						{
							type: "text",
							text: isError
								? errorMessage
								: isQuestionTool(exactTool)
									? "Question posed"
									: "Tool executed",
						},
					],
					details: isError ? undefined : args,
				},
				isError,
				durationMs: 0,
			});

			// Advance buffer past this tool block
			this.buffer = this.buffer.slice(closingIdx + 3);

			// If terminating tool, end turn immediately
			if (isTerminatingTool(exactTool)) {
				this.isTerminated = true;
				this.buffer = "";
				break;
			}
		}

		return events;
	}

	/**
	 * Processes a structured AgyStreamEvent from the Antigravity CLI runner.
	 *
	 * @param ev - AgyStreamEvent (text_delta, result, error)
	 * @returns Array of synthesized TurnWireEvent items
	 */
	public processAgyEvent(ev: AgyStreamEvent): TurnWireEvent[] {
		if (ev.type === "text_delta") {
			return this.processChunk(ev.text);
		}
		if (ev.type === "result") {
			return this.finish(ev.status, ev.usage);
		}
		if (ev.type === "error") {
			const events: TurnWireEvent[] = [];
			if (!this.ended) {
				events.push({
					type: "error",
					errorText: ev.message || "An error occurred",
				});
				events.push(...this.finish("ERROR"));
			}
			return events;
		}
		return [];
	}

	/**
	 * Concludes the stream, flushing any pending text if unterminated,
	 * and synthesizing message_end and agent_end wire events.
	 *
	 * @param status - Final status string
	 * @param usage - Optional usage metrics
	 * @returns Array of synthesized TurnWireEvent items
	 */
	public finish(status?: string, usage?: AgyUsage): TurnWireEvent[] {
		if (this.ended) {
			return [];
		}
		this.ended = true;

		const events: TurnWireEvent[] = [];

		if (!this.started) {
			events.push({
				type: "message_start",
				message: {
					role: "assistant",
					id: this.messageId,
					content: [{ type: "text", text: "" }],
				},
			});
			this.started = true;
		}

		if (!this.isTerminated && this.buffer.length > 0) {
			this.cleanText += this.buffer;
			this.buffer = "";
			this.maybeEmitMessageUpdate(events);
		}

		const hasTerminating = this.toolCalls.some((tc) => isTerminatingTool(tc.name));
		const finalMessage: WireTextMessage = {
			role: "assistant",
			id: this.messageId,
			content: this.buildContent(),
			stopReason: hasTerminating ? "toolUse" : status === "ERROR" ? "error" : "stop",
			usage,
		};

		events.push({
			type: "message_end",
			message: finalMessage,
		});

		events.push({
			type: "agent_end",
			messages: [finalMessage],
		});

		return events;
	}

	public isEnded(): boolean {
		return this.ended;
	}

	public isTerminatedState(): boolean {
		return this.isTerminated;
	}

	public getCleanText(): string {
		return this.cleanText;
	}

	public getToolCalls(): Array<{ id: string; name: StructuredToolName; args: any }> {
		return [...this.toolCalls];
	}
}

/**
 * Async generator that consumes an AgyStreamEvent async iterable,
 * applies delimiter buffering, and yields TurnWireEvent items in real time.
 *
 * @param agyStream - Async iterable yielding AgyStreamEvent items
 * @param options - Configuration options for stream bridge
 * @returns AsyncGenerator yielding TurnWireEvent items
 */
export async function* bridgeAgyStream(
	agyStream: AsyncIterable<AgyStreamEvent>,
	options?: AgyStreamBridgeOptions
): AsyncGenerator<TurnWireEvent, void, unknown> {
	const bridge = new AgyStreamBridge(options);
	for await (const ev of agyStream) {
		const wireEvents = bridge.processAgyEvent(ev);
		for (const we of wireEvents) {
			yield we;
		}
	}
	if (!bridge.isEnded()) {
		const wireEvents = bridge.finish();
		for (const we of wireEvents) {
			yield we;
		}
	}
}
