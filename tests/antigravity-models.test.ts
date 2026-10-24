import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ANTIGRAVITY_MODELS,
	antigravityEngineFor,
	antigravityEngineForSpec,
	antigravityModels,
	clampThinkingLevel,
	defaultThinkingLevel,
	getDefaultModel,
	getSupportedThinkingLevels,
	piEngineFor,
	piEngineForSpec,
	piModels,
	type AntigravityEngine,
	type AntigravityModel,
} from "../src/agent/models.ts";

describe("Antigravity Models Catalog", () => {
	it("includes Gemini 3.8 Flash High as default", () => {
		const def = getDefaultModel();
		assert.equal(def.id, "gemini-3.8-flash-high");
		assert.equal(def.name, "Gemini 3.8 Flash High");
		assert.equal(def.provider, "antigravity");
		assert.equal(def.reasoning, true);
		assert.deepEqual(def.input, ["text", "image"]);
	});

	it("lists all required Antigravity models with correct metadata", () => {
		const ids = ANTIGRAVITY_MODELS.map((m) => m.id);
		assert.deepEqual(ids, [
			"gemini-3.8-flash-high",
			"gemini-3.8-flash-medium",
			"gemini-3.8-flash-low",
			"claude-sonnet-4-6",
			"claude-opus-4-6-thinking",
			"gpt-oss-120b-medium",
		]);

		for (const model of ANTIGRAVITY_MODELS) {
			assert.equal(model.provider, "antigravity");
			assert.equal(model.reasoning, true);
			assert.ok(model.contextWindow > 0);
			assert.ok(model.maxTokens > 0);
			assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}

		const gptOss = ANTIGRAVITY_MODELS.find((m) => m.id === "gpt-oss-120b-medium");
		assert.ok(gptOss);
		assert.equal(gptOss.name, "GPT-OSS 120B Medium");
		assert.deepEqual(gptOss.input, ["text"]);

		const sonnet = ANTIGRAVITY_MODELS.find((m) => m.id === "claude-sonnet-4-6");
		assert.ok(sonnet);
		assert.equal(sonnet.name, "Claude Sonnet 4.6");
		assert.deepEqual(sonnet.input, ["text", "image"]);

		const opus = ANTIGRAVITY_MODELS.find((m) => m.id === "claude-opus-4-6-thinking");
		assert.ok(opus);
		assert.equal(opus.name, "Claude Opus 4.6 Thinking");
		assert.deepEqual(opus.input, ["text", "image"]);

		const flashMed = ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-3.8-flash-medium");
		assert.ok(flashMed);
		assert.equal(flashMed.name, "Gemini 3.8 Flash Medium");
		assert.deepEqual(flashMed.input, ["text", "image"]);

		const flashLow = ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-3.8-flash-low");
		assert.ok(flashLow);
		assert.equal(flashLow.name, "Gemini 3.8 Flash Low");
		assert.deepEqual(flashLow.input, ["text", "image"]);
	});

	it("resolves models via antigravityModels and piModels collections", () => {
		const collection = antigravityModels();
		assert.equal(collection.getModel("antigravity", "gemini-3.8-flash-high")?.name, "Gemini 3.8 Flash High");
		assert.equal(collection.getModel("openrouter", "gemini-3.8-flash-high"), undefined);
		assert.equal(collection.getModels("antigravity").length, 6);
		assert.equal(collection.getModels("unknown").length, 0);
		assert.deepEqual(collection.getProviders(), [{ id: "antigravity", name: "Antigravity" }]);

		// piModels alias test
		assert.equal(piModels().getModel("antigravity", "claude-sonnet-4-6")?.name, "Claude Sonnet 4.6");
	});

	it("computes supported thinking levels and clamps appropriately", () => {
		const flashHigh = getDefaultModel();
		const levels = getSupportedThinkingLevels(flashHigh);
		assert.deepEqual(levels, ["low", "medium", "high", "xhigh", "max"]);

		assert.equal(clampThinkingLevel(flashHigh, "minimal"), "low");
		assert.equal(clampThinkingLevel(flashHigh, "off"), "low");
		assert.equal(clampThinkingLevel(flashHigh, "low"), "low");
		assert.equal(clampThinkingLevel(flashHigh, "medium"), "medium");
		assert.equal(clampThinkingLevel(flashHigh, "high"), "high");
		assert.equal(clampThinkingLevel(flashHigh, "xhigh"), "xhigh");
		assert.equal(clampThinkingLevel(flashHigh, "max"), "max");

		// Non-reasoning model clamp behavior
		const nonReasoning = { reasoning: false };
		assert.deepEqual(getSupportedThinkingLevels(nonReasoning), ["off"]);
		assert.equal(clampThinkingLevel(nonReasoning, "high"), "off");
	});

	it("resolves default thinking level from baked DEFAULT_THINKING_ORDER", () => {
		const flashHigh = getDefaultModel();
		assert.equal(defaultThinkingLevel(flashHigh), "medium");

		const nonReasoning = { reasoning: false };
		assert.equal(defaultThinkingLevel(nonReasoning), "off");
	});

	it("creates engine with antigravityEngineForSpec and piEngineForSpec alias", () => {
		const engine1: AntigravityEngine = antigravityEngineForSpec({
			provider: "antigravity",
			id: "gemini-3.8-flash-high",
		});
		assert.equal(engine1.model.id, "gemini-3.8-flash-high");
		assert.equal(engine1.level, "medium");
		assert.equal(typeof engine1.streamFn, "function");

		const engine2 = piEngineForSpec({
			provider: "antigravity",
			id: "claude-sonnet-4-6",
			thinkingLevel: "high",
		});
		assert.equal(engine2.model.id, "claude-sonnet-4-6");
		assert.equal(engine2.level, "high");

		// Clamping out-of-range thinking level
		const clampedEngine = piEngineForSpec({
			provider: "antigravity",
			id: "gemini-3.8-flash-low",
			thinkingLevel: "minimal",
		});
		assert.equal(clampedEngine.level, "low");

		// Throws on unknown model
		assert.throws(
			() => antigravityEngineForSpec({ provider: "antigravity", id: "non-existent" }),
			/catalog has no model non-existent/,
		);
	});

	it("throws on legacy role entry points", () => {
		assert.throws(
			() => antigravityEngineFor("prober"),
			/no configured model for role "prober"/,
		);
		assert.throws(
			() => piEngineFor("teacher"),
			/no configured model for role "teacher"/,
		);
	});
});
