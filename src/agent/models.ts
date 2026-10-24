import { type ModelRole } from "../../config.ts";
import { DEFAULT_THINKING_ORDER } from "../core/settings.ts";
import type { ThinkingLevel } from "../core/contracts/messages.ts";
import packageMetadata from "../../package.json" with { type: "json" };

/** App identity is immutable and shared by Models and every native Agent. */
export const APP_IDENTITY = Object.freeze({
	userAgent: Object.freeze({ custom: `learnharness/${packageMetadata.version}` }),
	attribution: Object.freeze({ name: packageMetadata.name, url: packageMetadata.homepage }),
});

export type { ThinkingLevel };

/**
 * Native Antigravity model description.
 */
export interface AntigravityModel {
	id: string;
	name: string;
	provider: "antigravity";
	reasoning: boolean;
	input: ("text" | "image")[];
	supportedLevels: ThinkingLevel[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	api?: string;
}

/**
 * The curated list of native Antigravity CLI models.
 */
export const ANTIGRAVITY_MODELS: readonly AntigravityModel[] = Object.freeze([
	Object.freeze({
		id: "gemini-3.8-flash-high",
		name: "Gemini 3.8 Flash High",
		provider: "antigravity",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		supportedLevels: ["low", "medium", "high", "xhigh", "max"] as ThinkingLevel[],
		cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		api: "antigravity",
	}),
	Object.freeze({
		id: "gemini-3.8-flash-medium",
		name: "Gemini 3.8 Flash Medium",
		provider: "antigravity",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		supportedLevels: ["low", "medium", "high", "xhigh", "max"] as ThinkingLevel[],
		cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		api: "antigravity",
	}),
	Object.freeze({
		id: "gemini-3.8-flash-low",
		name: "Gemini 3.8 Flash Low",
		provider: "antigravity",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		supportedLevels: ["low", "medium", "high", "xhigh", "max"] as ThinkingLevel[],
		cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		api: "antigravity",
	}),
	Object.freeze({
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		provider: "antigravity",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		supportedLevels: ["low", "medium", "high", "xhigh", "max"] as ThinkingLevel[],
		cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		contextWindow: 200_000,
		maxTokens: 64_000,
		api: "antigravity",
	}),
	Object.freeze({
		id: "claude-opus-4-6-thinking",
		name: "Claude Opus 4.6 Thinking",
		provider: "antigravity",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		supportedLevels: ["low", "medium", "high", "xhigh", "max"] as ThinkingLevel[],
		cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		contextWindow: 200_000,
		maxTokens: 64_000,
		api: "antigravity",
	}),
	Object.freeze({
		id: "gpt-oss-120b-medium",
		name: "GPT-OSS 120B Medium",
		provider: "antigravity",
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		supportedLevels: ["low", "medium", "high", "xhigh", "max"] as ThinkingLevel[],
		cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		contextWindow: 128_000,
		maxTokens: 16_384,
		api: "antigravity",
	}),
]);

/**
 * Returns the default Antigravity model (Gemini 3.8 Flash High).
 */
export function getDefaultModel(): AntigravityModel {
	const model = ANTIGRAVITY_MODELS[0];
	if (!model) {
		throw new Error("Antigravity catalog is empty");
	}
	return model;
}

const ORDERED_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

/**
 * Computes supported thinking levels for a model.
 */
export function getSupportedThinkingLevels(model: {
	reasoning?: boolean;
	supportedLevels?: readonly ThinkingLevel[] | ThinkingLevel[];
}): ThinkingLevel[] {
	if (!model.reasoning) {
		return ["off"];
	}
	if (model.supportedLevels && model.supportedLevels.length > 0) {
		return [...model.supportedLevels];
	}
	return ["low", "medium", "high", "xhigh", "max"];
}

/**
 * Clamps a requested thinking level to the nearest level supported by the model.
 */
export function clampThinkingLevel(
	model: {
		reasoning?: boolean;
		supportedLevels?: readonly ThinkingLevel[] | ThinkingLevel[];
	},
	level: ThinkingLevel,
): ThinkingLevel {
	const available = getSupportedThinkingLevels(model);
	if (available.includes(level)) {
		return level;
	}
	const requestedIdx = ORDERED_LEVELS.indexOf(level);
	if (requestedIdx === -1) {
		return available[0] ?? "off";
	}
	for (let i = requestedIdx; i < ORDERED_LEVELS.length; i++) {
		const candidate = ORDERED_LEVELS[i];
		if (candidate && available.includes(candidate)) {
			return candidate;
		}
	}
	for (let i = requestedIdx - 1; i >= 0; i--) {
		const candidate = ORDERED_LEVELS[i];
		if (candidate && available.includes(candidate)) {
			return candidate;
		}
	}
	return available[0] ?? "off";
}

/**
 * The first entry of the baked default order the model supports.
 */
export function defaultThinkingLevel(model: {
	reasoning?: boolean;
	supportedLevels?: readonly ThinkingLevel[] | ThinkingLevel[];
}): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}

/**
 * Models collection interface compatible with existing callers.
 */
export interface AntigravityModelsCollection {
	getProviders(): { id: string; name: string }[];
	getModels(providerId?: string): readonly AntigravityModel[];
	getModel(provider: string, id: string): AntigravityModel | undefined;
}

export function antigravityModels(): AntigravityModelsCollection {
	return {
		getProviders: () => [{ id: "antigravity", name: "Antigravity" }],
		getModels: (providerId?: string) => {
			if (providerId && providerId !== "antigravity") return [];
			return ANTIGRAVITY_MODELS;
		},
		getModel: (provider: string, id: string) => {
			if (provider !== "antigravity") return undefined;
			return ANTIGRAVITY_MODELS.find((m) => m.id === id);
		},
	};
}

export const piModels = antigravityModels;

/** OpenRouter API key; legacy helper kept for backward compatibility. */
export function openRouterApiKey(): string | undefined {
	return process.env.OPENROUTER_API_KEY || undefined;
}

/**
 * A resolved model specification.
 */
export interface ResolvedModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

export type StreamFunction = (model: any, context: any, options?: any) => any;

/**
 * Antigravity execution engine shape.
 */
export interface AntigravityEngine {
	model: AntigravityModel | any;
	streamFn: StreamFunction;
	/** The resolved (config-or-settings, CLAMPED) thinking level */
	level?: ThinkingLevel;
}

export type PiEngine = AntigravityEngine;

/**
 * Resolves an engine for the given model specification.
 */
export function antigravityEngineForSpec(spec: ResolvedModelSpec): AntigravityEngine {
	const model = ANTIGRAVITY_MODELS.find(
		(m) => m.id === spec.id && (spec.provider === "antigravity" || !spec.provider),
	);
	if (!model) {
		throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
	}
	const level = spec.thinkingLevel
		? clampThinkingLevel(model, spec.thinkingLevel)
		: defaultThinkingLevel(model);
	return {
		model,
		level,
		streamFn: async () => {},
	};
}

export const piEngineForSpec = antigravityEngineForSpec;

/**
 * Legacy role entry point.
 */
export function antigravityEngineFor(role: ModelRole): AntigravityEngine {
	throw new Error(
		`no configured model for role "${role}" — set your model slots (settings → models)`,
	);
}

export const piEngineFor = antigravityEngineFor;
