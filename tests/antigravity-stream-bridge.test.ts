import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AgyStreamBridge,
	bridgeAgyStream,
	extractStructuredTools,
	isQuestionTool,
	isTerminatingTool,
	STRUCTURED_TOOL_NAMES,
	validateQuizArgs,
	type TurnWireEvent,
} from "../src/server/antigravity/stream-bridge.ts";
import type { AgyStreamEvent } from "../src/server/antigravity/runner.ts";

describe("Antigravity Stream Bridge", () => {
	describe("extractStructuredTools", () => {
		it("detects and extracts quiz block from text", () => {
			const text =
				'Here is the explanation.\n\n:::quiz\n{"question":"What is DNA?","options":["A","B"],"answer":0,"explanation":"Gene molecule"}\n:::\nMore text';
			const res = extractStructuredTools(text);
			assert.equal(res.cleanText.trim(), "Here is the explanation.");
			assert.equal(res.tools.length, 1);
			assert.equal(res.tools[0]!.name, "quiz");
			assert.equal(res.tools[0]!.args.question, "What is DNA?");
			assert.equal(res.tools[0]!.validation?.valid, true);
		});

		it("detects plan_init tool block and keeps surrounding text for non-terminating tools", () => {
			const text =
				'Let\'s plan our curriculum:\n\n:::plan_init\n{"root":"Biology","nodes":[{"id":"cell","title":"The Cell"}]}\n:::\nNow let\'s begin.';
			const res = extractStructuredTools(text);
			assert.equal(res.cleanText.trim(), "Let's plan our curriculum:\n\nNow let's begin.");
			assert.equal(res.tools.length, 1);
			assert.equal(res.tools[0]!.name, "plan_init");
			assert.equal(res.tools[0]!.args.root, "Biology");
		});

		it("detects all 10 supported structured tools", () => {
			const toolsToTest: Array<{ name: (typeof STRUCTURED_TOOL_NAMES)[number]; json: string }> = [
				{
					name: "quiz",
					json: '{"question":"Q?","options":["A","B"],"correctAnswer":"A"}',
				},
				{
					name: "ask_user_question",
					json: '{"question":"What topic do you prefer?"}',
				},
				{
					name: "plan_init",
					json: '{"root":"Root","nodes":[]}',
				},
				{
					name: "plan_update",
					json: '{"updates":[{"id":"node-1","status":"completed"}]}',
				},
				{
					name: "probe_done",
					json: '{"assessment":"Student ready"}',
				},
				{
					name: "problem",
					json: '{"statement":"Solve 2x=4","modelSolution":"x=2"}',
				},
				{
					name: "conclude",
					json: '{"outcome":"solved","verdict":"Good job"}',
				},
				{
					name: "spawn_research",
					json: '{"query":"CRISPR mechanics"}',
				},
				{
					name: "spawn_demo",
					json: '{"topic":"Sorting algorithms"}',
				},
				{
					name: "spawn_visual",
					json: '{"prompt":"Draw cell diagram"}',
				},
			];

			for (const { name, json } of toolsToTest) {
				const text = `Intro text.\n:::${name}\n${json}\n:::\nOutro.`;
				const res = extractStructuredTools(text);
				assert.equal(res.tools.length, 1, `Failed to extract tool: ${name}`);
				assert.equal(res.tools[0]!.name, name);
			}
		});

		it("handles markdown code fences (```json ... ```) inside tool blocks", () => {
			const text = `Teaching content.\n:::quiz\n\`\`\`json\n{\n  "question": "What is RNA?",\n  "options": ["A", "B"],\n  "correctAnswer": "A"\n}\n\`\`\`\n:::`;
			const res = extractStructuredTools(text);
			assert.equal(res.tools.length, 1);
			assert.equal(res.tools[0]!.name, "quiz");
			assert.equal(res.tools[0]!.args.question, "What is RNA?");
		});

		it("handles tool blocks with empty bodies (e.g. probe_done)", () => {
			const text = "Probing completed.\n:::probe_done\n:::";
			const res = extractStructuredTools(text);
			assert.equal(res.tools.length, 1);
			assert.equal(res.tools[0]!.name, "probe_done");
			assert.deepEqual(res.tools[0]!.args, {});
		});

		it("ignores malformed tool JSON while stripping the markup from cleanText", () => {
			const text = "Some text.\n:::quiz\n{ malformed: json without quotes }\n:::\nMore clean text.";
			const res = extractStructuredTools(text);
			assert.equal(res.tools.length, 0);
			assert.equal(res.cleanText.trim(), "Some text.\n\nMore clean text.");
		});

		it("returns cleanText untouched when no tools are present", () => {
			const text = "Just a regular assistant message without any tool blocks.";
			const res = extractStructuredTools(text);
			assert.equal(res.cleanText, text);
			assert.equal(res.tools.length, 0);
		});
	});

	describe("validateQuizArgs against QuestionData shapes", () => {
		it("validates a valid quiz with answer index and string array options", () => {
			const args = {
				question: "What is the speed of light?",
				options: ["300,000 km/s", "150,000 km/s"],
				answer: 0,
				explanation: "Fundamental constant.",
				type: "check",
				details: "Physics baseline",
			};

			const result = validateQuizArgs(args, "call_test_1");
			assert.equal(result.valid, true);
			assert.ok(result.questionData);
			assert.equal(result.questionData.id, "call_test_1");
			assert.equal(result.questionData.kind, "quiz");
			assert.equal(result.questionData.questionType, "check");
			assert.equal(result.questionData.question, "What is the speed of light?");
			assert.equal(result.questionData.mode, "single-select");
			assert.equal(result.questionData.options.length, 2);
			assert.equal(result.questionData.options[0]!.label, "300,000 km/s");
			assert.equal(result.questionData.options[0]!.value, "300,000 km/s");
			assert.deepEqual(result.questionData.correctIndices, [1]);
			assert.equal(result.questionData.explanation, "Fundamental constant.");
			assert.equal(result.questionData.context, "Physics baseline");
		});

		it("validates a valid quiz with object options and correctAnswer string", () => {
			const args = {
				question: "Select the primary color",
				options: [
					{ label: "Green", value: "green" },
					{ label: "Blue", value: "blue" },
				],
				correctAnswer: "blue",
				type: "predict",
			};

			const result = validateQuizArgs(args);
			assert.equal(result.valid, true);
			assert.ok(result.questionData);
			assert.equal(result.questionData.questionType, "predict");
			assert.deepEqual(result.questionData.correctIndices, [2]);
		});

		it("validates a multiSelect quiz with array of answers", () => {
			const args = {
				question: "Which are prime numbers?",
				options: ["2", "3", "4"],
				correctAnswer: ["2", "3"],
				multiSelect: true,
			};

			const result = validateQuizArgs(args);
			assert.equal(result.valid, true);
			assert.ok(result.questionData);
			assert.equal(result.questionData.mode, "multi-select");
			assert.deepEqual(result.questionData.correctIndices, [1, 2]);
		});

		it("fails validation when question is missing or empty", () => {
			const args = {
				question: "   ",
				options: ["A", "B"],
				correctAnswer: "A",
			};

			const result = validateQuizArgs(args);
			assert.equal(result.valid, false);
			assert.ok(result.errors?.some((e) => e.includes("question is required")));
		});

		it("fails validation when options have fewer than 2 items", () => {
			const args = {
				question: "Valid question?",
				options: ["Only one option"],
				correctAnswer: "Only one option",
			};

			const result = validateQuizArgs(args);
			assert.equal(result.valid, false);
			assert.ok(result.errors?.some((e) => e.includes("options must contain at least 2 items")));
		});

		it("fails validation when options have duplicate values", () => {
			const args = {
				question: "Valid question?",
				options: ["Duplicate", "Duplicate"],
				correctAnswer: "Duplicate",
			};

			const result = validateQuizArgs(args);
			assert.equal(result.valid, false);
			assert.ok(result.errors?.some((e) => e.includes("duplicate option value")));
		});

		it("fails validation when correctAnswer does not match any option", () => {
			const args = {
				question: "Valid question?",
				options: ["Option A", "Option B"],
				correctAnswer: "Option C",
			};

			const result = validateQuizArgs(args);
			assert.equal(result.valid, false);
			assert.ok(result.errors?.some((e) => e.includes("does not match any option value")));
		});

		it("fails validation when multiple answers given without multiSelect: true", () => {
			const args = {
				question: "Valid question?",
				options: ["A", "B", "C"],
				correctAnswer: ["A", "B"],
				multiSelect: false,
			};

			const result = validateQuizArgs(args);
			assert.equal(result.valid, false);
			assert.ok(result.errors?.some((e) => e.includes("multiSelect is not true")));
		});
	});

	describe("AgyStreamBridge delimiter buffering & event synthesis", () => {
		it("buffers incomplete colons (e.g. ::) until completed as :::quiz block", () => {
			const bridge = new AgyStreamBridge({ messageId: "msg_test_1" });
			const allEvents: TurnWireEvent[] = [];

			// Chunk 1: Plain text ending with ::
			const ev1 = bridge.processChunk("Hello student!\n\n::");
			allEvents.push(...ev1);

			// Should have emitted message_start and message_update with "Hello student!\n\n",
			// but NOT the "::"
			const updates1 = allEvents.filter((e) => e.type === "message_update");
			assert.equal(updates1.length, 1);
			const textBlock1 = updates1[0]!.message.content.find((c) => c.type === "text");
			assert.equal(textBlock1?.text, "Hello student!\n\n");

			// Chunk 2: Completes delimiter and tool block
			const ev2 = bridge.processChunk(
				':quiz\n{"question":"What is 2+2?","options":["3","4"],"answer":1,"explanation":"Math"}\n:::\nMore after quiz'
			);
			allEvents.push(...ev2);

			// Tool events synthesized
			const toolStart = allEvents.find((e) => e.type === "tool_execution_start");
			assert.ok(toolStart);
			assert.equal(toolStart.toolName, "quiz");
			assert.equal(toolStart.args.question, "What is 2+2?");

			const toolEnd = allEvents.find((e) => e.type === "tool_execution_end");
			assert.ok(toolEnd);
			assert.equal(toolEnd.toolName, "quiz");
			assert.equal(toolEnd.isError, false);

			// Finish
			const ev3 = bridge.finish("SUCCESS");
			allEvents.push(...ev3);

			const msgEnd = allEvents.find((e) => e.type === "message_end");
			assert.ok(msgEnd);
			assert.equal(msgEnd.message.stopReason, "toolUse");
		});

		it("buffers partial delimiter and flushes as plain text when proven not a tool block", () => {
			const bridge = new AgyStreamBridge();
			const events: TurnWireEvent[] = [];

			// Chunk 1: Ends with single colon
			events.push(...bridge.processChunk("The ratio is 1:"));

			// Chunk 2: Followed by "2", not another colon
			events.push(...bridge.processChunk("2 for dilution."));

			events.push(...bridge.finish("SUCCESS"));

			const updates = events.filter((e) => e.type === "message_update");
			const latestUpdate = updates[updates.length - 1];
			const textBlock = latestUpdate?.message.content.find((c) => c.type === "text");
			assert.equal(textBlock?.text, "The ratio is 1:2 for dilution.");
		});

		it("flushes ::: followed by non-tool name as plain text", () => {
			const bridge = new AgyStreamBridge();
			const events: TurnWireEvent[] = [];

			events.push(...bridge.processChunk(":::note\nThis is a standard markdown callout\n:::"));
			events.push(...bridge.finish("SUCCESS"));

			const toolStart = events.find((e) => e.type === "tool_execution_start");
			assert.equal(toolStart, undefined);

			const updates = events.filter((e) => e.type === "message_update");
			const latestUpdate = updates[updates.length - 1];
			const textBlock = latestUpdate?.message.content.find((c) => c.type === "text");
			assert.ok(textBlock?.text.includes(":::note"));
		});

		it("handles micro-chunks splitting tool delimiter across many chunks", () => {
			const bridge = new AgyStreamBridge();
			const events: TurnWireEvent[] = [];

			const chunks = [
				"Explaining mitosis.\n\n",
				":",
				":",
				":q",
				"uiz\n",
				'{"que',
				'stion":"What comes after prophase?",',
				'"options":["Metaphase","Anaphase"],',
				'"answer":0,',
				'"explanation":"Cell cycle phase"}',
				"\n:::",
			];

			for (const chunk of chunks) {
				events.push(...bridge.processChunk(chunk));
			}
			events.push(...bridge.finish("SUCCESS"));

			const toolStart = events.find((e) => e.type === "tool_execution_start");
			assert.ok(toolStart);
			assert.equal(toolStart.toolName, "quiz");
			assert.equal(toolStart.args.question, "What comes after prophase?");

			const toolEnd = events.find((e) => e.type === "tool_execution_end");
			assert.ok(toolEnd);
			assert.equal(toolEnd.isError, false);
		});

		it("synthesizes error tool_execution_end when quiz validation fails", () => {
			const bridge = new AgyStreamBridge();
			const events: TurnWireEvent[] = [];

			// Quiz with invalid options (only 1 option)
			const chunk =
				':::quiz\n{"question":"Invalid?","options":["OnlyOne"],"correctAnswer":"OnlyOne"}\n:::\n';
			events.push(...bridge.processChunk(chunk));
			events.push(...bridge.finish("SUCCESS"));

			const toolEnd = events.find((e) => e.type === "tool_execution_end");
			assert.ok(toolEnd);
			assert.equal(toolEnd.isError, true);
			assert.ok(toolEnd.result.content[0].text.includes("at least 2 items"));
		});
	});

	describe("bridgeAgyStream async generator", () => {
		it("transforms stream of AgyStreamEvents into TurnWireEvents", async () => {
			async function* mockAgyEvents(): AsyncGenerator<AgyStreamEvent, void, unknown> {
				yield { type: "text_delta", text: "Starting lesson.\n\n" };
				yield {
					type: "text_delta",
					text: ':::plan_init\n{"root":"Physics","nodes":[{"id":"kinematics","title":"Kinematics"}]}\n:::\n',
				};
				yield { type: "text_delta", text: "First topic is motion." };
				yield {
					type: "result",
					status: "SUCCESS",
					usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
				};
			}

			const wireEvents: TurnWireEvent[] = [];
			for await (const event of bridgeAgyStream(mockAgyEvents())) {
				wireEvents.push(event);
			}

			// Verify event sequence:
			// message_start, message_updates, tool_execution_start, tool_execution_end, message_end, agent_end
			const types = wireEvents.map((e) => e.type);
			assert.ok(types.includes("message_start"));
			assert.ok(types.includes("message_update"));
			assert.ok(types.includes("tool_execution_start"));
			assert.ok(types.includes("tool_execution_end"));
			assert.ok(types.includes("message_end"));
			assert.ok(types.includes("agent_end"));

			const toolStart = wireEvents.find((e) => e.type === "tool_execution_start");
			assert.equal(toolStart?.toolName, "plan_init");
			assert.equal(toolStart?.args.root, "Physics");

			const msgEnd = wireEvents.find((e) => e.type === "message_end");
			assert.equal(msgEnd?.message.usage?.total_tokens, 140);
		});

		it("handles error event in agy stream", async () => {
			async function* mockErrorStream(): AsyncGenerator<AgyStreamEvent, void, unknown> {
				yield { type: "text_delta", text: "Working..." };
				yield { type: "error", message: "Process terminated unexpectedly" };
			}

			const wireEvents: TurnWireEvent[] = [];
			for await (const event of bridgeAgyStream(mockErrorStream())) {
				wireEvents.push(event);
			}

			const errEvent = wireEvents.find((e) => e.type === "error");
			assert.ok(errEvent);
			assert.equal(errEvent.errorText, "Process terminated unexpectedly");

			const msgEnd = wireEvents.find((e) => e.type === "message_end");
			assert.ok(msgEnd);
			assert.equal(msgEnd.message.stopReason, "error");
		});
	});

	describe("tool classification helpers", () => {
		it("identifies question and terminating tools correctly", () => {
			assert.equal(isQuestionTool("quiz"), true);
			assert.equal(isQuestionTool("ask_user_question"), true);
			assert.equal(isQuestionTool("plan_init"), false);

			assert.equal(isTerminatingTool("quiz"), true);
			assert.equal(isTerminatingTool("ask_user_question"), true);
			assert.equal(isTerminatingTool("problem"), true);
			assert.equal(isTerminatingTool("plan_init"), false);
			assert.equal(isTerminatingTool("conclude"), false);
		});
	});
});
