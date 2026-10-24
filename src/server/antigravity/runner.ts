import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Usage metrics reported by Antigravity CLI in step_update or result events.
 */
export interface AgyUsage {
	input_tokens: number;
	output_tokens: number;
	thinking_tokens?: number;
	cache_read_tokens?: number;
	total_tokens: number;
}

/**
 * Common shape for stream events to allow both discriminated union pattern matching
 * and direct optional property access.
 */
export interface AgyBaseEvent {
	type: "text_delta" | "result" | "error";
	text?: string;
	status?: string;
	usage?: AgyUsage;
	message?: string;
}

/**
 * Stream event emitted by parseAgyNdjsonLine and runAgyStream.
 */
export type AgyStreamEvent =
	| ({ type: "text_delta"; text: string } & AgyBaseEvent)
	| ({ type: "result"; status: string; usage?: AgyUsage } & AgyBaseEvent)
	| ({ type: "error"; message: string } & AgyBaseEvent);

/**
 * Execution options for Antigravity CLI runner.
 */
export interface AgyRunOptions {
	prompt: string;
	model?: string;
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
	abortSignal?: AbortSignal;
	cwd?: string;
	agyPath?: string;
	extraArgs?: string[];
}

/**
 * Default location of the local Antigravity binary.
 */
export const DEFAULT_AGY_PATH = "/Users/lorenzo/.local/bin/agy";

/**
 * Builds CLI argument list for spawning agy in non-interactive streaming mode.
 * Prompt is piped via stdin when --input-format text is configured.
 *
 * @param opts - Execution options
 * @returns Array of CLI flags and arguments
 */
export function buildAgyArgs(opts: AgyRunOptions): string[] {
	const args: string[] = [
		"--output-format",
		"stream-json",
		"--dangerously-skip-permissions",
		"--input-format",
		"text",
	];

	if (opts.model) {
		args.push("--model", opts.model);
	}
	if (opts.effort) {
		args.push("--effort", opts.effort);
	}
	if (opts.extraArgs && opts.extraArgs.length > 0) {
		args.push(...opts.extraArgs);
	}

	return args;
}

/**
 * Parses a single NDJSON line emitted by Antigravity CLI.
 * Tolerates whitespace, empty lines, and malformed inputs safely.
 *
 * @param line - Raw line string from child process stdout
 * @returns Parsed AgyStreamEvent or null if the line has no actionable payload
 */
export function parseAgyNdjsonLine(line: string): AgyStreamEvent | null {
	const trimmed = line.trim();
	if (!trimmed) {
		return null;
	}

	let data: unknown;
	try {
		data = JSON.parse(trimmed);
	} catch {
		return null;
	}

	if (!data || typeof data !== "object") {
		return null;
	}

	const record = data as Record<string, unknown>;

	// 1. Text delta from step_update
	if (record.event === "step_update" && record.step_update && typeof record.step_update === "object") {
		const step = record.step_update as Record<string, unknown>;
		if (typeof step.text_delta === "string") {
			return {
				type: "text_delta",
				text: step.text_delta,
			};
		}
	}
	if (record.event === "step_update" && typeof record.text_delta === "string") {
		return {
			type: "text_delta",
			text: record.text_delta,
		};
	}
	if (record.type === "text_delta" && typeof record.text === "string") {
		return {
			type: "text_delta",
			text: record.text,
		};
	}

	// 2. Result event (final status and token usage)
	if (record.event === "result") {
		const resultObj =
			record.result && typeof record.result === "object"
				? (record.result as Record<string, unknown>)
				: record;
		const status = typeof resultObj.status === "string" ? resultObj.status : "SUCCESS";
		const rawUsage =
			resultObj.usage && typeof resultObj.usage === "object"
				? (resultObj.usage as Record<string, unknown>)
				: undefined;

		let usage: AgyUsage | undefined;
		if (rawUsage) {
			const inputTokens = Number(rawUsage.input_tokens ?? 0);
			const outputTokens = Number(rawUsage.output_tokens ?? 0);
			usage = {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				thinking_tokens:
					rawUsage.thinking_tokens !== undefined ? Number(rawUsage.thinking_tokens) : undefined,
				cache_read_tokens:
					rawUsage.cache_read_tokens !== undefined ? Number(rawUsage.cache_read_tokens) : undefined,
				total_tokens: Number(rawUsage.total_tokens ?? (inputTokens + outputTokens)),
			};
		}

		return {
			type: "result",
			status,
			usage,
		};
	}

	// 3. Error event
	if (record.event === "error" || record.error !== undefined) {
		let message = "Unknown error";
		if (typeof record.message === "string" && record.message) {
			message = record.message;
		} else if (typeof record.error === "string" && record.error) {
			message = record.error;
		} else if (record.error && typeof record.error === "object") {
			const errObj = record.error as Record<string, unknown>;
			if (typeof errObj.message === "string" && errObj.message) {
				message = errObj.message;
			}
		}
		return {
			type: "error",
			message,
		};
	}

	return null;
}

/**
 * Spawns the local Antigravity CLI subprocess and yields streaming events as an AsyncGenerator.
 * Pipes the prompt via stdin, parses NDJSON lines from stdout, monitors stderr,
 * and wires the provided AbortSignal to send SIGTERM to the subprocess.
 *
 * @param opts - Run options including prompt, optional model, effort, abortSignal, etc.
 * @returns AsyncGenerator yielding AgyStreamEvent instances
 */
export async function* runAgyStream(
	opts: AgyRunOptions
): AsyncGenerator<AgyStreamEvent, void, unknown> {
	const agyBinary = opts.agyPath || process.env.AGY_PATH || DEFAULT_AGY_PATH;
	const args = buildAgyArgs(opts);

	const child = spawn(agyBinary, args, {
		cwd: opts.cwd || process.cwd(),
		stdio: ["pipe", "pipe", "pipe"],
	});

	let aborted = false;
	const onAbort = () => {
		aborted = true;
		child.kill("SIGTERM");
	};

	if (opts.abortSignal) {
		if (opts.abortSignal.aborted) {
			onAbort();
		} else {
			opts.abortSignal.addEventListener("abort", onAbort, { once: true });
		}
	}

	// Pipe prompt via stdin
	if (child.stdin) {
		child.stdin.on("error", () => {
			// Suppress broken pipe errors if child terminates before reading full prompt
		});
		child.stdin.end(opts.prompt, "utf-8");
	}

	const errState: { spawnError: Error | null } = { spawnError: null };
	child.on("error", (err) => {
		errState.spawnError = err;
	});

	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer | string) => {
		stderr += chunk.toString();
	});

	try {
		if (aborted || opts.abortSignal?.aborted) {
			return;
		}

		const rl = createInterface({
			input: child.stdout,
			crlfDelay: Infinity,
		});

		let yieldedTerminal = false;

		for await (const line of rl) {
			if (opts.abortSignal?.aborted || aborted) {
				break;
			}

			const ev = parseAgyNdjsonLine(line);
			if (ev) {
				if (ev.type === "result" || ev.type === "error") {
					yieldedTerminal = true;
				}
				yield ev;
			}
		}

		if (opts.abortSignal?.aborted || aborted) {
			return;
		}

		if (errState.spawnError) {
			yield {
				type: "error",
				message: errState.spawnError.message,
			};
			return;
		}

		// If child process terminated without yielding a result or error event,
		// check if it exited with a non-zero code and emit an error event.
		if (!yieldedTerminal) {
			const exitCode = await new Promise<number | null>((resolve) => {
				if (child.exitCode !== null) {
					resolve(child.exitCode);
					return;
				}
				const timer = setTimeout(() => resolve(null), 1000);
				child.once("close", (code) => {
					clearTimeout(timer);
					resolve(code);
				});
			});

			if (exitCode !== null && exitCode !== 0 && !aborted && !opts.abortSignal?.aborted) {
				yield {
					type: "error",
					message: stderr.trim() || `Process exited with code ${exitCode}`,
				};
			}
		}
	} finally {
		if (opts.abortSignal) {
			opts.abortSignal.removeEventListener("abort", onAbort);
		}
		if (!child.killed && child.exitCode === null) {
			child.kill("SIGTERM");
		}
	}
}
