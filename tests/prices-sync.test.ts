/**
 * THE PRICE-TABLE DRIFT GUARD (owner, 2026-09-29, adapted for Antigravity migration).
 *
 * Verifies that all native Antigravity models have zero-cost entries in PRICES,
 * while preserving historical static prices for past session cost views.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PRICES } from "../src/core/prices.ts";
import { ANTIGRAVITY_MODELS } from "../src/agent/models.ts";

test("PRICES contains zero-cost entries for all native Antigravity models", () => {
	assert.ok(ANTIGRAVITY_MODELS.length > 0);
	for (const m of ANTIGRAVITY_MODELS) {
		const key = `${m.provider}:${m.id}`;
		const price = PRICES[key];
		assert.ok(price, `Antigravity model ${key} must exist in PRICES`);
		assert.equal(price.input, 0);
		assert.equal(price.output, 0);
		assert.equal(price.cacheRead, 0);
		assert.equal(price.cacheWrite, 0);
	}
});
