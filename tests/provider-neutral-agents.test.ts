/**
 * RETIRED (Antigravity Migration):
 *
 * Provider-neutral raw agent loops previously tested pi-ai SDK HTTP transport
 * serialization across 8 external providers (opencode, openrouter, openai,
 * anthropic, google).
 *
 * Under the Google Antigravity CLI migration, all agent loops and subagents
 * (visual-maker, pdf-reader, researcher, demo-builder, runner) are powered
 * by local `agy` sessions via `runAntigravitySubagent`, eliminating external
 * HTTP provider endpoints and API key transports.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ANTIGRAVITY_MODELS, getDefaultModel, piEngineForSpec } from "../src/agent/models.ts";
import { detectAntigravity } from "../app/api/keys/route.ts";

describe("provider-neutral multi-provider HTTP transports (RETIRED under Antigravity migration)", () => {
	it("external provider HTTP transports are retired — Antigravity is the unified engine", () => {
		const defaultModel = getDefaultModel();
		assert.equal(defaultModel.provider, "antigravity");
		assert.ok(ANTIGRAVITY_MODELS.length > 0);
	});

	it("engine resolution targets Antigravity native models without external API keys", () => {
		const engine = piEngineForSpec({ provider: "antigravity", id: "gemini-3.8-flash-high" });
		assert.equal(engine.model.provider, "antigravity");
		assert.equal(engine.model.id, "gemini-3.8-flash-high");
	});

	it("Antigravity runner availability check is operational", () => {
		const status = detectAntigravity();
		assert.equal(typeof status.detected, "boolean");
		assert.ok(["connected", "not_found"].includes(status.status));
	});
});
