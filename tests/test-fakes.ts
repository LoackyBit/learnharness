import { Value } from "typebox/value";
import type {
	AssistantMessage,
	ImageContent,
	Message,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../src/core/contracts/messages.ts";

export interface FauxToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
}

export function fauxToolCall(name: string, args: Record<string, any> = {}, options: { id?: string } = {}): ToolCall {
	return {
		type: "toolCall",
		id: options.id ?? `call_${name}_${Math.random().toString(36).slice(2, 9)}`,
		name,
		arguments: args,
	};
}

export function fauxText(text: string): TextContent {
	return {
		type: "text",
		text,
	};
}

export function fauxThinking(thinking: string): ThinkingContent {
	return {
		type: "thinking",
		thinking,
	};
}

export interface FauxAssistantMessageOptions {
	stopReason?: "stop" | "toolUse" | "length" | "aborted" | "abort" | "error";
	model?: string;
	provider?: string;
	usage?: Partial<Usage>;
}

export function fauxAssistantMessage(
	content: string | (TextContent | ThinkingContent | ToolCall)[],
	options: FauxAssistantMessageOptions = {},
): AssistantMessage {
	const contentArr = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
	const hasTool = contentArr.some((c) => c.type === "toolCall");

	const rawStop = options.stopReason ?? (hasTool ? "toolUse" : "stop");
	const stopReason: StopReason = rawStop === "abort" ? "aborted" : rawStop;

	return {
		role: "assistant",
		content: contentArr,
		api: "antigravity",
		provider: options.provider ?? "antigravity",
		model: options.model ?? "gemini-3.8-flash-high",
		usage: {
			input: options.usage?.input ?? 20,
			output: options.usage?.output ?? 20,
			cacheRead: options.usage?.cacheRead ?? 0,
			cacheWrite: options.usage?.cacheWrite ?? 0,
			totalTokens: options.usage?.totalTokens ?? 40,
			cost: options.usage?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			reasoning: options.usage?.reasoning ?? 0,
		},
		stopReason,
		durationMs: 5,
		timestamp: Date.now(),
	};
}

export type FauxResponseStep =
	| AssistantMessage
	| ((context: any, options?: any, state?: any, model?: any) => AssistantMessage | Promise<AssistantMessage>);

export function normalizeContext(ctx: {
	systemPrompt?: string;
	messages?: Message[];
	tools?: any[];
	[key: string]: any;
}): { systemPrompt: string; messages: Message[]; tools: any[] } {
	return {
		systemPrompt: ctx.systemPrompt ?? "",
		messages: ctx.messages ?? [],
		tools: ctx.tools ?? [],
		...ctx,
	};
}

export function validateToolArguments(tool: { parameters?: any }, argsOrCall: any): any {
	const args =
		argsOrCall && typeof argsOrCall === "object" && "arguments" in argsOrCall
			? argsOrCall.arguments
			: argsOrCall;
	if (!tool.parameters) return args;
	const cloned = structuredClone(args);
	try {
		Value.Convert(tool.parameters, cloned);
	} catch {}
	if (!Value.Check(tool.parameters, cloned)) {
		const errors = [...Value.Errors(tool.parameters, cloned)].map((e) => `${(e as any).path || "(root)"}: ${e.message}`);
		throw new Error(`Validation failed for tool arguments: ${errors.join(", ")}`);
	}
	return Value.Clean(tool.parameters, cloned);
}

export interface FauxCoreOptions {
	tokenSize?: { min: number; max: number };
	modelId?: string;
}

export function createFauxCore(options: FauxCoreOptions = {}) {
	let steps: FauxResponseStep[] = [];
	let stepIdx = 0;

	const model = {
		id: options.modelId ?? "gemini-3.8-flash-high",
		provider: "antigravity",
		name: "Antigravity Faux Model",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};

	const streamSimple = (requestModel: any, context: any, streamOptions: any = {}) => {
		const step = steps[stepIdx++];
		const stepPromise = (async () => {
			if (!step) {
				return fauxAssistantMessage([fauxText("")]);
			}
			if (typeof step === "function") {
				return await step(context, streamOptions, {}, requestModel || model);
			}
			return step;
		})();

		return {
			result: async () => await stepPromise,
			async *[Symbol.asyncIterator]() {
				const assistantMsg = await stepPromise;
				yield {
					type: "start",
					partial: { role: "assistant", content: [], timestamp: Date.now() },
				};
				for (const c of assistantMsg.content) {
					if (c.type === "text") {
						yield { type: "text_delta", delta: c.text };
					} else if (c.type === "thinking") {
						yield { type: "thinking_delta", delta: c.thinking };
					}
				}
				yield {
					type: "done",
					reason: assistantMsg.stopReason ?? "stop",
					message: assistantMsg,
				};
			},
		};
	};

	return {
		getModel: () => model,
		setResponses: (newSteps: FauxResponseStep[]) => {
			steps = [...newSteps];
			stepIdx = 0;
		},
		streamSimple,
	};
}

export const builtinProviders = [
	{ id: "antigravity", label: "Google Antigravity CLI", envVar: "AGY_PATH" },
];

export function streamCodex(model: any, context: any, options: any) {
	if (options.onPayload) {
		options.onPayload({ prompt_cache_key: Array.from(options.sessionId || "").slice(0, 64).join("") });
	}
	return {
		result: async () => ({ errorMessage: undefined }),
	};
}

export interface Model<TApi = any> {
	id: string;
	provider: string;
	api: TApi;
	[key: string]: any;
}

export type SimpleStreamOptions = any;

