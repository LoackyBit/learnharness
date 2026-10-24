/**
 * RETIRED (Antigravity Migration):
 *
 * The getApiKey-hook test previously verified that pi-ai agent instances didn't
 * set a custom getApiKey hook that broke native per-provider env resolution.
 * Under Antigravity CLI, all AI execution is routed through local `agy`
 * sessions without third-party API keys or pi-ai provider resolution hooks.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("the getApiKey hook is RETIRED (Antigravity migration)", () => {
	it("pi-ai getApiKey hooks are obsolete — Antigravity uses local CLI session authentication", () => {
		assert.ok(true, "pi-ai getApiKey hook retired");
	});
});