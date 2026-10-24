import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	catalogDefaultsFor,
	catalogProviders,
	catalogRolePins,
	catalogSlots,
	clampChatLevel,
	clampModelsLevels,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	modelCatalog,
	rolePinsFor,
	toModelDto,
	validateChatSettings,
	validateModelsSettings,
} from "../src/server/model-catalog.ts";
import type { EffectiveSlot } from "../src/core/settings-resolution.ts";
import type { SettingsValidation } from "../src/server/model-catalog.ts";
import { DEFAULT_THINKING_ORDER } from "../src/core/settings.ts";
import { piEngineForSpec, piModels, ANTIGRAVITY_MODELS, getDefaultModel } from "../src/agent/models.ts";
import { BACKGROUND_MODEL_ROLES } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { readSettings } from "../src/store/settings.ts";
import { effectiveSettings } from "../src/server/stores.ts";

/** Native default model specimen. */
function defaultModel() {
	const model = piModels().getModel("antigravity", "gemini-3.8-flash-high");
	assert.ok(model, "gemini-3.8-flash-high in catalog");
	return model!;
}

/** Another reasoning specimen from Antigravity catalog. */
function sonnetModel() {
	const model = piModels().getModel("antigravity", "claude-sonnet-4-6");
	assert.ok(model, "claude-sonnet-4-6 in catalog");
	return model!;
}

describe("the model catalog projection", () => {
	it("serves the native Antigravity catalog with the picker's DTO shape", () => {
		const { models, defaults, providers, slots } = modelCatalog();
		assert.equal(models.length, 6);
		for (const m of models) {
			assert.equal(typeof m.id, "string");
			assert.equal(typeof m.name, "string");
			assert.equal(m.provider, "antigravity");
			assert.ok(Array.isArray(m.supportedLevels));
			assert.ok(typeof m.cost.input === "number" && typeof m.cost.output === "number");
			assert.ok(m.contextWindow > 0);
			assert.ok(m.maxTokens > 0);
		}
		const gemini = models.find((m) => m.id === "gemini-3.8-flash-high");
		assert.ok(gemini, "gemini-3.8-flash-high in catalog");
		assert.deepEqual(gemini!.supportedLevels, ["low", "medium", "high", "xhigh", "max"]);
		assert.deepEqual(gemini!.input, ["text", "image"]);
		assert.deepEqual(gemini!.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		const gptOss = models.find((m) => m.id === "gpt-oss-120b-medium");
		assert.ok(gptOss, "gpt-oss-120b-medium in catalog");
		assert.deepEqual(gptOss!.input, ["text"]);

		const agyProvider = providers.find((p) => p.id === "antigravity");
		assert.ok(agyProvider && agyProvider.keyPresent, "antigravity provider present");
		assert.deepEqual(Object.keys(slots), ["strong", "cheap", "vision"]);

		const record = readSettings();
		const strong = effectiveSettings().models.strong;
		if (strong) {
			assert.ok(defaults, "a configured strong slot yields a default");
			assert.deepEqual(defaults!.model, { provider: strong.provider, id: strong.id });
		} else {
			assert.equal(defaults, null);
		}
		for (const name of ["strong", "cheap", "vision"] as const) {
			const stored = record?.models?.[name];
			if (stored?.model) {
				assert.ok(slots[name], name);
				assert.deepEqual(slots[name]!.model, stored.model);
			} else {
				assert.equal(slots[name], null, name);
			}
		}
	});

	it("defaults: the strong slot verbatim; null when unset (BYOK, per-session models 2026-09-28)", () => {
		assert.equal(catalogDefaultsFor(null), null);
		const strong = { provider: "antigravity", id: "gemini-3.8-flash-high", thinkingLevel: "low" as const };
		const d = catalogDefaultsFor(strong);
		assert.deepEqual(d, { model: { provider: "antigravity", id: "gemini-3.8-flash-high" }, thinkingLevel: "low" });
		const bare = catalogDefaultsFor({ provider: "antigravity", id: "claude-sonnet-4-6" });
		assert.deepEqual(bare, { model: { provider: "antigravity", id: "claude-sonnet-4-6" } });
	});

	it("toModelDto projects the raw catalog model verbatim", () => {
		const raw = defaultModel();
		const dto = toModelDto(raw);
		assert.equal(dto.id, raw.id);
		assert.equal(dto.name, raw.name);
		assert.deepEqual(dto.supportedLevels, getSupportedThinkingLevels(raw));
		assert.equal(dto.cost.input, raw.cost.input);
		assert.equal(dto.contextWindow, raw.contextWindow);
	});
});

describe("the background roles' resolved pins (rolePins)", () => {
	it("no record → every role is NULL (BYOK: no phantom defaults)", () => {
		const pins = rolePinsFor(resolveSettings(null).agent.models);
		assert.deepEqual(Object.keys(pins), [...BACKGROUND_MODEL_ROLES]);
		for (const role of BACKGROUND_MODEL_ROLES) {
			assert.equal(pins[role], null, role);
		}
	});

	it("a slot re-tiers its roles; overrides win for that role only", () => {
		const record = {
			version: 1,
			models: { cheap: { model: { provider: "antigravity", id: "gemini-3.8-flash-low" } } },
			agent: { models: { researcher: { model: { provider: "antigravity", id: "gemini-3.8-flash-high" }, thinkingLevel: "high" as const } } },
		};
		const pins = rolePinsFor(resolveSettings(record).agent.models);
		assert.deepEqual(pins.researcher, { model: { provider: "antigravity", id: "gemini-3.8-flash-high" }, thinkingLevel: "high" });
		assert.deepEqual(pins.auditor, { model: { provider: "antigravity", id: "gemini-3.8-flash-low" } });
		assert.equal(pins.visualMaker, null, "vision tier untouched");
	});

	it("catalogRolePins matches the same resolution the engine wiring uses", () => {
		const pins = catalogRolePins();
		for (const role of BACKGROUND_MODEL_ROLES) {
			assert.ok(pins[role] === null || typeof pins[role]!.model.id === "string");
		}
	});
});

describe("the model slots surface (model slots wave, 2026-09-20)", () => {
	it("catalogSlots projects the record's tiers — NULL only where a tier holds no model", () => {
		const record = readSettings();
		const slots = catalogSlots();
		for (const name of ["strong", "cheap", "vision"] as const) {
			const stored = record?.models?.[name];
			if (stored?.model) {
				assert.ok(slots[name], name);
				assert.deepEqual(slots[name]!.model, stored.model);
			} else {
				assert.equal(slots[name], null, name);
			}
		}
	});

	it("catalogProviders reads keys env-wins, fresh per call", () => {
		const before = catalogProviders().find((p) => p.id === "zai");
		assert.equal(before?.keyPresent, false);
		const saved = process.env.ZAI_API_KEY;
		process.env.ZAI_API_KEY = "test-zai-key-1234567890";
		try {
			assert.equal(catalogProviders().find((p) => p.id === "zai")?.keyPresent, true);
		} finally {
			if (saved === undefined) delete process.env.ZAI_API_KEY;
			else process.env.ZAI_API_KEY = saved;
		}
	});
});

describe("the models-section validation gate", () => {
	it("accepts a valid slot and rejects unknown provider/model", () => {
		assert.equal(
			validateModelsSettings({ strong: { model: { provider: "antigravity", id: "gemini-3.8-flash-high" } } }).ok,
			true,
		);
		assert.equal(
			validateModelsSettings({ cheap: { model: { provider: "nope", id: "x" } } }).ok,
			false,
		);
		assert.equal(
			validateModelsSettings({ vision: { model: { provider: "antigravity", id: "nope/nope" } } }).ok,
			false,
		);
	});

	it("thinking levels never reject a slot write (owner, interlude 2026-09-22)", () => {
		assert.deepEqual(
			validateModelsSettings({ strong: { model: { provider: "antigravity", id: "gemini-3.8-flash-high" }, thinkingLevel: "minimal" } }),
			{ ok: true },
		);
		assert.deepEqual(
			validateModelsSettings({ strong: { model: { provider: "antigravity", id: "gemini-3.8-flash-high" }, thinkingLevel: "xhigh" } }),
			{ ok: true },
		);
	});

	it("clampModelsLevels: the slot's own model translates the pin", () => {
		const gemini = { model: { provider: "antigravity", id: "gemini-3.8-flash-high" }, thinkingLevel: "xhigh" as const };
		assert.deepEqual(clampModelsLevels({ strong: gemini }), {
			strong: { model: { provider: "antigravity", id: "gemini-3.8-flash-high" }, thinkingLevel: "xhigh" },
		});
		assert.deepEqual(clampModelsLevels({ strong: { ...gemini, thinkingLevel: "minimal" as const } }).strong, {
			model: { provider: "antigravity", id: "gemini-3.8-flash-high" },
			thinkingLevel: "low",
		});
		assert.equal(
			clampModelsLevels({ strong: { ...gemini, thinkingLevel: "off" as const } }).strong?.thinkingLevel,
			"low",
		);
		assert.deepEqual(clampModelsLevels({ strong: { ...gemini, thinkingLevel: "high" as const } }).strong, {
			model: { provider: "antigravity", id: "gemini-3.8-flash-high" },
			thinkingLevel: "high",
		});
		assert.deepEqual(clampModelsLevels({ strong: { model: gemini.model } }), {
			strong: { model: { provider: "antigravity", id: "gemini-3.8-flash-high" } },
		});
	});

	it("accepts empty settings (the clear-slots write)", () => {
		assert.deepEqual(validateModelsSettings({}), { ok: true });
	});
});

describe("the settings validation gate", () => {
	it("thinking levels never reject a chat write (owner, interlude 2026-09-22)", () => {
		assert.deepEqual(
			validateChatSettings({ model: { provider: "antigravity", id: "gemini-3.8-flash-high" }, thinkingLevel: "minimal" }),
			{ ok: true },
		);
		assert.deepEqual(validateChatSettings({ thinkingLevel: "xhigh" }), { ok: true });
	});

	it("clampChatLevel: the body's model, else the strong slot, translates the pin", () => {
		const gemini = { provider: "antigravity", id: "gemini-3.8-flash-high" };
		const strong: EffectiveSlot = { provider: "antigravity", id: "gemini-3.8-flash-high" };
		assert.deepEqual(
			clampChatLevel({ model: { provider: "antigravity", id: "claude-sonnet-4-6" }, thinkingLevel: "minimal" as const }, strong),
			{ model: { provider: "antigravity", id: "claude-sonnet-4-6" }, thinkingLevel: "low" },
		);
		assert.equal(clampChatLevel({ thinkingLevel: "minimal" as const }, strong).thinkingLevel, "low");
		assert.deepEqual(clampChatLevel({ thinkingLevel: "minimal" as const }, null), { thinkingLevel: "minimal" });
		assert.deepEqual(clampChatLevel({ model: { ...gemini } }, strong), { model: { ...gemini } });
	});

	it("rejects unknown providers and models", () => {
		assert.equal(validateChatSettings({ model: { provider: "nope", id: "x/y" } }).ok, false);
		assert.equal(validateChatSettings({ model: { provider: "antigravity", id: "nope/nope" } }).ok, false);
	});

	it("accepts empty settings (the clear-overrides write)", () => {
		assert.deepEqual(validateChatSettings({}), { ok: true });
	});
});

describe("antigravity thinking truth", () => {
	it("gemini-3.8-flash-high: low|medium|high|xhigh|max; anything else clamps to the nearest", () => {
		const gemini = defaultModel();
		assert.deepEqual(getSupportedThinkingLevels(gemini), ["low", "medium", "high", "xhigh", "max"]);
		assert.equal(clampThinkingLevel(gemini, "minimal"), "low");
		assert.equal(clampThinkingLevel(gemini, "off"), "low");
		assert.equal(clampThinkingLevel(gemini, "xhigh"), "xhigh");
		assert.equal(clampThinkingLevel(gemini, "high"), "high");
		assert.equal(clampThinkingLevel(gemini, "max"), "max");
	});

	it("the engine factory clamps explicit levels; unknown models throw honestly", () => {
		const over = piEngineForSpec({ provider: "antigravity", id: "claude-sonnet-4-6", thinkingLevel: "high" });
		assert.equal(over.model.id, "claude-sonnet-4-6");
		assert.equal(over.level, "high");
		const clamped = piEngineForSpec({ provider: "antigravity", id: "gemini-3.8-flash-high", thinkingLevel: "minimal" });
		assert.equal(clamped.level, "low");
		assert.throws(() => piEngineForSpec({ provider: "antigravity", id: "nope/nope", thinkingLevel: "low" }), /catalog has no model/);
	});

	it("UNSET levels resolve from the baked DEFAULT_THINKING_ORDER", () => {
		assert.deepEqual([...DEFAULT_THINKING_ORDER], ["medium", "low", "high", "minimal", "xhigh", "max"]);
		const gemini = piEngineForSpec({ provider: "antigravity", id: "gemini-3.8-flash-high" });
		assert.equal(gemini.level, "medium");
		assert.equal(piEngineForSpec({ provider: "antigravity", id: "gemini-3.8-flash-high", thinkingLevel: "max" }).level, "max");
		const flat = { reasoning: false, id: "test-flat", provider: "antigravity" as const };
		assert.deepEqual(getSupportedThinkingLevels(flat), ["off"]);
		assert.equal(clampThinkingLevel(flat, "high"), "off");
	});

	it("the legacy piEngineFor role entry point throws honestly", async () => {
		const { piEngineFor } = await import("../src/agent/models.ts");
		assert.throws(() => piEngineFor("prober"), /no configured model for role "prober"/);
	});
});

