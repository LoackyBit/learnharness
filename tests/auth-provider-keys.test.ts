/**
 * AUTH_PROVIDER_KEYS (auth-keys wave, 2026-09-19): core/auth-keys.ts
 *
 * Validates the provider key catalog entries, exclusion rules, and
 * isProviderEnvVar lookup helper.
 *
 * Note: Direct runtime derivation against pi-ai internal provider tables
 * is retired under Antigravity CLI migration.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AUTH_PROVIDER_KEYS, isProviderEnvVar } from "../src/core/auth-keys.ts";

/** Anthropic AUTH_TOKEN/OAUTH_TOKEN alternates stay env-only by owner spec;
 *  asserted absent below. */
const ANTHROPIC_ALTERNATES = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"];

const EXCLUDED_PROVIDERS = new Set([
	"github-copilot",
	"amazon-bedrock",
	"google-vertex",
	"azure",
	"cloudflare-workers-ai",
	"cloudflare-ai-gateway",
]);

describe("AUTH_PROVIDER_KEYS — provider key specifications", () => {
	it("contains well-formed provider key entries (id, envVar, label)", () => {
		assert.ok(AUTH_PROVIDER_KEYS.length > 0, "table must not be empty");
		for (const p of AUTH_PROVIDER_KEYS) {
			assert.ok(p.id && typeof p.id === "string", "provider id required");
			assert.ok(p.envVar && typeof p.envVar === "string", "envVar required");
			assert.ok(p.label && typeof p.label === "string", "label required");
		}
	});

	it("the owner-spec exclusions are absent", () => {
		const ids = new Set(AUTH_PROVIDER_KEYS.map((p) => p.id));
		for (const excluded of EXCLUDED_PROVIDERS) assert.ok(!ids.has(excluded), `${excluded} must not be listed`);
		for (const p of AUTH_PROVIDER_KEYS) {
			assert.ok(!ANTHROPIC_ALTERNATES.includes(p.envVar), `${p.envVar} must not appear`);
		}
	});

	it("openrouter IS in the table (it graduated from the curated catalog)", () => {
		const row = AUTH_PROVIDER_KEYS.find((p) => p.id === "openrouter");
		assert.ok(row);
		assert.equal(row.envVar, "OPENROUTER_API_KEY");
	});

	it("isProviderEnvVar: exactly the table's distinct env vars", () => {
		for (const p of AUTH_PROVIDER_KEYS) assert.ok(isProviderEnvVar(p.envVar), `${p.envVar} is a provider var`);
		assert.ok(!isProviderEnvVar("OPENROUTER_API_KEYS"), "typo'd name is not one");
		assert.ok(!isProviderEnvVar("DEEPGRAM_API_KEY"), "curated ≠ provider — separate surfaces");
	});
});
