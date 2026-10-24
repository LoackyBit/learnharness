/**
 * Backward-compatibility re-export of the Antigravity subagent runner.
 *
 * Forwards runSubagent to runAntigravitySubagent and preserves legacy types
 * without any external dependencies on @earendil-works/*.
 */

export {
	runAntigravitySubagent,
	runAntigravitySubagent as runSubagent,
	subagentEngine,
	agyUsageToUsage,
	usageToCallUsage,
	extractSubagentToolCalls,
	buildSubagentPrompt,
	type SubagentRunOptions,
	type SubagentRunResult,
	type SubagentStep,
	type CallUsage,
	type ExtractedToolCall,
} from "./antigravity-run.ts";
