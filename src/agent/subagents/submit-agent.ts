/**
 * runSubmitAgent — the shared single-submit agent seam: one TypeBox-validated submit
 * call is the whole deliverable (driven via Antigravity subagent runner so the model
 * can retry a schema-invalid or malformed call). The submitted value is captured from
 * the execute seam, which only fires on a schema-valid call.
 */

import type { Usage } from "../../core/contracts/messages.ts";
import type { AgentTool } from "../tool-execute.ts";
import type { TSchema } from "typebox";
import { invalidInputResult, toToolResult } from "../tool-execute.ts";
import type { ModelRole } from "../../../config.ts";
import type { PiEngine } from "../models.ts";
import { runAntigravitySubagent } from "./antigravity-run.ts";
import { healToolRecord } from "../tools/heal.ts";
import { healEncodedArguments } from "../../core/argument-heal.ts";

/**
 * Weak-model string-heal: heals stringified arrays (e.g. propositions as a JSON-string)
 * before TypeBox validation.
 */
export function healStringifiedArrays(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return raw;
	const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
	for (const key of ["propositions", "chains"]) {
		const v = out[key];
		if (typeof v !== "string" || v.trim().length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(v);
			if (Array.isArray(parsed)) out[key] = parsed;
		} catch {
			// not a clean stringify (e.g. truncated) — leave for validation
		}
	}
	return out;
}

export async function runSubmitAgent<T>(opts: {
	role: ModelRole;
	toolName: string;
	toolDescription: string;
	parameters: TSchema;
	/** Weak-model tolerance: the old zod `.default()`s, applied to the
	 *  schema-valid raw input at the submit seam. */
	fill: (input: any) => T;
	systemPrompt: string;
	prompt: string;
	engine: PiEngine | undefined;
	signal: AbortSignal | undefined;
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void;
	neverSubmitted: string;
	/** Extra tools beside the submit call (the auditor's graph-exploration
	 *  set): a small agentic loop instead of a bare retry. */
	extraTools?: Record<string, AgentTool<any>>;
	/** Turn budget for the loop (default 4 = retry-only; the auditor runs
	 *  an exploration loop instead — 16). */
	maxTurns?: number;
	/** Debug: raw provider-event recording key (LH_PROVIDER_EVENTS=1). */
	chatId?: string;
	/** Weak-model argument heal at prepareArguments seam (runs BEFORE
	 *  TypeBox validation). Identity by default; extraction wires healStringifiedArrays here. */
	prepareArguments?: (args: unknown) => unknown;
	/** Semantic validation at the submit seam: the value is schema-valid
	 *  but may violate a PIPELINE law (coverage, echo-equality). Returning
	 *  a problem string yields an isError result (invalidInputResult) →
	 *  the model retries within maxTurns. null = accept. */
	validate?: (value: T) => string | null;
	/** Test seam: path to agy binary */
	agyPath?: string;
}): Promise<T> {
	let submitted: T | undefined;

	const submitTool: AgentTool<any> = {
		name: opts.toolName,
		label: opts.toolName,
		description: opts.toolDescription,
		parameters: opts.parameters,
		prepareArguments: (args) =>
			// The standard heal composes AFTER the caller's shim — extraction's
			// healStringifiedArrays stays the inner pass.
			healEncodedArguments(
				opts.prepareArguments ? opts.prepareArguments(args) : args,
				opts.parameters,
			) as never,
		execute: async (_toolCallId, input) => {
			const value = opts.fill(input);
			const problem = opts.validate?.(value) ?? null;
			if (problem) return invalidInputResult(opts.toolName, [problem]);
			submitted = value;
			return toToolResult(submitted);
		},
	};

	const tools: AgentTool<any>[] = [
		// Standard argument heal over extra tools
		...(opts.extraTools ? Object.values(healToolRecord(opts.extraTools)) : []),
		submitTool,
	];

	await runAntigravitySubagent(tools, {
		role: opts.role,
		engine: opts.engine,
		systemPrompt: opts.systemPrompt,
		prompt: opts.prompt,
		maxTurns: opts.maxTurns ?? 4,
		abortSignal: opts.signal,
		chatId: opts.chatId,
		agyPath: opts.agyPath,
		onAssistantMessage: (message, step) =>
			opts.onStep(
				message.usage,
				`${message.provider}:${message.model}`,
				step,
				message.stopReason,
				message.content
					.filter((c) => c.type === "toolCall")
					.map((c) => (c as { name: string }).name)
					.join(", ") || "(none)",
			),
		shouldStop: (_message, toolResults) =>
			toolResults.some((r) => r.toolName === opts.toolName && !r.isError),
	});

	if (!submitted) throw new Error(opts.neverSubmitted);
	return submitted;
}
