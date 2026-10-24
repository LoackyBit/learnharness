# Antigravity CLI Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate LearnHarness from `@earendil-works/pi-*` and third-party API keys to Google Antigravity CLI (`agy`) as the sole AI engine, preserving real-time streaming, teaching workflows, interactive quizzes, plan trees, and background subagents.

**Architecture:** An Antigravity execution bridge (`src/server/antigravity/`) spawns the local `agy` process in non-interactive streaming mode (`--output-format stream-json`). A lightweight stream parser translates `agy` NDJSON chunks directly into LearnHarness's SSE wire protocol (`TurnWireEvent`) and detects structured tool blocks (`:::quiz`, `:::plan_init`, `:::ask_user_question`) to mount UI docks and terminate turns with zero MCP overhead. Third-party provider keys and `@earendil-works/*` packages are completely pruned.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Node.js `child_process`, Google Antigravity CLI (`agy`), React 19, Tailwind CSS.

---

## Architecture Decision Record (ADR)

### Context & Problem Statement
LearnHarness currently relies on `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`, which require external API keys (OpenRouter, Anthropic, OpenAI, etc.) stored in plaintext configuration files. The user uses Google Antigravity CLI (`agy`) for all AI workloads and wants `agy` to be the sole AI powering LearnHarness, eliminating external API keys and `pi.dev` dependencies without altering the core pedagogical UX (plan tree, prober, quizzes, practice, subagents).

### Considered Options
1. **Antigravity CLI Subprocess with Stream-JSON & Structured Blocks (Selected)**: LearnHarness executes the local `agy` binary with `--output-format stream-json --input-format text`. Text streams in real time; question tools (`quiz`, `ask_user_question`) and plan operations (`plan_init`, `plan_update`) are structured blocks in the prompt. Turns terminate on question blocks with zero multi-turn latency.
2. **External MCP Server for agy**: LearnHarness exposes tools via a Model Context Protocol server consumed by `agy`. Rejected because MCP adds 1-2s process handshake overhead, and question tools cause an extra full model round-trip (doubling turn latency) simply to report "question posed".
3. **Direct OAuth API Client to Google**: LearnHarness reads `~/.gemini/oauth_creds.json` and calls Google APIs directly. Rejected because it bypasses Antigravity CLI's model abstractions, reasoning effort controls, and updates.

### Decision Outcome
Adopt **Option 1**.
- **Efficiency**: Direct NDJSON delta streaming to SSE.
- **Minimal Surface Change**: Core domain (`src/core/`), data stores (`src/store/`), and presentation shell (`components/`) remain intact.
- **Zero API Keys**: Uses the existing authenticated Antigravity CLI environment.

---

## Tasks

### Task 1: Antigravity CLI Subprocess Runner

**Files:**
- Create: `src/server/antigravity/runner.ts`
- Test: `tests/antigravity-runner.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAgyNdjsonLine, buildAgyArgs } from "../src/server/antigravity/runner.ts";

describe("Antigravity CLI Runner", () => {
	it("builds correct agy execution arguments", () => {
		const args = buildAgyArgs({
			prompt: "Hello",
			model: "gemini-3.8-flash-high",
		});
		assert.deepEqual(args, [
			"--print",
			"Hello",
			"--model",
			"gemini-3.8-flash-high",
			"--output-format",
			"stream-json",
			"--dangerously-skip-permissions",
		]);
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

	it("parses agy final usage metrics", () => {
		const line = JSON.stringify({
			event: "result",
			result: {
				status: "SUCCESS",
				usage: {
					input_tokens: 120,
					output_tokens: 45,
					thinking_tokens: 30,
					total_tokens: 165,
				},
			},
		});
		const parsed = parseAgyNdjsonLine(line);
		assert.equal(parsed?.type, "result");
		assert.equal(parsed?.usage?.input_tokens, 120);
		assert.equal(parsed?.usage?.output_tokens, 45);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/antigravity-runner.test.ts`
Expected: FAIL with "Cannot find module '../src/server/antigravity/runner.ts'"

**Step 3: Implement minimal runner**

```typescript
// src/server/antigravity/runner.ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface AgyRunOptions {
	prompt: string;
	model?: string;
	effort?: "low" | "medium" | "high" | "max";
	abortSignal?: AbortSignal;
	cwd?: string;
}

export type AgyStreamEvent =
	| { type: "text_delta"; text: string }
	| { type: "result"; status: string; usage?: { input_tokens: number; output_tokens: number; thinking_tokens?: number; total_tokens: number } }
	| { type: "error"; message: string };

export function buildAgyArgs(opts: AgyRunOptions): string[] {
	const args = [
		"--print",
		opts.prompt,
	];
	if (opts.model) {
		args.push("--model", opts.model);
	}
	if (opts.effort) {
		args.push("--effort", opts.effort);
	}
	args.push(
		"--output-format",
		"stream-json",
		"--dangerously-skip-permissions",
	);
	return args;
}

export function parseAgyNdjsonLine(line: string): AgyStreamEvent | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const data = JSON.parse(trimmed);
		if (data.event === "step_update" && data.step_update?.step_type === "agent_response" && typeof data.step_update.text_delta === "string") {
			return { type: "text_delta", text: data.step_update.text_delta };
		}
		if (data.event === "result" && data.result) {
			return {
				type: "result",
				status: data.result.status,
				usage: data.result.usage,
			};
		}
		return null;
	} catch {
		return null;
	}
}

export async function* runAgyStream(opts: AgyRunOptions): AsyncGenerator<AgyStreamEvent, void, unknown> {
	const agyBinary = process.env.AGY_PATH || "/Users/lorenzo/.local/bin/agy";
	const child = spawn(agyBinary, buildAgyArgs(opts), {
		cwd: opts.cwd || process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});

	if (opts.abortSignal) {
		opts.abortSignal.addEventListener("abort", () => {
			child.kill("SIGTERM");
		}, { once: true });
	}

	const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

	for await (const line of rl) {
		const ev = parseAgyNdjsonLine(line);
		if (ev) yield ev;
	}
}
```

**Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/antigravity-runner.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/antigravity/runner.ts tests/antigravity-runner.test.ts
git commit -m "feat(antigravity): add agy subprocess stream runner"
```

---

### Task 2: Structured Tool Parser & Turn Stream Bridge

**Files:**
- Create: `src/server/antigravity/stream-bridge.ts`
- Test: `tests/antigravity-stream-bridge.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractStructuredTools } from "../src/server/antigravity/stream-bridge.ts";

describe("Antigravity Stream Bridge", () => {
	it("detects and extracts quiz block from text", () => {
		const text = "Here is the explanation.\n\n:::quiz\n{\"question\":\"What is DNA?\",\"options\":[\"A\",\"B\"],\"answer\":0,\"explanation\":\"Gene molecule\"}\n:::\nMore text";
		const res = extractStructuredTools(text);
		assert.equal(res.cleanText.trim(), "Here is the explanation.");
		assert.equal(res.tools.length, 1);
		assert.equal(res.tools[0].name, "quiz");
		assert.equal(res.tools[0].args.question, "What is DNA?");
	});

	it("detects plan_init tool block", () => {
		const text = "Let's plan our curriculum:\n\n:::plan_init\n{\"root\":\"Biology\",\"nodes\":[{\"id\":\"cell\",\"title\":\"The Cell\"}]}\n:::\n";
		const res = extractStructuredTools(text);
		assert.equal(res.tools[0].name, "plan_init");
		assert.equal(res.tools[0].args.root, "Biology");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/antigravity-stream-bridge.test.ts`
Expected: FAIL with "Cannot find module '../src/server/antigravity/stream-bridge.ts'"

**Step 3: Implement stream bridge and tool extractor**

```typescript
// src/server/antigravity/stream-bridge.ts
export interface DetectedToolCall {
	name: "quiz" | "ask_user_question" | "plan_init" | "plan_update" | "probe_done" | "spawn_research" | "spawn_demo" | "spawn_visual";
	args: any;
	raw: string;
}

export function extractStructuredTools(rawText: string): { cleanText: string; tools: DetectedToolCall[] } {
	const toolRegex = /:::(quiz|ask_user_question|plan_init|plan_update|probe_done|spawn_research|spawn_demo|spawn_visual)\s*([\s\S]*?):::/g;
	const tools: DetectedToolCall[] = [];
	let cleanText = rawText;

	let match: RegExpExecArray | null;
	while ((match = toolRegex.exec(rawText)) !== null) {
		const toolName = match[1] as DetectedToolCall["name"];
		const body = match[2].trim();
		try {
			const parsed = body ? JSON.parse(body) : {};
			tools.push({ name: toolName, args: parsed, raw: match[0] });
		} catch (err) {
			// Malformed tool json ignored
		}
	}

	cleanText = rawText.replace(toolRegex, "").trim();
	return { cleanText, tools };
}
```

**Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/antigravity-stream-bridge.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/antigravity/stream-bridge.ts tests/antigravity-stream-bridge.test.ts
git commit -m "feat(antigravity): add structured tool parser for agy output"
```

---

### Task 3: Antigravity Model Catalog & Engine Definitions

**Files:**
- Modify: `src/agent/models.ts`
- Modify: `src/server/model-catalog.ts`
- Modify: `config.ts`
- Test: `tests/antigravity-models.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ANTIGRAVITY_MODELS, getDefaultModel } from "../src/agent/models.ts";

describe("Antigravity Models", () => {
	it("includes Gemini 3.8 Flash High as default", () => {
		const def = getDefaultModel();
		assert.equal(def.id, "gemini-3.8-flash-high");
		assert.equal(def.provider, "antigravity");
	});

	it("lists all available agy models", () => {
		const ids = ANTIGRAVITY_MODELS.map((m) => m.id);
		assert.ok(ids.includes("gemini-3.8-flash-high"));
		assert.ok(ids.includes("claude-sonnet-4-6"));
		assert.ok(ids.includes("claude-opus-4-6-thinking"));
		assert.ok(ids.includes("gpt-oss-120b-medium"));
	});
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/antigravity-models.test.ts`
Expected: FAIL

**Step 3: Update `src/agent/models.ts` and `src/server/model-catalog.ts`**

Update `src/agent/models.ts`:
- Define `ANTIGRAVITY_MODELS`:
  - `gemini-3.8-flash-high` ("Gemini 3.8 Flash High", default)
  - `gemini-3.8-flash-medium` ("Gemini 3.8 Flash Medium")
  - `gemini-3.8-flash-low` ("Gemini 3.8 Flash Low")
  - `claude-sonnet-4-6` ("Claude Sonnet 4.6")
  - `claude-opus-4-6-thinking` ("Claude Opus 4.6 Thinking")
  - `gpt-oss-120b-medium` ("GPT-OSS 120B Medium")
- Replace `piModels` with `antigravityModels`.

**Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/antigravity-models.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/models.ts src/server/model-catalog.ts tests/antigravity-models.test.ts
git commit -m "feat(models): map catalog to native Antigravity CLI models"
```

---

### Task 4: Adapt Teacher & Prober System Prompts with Tool Directives

**Files:**
- Modify: `src/agent/prompts/shared/01-tools.md`
- Modify: `src/agent/teacher-agent.ts`
- Test: `tests/prompt-overrides.test.ts`

**Step 1: Write test for structured tool directives in composed prompt**

```typescript
// Add test in tests/prompt-overrides.test.ts
it("composes prompt instructing :::quiz structured block format for agy", () => {
	const prompt = composeInstructions("teacher");
	assert.ok(prompt.includes(":::quiz"));
	assert.ok(prompt.includes(":::plan_init"));
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/prompt-overrides.test.ts`
Expected: FAIL

**Step 3: Update prompt fragment**

Update `src/agent/prompts/shared/01-tools.md` to instruct `agy` to output tool calls wrapped in `:::tool_name\n{ ... }\n:::` format when posing questions or initializing plans.

**Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/prompt-overrides.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/prompts/shared/01-tools.md tests/prompt-overrides.test.ts
git commit -m "docs(prompts): document structured block tool format for Antigravity"
```

---

### Task 5: Refactor Chat Turn Execution in `chat-handler.ts`

**Files:**
- Modify: `src/server/chat-handler.ts`
- Modify: `src/server/pi/ui-stream.ts` (migrate to `src/server/antigravity/ui-stream.ts`)
- Test: `tests/chat-flow.test.ts`

**Step 1: Verify current `tests/chat-flow.test.ts`**

Run: `npx tsx --test tests/chat-flow.test.ts`

**Step 2: Wire `runAgyStream` and `extractStructuredTools` in `chat-handler.ts`**

- In `handleChatRequest`:
  - Format the chat messages as conversational history for `agy`.
  - Pass the composed system prompt.
  - Stream `agy`'s output into the response SSE stream.
  - When `:::quiz` or `:::ask_user_question` is detected, save question to record and complete the turn.
  - On finish, persist turn usage metrics and trigger background extraction.

**Step 3: Run `tests/chat-flow.test.ts` and verify passes**

Run: `npx tsx --test tests/chat-flow.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/server/chat-handler.ts src/server/antigravity/ tests/chat-flow.test.ts
git commit -m "refactor(server): drive chat turn pipeline via Antigravity runner"
```

---

### Task 6: Subagents Refactor (Extraction, Researcher, Demos)

**Files:**
- Modify: `src/agent/subagents/pi-run.ts` -> `src/agent/subagents/antigravity-run.ts`
- Modify: `src/agent/subagents/extraction.ts`
- Modify: `src/agent/subagents/researcher.ts`
- Modify: `src/agent/subagents/demo-builder.ts`
- Modify: `src/agent/subagents/visual-maker.ts`
- Test: `tests/extraction.test.ts`

**Step 1: Write/Update unit test for subagent execution**

Run: `npx tsx --test tests/extraction.test.ts`

**Step 2: Refactor runner to invoke `agy`**

- `runAntigravitySubagent(opts)` invokes `runAgyStream` with role-specific prompt and captures result.
- For `researcher`, leverage Antigravity CLI's native web search capability instead of requiring external Tavily/Brave API keys.

**Step 3: Run tests and verify**

Run: `npx tsx --test tests/extraction.test.ts tests/jobs.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/agent/subagents/ tests/extraction.test.ts
git commit -m "refactor(subagents): execute background jobs through Antigravity CLI"
```

---

### Task 7: Replace Settings Keys & Setup Dialog with Antigravity Status Panel

**Files:**
- Create: `components/settings/antigravity-status.tsx`
- Modify: `components/settings/keys-section.tsx`
- Modify: `components/setup-dialog.tsx`
- Modify: `app/api/keys/route.ts`
- Test: `tests/render-stats-bar.test.tsx`

**Step 1: Implement Antigravity Status Card**

Create `components/settings/antigravity-status.tsx`:
- Shows Antigravity CLI binary detected (`/Users/lorenzo/.local/bin/agy`).
- Shows connection status: "Connected via local session".
- Allows setting default model (`gemini-3.8-flash-high`, etc.).
- Replaces provider API key form.

**Step 2: Update `components/setup-dialog.tsx`**

- Remove "Enter OpenRouter API Key" blocking step.
- Verify Antigravity CLI presence on startup; if present, dismiss dialog immediately.

**Step 3: Run UI tests**

Run: `npx tsx --test tests/render-stats-bar.test.tsx`
Expected: PASS

**Step 4: Commit**

```bash
git add components/settings/ components/setup-dialog.tsx app/api/keys/route.ts
git commit -m "feat(ui): replace API key configuration with Antigravity CLI status card"
```

---

### Task 8: Prune `@earendil-works/pi-*` Dependencies and Final Gate Check

**Files:**
- Modify: `package.json`
- Remove: references to `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`
- Test: Full test suite, lint, and typecheck

**Step 1: Remove dependencies from `package.json`**

Remove:
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`

**Step 2: Run npm install**

Run: `npm install`
Expected: Clean removal of pi packages.

**Step 3: Run full verification suite**

Run: `npm run typecheck`
Expected: PASS (0 errors)

Run: `npm run lint`
Expected: PASS (0 lint warnings/errors)

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): remove pi.dev packages and finalize Antigravity migration"
```

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-10-24-antigravity-migration.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagents per task, review between tasks, fast iteration.

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints.

**Which approach?**
