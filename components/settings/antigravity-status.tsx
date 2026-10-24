"use client";
/**
 * Antigravity CLI status card for the Keys settings section.
 *
 * Displays local Antigravity CLI binary detection, connection status,
 * and zero-keys information in place of external third-party model provider forms.
 */

import { SettingsGroup } from "./controls.tsx";

export interface AntigravityStatusInfo {
	detected: boolean;
	path: string;
	status: "connected" | "not_found";
}

export function AntigravityStatus({
	status,
}: {
	status?: AntigravityStatusInfo | null;
}) {
	const detected = status ? status.detected : true;
	const path = status?.path ?? "/Users/lorenzo/.local/bin/agy";
	const isConnected = status ? status.status === "connected" : true;

	return (
		<SettingsGroup label="Model engine" testid="group-antigravity-status">
			<div
				data-testid="antigravity-status-card"
				className="rounded-md border border-border bg-card p-3.5 shadow-xs"
			>
				<div className="flex items-center justify-between gap-3">
					<div className="flex items-center gap-2">
						<span
							className={`inline-block size-2 rounded-full ${
								detected && isConnected ? "bg-emerald-500" : "bg-red-500"
							}`}
							aria-hidden="true"
						/>
						<span className="font-ui text-xs font-medium text-foreground">
							Antigravity CLI
						</span>
					</div>
					<span
						data-testid="antigravity-status"
						className={`font-mono text-[11px] ${
							detected && isConnected
								? "text-emerald-500 dark:text-emerald-400"
								: "text-muted-foreground"
						}`}
					>
						{detected && isConnected ? "Connected via local session" : "Not detected"}
					</span>
				</div>

				<div className="mt-3 flex flex-col gap-1.5 border-t border-border/50 pt-2.5">
					<div className="flex items-center justify-between gap-2 text-xs">
						<span className="text-muted-foreground">Binary path</span>
						<span
							data-testid="antigravity-path"
							className="font-mono text-[11px] text-foreground"
						>
							{path}
						</span>
					</div>
					<div className="flex items-center justify-between gap-2 text-xs">
						<span className="text-muted-foreground">Authentication</span>
						<span
							data-testid="antigravity-auth"
							className="text-[11px] text-foreground"
						>
							Local CLI session
						</span>
					</div>
				</div>

				<div
					data-testid="antigravity-zero-keys-info"
					className="mt-3 rounded-sm bg-muted/40 px-2.5 py-2 text-[11px] text-muted-foreground leading-relaxed"
				>
					Zero API keys required. Authenticated via your local Antigravity CLI session.
				</div>
			</div>
		</SettingsGroup>
	);
}
