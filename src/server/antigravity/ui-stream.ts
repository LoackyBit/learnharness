import type {
	AgentMessage,
	AssistantMessage,
	StopReason,
	Usage,
} from "../../core/contracts/messages.ts";
import type { SteerMessage } from "../../core/contracts.ts";
import { newMessageId } from "../../core/native-messages.ts";
import { noteSteerVisible } from "../jobs.ts";
import { ToolCallIdUniquifier } from "../pi/call-ids.ts";
import type { PiTurnHandle } from "../pi/ui-stream.ts";
import {
	runAgyStream,
	type AgyRunOptions,
	type AgyStreamEvent,
} from "./runner.ts";
import {
	bridgeAgyStream,
	type AgyStreamBridgeOptions,
	type TurnWireEvent,
	type WireTextMessage,
} from "./stream-bridge.ts";

export type { PiTurnHandle, TurnWireEvent };

/**
 * Execution spec for an Antigravity background turn.
 * Matches the background turn runner semantics of PiTurnSpec while adapting
 * to the Antigravity CLI runner and structured stream bridge.
 */
export interface AntigravityTurnSpec {
	/** The prompt string to pass to the Antigravity CLI. */
	prompt?: string;
	/** Target model for Antigravity generation (e.g. "gemini-3.8-flash-high"). */
	model?: string;
	/** Thinking / reasoning effort level. */
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
	/** Working directory for agy CLI subprocess. */
	cwd?: string;
	/** Path to local agy CLI binary. */
	agyPath?: string;
	/** Additional CLI flags. */
	extraArgs?: string[];
	/** External abort signal (optional; PiTurnHandle also provides abort()). */
	abortSignal?: AbortSignal;
	/** Runner options object for agy CLI (merged with top-level fields). */
	runOptions?: Partial<AgyRunOptions>;
	/** Direct stream or generator (or factory taking AbortSignal) to consume instead of spawning agy. */
	stream?:
		| AsyncIterable<AgyStreamEvent>
		| ((signal: AbortSignal) => AsyncIterable<AgyStreamEvent>);
	/** Base messages from chat history before this turn. */
	baseMessages?: AgentMessage[];
	/** Initial messages alias for baseMessages. */
	initialMessages?: AgentMessage[];
	/** Error-masking policy for loop-level failures. */
	onError?: (error: unknown) => string;
	/** Canonical end-of-turn seam: persists state and notifies chat completion. */
	onFinish: (messages: AgentMessage[], isAborted: boolean) => void;
	/** Tool-call ids already used in this chat's record for ToolCallIdUniquifier. */
	usedToolCallIds?: ReadonlySet<string>;
	/** The coalescing window for update fan-out (Compaction Law). Defaults to 100ms. */
	updateFlushMs?: number;
	/** Unique message ID for assistant message. */
	messageId?: string;
	/** Optional generator for custom tool call IDs. */
	toolCallIdGenerator?: (toolName: string) => string;
}

/**
 * One view onto a running turn: push() replays/streams an event, done() terminates the view.
 */
export interface AntigravityTurnSubscriber {
	push(event: TurnWireEvent): void;
	done(): void;
}

/**
 * Runs an Antigravity turn decoupled from any single HTTP response.
 *
 * Invariants preserved:
 * 1. Interface matching PiTurnHandle (subscribe() and abort()).
 * 2. Compaction Law: coalesces rapid partial updates (message_update / tool_execution_update)
 *    within updateFlushMs window in both in-memory log and live fan-out.
 * 3. Multi-view subscriber fan-out: subscribe() yields SSE events (`data: ...\n\n` and `data: [DONE]\n\n`).
 * 4. View cancellation isolation: subscriber unsubscribe/disconnect detaches that view only,
 *    never killing the running turn or agy process.
 * 5. Remote abort: handle.abort() terminates the underlying agy process and marks the turn aborted.
 * 6. Invokes onFinish(messages, isAborted) with clean final messages.
 * 7. Wires ToolCallIdUniquifier when usedToolCallIds is provided for call ID stability.
 *
 * @param spec - Antigravity turn configuration
 * @returns PiTurnHandle with subscribe() and abort()
 */
export function runAntigravityTurn(spec: AntigravityTurnSpec): PiTurnHandle {
	const {
		onError,
		onFinish,
		usedToolCallIds,
		updateFlushMs = 100,
		messageId,
		toolCallIdGenerator,
	} = spec;

	const uniquifier = usedToolCallIds ? new ToolCallIdUniquifier(usedToolCallIds) : undefined;
	const abortController = new AbortController();

	let settled = false;
	let sawAbort = false;
	let hasSettledSeamRun = false;

	// In-memory compacted event log & live subscriber set (Compaction Law)
	const log: TurnWireEvent[] = [];
	const updateSlots = new Map<string, number>();
	const pending = new Map<string, TurnWireEvent>();
	const subscribers = new Set<AntigravityTurnSubscriber>();

	let lastAssistantMessage: WireTextMessage | undefined;

	const coalesceKey = (event: TurnWireEvent): string | null => {
		if (event.type === "message_update") return "message";
		if (event.type === "tool_execution_update") return `tool:${(event as { toolCallId: string }).toolCallId}`;
		return null;
	};

	let flushTimer: ReturnType<typeof setTimeout> | undefined;

	const flushPending = () => {
		if (flushTimer !== undefined) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		if (pending.size === 0) return;
		const batch = [...pending.values()];
		pending.clear();
		for (const sub of subscribers) {
			for (const event of batch) {
				sub.push(event);
			}
		}
	};

	const armFlush = () => {
		if (flushTimer !== undefined) return;
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			flushPending();
		}, updateFlushMs);
		(flushTimer as { unref?: () => void }).unref?.();
	};

	const send = (event: TurnWireEvent) => {
		if (settled) return;
		const key = coalesceKey(event);
		if (key !== null) {
			// Retention: replace-in-place the run's latest snapshot.
			const idx = updateSlots.get(key);
			if (idx !== undefined) {
				log[idx] = event;
			} else {
				updateSlots.set(key, log.length);
				log.push(event);
			}
			// Fan-out: coalesced — latest wins, flushed at <= 1 per window.
			pending.set(key, event);
			armFlush();
			return;
		}

		// Boundary events end the update run
		if (event.type === "message_end") updateSlots.delete("message");
		if (event.type === "tool_execution_end") {
			updateSlots.delete(`tool:${(event as { toolCallId: string }).toolCallId}`);
		}

		// Strict per-subscriber ordering: pending updates precede boundary events
		flushPending();
		log.push(event);
		for (const sub of subscribers) {
			sub.push(event);
		}
	};

	const closeAll = () => {
		if (settled) return;
		flushPending();
		settled = true;
		for (const sub of subscribers) {
			sub.done();
		}
		subscribers.clear();
	};

	const normalizeToAgentMessage = (m: WireTextMessage): AgentMessage => {
		const inputTokens = m.usage?.input_tokens ?? 0;
		const outputTokens = m.usage?.output_tokens ?? 0;
		const totalTokens = m.usage?.total_tokens ?? (inputTokens + outputTokens);
		const cacheRead = m.usage?.cache_read_tokens ?? 0;
		const thinkingTokens = m.usage?.thinking_tokens;

		const usage: Usage = {
			input: inputTokens,
			output: outputTokens,
			cacheRead,
			cacheWrite: 0,
			reasoning: thinkingTokens,
			totalTokens,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		};

		let stopReason: StopReason = "stop";
		if (sawAbort) {
			stopReason = "aborted";
		} else if (m.stopReason === "toolUse") {
			stopReason = "toolUse";
		} else if (m.stopReason === "error") {
			stopReason = "error";
		} else if (m.stopReason === "aborted") {
			stopReason = "aborted";
		} else if (m.stopReason === "length") {
			stopReason = "length";
		}

		return Object.assign(m, {
			id: m.id || newMessageId(),
			role: "assistant" as const,
			content: m.content || [{ type: "text", text: "" }],
			api: "antigravity-cli",
			provider: "antigravity",
			model: spec.model ?? spec.runOptions?.model ?? "antigravity",
			usage,
			stopReason,
			timestamp: Date.now(),
			errorMessage: m.errorMessage,
		}) as unknown as AgentMessage;
	};

	const settleWith = (agentEndMessages?: WireTextMessage[]) => {
		if (hasSettledSeamRun) return;
		hasSettledSeamRun = true;

		let newMessages: AgentMessage[] = [];
		if (agentEndMessages && agentEndMessages.length > 0) {
			newMessages = agentEndMessages.map(normalizeToAgentMessage);
		} else if (lastAssistantMessage) {
			newMessages = [normalizeToAgentMessage(lastAssistantMessage)];
		} else {
			newMessages = [
				normalizeToAgentMessage({
					role: "assistant",
					content: [{ type: "text", text: "" }],
					stopReason: sawAbort ? "aborted" : "error",
				}),
			];
		}

		const base = [...(spec.baseMessages ?? spec.initialMessages ?? [])];
		const allMessages = [...base, ...newMessages];
		const finalMessages = (uniquifier?.remapSettled(allMessages) as AgentMessage[]) ?? allMessages;
		onFinish(finalMessages, sawAbort);
	};

	const handleEvent = (event: TurnWireEvent) => {
		if (settled) return;

		if (
			event.type === "message_start" ||
			event.type === "message_update" ||
			event.type === "message_end"
		) {
			lastAssistantMessage = event.message;
		}

		if (sawAbort) {
			if (event.type === "message_end" && event.message) {
				event.message.stopReason = "aborted";
			}
			if (event.type === "agent_end" && event.messages?.[0]) {
				event.messages[0].stopReason = "aborted";
			}
		}

		const uniqued = uniquifier ? (uniquifier.event(event as any) as TurnWireEvent) : event;
		send(uniqued);

		if (event.type === "message_end") {
			const m = event.message as { role?: string; stopReason?: string } | undefined;
			if (m?.role === "assistant" && m.stopReason === "aborted") {
				sawAbort = true;
			}
			if ((m as { role?: string })?.role === "custom") {
				try {
					noteSteerVisible(event.message as unknown as SteerMessage);
				} catch {
					/* ignore steer bookkeeping if not queued */
				}
			}
		}

		if (event.type === "agent_end") {
			closeAll();
			settleWith(event.messages);
		}
	};

	const streamSource: AsyncIterable<AgyStreamEvent> =
		typeof spec.stream === "function"
			? spec.stream(abortController.signal)
			: spec.stream ??
			  runAgyStream({
					prompt: spec.prompt ?? spec.runOptions?.prompt ?? "",
					model: spec.model ?? spec.runOptions?.model,
					effort: spec.effort ?? spec.runOptions?.effort,
					cwd: spec.cwd ?? spec.runOptions?.cwd,
					agyPath: spec.agyPath ?? spec.runOptions?.agyPath,
					extraArgs: spec.extraArgs ?? spec.runOptions?.extraArgs,
					abortSignal: abortController.signal,
			  });

	const doAbort = () => {
		if (settled) return;
		sawAbort = true;
		abortController.abort();
		if (lastAssistantMessage) {
			send({
				type: "message_end",
				message: {
					...lastAssistantMessage,
					stopReason: "aborted",
				},
			});
		}
		closeAll();
		settleWith();
	};

	if (spec.abortSignal) {
		if (spec.abortSignal.aborted) {
			doAbort();
		} else {
			spec.abortSignal.addEventListener("abort", () => doAbort(), { once: true });
		}
	}

	abortController.signal.addEventListener("abort", () => {
		if (typeof (streamSource as AsyncGenerator)?.return === "function") {
			void (streamSource as AsyncGenerator).return?.(undefined);
		}
	});

	const bridgeOptions: AgyStreamBridgeOptions = {
		messageId,
		toolCallIdGenerator,
	};

	void (async () => {
		try {
			for await (const wireEvent of bridgeAgyStream(streamSource, bridgeOptions)) {
				if (settled) break;
				handleEvent(wireEvent);
			}
			if (!settled) {
				closeAll();
				settleWith();
			}
		} catch (err) {
			if (settled) return;
			console.error("[turn] antigravity loop failed:", err);
			send({ type: "error", errorText: onError?.(err) ?? "An error occurred." });
			closeAll();
			settleWith();
		}
	})();

	const handle: PiTurnHandle = {
		subscribe() {
			let sub: AntigravityTurnSubscriber | undefined;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const encoder = new TextEncoder();
					let closed = false;
					sub = {
						push(event) {
							if (closed) return;
							try {
								controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
							} catch {
								/* reader cancelled — stop emitting, keep running */
								closed = true;
							}
						},
						done() {
							if (closed) return;
							closed = true;
							try {
								controller.enqueue(encoder.encode("data: [DONE]\n\n"));
								controller.close();
							} catch {
								/* already cancelled */
							}
						},
					};

					subscribers.add(sub);
					for (const event of log) {
						sub.push(event);
					}
					if (settled) {
						sub.done();
					}
				},
				cancel() {
					if (sub) {
						subscribers.delete(sub);
					}
				},
			});
			return stream;
		},
		abort() {
			doAbort();
		},
	};

	return handle;
}

/**
 * Convenience helper wrapping PiTurnHandle as an SSE HTTP Response.
 */
export function antigravityTurnResponse(handle: PiTurnHandle): Response {
	return new Response(handle.subscribe(), {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}

export const agyTurnResponse = antigravityTurnResponse;
