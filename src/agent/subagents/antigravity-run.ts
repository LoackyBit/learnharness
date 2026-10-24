import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import type { ModelRole } from "../../../config.ts";
import type {
	AgentMessage,
	AssistantMessage,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../../core/contracts/messages.ts";
import type { CallUsage } from "../../core/contracts/chat.ts";
import {
	APP_IDENTITY,
	type AntigravityEngine,
	type PiEngine,
	getDefaultModel,
	piEngineFor,
} from "../models.ts";
import type { AgentTool } from "../tool-execute.ts";
import {
	runAgyStream,
	type AgyRunOptions,
	type AgyStreamEvent,
	type AgyUsage,
} from "../../server/antigravity/runner.ts";

export type { CallUsage };

/**
 * Execution options for Antigravity subagents.
 */
export interface SubagentRunOptions {
	/** The role whose engine (model + thinking level) this run uses. */
	role: ModelRole;
	/** Test seam: a scripted engine replaces the role's production one. */
	engine?: PiEngine;
	systemPrompt: string;
	/** Initial transcript (continuation semantics: ends user / toolResult). */
	messages?: AgentMessage[];
	/** Fresh-run prompt text (mutually exclusive with a continuation). */
	prompt?: string;
	/** Max model calls (the old stepCountIs safety net). */
	maxTurns: number;
	/** Abort mid-model-call (the real-kill semantics). */
	abortSignal?: AbortSignal;
	/** Money channel: one call per model request. */
	onUsage?: (usage: Usage) => void;
	/** Activity line per tool execution (job record progress). */
	onToolStart?: (toolName: string, args: unknown) => void;
	/** Per completed assistant message (extraction's step log). */
	onAssistantMessage?: (message: AssistantMessage, step: number) => void;
	/** Extra stop rule (extractor: stop after a clean submit). */
	shouldStop?: (message: AssistantMessage, toolResults: ToolResultMessage[]) => boolean;
	/** Debug: when set AND LH_PROVIDER_EVENTS=1, raw provider stream
	 *  events append to data/debug/provider-events/<chatId>.jsonl (context
	 *  "job:<role>"). Absent or env-off → no observer. */
	chatId?: string;
	/** Test seam: path to agy binary */
	agyPath?: string;
	/** Extra CLI flags for agy runner */
	extraArgs?: string[];
	/** Working directory for agy */
	cwd?: string;
	/** Effort level override */
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
	/** Tools array when passed inside options object */
	tools?: AgentTool<any, any>[];
}

/**
 * Report of an individual subagent turn/step.
 */
export interface SubagentStep {
	step: number;
	usage: Usage;
	callUsage?: CallUsage;
	model: string;
	finishReason: string;
	tools?: string;
	message?: AssistantMessage;
}

/**
 * Final result returned by runAntigravitySubagent.
 */
export interface SubagentRunResult {
	/** The messages this run added (assistant + tool results). */
	newMessages: AgentMessage[];
	/** The final assistant text (the deliverable). */
	text: string;
}

/**
 * Resolves the engine for a subagent role, honoring caller override.
 */
export function subagentEngine(role: ModelRole, override?: PiEngine): PiEngine {
	return override ?? piEngineFor(role);
}

/**
 * Normalizes Antigravity CLI usage into standard Usage format.
 */
export function agyUsageToUsage(agyUsage?: AgyUsage): Usage {
	const input = Number(agyUsage?.input_tokens ?? 0);
	const output = Number(agyUsage?.output_tokens ?? 0);
	const reasoning =
		agyUsage?.thinking_tokens !== undefined ? Number(agyUsage.thinking_tokens) : undefined;
	const cacheRead = Number(agyUsage?.cache_read_tokens ?? 0);
	const totalTokens = Number(agyUsage?.total_tokens ?? (input + output));
	return {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		reasoning,
		totalTokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

/**
 * Maps Usage to CallUsage representation.
 */
export function usageToCallUsage(usage: Usage): CallUsage {
	return {
		inputTokens: usage.input || undefined,
		outputTokens: usage.output || undefined,
		cacheReadTokens: usage.cacheRead || undefined,
		cacheWriteTokens: usage.cacheWrite || undefined,
		reasoningTokens: usage.reasoning || undefined,
	};
}

export interface ExtractedToolCall {
	id: string;
	name: string;
	args: Record<string, any>;
	raw: string;
	parseError?: string;
}

/**
 * Extracts structured tool call blocks (`:::tool_name\n{ ... }\n:::`)
 * from raw text emitted by Antigravity CLI.
 */
export function extractSubagentToolCalls(
	text: string,
	knownToolNames?: Set<string>,
): { cleanText: string; toolCalls: ExtractedToolCall[] } {
	const blockRegex = /:::([a-zA-Z0-9_-]+)\s*([\s\S]*?):::/g;
	const toolCalls: ExtractedToolCall[] = [];
	let counter = 0;

	let match: RegExpExecArray | null;
	while ((match = blockRegex.exec(text)) !== null) {
		const rawName = match[1]!;
		const rawBody = match[2]!.trim();

		if (knownToolNames && !knownToolNames.has(rawName)) {
			continue;
		}

		let jsonStr = rawBody;
		if (jsonStr.startsWith("```")) {
			jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
		}

		let args: Record<string, any> = {};
		let parseError: string | undefined;

		if (!jsonStr) {
			args = {};
		} else {
			try {
				args = JSON.parse(jsonStr);
			} catch (err: any) {
				parseError = `Malformed JSON: ${err.message}`;
			}
		}

		counter++;
		toolCalls.push({
			id: `call_${rawName}_${counter}_${Date.now()}`,
			name: rawName,
			args,
			raw: match[0],
			parseError,
		});
	}

	let cleanText = text.replace(blockRegex, (fullMatch, name) => {
		if (knownToolNames && !knownToolNames.has(name)) return fullMatch;
		return "";
	}).trim();

	// Fallback single-tool detection when model emits raw JSON or code fence without ::: prefix
	if (toolCalls.length === 0 && knownToolNames && knownToolNames.size === 1) {
		const singleToolName = Array.from(knownToolNames)[0]!;
		const trimmed = text.trim();

		const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
		if (fenceMatch) {
			const candidate = fenceMatch[1]!.trim();
			try {
				const parsed = JSON.parse(candidate);
				if (typeof parsed === "object" && parsed !== null) {
					toolCalls.push({
						id: `call_${singleToolName}_1_${Date.now()}`,
						name: singleToolName,
						args: parsed,
						raw: fenceMatch[0],
					});
					cleanText = text.replace(fenceMatch[0], "").trim();
				}
			} catch (err: any) {
				toolCalls.push({
					id: `call_${singleToolName}_1_${Date.now()}`,
					name: singleToolName,
					args: {},
					raw: fenceMatch[0],
					parseError: `Malformed JSON: ${err.message}`,
				});
				cleanText = text.replace(fenceMatch[0], "").trim();
			}
		} else {
			const firstBrace = trimmed.indexOf("{");
			const lastBrace = trimmed.lastIndexOf("}");

			if (firstBrace !== -1 && lastBrace > firstBrace) {
				const jsonSubstring = trimmed.slice(firstBrace, lastBrace + 1);
				try {
					const parsed = JSON.parse(jsonSubstring);
					if (typeof parsed === "object" && parsed !== null) {
						toolCalls.push({
							id: `call_${singleToolName}_1_${Date.now()}`,
							name: singleToolName,
							args: parsed,
							raw: jsonSubstring,
						});
						cleanText = trimmed.slice(0, firstBrace).trim();
					}
				} catch (err: any) {
					toolCalls.push({
						id: `call_${singleToolName}_1_${Date.now()}`,
						name: singleToolName,
						args: {},
						raw: jsonSubstring,
						parseError: `Malformed JSON: ${err.message}`,
					});
					cleanText = trimmed.slice(0, firstBrace).trim();
				}
			} else if (firstBrace !== -1) {
				toolCalls.push({
					id: `call_${singleToolName}_1_${Date.now()}`,
					name: singleToolName,
					args: {},
					raw: trimmed.slice(firstBrace),
					parseError: "Malformed JSON: unclosed object",
				});
				cleanText = trimmed.slice(0, firstBrace).trim();
			}
		}
	}

	return { cleanText, toolCalls };
}

/**
 * Builds the composite prompt string for an Antigravity subprocess run.
 */
export function buildSubagentPrompt(
	systemPrompt: string,
	tools: AgentTool<any, any>[],
	messages: AgentMessage[],
	currentPrompt?: string,
): string {
	const parts: string[] = [];

	if (systemPrompt && systemPrompt.trim()) {
		parts.push(systemPrompt.trim());
	}

	if (tools.length > 0) {
		const toolLines = [
			"### Available Tools",
			"You can call tools using structured blocks in this format:",
			":::<tool_name>",
			"{ ...json arguments... }",
			":::",
			"",
			...tools.map((t) => {
				const params = t.parameters ? JSON.stringify(t.parameters) : "{}";
				return `- :::${t.name}\n${t.description}\nParameters: ${params}\n:::`;
			}),
		];
		parts.push(toolLines.join("\n"));
	}

	if (messages.length > 0) {
		const transcriptLines = ["### Conversation History"];
		for (const m of messages) {
			if (m.role === "user") {
				const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
				transcriptLines.push(`User: ${text}`);
			} else if (m.role === "assistant") {
				const text = m.content
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("");
				transcriptLines.push(`Assistant: ${text}`);
				for (const c of m.content) {
					if (c.type === "toolCall") {
						transcriptLines.push(`:::${c.name}\n${JSON.stringify(c.arguments)}\n:::`);
					}
				}
			} else if (m.role === "toolResult") {
				const text = m.content
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("");
				transcriptLines.push(`Tool Result [${m.toolName}]: ${text}`);
			}
		}
		parts.push(transcriptLines.join("\n\n"));
	}

	if (currentPrompt && currentPrompt.trim()) {
		parts.push(currentPrompt.trim());
	}

	return parts.join("\n\n");
}

function isCustomStreamFn(engine?: PiEngine): boolean {
	return Boolean(
		engine?.streamFn && typeof engine.streamFn === "function" && engine.streamFn.length > 0,
	);
}

/**
 * Executes a subagent task via Antigravity CLI runner with prompt, model,
 * and multi-turn tool execution loop.
 */
export async function runAntigravitySubagent(
	tools: AgentTool<any, any>[],
	opts: SubagentRunOptions,
): Promise<SubagentRunResult>;
export async function runAntigravitySubagent(
	opts: SubagentRunOptions & { tools?: AgentTool<any, any>[] },
): Promise<SubagentRunResult>;
export async function runAntigravitySubagent(
	toolsOrOpts: AgentTool<any, any>[] | (SubagentRunOptions & { tools?: AgentTool<any, any>[] }),
	maybeOpts?: SubagentRunOptions,
): Promise<SubagentRunResult> {
	let tools: AgentTool<any, any>[] = [];
	let opts: SubagentRunOptions;

	if (Array.isArray(toolsOrOpts)) {
		tools = toolsOrOpts;
		if (!maybeOpts) {
			throw new Error("Missing SubagentRunOptions in runAntigravitySubagent");
		}
		opts = maybeOpts;
	} else {
		opts = toolsOrOpts;
		tools = toolsOrOpts.tools ?? [];
	}

	if (opts.abortSignal?.aborted) {
		const err = new Error("aborted");
		err.name = "AbortError";
		throw err;
	}

	let modelId = "gemini-3.8-flash-high";
	let effort = opts.effort;

	if (opts.engine?.model) {
		if (typeof opts.engine.model === "string") {
			modelId = opts.engine.model;
		} else if (opts.engine.model.id) {
			modelId = opts.engine.model.id;
		}
		if (
			!effort &&
			opts.engine.level &&
			opts.engine.level !== "off" &&
			opts.engine.level !== "minimal"
		) {
			effort = opts.engine.level as any;
		}
	} else {
		try {
			const eng = subagentEngine(opts.role);
			if (eng.model?.id) modelId = eng.model.id;
		} catch {
			modelId = getDefaultModel().id;
		}
	}

	const sessionId = randomUUID();
	let turns = 0;
	let step = 0;
	const newMessages: AgentMessage[] = [];
	const currentMessages: AgentMessage[] = [...(opts.messages ?? [])];
	if (opts.prompt) {
		currentMessages.push({
			role: "user",
			content: opts.prompt,
			timestamp: Date.now(),
		});
	}
	const knownToolNames = new Set(tools.map((t) => t.name));
	let latestAssistantText = "";

	while (turns < opts.maxTurns) {
		if (opts.abortSignal?.aborted) {
			const err = new Error("aborted");
			err.name = "AbortError";
			throw err;
		}

		turns++;
		step++;
		const turnStartTime = Date.now();

		let assistantMessage: AssistantMessage;
		let usage: Usage;

		if (isCustomStreamFn(opts.engine)) {
			// Scripted test engine branch
			const context = {
				messages: currentMessages,
				systemPrompt: opts.systemPrompt,
				tools,
			};
			const stream = opts.engine!.streamFn(opts.engine!.model, context, {
				sessionId,
				identity: APP_IDENTITY,
				signal: opts.abortSignal,
			});
			const res = await (stream && typeof stream.result === "function"
				? stream.result()
				: stream);

			if (opts.abortSignal?.aborted) {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			}

			usage = res.usage ?? {
				input: 10,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 20,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			assistantMessage = {
				role: "assistant",
				content: res.content ?? [],
				api: "antigravity",
				provider: "antigravity",
				model: modelId,
				usage,
				stopReason: res.stopReason ?? "stop",
				durationMs: res.durationMs ?? (Date.now() - turnStartTime),
				timestamp: Date.now(),
			};
		} else {
			// Subprocess Antigravity runner branch
			const turnPrompt = buildSubagentPrompt(
				opts.systemPrompt,
				tools,
				currentMessages,
			);

			let textAcc = "";
			let agyUsage: AgyUsage | undefined;
			let errorMessage: string | undefined;

			const stream = runAgyStream({
				prompt: turnPrompt,
				model: modelId,
				effort,
				abortSignal: opts.abortSignal,
				agyPath: opts.agyPath,
				extraArgs: opts.extraArgs,
				cwd: opts.cwd,
			});

			for await (const event of stream) {
				if (opts.abortSignal?.aborted) {
					const err = new Error("aborted");
					err.name = "AbortError";
					throw err;
				}

				if (event.type === "text_delta") {
					textAcc += event.text;
				} else if (event.type === "result") {
					if (event.usage) agyUsage = event.usage;
				} else if (event.type === "error") {
					errorMessage = event.message;
				}
			}

			if (opts.abortSignal?.aborted) {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			}

			if (errorMessage) {
				throw new Error(errorMessage);
			}

			usage = agyUsageToUsage(agyUsage);

			const { cleanText, toolCalls } = extractSubagentToolCalls(textAcc, knownToolNames);
			latestAssistantText = cleanText || textAcc;

			const assistantContent: AssistantMessage["content"] = [];
			if (cleanText) {
				assistantContent.push({ type: "text", text: cleanText });
			}

			for (const tc of toolCalls) {
				assistantContent.push({
					type: "toolCall",
					id: tc.id,
					name: tc.name,
					arguments: tc.args,
					argumentsError: tc.parseError,
				});
			}

			assistantMessage = {
				role: "assistant",
				content: assistantContent,
				api: "antigravity",
				provider: "antigravity",
				model: modelId,
				usage,
				stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
				durationMs: Date.now() - turnStartTime,
				timestamp: Date.now(),
			};
		}

		newMessages.push(assistantMessage);
		currentMessages.push(assistantMessage);

		opts.onUsage?.(usage);
		opts.onAssistantMessage?.(assistantMessage, step);

		const toolCalls = assistantMessage.content.filter(
			(c): c is ToolCall => c.type === "toolCall",
		);

		if (toolCalls.length === 0) {
			const textParts = assistantMessage.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text);
			if (textParts.length > 0) {
				latestAssistantText = textParts.join("");
			}
			break;
		}

		// Execute tool calls
		const toolResults: ToolResultMessage[] = [];
		for (const tc of toolCalls) {
			if (opts.abortSignal?.aborted) {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			}

			const toolExecStartTime = Date.now();
			opts.onToolStart?.(tc.name, tc.arguments);

			const toolDef = tools.find((t) => t.name === tc.name);
			let toolResultMsg: ToolResultMessage;

			if (!toolDef) {
				toolResultMsg = {
					role: "toolResult",
					toolCallId: tc.id,
					toolName: tc.name,
					content: [{ type: "text", text: `Unknown tool: ${tc.name}` }],
					isError: true,
					durationMs: Date.now() - toolExecStartTime,
					timestamp: Date.now(),
				};
			} else if (tc.argumentsError) {
				toolResultMsg = {
					role: "toolResult",
					toolCallId: tc.id,
					toolName: tc.name,
					content: [
						{
							type: "text",
							text: `Invalid JSON for tool "${tc.name}": ${tc.argumentsError}\n\nPlease retry with valid JSON.`,
						},
					],
					isError: true,
					details: { tool: tc.name, error: tc.argumentsError },
					durationMs: Date.now() - toolExecStartTime,
					timestamp: Date.now(),
				};
			} else {
				try {
					let preparedArgs = tc.arguments;
					if (toolDef.prepareArguments) {
						preparedArgs = toolDef.prepareArguments(preparedArgs);
					}

					// TypeBox parameter validation
					if (toolDef.parameters && typeof toolDef.parameters === "object") {
						const cloned = structuredClone(preparedArgs);
						try {
							Value.Convert(toolDef.parameters, cloned);
						} catch {}
						if (!Value.Check(toolDef.parameters, cloned)) {
							const errors = [...Value.Errors(toolDef.parameters, cloned)].map(
								(e: any) => `${e.path || "(root)"}: ${e.message}`,
							);
							const errorText = `Invalid tool input for tool "${tc.name}":\n${errors.map((p) => `- ${p}`).join("\n")}`;
							toolResultMsg = {
								role: "toolResult",
								toolCallId: tc.id,
								toolName: tc.name,
								content: [{ type: "text", text: errorText }],
								isError: true,
								details: { tool: tc.name, problems: errors },
								durationMs: Date.now() - toolExecStartTime,
								timestamp: Date.now(),
							};
							toolResults.push(toolResultMsg);
							newMessages.push(toolResultMsg);
							currentMessages.push(toolResultMsg);
							continue;
						}
						preparedArgs = Value.Clean(toolDef.parameters, cloned) as Record<string, any>;
					}

					const result = await toolDef.execute(tc.id, preparedArgs, opts.abortSignal);
					toolResultMsg = {
						role: "toolResult",
						toolCallId: tc.id,
						toolName: tc.name,
						content: result.content,
						details: result.details,
						isError: result.isError ?? false,
						durationMs: Date.now() - toolExecStartTime,
						timestamp: Date.now(),
					};
				} catch (err: any) {
					toolResultMsg = {
						role: "toolResult",
						toolCallId: tc.id,
						toolName: tc.name,
						content: [{ type: "text", text: `Execution failed: ${err.message}` }],
						isError: true,
						durationMs: Date.now() - toolExecStartTime,
						timestamp: Date.now(),
					};
				}
			}

			toolResults.push(toolResultMsg);
			newMessages.push(toolResultMsg);
			currentMessages.push(toolResultMsg);
		}

		if (opts.shouldStop?.(assistantMessage, toolResults)) {
			break;
		}
	}

	const assistants = newMessages.filter(
		(m) => (m as { role?: string }).role === "assistant",
	) as AssistantMessage[];
	const last = assistants[assistants.length - 1];
	const finalText = last
		? last.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("")
		: latestAssistantText;

	return {
		newMessages,
		text: finalText,
	};
}
