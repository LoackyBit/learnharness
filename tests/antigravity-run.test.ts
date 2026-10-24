import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";
import { Type } from "typebox";
import {
	runAntigravitySubagent,
	subagentEngine,
	extractSubagentToolCalls,
	buildSubagentPrompt,
	type SubagentRunOptions,
	type SubagentStep,
	type CallUsage,
} from "../src/agent/subagents/antigravity-run.ts";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";
import { runSubmitAgent, healStringifiedArrays } from "../src/agent/subagents/submit-agent.ts";
import type { AgentTool } from "../src/agent/tool-execute.ts";
import type { Usage } from "../src/core/contracts/messages.ts";

describe("Antigravity Subagent Runner Core", () => {
	let mockAgyPath: string;

	before(() => {
		mockAgyPath = path.join(
			os.tmpdir(),
			`mock-subagent-agy-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
		);

		const scriptContent = `#!/usr/bin/env node
let stdin = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
	if (stdin.includes("FORCE_CLI_ERROR")) {
		process.stdout.write(JSON.stringify({ event: "error", error: "CLI execution failed" }) + "\\n");
		return;
	}
	if (stdin.includes("HANG_UNTIL_KILL")) {
		process.stdout.write(JSON.stringify({ event: "step_update", step_update: { text_delta: "Hanging..." } }) + "\\n");
		setInterval(() => {}, 1000);
		return;
	}
	if (stdin.includes("BASIC_NO_TOOLS")) {
		process.stdout.write(JSON.stringify({ event: "step_update", step_update: { text_delta: "Antigravity subagent completed." } }) + "\\n");
		process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", usage: { input_tokens: 40, output_tokens: 15, total_tokens: 55 } } }) + "\\n");
		return;
	}
	if (stdin.includes("SINGLE_TOOL_CALL")) {
		process.stdout.write(JSON.stringify({ event: "step_update", step_update: { text_delta: "Thinking...\\n:::test_tool\\n{\\"action\\":\\"execute\\"}\\n:::\\nDone." } }) + "\\n");
		process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", usage: { input_tokens: 30, output_tokens: 20, total_tokens: 50 } } }) + "\\n");
		return;
	}
	if (stdin.includes("MULTI_TURN_TEST")) {
		if (stdin.includes("Tool Result [step_tool]:")) {
			process.stdout.write(JSON.stringify({ event: "step_update", step_update: { text_delta: "Multi-turn finished successfully." } }) + "\\n");
			process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", usage: { input_tokens: 60, output_tokens: 15, total_tokens: 75 } } }) + "\\n");
		} else {
			process.stdout.write(JSON.stringify({ event: "step_update", step_update: { text_delta: ":::step_tool\\n{\\"step\\":1}\\n:::" } }) + "\\n");
			process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 } } }) + "\\n");
		}
		return;
	}
	if (stdin.includes("LOOP_MAX_TURNS")) {
		process.stdout.write(JSON.stringify({ event: "step_update", step_update: { text_delta: ":::loop_tool\\n{\\"iter\\":true}\\n:::" } }) + "\\n");
		process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } }) + "\\n");
		return;
	}
	if (stdin.includes("SUBMIT_CLEAN")) {
		process.stdout.write(JSON.stringify({ event: "step_update", step_update: { text_delta: "Submitting findings:\\n:::submit_target\\n{\\"score\\":95,\\"name\\":\\"algebra\\"}\\n:::" } }) + "\\n");
		process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", usage: { input_tokens: 50, output_tokens: 25, total_tokens: 75 } } }) + "\\n");
		return;
	}
	if (stdin.includes("SUBMIT_BARE_JSON")) {
		process.stdout.write(JSON.stringify({ event: "step_update", step_update: { text_delta: "\`\`\`json\\n{\\"score\\":88,\\"name\\":\\"geometry\\"}\\n\`\`\`" } }) + "\\n");
		process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", usage: { input_tokens: 50, output_tokens: 25, total_tokens: 75 } } }) + "\\n");
		return;
	}
	if (stdin.includes("RETRY_MALFORMED_JSON")) {
		if (stdin.includes("Invalid JSON for tool")) {
			process.stdout.write(JSON.stringify({ event: "step_update", step_update: { text_delta: ":::submit_target\\n{\\"score\\":100,\\"name\\":\\"healed\\"}\\n:::" } }) + "\\n");
		} else {
			process.stdout.write(JSON.stringify({ event: "step_update", step_update: { text_delta: ":::submit_target\\n{ score: bad json\\n:::" } }) + "\\n");
		}
		process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", usage: { input_tokens: 45, output_tokens: 20, total_tokens: 65 } } }) + "\\n");
		return;
	}
	if (stdin.includes("RETRY_SCHEMA_INVALID")) {
		if (stdin.includes("Invalid tool input for tool") || stdin.includes("Validation failed")) {
			process.stdout.write(JSON.stringify({ event: "step_update", step_update: { text_delta: ":::submit_target\\n{\\"score\\":100,\\"name\\":\\"valid_now\\"}\\n:::" } }) + "\\n");
		} else {
			process.stdout.write(JSON.stringify({ event: "step_update", step_update: { text_delta: ":::submit_target\\n{\\"name\\":\\"missing_score\\"}\\n:::" } }) + "\\n");
		}
		process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", usage: { input_tokens: 45, output_tokens: 20, total_tokens: 65 } } }) + "\\n");
		return;
	}
	if (stdin.includes("RETRY_SEMANTIC_FAIL")) {
		if (stdin.includes("Score must be at least 50")) {
			process.stdout.write(JSON.stringify({ event: "step_update", step_update: { text_delta: ":::submit_target\\n{\\"score\\":90,\\"name\\":\\"fixed_score\\"}\\n:::" } }) + "\\n");
		} else {
			process.stdout.write(JSON.stringify({ event: "step_update", step_update: { text_delta: ":::submit_target\\n{\\"score\\":10,\\"name\\":\\"low_score\\"}\\n:::" } }) + "\\n");
		}
		process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", usage: { input_tokens: 45, output_tokens: 20, total_tokens: 65 } } }) + "\\n");
		return;
	}
	if (stdin.includes("NEVER_SUBMIT_TEST")) {
		process.stdout.write(JSON.stringify({ event: "step_update", step_update: { text_delta: "Refusing to submit." } }) + "\\n");
		process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } }) + "\\n");
		return;
	}

	process.stdout.write(JSON.stringify({ event: "step_update", step_update: { text_delta: "Default response." } }) + "\\n");
	process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }) + "\\n");
});
`;
		fs.writeFileSync(mockAgyPath, scriptContent, { mode: 0o755 });
	});

	after(() => {
		try {
			if (fs.existsSync(mockAgyPath)) {
				fs.unlinkSync(mockAgyPath);
			}
		} catch {}
	});

	describe("tool block parsing and prompt builders", () => {
		it("extracts structured tool calls cleanly", () => {
			const text = "Prefix text.\n:::my_tool\n{\"a\":1,\"b\":\"two\"}\n:::\nSuffix text.";
			const { cleanText, toolCalls } = extractSubagentToolCalls(text, new Set(["my_tool"]));
			assert.equal(cleanText, "Prefix text.\n\nSuffix text.");
			assert.equal(toolCalls.length, 1);
			assert.equal(toolCalls[0]!.name, "my_tool");
			assert.deepEqual(toolCalls[0]!.args, { a: 1, b: "two" });
		});

		it("handles single-tool fallback with markdown code fence", () => {
			const text = "Here is the result:\n```json\n{\"id\":\"target\",\"value\":42}\n```";
			const { cleanText, toolCalls } = extractSubagentToolCalls(text, new Set(["submit_single"]));
			assert.equal(cleanText, "Here is the result:");
			assert.equal(toolCalls.length, 1);
			assert.equal(toolCalls[0]!.name, "submit_single");
			assert.deepEqual(toolCalls[0]!.args, { id: "target", value: 42 });
		});

		it("builds subagent prompt with instructions and tool descriptions", () => {
			const tool: AgentTool<any> = {
				name: "search",
				label: "search",
				description: "Search documents",
				parameters: Type.Object({ query: Type.String() }),
				execute: async () => ({ content: [], details: {} }),
			};
			const prompt = buildSubagentPrompt("System instructions", [tool], [], "Do query");
			assert.ok(prompt.includes("System instructions"));
			assert.ok(prompt.includes(":::search"));
			assert.ok(prompt.includes("Search documents"));
			assert.ok(prompt.includes("Do query"));
		});
	});

	describe("runAntigravitySubagent execution", () => {
		it("runs basic subagent without tools and captures text and usage", async () => {
			let capturedUsage: Usage | undefined;
			let stepCalled = 0;

			const result = await runAntigravitySubagent([], {
				role: "researcher",
				systemPrompt: "You are researcher.",
				prompt: "BASIC_NO_TOOLS",
				maxTurns: 3,
				agyPath: mockAgyPath,
				onUsage: (u) => {
					capturedUsage = u;
				},
				onAssistantMessage: (_msg, step) => {
					stepCalled = step;
				},
			});

			assert.equal(result.text, "Antigravity subagent completed.");
			assert.equal(result.newMessages.length, 1);
			assert.equal(result.newMessages[0]!.role, "assistant");
			assert.equal(capturedUsage?.totalTokens, 55);
			assert.equal(stepCalled, 1);
		});

		it("executes single tool call and passes results", async () => {
			let toolStarted = false;
			let toolExecuted = false;

			const testTool: AgentTool<any> = {
				name: "test_tool",
				label: "test_tool",
				description: "Test execution tool",
				parameters: Type.Object({ action: Type.String() }),
				execute: async (_callId, input) => {
					toolExecuted = true;
					assert.equal(input.action, "execute");
					return {
						content: [{ type: "text", text: "Tool output successful" }],
						details: { executed: true },
					};
				},
			};

			const result = await runAntigravitySubagent([testTool], {
				role: "demoBuilder",
				systemPrompt: "Run demo",
				prompt: "SINGLE_TOOL_CALL",
				maxTurns: 1,
				agyPath: mockAgyPath,
				onToolStart: (name) => {
					if (name === "test_tool") toolStarted = true;
				},
			});

			assert.ok(toolStarted);
			assert.ok(toolExecuted);
			assert.equal(result.newMessages.length, 2);
			assert.equal(result.newMessages[0]!.role, "assistant");
			assert.equal(result.newMessages[1]!.role, "toolResult");
			assert.equal((result.newMessages[1] as any).toolName, "test_tool");
		});

		it("runs multi-turn tool execution loop to completion", async () => {
			let stepExecuted = false;

			const stepTool: AgentTool<any> = {
				name: "step_tool",
				label: "step_tool",
				description: "Step tool",
				parameters: Type.Object({ step: Type.Number() }),
				execute: async (_callId, input) => {
					stepExecuted = true;
					assert.equal(input.step, 1);
					return {
						content: [{ type: "text", text: "Step 1 OK" }],
						details: { ok: true },
					};
				},
			};

			const result = await runAntigravitySubagent([stepTool], {
				role: "researcher",
				systemPrompt: "Multi turn task",
				prompt: "MULTI_TURN_TEST",
				maxTurns: 3,
				agyPath: mockAgyPath,
			});

			assert.ok(stepExecuted);
			assert.equal(result.text, "Multi-turn finished successfully.");
			// Turn 1: assistant + toolResult; Turn 2: assistant
			assert.equal(result.newMessages.length, 3);
		});

		it("stops early when shouldStop returns true", async () => {
			let turnsCount = 0;
			const loopTool: AgentTool<any> = {
				name: "loop_tool",
				label: "loop_tool",
				description: "Loop tool",
				parameters: Type.Object({ iter: Type.Boolean() }),
				execute: async () => ({
					content: [{ type: "text", text: "Iter done" }],
					details: {},
				}),
			};

			const result = await runAntigravitySubagent([loopTool], {
				role: "extractor",
				systemPrompt: "Loop task",
				prompt: "LOOP_MAX_TURNS",
				maxTurns: 5,
				agyPath: mockAgyPath,
				onAssistantMessage: () => {
					turnsCount++;
				},
				shouldStop: (_msg, toolResults) => toolResults.some((r) => r.toolName === "loop_tool"),
			});

			assert.equal(turnsCount, 1);
			assert.equal(result.newMessages.length, 2);
		});

		it("stops when maxTurns budget is reached", async () => {
			let turnsCount = 0;
			const loopTool: AgentTool<any> = {
				name: "loop_tool",
				label: "loop_tool",
				description: "Loop tool",
				parameters: Type.Object({ iter: Type.Boolean() }),
				execute: async () => ({
					content: [{ type: "text", text: "Iter done" }],
					details: {},
				}),
			};

			await runAntigravitySubagent([loopTool], {
				role: "extractor",
				systemPrompt: "Loop task",
				prompt: "LOOP_MAX_TURNS",
				maxTurns: 2,
				agyPath: mockAgyPath,
				onAssistantMessage: () => {
					turnsCount++;
				},
			});

			assert.equal(turnsCount, 2);
		});

		it("throws AbortError when abortSignal is already aborted", async () => {
			const controller = new AbortController();
			controller.abort();

			await assert.rejects(
				async () => {
					await runAntigravitySubagent([], {
						role: "researcher",
						systemPrompt: "Test",
						prompt: "BASIC_NO_TOOLS",
						maxTurns: 2,
						abortSignal: controller.signal,
						agyPath: mockAgyPath,
					});
				},
				(err: any) => err.name === "AbortError",
			);
		});

		it("throws AbortError when aborted during execution", async () => {
			const controller = new AbortController();

			const promise = runAntigravitySubagent([], {
				role: "researcher",
				systemPrompt: "Test",
				prompt: "HANG_UNTIL_KILL",
				maxTurns: 2,
				abortSignal: controller.signal,
				agyPath: mockAgyPath,
			});

			setTimeout(() => controller.abort(), 50);

			await assert.rejects(promise, (err: any) => err.name === "AbortError");
		});

		it("throws when CLI stream encounters error", async () => {
			await assert.rejects(
				async () => {
					await runAntigravitySubagent([], {
						role: "researcher",
						systemPrompt: "Test",
						prompt: "FORCE_CLI_ERROR",
						maxTurns: 2,
						agyPath: mockAgyPath,
					});
				},
				/CLI execution failed/,
			);
		});
	});

	describe("runSubmitAgent with structured validation and retries", () => {
		const targetSchema = Type.Object({
			score: Type.Number(),
			name: Type.String(),
		});

		it("submits clean structured tool payload on turn 1", async () => {
			let stepLogged = false;

			const result = await runSubmitAgent<{ score: number; name: string }>({
				role: "extractor",
				toolName: "submit_target",
				toolDescription: "Submit findings",
				parameters: targetSchema,
				fill: (input) => ({ score: input.score, name: input.name }),
				systemPrompt: "Extract algebra findings",
				prompt: "SUBMIT_CLEAN",
				engine: undefined,
				signal: undefined,
				neverSubmitted: "Never submitted",
				agyPath: mockAgyPath,
				onStep: () => {
					stepLogged = true;
				},
			});

			assert.ok(stepLogged);
			assert.equal(result.score, 95);
			assert.equal(result.name, "algebra");
		});

		it("submits clean payload from bare JSON code fence", async () => {
			const result = await runSubmitAgent<{ score: number; name: string }>({
				role: "extractor",
				toolName: "submit_target",
				toolDescription: "Submit findings",
				parameters: targetSchema,
				fill: (input) => ({ score: input.score, name: input.name }),
				systemPrompt: "Extract geometry",
				prompt: "SUBMIT_BARE_JSON",
				engine: undefined,
				signal: undefined,
				neverSubmitted: "Never submitted",
				agyPath: mockAgyPath,
				onStep: () => {},
			});

			assert.equal(result.score, 88);
			assert.equal(result.name, "geometry");
		});

		it("retries on malformed JSON and succeeds on turn 2", async () => {
			let steps = 0;

			const result = await runSubmitAgent<{ score: number; name: string }>({
				role: "extractor",
				toolName: "submit_target",
				toolDescription: "Submit findings",
				parameters: targetSchema,
				fill: (input) => ({ score: input.score, name: input.name }),
				systemPrompt: "Extract",
				prompt: "RETRY_MALFORMED_JSON",
				maxTurns: 4,
				engine: undefined,
				signal: undefined,
				neverSubmitted: "Never submitted",
				agyPath: mockAgyPath,
				onStep: () => {
					steps++;
				},
			});

			assert.equal(steps, 2);
			assert.equal(result.score, 100);
			assert.equal(result.name, "healed");
		});

		it("retries on TypeBox schema violation and succeeds on turn 2", async () => {
			let steps = 0;

			const result = await runSubmitAgent<{ score: number; name: string }>({
				role: "extractor",
				toolName: "submit_target",
				toolDescription: "Submit findings",
				parameters: targetSchema,
				fill: (input) => ({ score: input.score, name: input.name }),
				systemPrompt: "Extract",
				prompt: "RETRY_SCHEMA_INVALID",
				maxTurns: 4,
				engine: undefined,
				signal: undefined,
				neverSubmitted: "Never submitted",
				agyPath: mockAgyPath,
				onStep: () => {
					steps++;
				},
			});

			assert.equal(steps, 2);
			assert.equal(result.score, 100);
			assert.equal(result.name, "valid_now");
		});

		it("retries on semantic validation failure and succeeds on turn 2", async () => {
			let steps = 0;

			const result = await runSubmitAgent<{ score: number; name: string }>({
				role: "extractor",
				toolName: "submit_target",
				toolDescription: "Submit findings",
				parameters: targetSchema,
				fill: (input) => ({ score: input.score, name: input.name }),
				validate: (val) => (val.score < 50 ? "Score must be at least 50" : null),
				systemPrompt: "Extract",
				prompt: "RETRY_SEMANTIC_FAIL",
				maxTurns: 4,
				engine: undefined,
				signal: undefined,
				neverSubmitted: "Never submitted",
				agyPath: mockAgyPath,
				onStep: () => {
					steps++;
				},
			});

			assert.equal(steps, 2);
			assert.equal(result.score, 90);
			assert.equal(result.name, "fixed_score");
		});

		it("throws neverSubmitted when model fails to submit within maxTurns", async () => {
			await assert.rejects(
				async () => {
					await runSubmitAgent<{ score: number; name: string }>({
						role: "extractor",
						toolName: "submit_target",
						toolDescription: "Submit findings",
						parameters: targetSchema,
						fill: (input) => ({ score: input.score, name: input.name }),
						systemPrompt: "Extract",
						prompt: "NEVER_SUBMIT_TEST",
						maxTurns: 2,
						engine: undefined,
						signal: undefined,
						neverSubmitted: "the extractor never submitted findings",
						agyPath: mockAgyPath,
						onStep: () => {},
					});
				},
				/the extractor never submitted findings/,
			);
		});

		it("heals stringified arrays in healStringifiedArrays", () => {
			const input = {
				propositions: JSON.stringify([{ id: "p1", name: "Prop 1" }]),
				chains: JSON.stringify([{ premises: ["p1"], conclusion: "c1" }]),
				other: "unmodified",
			};
			const healed = healStringifiedArrays(input) as Record<string, unknown>;
			assert.ok(Array.isArray(healed.propositions));
			assert.ok(Array.isArray(healed.chains));
			assert.equal(healed.other, "unmodified");
		});
	});

	describe("backward compatibility re-exports via pi-run.ts", () => {
		it("forwards runSubagent to runAntigravitySubagent", () => {
			assert.equal(runSubagent, runAntigravitySubagent);
		});

		it("exports subagentEngine and resolves engine override", () => {
			const fakeEngine: any = { model: { id: "test-model" }, level: "high" };
			const resolved = subagentEngine("researcher", fakeEngine);
			assert.equal(resolved, fakeEngine);
		});
	});
});
