import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ANTIGRAVITY_MODELS, piEngineForSpec } from "../src/agent/models.ts";
import { modelCatalog, validateChatSettings, validateModelsSettings } from "../src/server/model-catalog.ts";
import { callCost } from "../src/core/prices.ts";

describe("native Antigravity catalog & legacy provider boundary (offline)", { concurrency: false }, () => {
	it("catalog lists native Antigravity models with zero cost and valid settings", () => {
		const catalog = modelCatalog();
		assert.ok(catalog.models.length > 0, "must list Antigravity models");
		for (const model of catalog.models) {
			assert.equal(model.provider, "antigravity");
			assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			assert.ok(model.input.includes("text"));
			assert.deepEqual(validateChatSettings({ model: { provider: model.provider, id: model.id } }), { ok: true });
			assert.deepEqual(
				validateModelsSettings({
					strong: { model: { provider: model.provider, id: model.id } },
					cheap: { model: { provider: model.provider, id: model.id } },
				}),
				{ ok: true },
			);
		}
	});

	it("legacy third-party providers (e.g. openrouter) are not in the model catalog", () => {
		const catalog = modelCatalog();
		assert.ok(!catalog.models.some((m) => m.provider === "openrouter"), "openrouter models must not be listed");
	});

	it("engine resolution succeeds for valid Antigravity models", () => {
		const first = ANTIGRAVITY_MODELS[0];
		assert.ok(first);
		const defaultSpec = { provider: "antigravity", id: first.id };
		const engine = piEngineForSpec(defaultSpec);
		assert.equal(engine.model.id, first.id);
		assert.equal(engine.model.provider, "antigravity");
	});

	it("removed/unknown native models remain unpriced and unresolvable, never aliased to a paid fallback", () => {
		assert.equal(callCost({ inputTokens: 1, outputTokens: 1 }, "openrouter:removed/no-such-model"), null);
		assert.throws(() => piEngineForSpec({ provider: "openrouter", id: "removed/no-such-model" }), /catalog has no model/);
	});
});
