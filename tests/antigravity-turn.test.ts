import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";
import type { AgentMessage, AssistantMessage } from "../src/core/contracts/messages.ts";
import type { AgyStreamEvent } from "../src/server/antigravity/runner.ts";
import {
	runAntigravityTurn,
	antigravityTurnResponse,
	agyTurnResponse,
	type AntigravityTurnSpec,
	type PiTurnHandle,
	type TurnWireEvent,
} from "../src/server/antigravity/ui-stream.ts";

/** Helper reading an SSE stream into parsed TurnWireEvent items and raw chunks */
async function collectSseEvents(stream: ReadableStream<Uint8Array>): Promise<{
	raw: string;
	events: TurnWireEvent[];
	doneSeen: boolean;
}> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let raw = "";
	let buffer = "";
	const events: TurnWireEvent[] = [];
	let doneSeen = false;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = decoder.decode(value, { stream: true });
			raw += chunk;
			buffer += chunk;

			const parts = buffer.split("\n\n");
			buffer = parts.pop() ?? "";
			for (const part of parts) {
				const trimmed = part.trim();
				if (!trimmed) continue;
				if (trimmed === "data: [DONE]") {
					doneSeen = true;
				} else if (trimmed.startsWith("data: ")) {
					try {
						events.push(JSON.parse(trimmed.slice(6)));
					} catch {
						/* ignore malformed json */
					}
				}
			}
		}
		if (buffer.trim()) {
			const trimmed = buffer.trim();
			if (trimmed === "data: [DONE]") {
				doneSeen = true;
			} else if (trimmed.startsWith("data: ")) {
				try {
					events.push(JSON.parse(trimmed.slice(6)));
				} catch {
					/* ignore malformed json */
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	return { raw, events, doneSeen };
}

describe("Antigravity UI Stream & Background Turn Runner", () => {
	describe("Basic turn execution & SSE wire format", () => {
		it("streams text deltas, yields valid SSE frames ending with [DONE], and invokes onFinish", async () => {
			async function* textStream(): AsyncGenerator<AgyStreamEvent, void, unknown> {
				yield { type: "text_delta", text: "Hello " };
				yield { type: "text_delta", text: "world!" };
				yield {
					type: "result",
					status: "SUCCESS",
					usage: { input_tokens: 50, output_tokens: 15, total_tokens: 65 },
				};
			}

			let finishedMessages: AgentMessage[] | undefined;
			let finishedAborted: boolean | undefined;

			const handle = runAntigravityTurn({
				stream: textStream(),
				model: "gemini-3.8-flash-high",
				updateFlushMs: 10,
				onFinish: (messages, isAborted) => {
					finishedMessages = messages;
					finishedAborted = isAborted;
				},
			});

			const { raw, events, doneSeen } = await collectSseEvents(handle.subscribe());

			// Check wire format: SSE data lines
			assert.ok(raw.includes("data: {\"type\":"));
			assert.ok(raw.includes("data: [DONE]\n\n"));
			assert.equal(doneSeen, true);

			// Check wire event progression
			const eventTypes = events.map((e) => e.type);
			assert.ok(eventTypes.includes("message_start"));
			assert.ok(eventTypes.includes("message_update"));
			assert.ok(eventTypes.includes("message_end"));
			assert.ok(eventTypes.includes("agent_end"));

			const msgEnd = events.find((e) => e.type === "message_end") as { message: { content: Array<{ type: string; text: string }> } };
			assert.equal(msgEnd.message.content[0]?.text, "Hello world!");

			// onFinish checks
			assert.equal(finishedAborted, false);
			assert.ok(finishedMessages);
			assert.equal(finishedMessages.length, 1);
			const assistant = finishedMessages[0] as AssistantMessage;
			assert.equal(assistant.role, "assistant");
			assert.equal(assistant.model, "gemini-3.8-flash-high");
			assert.equal(assistant.provider, "antigravity");
			assert.equal(assistant.stopReason, "stop");
			assert.equal(assistant.content[0]?.type, "text");
			assert.equal((assistant.content[0] as { text: string }).text, "Hello world!");
			assert.equal(assistant.usage.input, 50);
			assert.equal(assistant.usage.output, 15);
			assert.equal(assistant.usage.totalTokens, 65);
		});
	});

	describe("Compaction Law (in-memory log & live fan-out coalescing)", () => {
		it("coalesces live message_update events within the updateFlushMs window", async () => {
			async function* rapidStream(): AsyncGenerator<AgyStreamEvent, void, unknown> {
				// Rapid burst of 5 text deltas without artificial delay
				for (let i = 1; i <= 5; i++) {
					yield { type: "text_delta", text: `word${i} ` };
				}
				// Small wait to allow flush window to tick
				await new Promise((r) => setTimeout(r, 60));
				yield { type: "text_delta", text: "final" };
				yield {
					type: "result",
					status: "SUCCESS",
					usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
				};
			}

			const handle = runAntigravityTurn({
				stream: rapidStream(),
				updateFlushMs: 40,
				onFinish: () => {},
			});

			const { events } = await collectSseEvents(handle.subscribe());
			const updateEvents = events.filter((e) => e.type === "message_update");

			// Rather than 6 separate update events, compaction coalesces them into fewer frames (<= 3)
			assert.ok(updateEvents.length < 6, `Expected fewer than 6 updates, got ${updateEvents.length}`);
			const lastUpdate = updateEvents[updateEvents.length - 1] as { message: { content: Array<{ text: string }> } };
			assert.equal(lastUpdate.message.content[0]?.text, "word1 word2 word3 word4 word5 final");
		});

		it("compacts state in the in-memory log so late-joining subscribers only replay the latest update", async () => {
			let continueStream: () => void;
			const pauseGate = new Promise<void>((resolve) => {
				continueStream = resolve;
			});

			async function* pausedStream(): AsyncGenerator<AgyStreamEvent, void, unknown> {
				yield { type: "text_delta", text: "chunk 1 " };
				yield { type: "text_delta", text: "chunk 2 " };
				yield { type: "text_delta", text: "chunk 3 " };
				// Pause mid-turn to let late subscriber attach
				await pauseGate;
				yield { type: "text_delta", text: "chunk 4" };
				yield { type: "result", status: "SUCCESS" };
			}

			const handle = runAntigravityTurn({
				stream: pausedStream(),
				updateFlushMs: 10,
				onFinish: () => {},
			});

			// Wait for the first 3 chunks to arrive and settle into log
			await new Promise((r) => setTimeout(r, 30));

			// Late subscriber connects now
			const lateStream = handle.subscribe();

			// Resume stream to completion
			continueStream!();

			const { events } = await collectSseEvents(lateStream);
			const messageUpdates = events.filter((e) => e.type === "message_update");

			// Late subscriber must not have seen 3 separate early updates; the log compacted them to 1
			// Total updates received should be at most 2 (1 compacted replayed + 1 subsequent live)
			assert.ok(messageUpdates.length <= 2, `Expected at most 2 updates for late subscriber, got ${messageUpdates.length}`);

			const msgEnd = events.find((e) => e.type === "message_end") as { message: { content: Array<{ text: string }> } };
			assert.equal(msgEnd.message.content[0]?.text, "chunk 1 chunk 2 chunk 3 chunk 4");
		});
	});

	describe("Multi-view subscriber fan-out", () => {
		it("fans out events to concurrent subscribers simultaneously", async () => {
			async function* slowStream(): AsyncGenerator<AgyStreamEvent, void, unknown> {
				yield { type: "text_delta", text: "A" };
				await new Promise((r) => setTimeout(r, 20));
				yield { type: "text_delta", text: "B" };
				await new Promise((r) => setTimeout(r, 20));
				yield { type: "text_delta", text: "C" };
				yield { type: "result", status: "SUCCESS" };
			}

			const handle = runAntigravityTurn({
				stream: slowStream(),
				updateFlushMs: 10,
				onFinish: () => {},
			});

			const sub1Promise = collectSseEvents(handle.subscribe());
			const sub2Promise = collectSseEvents(handle.subscribe());

			const [res1, res2] = await Promise.all([sub1Promise, sub2Promise]);

			assert.equal(res1.doneSeen, true);
			assert.equal(res2.doneSeen, true);

			const end1 = res1.events.find((e) => e.type === "message_end") as any;
			const end2 = res2.events.find((e) => e.type === "message_end") as any;

			assert.equal(end1.message.content[0].text, "ABC");
			assert.equal(end2.message.content[0].text, "ABC");
		});

		it("allows subscribers connecting after turn settlement to receive full replay plus [DONE]", async () => {
			async function* quickStream(): AsyncGenerator<AgyStreamEvent, void, unknown> {
				yield { type: "text_delta", text: "Settled already." };
				yield { type: "result", status: "SUCCESS" };
			}

			let settled = false;
			const handle = runAntigravityTurn({
				stream: quickStream(),
				updateFlushMs: 5,
				onFinish: () => {
					settled = true;
				},
			});

			// Wait for turn to settle completely
			while (!settled) {
				await new Promise((r) => setTimeout(r, 10));
			}

			// Attach subscriber after turn is settled
			const postSettleStream = handle.subscribe();
			const { events, doneSeen } = await collectSseEvents(postSettleStream);

			assert.equal(doneSeen, true);
			const msgEnd = events.find((e) => e.type === "message_end") as any;
			assert.equal(msgEnd.message.content[0].text, "Settled already.");
		});
	});

	describe("View cancellation isolation", () => {
		it("subscriber reader cancellation does not abort or kill the running turn", async () => {
			let finishCalled = false;
			let finishedWithAborted = false;

			async function* multiStepStream(): AsyncGenerator<AgyStreamEvent, void, unknown> {
				yield { type: "text_delta", text: "Part 1 " };
				await new Promise((r) => setTimeout(r, 30));
				yield { type: "text_delta", text: "Part 2" };
				yield { type: "result", status: "SUCCESS" };
			}

			const handle = runAntigravityTurn({
				stream: multiStepStream(),
				updateFlushMs: 10,
				onFinish: (_msgs, isAborted) => {
					finishCalled = true;
					finishedWithAborted = isAborted;
				},
			});

			// Subscriber 1 attaches and cancels immediately after first read
			const stream1 = handle.subscribe();
			const reader1 = stream1.getReader();
			const firstChunk = await reader1.read();
			assert.equal(firstChunk.done, false);
			await reader1.cancel("User navigated away");

			// Subscriber 2 attaches and stays until completion
			const sub2Promise = collectSseEvents(handle.subscribe());
			const res2 = await sub2Promise;

			assert.equal(res2.doneSeen, true);
			const msgEnd = res2.events.find((e) => e.type === "message_end") as any;
			assert.equal(msgEnd.message.content[0].text, "Part 1 Part 2");

			// Verify the turn completed normally without aborting
			assert.equal(finishCalled, true);
			assert.equal(finishedWithAborted, false);
		});
	});

	describe("Remote abort channel", () => {
		it("terminates generator and marks turn aborted when handle.abort() is called", async () => {
			let wasCleanedUp = false;

			async function* endlessStream(signal: AbortSignal): AsyncGenerator<AgyStreamEvent, void, unknown> {
				try {
					yield { type: "text_delta", text: "Beginning output... " };
					// Hang until cancelled via abortSignal
					await new Promise((resolve) => {
						signal.addEventListener("abort", () => resolve(undefined), { once: true });
					});
					yield { type: "text_delta", text: "Should never happen" };
				} finally {
					wasCleanedUp = true;
				}
			}

			let finishMessages: AgentMessage[] | undefined;
			let finishAborted: boolean | undefined;

			const handle = runAntigravityTurn({
				stream: (signal) => endlessStream(signal),
				updateFlushMs: 10,
				onFinish: (msgs, isAborted) => {
					finishMessages = msgs;
					finishAborted = isAborted;
				},
			});

			const subEventsPromise = collectSseEvents(handle.subscribe());

			// Wait for first delta to be processed
			await new Promise((r) => setTimeout(r, 25));

			// Remote kill
			handle.abort();

			const { doneSeen } = await subEventsPromise;
			assert.equal(doneSeen, true);
			assert.equal(wasCleanedUp, true);
			assert.equal(finishAborted, true);

			assert.ok(finishMessages);
			const assistant = finishMessages[0] as AssistantMessage;
			assert.equal(assistant.stopReason, "aborted");
			assert.equal((assistant.content[0] as { text: string }).text, "Beginning output... ");
		});

		it("terminates turn when external spec.abortSignal is aborted", async () => {
			const controller = new AbortController();

			async function* hangingStream(): AsyncGenerator<AgyStreamEvent, void, unknown> {
				yield { type: "text_delta", text: "Before external abort" };
				await new Promise((r) => setTimeout(r, 2000));
			}

			let finishAborted: boolean | undefined;

			const handle = runAntigravityTurn({
				stream: hangingStream(),
				abortSignal: controller.signal,
				updateFlushMs: 10,
				onFinish: (_msgs, isAborted) => {
					finishAborted = isAborted;
				},
			});

			const subPromise = collectSseEvents(handle.subscribe());

			await new Promise((r) => setTimeout(r, 20));
			controller.abort();

			await subPromise;
			assert.equal(finishAborted, true);
		});
	});

	describe("Structured tool calls & ToolCallIdUniquifier", () => {
		it("detects structured quiz tool, ends turn with toolUse stopReason, and preserves toolCall in onFinish", async () => {
			async function* quizStream(): AsyncGenerator<AgyStreamEvent, void, unknown> {
				yield { type: "text_delta", text: "Here is your practice problem:\n\n" };
				yield {
					type: "text_delta",
					text: ':::quiz\n{"question":"What does ATP stand for?","options":["Adenosine Triphosphate","Amino Acid"],"correctAnswer":"Adenosine Triphosphate"}\n:::\n',
				};
				yield { type: "result", status: "SUCCESS" };
			}

			let finishedMessages: AgentMessage[] | undefined;

			const handle = runAntigravityTurn({
				stream: quizStream(),
				updateFlushMs: 10,
				onFinish: (msgs) => {
					finishedMessages = msgs;
				},
			});

			const { events, doneSeen } = await collectSseEvents(handle.subscribe());
			assert.equal(doneSeen, true);

			const toolStart = events.find((e) => e.type === "tool_execution_start") as any;
			assert.ok(toolStart);
			assert.equal(toolStart.toolName, "quiz");

			const toolEnd = events.find((e) => e.type === "tool_execution_end") as any;
			assert.ok(toolEnd);
			assert.equal(toolEnd.toolName, "quiz");
			assert.equal(toolEnd.isError, false);

			const msgEnd = events.find((e) => e.type === "message_end") as any;
			assert.equal(msgEnd.message.stopReason, "toolUse");

			assert.ok(finishedMessages);
			const assistant = finishedMessages[0] as AssistantMessage;
			assert.equal(assistant.stopReason, "toolUse");

			const toolCallContent = assistant.content.find((c) => c.type === "toolCall") as any;
			assert.ok(toolCallContent);
			assert.equal(toolCallContent.name, "quiz");
			assert.equal(toolCallContent.arguments.question, "What does ATP stand for?");
		});

		it("uniquifies colliding tool-call IDs when usedToolCallIds is provided", async () => {
			async function* toolStream(): AsyncGenerator<AgyStreamEvent, void, unknown> {
				yield {
					type: "text_delta",
					text: ':::quiz\n{"question":"Sample?","options":["A","B"],"correctAnswer":"A"}\n:::\n',
				};
				yield { type: "result", status: "SUCCESS" };
			}

			// Pre-seed usedToolCallIds with call_quiz_1 (the ID AgyStreamBridge mints first)
			const usedIds = new Set(["call_quiz_1"]);

			let settledMessages: AgentMessage[] | undefined;

			const handle = runAntigravityTurn({
				stream: toolStream(),
				usedToolCallIds: usedIds,
				updateFlushMs: 10,
				onFinish: (msgs) => {
					settledMessages = msgs;
				},
			});

			const { events } = await collectSseEvents(handle.subscribe());

			const toolStart = events.find((e) => e.type === "tool_execution_start") as any;
			// ToolCallIdUniquifier remaps colliding call_quiz_1 -> call_quiz_1~2
			assert.equal(toolStart.toolCallId, "call_quiz_1~2");

			const toolEnd = events.find((e) => e.type === "tool_execution_end") as any;
			assert.equal(toolEnd.toolCallId, "call_quiz_1~2");

			assert.ok(settledMessages);
			const assistant = settledMessages[0] as AssistantMessage;
			const toolCall = assistant.content.find((c) => c.type === "toolCall") as any;
			assert.equal(toolCall.id, "call_quiz_1~2");
		});
	});

	describe("Loop error handling & HTTP response helper", () => {
		it("handles stream failure with onError masking and emits error event", async () => {
			async function* brokenStream(): AsyncGenerator<AgyStreamEvent, void, unknown> {
				yield { type: "text_delta", text: "Working..." };
				throw new Error("CLI process crashed unexpectedly");
			}

			let errorSeenOnWire: string | undefined;

			const handle = runAntigravityTurn({
				stream: brokenStream(),
				onError: (err) => `Masked error: ${(err as Error).message}`,
				onFinish: () => {},
			});

			const { events, doneSeen } = await collectSseEvents(handle.subscribe());
			assert.equal(doneSeen, true);

			const errEvent = events.find((e) => e.type === "error") as any;
			assert.ok(errEvent);
			assert.equal(errEvent.errorText, "Masked error: CLI process crashed unexpectedly");
		});

		it("antigravityTurnResponse and agyTurnResponse wrap handle in standard SSE Response headers", async () => {
			async function* dummyStream(): AsyncGenerator<AgyStreamEvent, void, unknown> {
				yield { type: "text_delta", text: "Response test" };
				yield { type: "result", status: "SUCCESS" };
			}

			const handle = runAntigravityTurn({
				stream: dummyStream(),
				onFinish: () => {},
			});

			const res1 = antigravityTurnResponse(handle);
			assert.equal(res1.headers.get("Content-Type"), "text/event-stream");
			assert.equal(res1.headers.get("Cache-Control"), "no-cache, no-transform");
			assert.equal(res1.headers.get("X-Accel-Buffering"), "no");

			const res2 = agyTurnResponse(handle);
			assert.equal(res2.headers.get("Content-Type"), "text/event-stream");
		});
	});

	describe("Subprocess integration with mock agy binary", () => {
		let mockAgyPath: string;

		before(() => {
			mockAgyPath = path.join(
				os.tmpdir(),
				`mock-agy-turn-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`
			);

			const scriptContent = `#!/usr/bin/env node
const args = process.argv.slice(2);

if (args.includes("--test-abort")) {
	process.stdout.write(JSON.stringify({
		event: "step_update",
		step_update: { step_index: 0, text_delta: "Starting long job... " }
	}) + "\\n");

	process.on("SIGTERM", () => {
		process.exit(0);
	});

	setInterval(() => {}, 500);
} else {
	let input = "";
	process.stdin.setEncoding("utf-8");
	process.stdin.on("data", (c) => input += c);
	process.stdin.on("end", () => {
		process.stdout.write(JSON.stringify({
			event: "step_update",
			step_update: { step_index: 1, text_delta: "Agy responded to: " + input }
		}) + "\\n");
		process.stdout.write(JSON.stringify({
			event: "result",
			result: { status: "SUCCESS", usage: { input_tokens: 25, output_tokens: 10, total_tokens: 35 } }
		}) + "\\n");
	});
}
`;
			fs.writeFileSync(mockAgyPath, scriptContent, { mode: 0o755 });
		});

		after(() => {
			try {
				if (fs.existsSync(mockAgyPath)) {
					fs.unlinkSync(mockAgyPath);
				}
			} catch {
				/* ignore */
			}
		});

		it("spawns subprocess and pipes prompt via stdin to completion", async () => {
			let onFinishCalled = false;
			let finishMessages: AgentMessage[] | undefined;

			const handle = runAntigravityTurn({
				prompt: "Physics question",
				agyPath: mockAgyPath,
				updateFlushMs: 10,
				onFinish: (msgs) => {
					onFinishCalled = true;
					finishMessages = msgs;
				},
			});

			const { events, doneSeen } = await collectSseEvents(handle.subscribe());
			assert.equal(doneSeen, true);

			const msgEnd = events.find((e) => e.type === "message_end") as any;
			assert.ok(msgEnd.message.content[0].text.includes("Agy responded to: Physics question"));

			assert.equal(onFinishCalled, true);
			assert.ok(finishMessages);
			assert.equal(finishMessages.length, 1);
		});

		it("kills subprocess with SIGTERM when handle.abort() is called", async () => {
			let isAbortedResult: boolean | undefined;

			const handle = runAntigravityTurn({
				prompt: "Will be aborted",
				agyPath: mockAgyPath,
				extraArgs: ["--test-abort"],
				updateFlushMs: 10,
				onFinish: (_msgs, isAborted) => {
					isAbortedResult = isAborted;
				},
			});

			const eventsPromise = collectSseEvents(handle.subscribe());

			// Wait for first delta from subprocess
			await new Promise((r) => setTimeout(r, 60));

			// Remote kill sends SIGTERM to child
			handle.abort();

			const { doneSeen } = await eventsPromise;
			assert.equal(doneSeen, true);
			assert.equal(isAbortedResult, true);
		});
	});
});
