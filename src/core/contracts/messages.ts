/**
 * Native message and provider domain contracts.
 *
 * Defines the core transcript shapes (system, user, assistant, tool result)
 * and agent messaging types without external dependencies on pi-ai or
 * pi-agent-core, ensuring 100% JSON wire compatibility with existing stored sessions.
 */

// ─── Thinking Levels ─────────────────────────────────────────────────────────

/**
 * Thinking/reasoning level for models that support reasoning effort.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// ─── Usage and Cost Accounting ──────────────────────────────────────────────

/**
 * Breakdown of monetary cost for a model call or run in USD.
 */
export interface UsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

/**
 * Complete token and cost usage report for a model generation.
 */
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Subset of cacheWrite written with 1h retention (reported by select providers). */
	cacheWrite1h?: number;
	/**
	 * Reasoning/thinking tokens, when the provider reports them. This is a subset of
	 * output: output already includes these tokens.
	 */
	reasoning?: number;
	totalTokens: number;
	cost: UsageCost;
}

// ─── Message Content Blocks ──────────────────────────────────────────────────

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	/** When true, thinking content was redacted by safety filters. */
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

export type JsonObject = {
	[key: string]: JsonValue;
};

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
	thoughtSignature?: string;
	/** OpenAI Responses namespace for calls to dynamically loaded or namespaced tools. */
	namespace?: string;
	/**
	 * Set when the model's complete arguments text was not a valid JSON object.
	 */
	argumentsError?: string;
}

// ─── Stop Reasons ────────────────────────────────────────────────────────────

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

// ─── Tool Definitions & Reference Types ──────────────────────────────────────

export interface ToolReference {
	name: string;
}

export interface Tool<TParameters = unknown> {
	name: string;
	description: string;
	parameters: TParameters;
}

// ─── Diagnostics & Deferred Handles ──────────────────────────────────────────

export interface DiagnosticErrorInfo {
	name?: string;
	message: string;
	stack?: string;
	code?: string | number;
}

export interface AssistantMessageDiagnostic {
	type: string;
	timestamp: number;
	error?: DiagnosticErrorInfo;
	details?: Record<string, unknown>;
}

export interface DeferredHandle {
	provider: string;
	modelId: string;
	api: string;
	id: string;
	expiresAt?: number;
	pollAfterMs?: number;
	data?: unknown;
}

// ─── Nested Tool Calls ───────────────────────────────────────────────────────

export interface NestedToolCallRecord {
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
	argumentsBytes?: number;
	status: "ok" | "error" | "unfinished";
	durationMs?: number;
	error?: string;
}

export interface NestedToolCalls {
	calls: NestedToolCallRecord[];
	complete: boolean;
}

// ─── Messages ────────────────────────────────────────────────────────────────

export interface SystemMessage {
	role: "system";
	/** Instruction text. On the leading message this is the base prompt; later, additional instructions. */
	content: string | TextContent[];
	/**
	 * Named, ordered prompt sections rendered verbatim after content.
	 */
	sections?: Record<string, string | null>;
	/** Complete definitions of tools that become available at this point. */
	toolsAdded?: Tool[];
	/** Tools that stop being available at this point. */
	toolsRemoved?: ToolReference[];
	timestamp: number;
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: string;
	provider: string;
	model: string;
	responseModel?: string;
	responseId?: string;
	/** Exact provider-native effort level used for this response. */
	providerThinkingLevel?: string;
	/** Thinking level requested for this response. */
	thinkingLevel?: ThinkingLevel;
	diagnostics?: AssistantMessageDiagnostic[];
	usage: Usage;
	stopReason: StopReason;
	deferred?: DeferredHandle;
	errorMessage?: string;
	rawStopReason?: string;
	/** Provider indication of whether the model explicitly ended its turn. */
	endTurn?: boolean;
	/** Unix timestamp in milliseconds when the request started. */
	timestamp: number;
	/** Milliseconds from timestamp until the response ended. */
	durationMs?: number;
}

export interface ToolResultMessage<TDetails = any> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: TDetails;
	/** Usage from the tool execution itself, if available. */
	usage?: Usage;
	/** Calls this tool made to other tools. */
	nestedCalls?: NestedToolCalls;
	isError: boolean;
	/** Unix timestamp in milliseconds when the result was created. */
	timestamp: number;
	/** Milliseconds the tool's execution took. */
	durationMs?: number;
}

/** Union of the standard LLM wire messages. */
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

/**
 * Extensible interface for custom application messages.
 * Extend via TypeScript declaration merging:
 *
 * declare module "@/src/core" {
 *   interface CustomAgentMessages {
 *     myMessage: MyCustomMessage;
 *   }
 * }
 */
export interface CustomAgentMessages {}

/**
 * AgentMessage: Union of LLM wire messages + custom app messages.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
