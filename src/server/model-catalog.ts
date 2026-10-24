/**
 * The model catalog's server surface (native Antigravity CLI models).
 * Projects native Antigravity models to client-safe DTOs for the picker (GET
 * /api/models), plus validation gate for settings writes (PUT /api/settings/*).
 */

import {
	ANTIGRAVITY_MODELS,
	antigravityModels,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type AntigravityModel,
} from "../agent/models.ts";
import { effectiveSettings } from "./stores.ts";
import { keyValue } from "./keys.ts";
import type { ChatSettings } from "../core/contracts/chat.ts";
import type { ThinkingLevel } from "../core/contracts/messages.ts";
import type {
	CatalogDefaults,
	CatalogProvider,
	ModelCatalogEntry,
	ModelCatalogResponse,
	RolePins,
	SlotPins,
} from "../core/contracts/models.ts";
import type { EffectiveModelSpec, EffectiveSlot } from "../core/settings-resolution.ts";
import { AUTH_PROVIDER_KEYS } from "../core/auth-keys.ts";
import {
	BACKGROUND_MODEL_ROLES,
	MODEL_SLOTS,
	type BackgroundModelRole,
	type ModelSlotName,
	type ModelsSettings,
} from "../core/settings.ts";

export { clampThinkingLevel, getSupportedThinkingLevels };

/** The picker's client-safe model entry (contract: core/contracts/models.ts). */
export type ModelDto = ModelCatalogEntry;

/**
 * The conversation agents' resolved default (pure form — the strong slot
 * in, CatalogDefaults out; `catalogDefaults()` below is the fs wrapper).
 */
export function catalogDefaultsFor(
	strong: EffectiveSlot | null,
): CatalogDefaults | null {
	const model = strong ? { provider: strong.provider, id: strong.id } : undefined;
	if (!model) return null;
	const level = strong?.thinkingLevel;
	return {
		model,
		...(level !== undefined ? { thinkingLevel: level } : {}),
	};
}

/** The conversation agents' resolved default — what a settings-less chat
 *  runs: the strong slot, i.e. the birth-default for new sessions. */
export function catalogDefaults(): CatalogDefaults | null {
	return catalogDefaultsFor(effectiveSettings().models.strong);
}

/** Project the resolved per-role specs to the client DTO (pure — the
 *  settings UI's "Default: <actual pinned model>" caption reads this). */
export function rolePinsFor(
	models: Record<BackgroundModelRole, EffectiveModelSpec | undefined>,
): RolePins {
	const pins = {} as RolePins;
	for (const role of BACKGROUND_MODEL_ROLES) {
		const spec = models[role];
		pins[role] = spec
			? {
					model: { provider: spec.provider, id: spec.id },
					...(spec.thinkingLevel !== undefined ? { thinkingLevel: spec.thinkingLevel } : {}),
				}
			: null;
	}
	return pins;
}

/** The background roles' RESOLVED pins: the user's agent-models
 *  override → tier slot → nothing — the same resolution the agent wiring
 *  uses (src/server/stores.ts effectiveSettings). */
export function catalogRolePins(): RolePins {
	return rolePinsFor(effectiveSettings().agent.models);
}

/** The three slot tiers' RESOLVED pins — effectiveSettings().models
 *  verbatim. NULL per tier that holds no model. */
export function catalogSlots(): SlotPins {
	const slots = effectiveSettings().models;
	const pins = {} as SlotPins;
	for (const name of ["strong", "cheap", "vision"] as const) {
		const slot: EffectiveSlot | null = slots[name];
		pins[name] = slot
			? {
					model: { provider: slot.provider, id: slot.id },
					...(slot.thinkingLevel !== undefined ? { thinkingLevel: slot.thinkingLevel } : {}),
				}
			: null;
	}
	return pins;
}

/** The providers surface: native Antigravity provider plus plain-key providers
 *  for discovery. */
export function catalogProviders(): CatalogProvider[] {
	const antigravityProvider: CatalogProvider = {
		id: "antigravity",
		envVar: "AGY_PATH",
		keyPresent: true,
	};
	const authProviders: CatalogProvider[] = AUTH_PROVIDER_KEYS.map((p) => ({
		id: p.id,
		envVar: p.envVar,
		keyPresent: keyValue(p.envVar) !== undefined,
	}));
	return [antigravityProvider, ...authProviders].sort((a, b) => a.id.localeCompare(b.id));
}

/** Project one catalog model to the client DTO. */
export function toModelDto(model: AntigravityModel): ModelDto {
	return {
		id: model.id,
		name: model.name,
		provider: model.provider,
		reasoning: model.reasoning,
		input: [...model.input],
		supportedLevels: getSupportedThinkingLevels(model),
		cost: {
			input: model.cost.input,
			output: model.cost.output,
			cacheRead: model.cost.cacheRead,
			cacheWrite: model.cost.cacheWrite,
		},
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

/** The live-limits index: provider:id → contextWindow for all Antigravity models. */
export function catalogContextLimits(): Map<string, number> {
	const index = new Map<string, number>();
	for (const model of ANTIGRAVITY_MODELS) {
		index.set(`${model.provider}:${model.id}`, model.contextWindow);
	}
	return index;
}

/** The full picker payload: every Antigravity model + defaults + role pins + slots + providers. */
export function modelCatalog(): ModelCatalogResponse {
	const models = ANTIGRAVITY_MODELS.map(toModelDto).sort((a, b) =>
		a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider),
	);
	return {
		models,
		defaults: catalogDefaults(),
		rolePins: catalogRolePins(),
		slots: catalogSlots(),
		providers: catalogProviders(),
	};
}

/** One validated outcome for a settings write. */
export type SettingsValidation =
	| { ok: true }
	| { ok: false; error: string; supported?: ThinkingLevel[] };

/** Validate a picker write against the catalog. */
export function validateChatSettings(settings: ChatSettings): SettingsValidation {
	const providers = ["antigravity"];
	if (settings.model) {
		const { provider, id } = settings.model;
		if (!providers.includes(provider)) {
			return { ok: false, error: `Unknown provider "${provider}" — configured: ${providers.join(", ")}` };
		}
		if (!antigravityModels().getModel(provider, id)) {
			return { ok: false, error: `No model "${id}" in the ${provider} catalog` };
		}
	}
	return { ok: true };
}

export function validateModelsSettings(settings: ModelsSettings): SettingsValidation {
	for (const name of MODEL_SLOTS) {
		const slot = settings[name];
		if (!slot) continue;
		const verdict = validateSlotSpec(name, slot);
		if (!verdict.ok) return verdict;
	}
	return { ok: true };
}

function validateSlotSpec(
	name: ModelSlotName,
	slot: { model?: { provider: string; id: string }; thinkingLevel?: ThinkingLevel },
): SettingsValidation {
	const providers = ["antigravity"];
	if (slot.model) {
		const { provider, id } = slot.model;
		if (!providers.includes(provider)) {
			return { ok: false, error: `Unknown provider "${provider}" — configured: ${providers.join(", ")}` };
		}
		if (!antigravityModels().getModel(provider, id)) {
			return { ok: false, error: `No model "${id}" in the ${provider} catalog` };
		}
	}
	return { ok: true };
}

/** Clamp one level against one model. */
function clampLevelFor(provider: string, id: string, level: ThinkingLevel): ThinkingLevel {
	const model = antigravityModels().getModel(provider, id);
	return model ? clampThinkingLevel(model, level) : level;
}

/** The models-section write's level translation: every slot's pinned thinkingLevel clamps against the slot's own model. */
export function clampModelsLevels(settings: ModelsSettings): ModelsSettings {
	const out: ModelsSettings = {};
	for (const name of MODEL_SLOTS) {
		const slot = settings[name];
		if (!slot?.model) continue;
		out[name] =
			slot.thinkingLevel !== undefined
				? {
						model: slot.model,
						thinkingLevel: clampLevelFor(slot.model.provider, slot.model.id, slot.thinkingLevel),
					}
				: slot;
	}
	return out;
}

/** The chat-section write's level translation. */
export function clampChatLevel(settings: ChatSettings, strong: EffectiveSlot | null): ChatSettings {
	if (settings.thinkingLevel === undefined) return settings;
	const provider = settings.model?.provider ?? strong?.provider;
	const id = settings.model?.id ?? strong?.id;
	if (!provider || !id) return settings;
	return { ...settings, thinkingLevel: clampLevelFor(provider, id, settings.thinkingLevel) };
}
