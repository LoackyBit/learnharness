import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";
import {
	buildAgyArgs,
	parseAgyNdjsonLine,
	runAgyStream,
	type AgyRunOptions,
	type AgyStreamEvent,
} from "../src/server/antigravity/runner.ts";

describe("Antigravity CLI Runner", () => {
	describe("buildAgyArgs", () => {
		it("builds correct default agy execution arguments", () => {
			const args = buildAgyArgs({
				prompt: "Hello",
			});
			assert.deepEqual(args, [
				"--output-format",
				"stream-json",
				"--dangerously-skip-permissions",
				"--input-format",
				"text",
			]);
		});

		it("appends model when specified", () => {
			const args = buildAgyArgs({
				prompt: "Hello",
				model: "gemini-3.8-flash-high",
			});
			assert.deepEqual(args, [
				"--output-format",
				"stream-json",
				"--dangerously-skip-permissions",
				"--input-format",
				"text",
				"--model",
				"gemini-3.8-flash-high",
			]);
		});

		it("appends effort when specified", () => {
			const args = buildAgyArgs({
				prompt: "Hello",
				effort: "high",
			});
			assert.deepEqual(args, [
				"--output-format",
				"stream-json",
				"--dangerously-skip-permissions",
				"--input-format",
				"text",
				"--effort",
				"high",
			]);
		});

		it("combines model, effort, and extraArgs in order", () => {
			const args = buildAgyArgs({
				prompt: "Explain relativity",
				model: "claude-sonnet-4-6",
				effort: "medium",
				extraArgs: ["--sandbox"],
			});
			assert.deepEqual(args, [
				"--output-format",
				"stream-json",
				"--dangerously-skip-permissions",
				"--input-format",
				"text",
				"--model",
				"claude-sonnet-4-6",
				"--effort",
				"medium",
				"--sandbox",
			]);
		});
	});

	describe("parseAgyNdjsonLine", () => {
		it("returns null for empty lines or whitespace", () => {
			assert.equal(parseAgyNdjsonLine(""), null);
			assert.equal(parseAgyNdjsonLine("   \t  \n"), null);
		});

		it("returns null for non-JSON lines or malformed text", () => {
			assert.equal(parseAgyNdjsonLine("not a json"), null);
			assert.equal(parseAgyNdjsonLine("{ broken json"), null);
			assert.equal(parseAgyNdjsonLine("12345"), null);
		});

		it("returns null for unhandled events like init or user_input", () => {
			const initLine = JSON.stringify({
				event: "init",
				conversation_id: "xyz",
				init: { cwd: "/tmp", tools: [] },
			});
			assert.equal(parseAgyNdjsonLine(initLine), null);

			const userInputLine = JSON.stringify({
				event: "step_update",
				step_update: { step_index: 0, state: "DONE", step_type: "user_input" },
			});
			assert.equal(parseAgyNdjsonLine(userInputLine), null);
		});

		it("parses agy step_update text delta correctly", () => {
			const line = JSON.stringify({
				event: "step_update",
				step_update: {
					step_index: 1,
					state: "ACTIVE",
					step_type: "agent_response",
					text_delta: "Hello student!",
				},
			});
			const parsed = parseAgyNdjsonLine(line);
			assert.equal(parsed?.type, "text_delta");
			assert.equal(parsed?.text, "Hello student!");
		});

		it("parses step_update with text_delta at root or direct type", () => {
			const directDelta = JSON.stringify({
				event: "step_update",
				text_delta: "Chunk 1",
			});
			const p1 = parseAgyNdjsonLine(directDelta);
			assert.equal(p1?.type, "text_delta");
			assert.equal(p1?.text, "Chunk 1");

			const altDelta = JSON.stringify({
				type: "text_delta",
				text: "Chunk 2",
			});
			const p2 = parseAgyNdjsonLine(altDelta);
			assert.equal(p2?.type, "text_delta");
			assert.equal(p2?.text, "Chunk 2");
		});

		it("parses agy final usage metrics and result event", () => {
			const line = JSON.stringify({
				event: "result",
				result: {
					status: "SUCCESS",
					usage: {
						input_tokens: 120,
						output_tokens: 45,
						thinking_tokens: 30,
						cache_read_tokens: 200,
						total_tokens: 165,
					},
				},
			});
			const parsed = parseAgyNdjsonLine(line);
			assert.equal(parsed?.type, "result");
			assert.equal(parsed?.status, "SUCCESS");
			assert.equal(parsed?.usage?.input_tokens, 120);
			assert.equal(parsed?.usage?.output_tokens, 45);
			assert.equal(parsed?.usage?.thinking_tokens, 30);
			assert.equal(parsed?.usage?.cache_read_tokens, 200);
			assert.equal(parsed?.usage?.total_tokens, 165);
		});

		it("handles result without full usage metrics gracefully", () => {
			const line = JSON.stringify({
				event: "result",
				result: {
					status: "PARTIAL",
				},
			});
			const parsed = parseAgyNdjsonLine(line);
			assert.equal(parsed?.type, "result");
			assert.equal(parsed?.status, "PARTIAL");
			assert.equal(parsed?.usage, undefined);
		});

		it("parses agy error event with string or error object", () => {
			const lineWithObj = JSON.stringify({
				event: "error",
				error: {
					message: "Quota exceeded",
				},
			});
			const p1 = parseAgyNdjsonLine(lineWithObj);
			assert.equal(p1?.type, "error");
			assert.equal(p1?.message, "Quota exceeded");

			const lineWithStr = JSON.stringify({
				event: "error",
				error: "Failed to connect to gateway",
			});
			const p2 = parseAgyNdjsonLine(lineWithStr);
			assert.equal(p2?.type, "error");
			assert.equal(p2?.message, "Failed to connect to gateway");

			const lineWithMessageProp = JSON.stringify({
				event: "error",
				message: "Authentication expired",
			});
			const p3 = parseAgyNdjsonLine(lineWithMessageProp);
			assert.equal(p3?.type, "error");
			assert.equal(p3?.message, "Authentication expired");
		});
	});

	describe("runAgyStream", () => {
		let mockAgyPath: string;

		before(() => {
			mockAgyPath = path.join(os.tmpdir(), `mock-agy-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
			const scriptContent = `#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);

// Check if abort testing mode
if (args.includes("--test-abort")) {
	process.stdout.write(JSON.stringify({ event: "step_update", step_update: { text_delta: "Before abort" } }) + "\\n");
	process.on("SIGTERM", () => {
		process.exit(0);
	});
	// Keep alive until killed
	setInterval(() => {}, 500);
} else if (args.includes("--test-error-exit")) {
	process.stderr.write("Fatal CLI failure\\n");
	process.exit(2);
} else if (args.includes("--test-stay-alive-after-result")) {
	process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS" } }) + "\\n");
	process.on("SIGTERM", () => {
		process.exit(0);
	});
	setInterval(() => {}, 500);
} else {
	// Read full prompt from stdin
	let stdinData = "";
	process.stdin.setEncoding("utf-8");
	process.stdin.on("data", (chunk) => {
		stdinData += chunk;
	});
	process.stdin.on("end", () => {
		// Output NDJSON sequence
		process.stdout.write(JSON.stringify({ event: "init", init: { cwd: process.cwd() } }) + "\\n");
		process.stdout.write("\\n\\n"); // Blank lines to test resilience
		process.stdout.write(JSON.stringify({
			event: "step_update",
			step_update: { step_index: 1, step_type: "agent_response", text_delta: "Received: " + stdinData }
		}) + "\\n");
		process.stdout.write(JSON.stringify({
			event: "step_update",
			step_update: { step_index: 2, step_type: "agent_response", text_delta: " | Done!" }
		}) + "\\n");
		process.stdout.write(JSON.stringify({
			event: "result",
			result: {
				status: "SUCCESS",
				usage: { input_tokens: 50, output_tokens: 15, total_tokens: 65 }
			}
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
				// Ignore cleanup error
			}
		});

		it("pipes prompt via stdin and streams text deltas and result event", async () => {
			const events: AgyStreamEvent[] = [];
			const options: AgyRunOptions = {
				prompt: "Hello Antigravity",
				agyPath: mockAgyPath,
				model: "gemini-3.8-flash-high",
			};

			for await (const ev of runAgyStream(options)) {
				events.push(ev);
			}

			assert.equal(events.length, 3);
			assert.equal(events[0]!.type, "text_delta");
			assert.equal(events[0]!.text, "Received: Hello Antigravity");
			assert.equal(events[1]!.type, "text_delta");
			assert.equal(events[1]!.text, " | Done!");
			assert.equal(events[2]!.type, "result");
			assert.equal(events[2]!.status, "SUCCESS");
			assert.equal(events[2]!.usage?.input_tokens, 50);
			assert.equal(events[2]!.usage?.output_tokens, 15);
		});

		it("terminates stream and sends SIGTERM on abort signal", async () => {
			const controller = new AbortController();
			const events: AgyStreamEvent[] = [];

			const options: AgyRunOptions = {
				prompt: "Will abort",
				agyPath: mockAgyPath,
				extraArgs: ["--test-abort"],
				abortSignal: controller.signal,
			};

			for await (const ev of runAgyStream(options)) {
				events.push(ev);
				if (ev.type === "text_delta") {
					// Trigger abort once we receive first delta
					controller.abort();
				}
			}

			assert.equal(events.length, 1);
			assert.equal(events[0]!.type, "text_delta");
			assert.equal(events[0]!.text, "Before abort");
		});

		it("returns immediately if abort signal is already aborted", async () => {
			const controller = new AbortController();
			controller.abort();

			const events: AgyStreamEvent[] = [];
			const options: AgyRunOptions = {
				prompt: "Pre-aborted",
				agyPath: mockAgyPath,
				abortSignal: controller.signal,
			};

			for await (const ev of runAgyStream(options)) {
				events.push(ev);
			}

			assert.equal(events.length, 0);
		});

		it("emits error event if process exits with non-zero code without result", async () => {
			const events: AgyStreamEvent[] = [];
			const options: AgyRunOptions = {
				prompt: "Will fail",
				agyPath: mockAgyPath,
				extraArgs: ["--test-error-exit"],
			};

			for await (const ev of runAgyStream(options)) {
				events.push(ev);
			}

			assert.equal(events.length, 1);
			assert.equal(events[0]!.type, "error");
			assert.ok(events[0]!.message?.includes("Fatal CLI failure"));
		});

		it("cleans up child process when stream consumer breaks early", async () => {
			const options: AgyRunOptions = {
				prompt: "Early break",
				agyPath: mockAgyPath,
				extraArgs: ["--test-abort"],
			};

			let receivedFirst = false;
			for await (const ev of runAgyStream(options)) {
				if (ev.type === "text_delta") {
					receivedFirst = true;
					break; // Early break
				}
			}

			assert.equal(receivedFirst, true);
		});

		it("terminates stream immediately when terminal result event is received even if process keeps running", async () => {
			const events: AgyStreamEvent[] = [];
			const options: AgyRunOptions = {
				prompt: "Result stay alive",
				agyPath: mockAgyPath,
				extraArgs: ["--test-stay-alive-after-result"],
			};

			for await (const ev of runAgyStream(options)) {
				events.push(ev);
			}

			assert.equal(events.length, 1);
			assert.equal(events[0]!.type, "result");
			assert.equal(events[0]!.status, "SUCCESS");
		});
	});
});
