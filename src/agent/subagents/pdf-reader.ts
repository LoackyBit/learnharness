import { Type } from "typebox";
import type { AgentMessage, Usage } from "../../core/contracts/messages.ts";
import type { AgentTool } from "../tool-execute.ts";
import type { PiEngine } from "../models.ts";
import type { PdfResult, PdfToolInput } from "../../core/contracts.ts";
import { getHeadless, type HeadlessApi } from "./headless.ts";
import { pdfExtract, pdfInfo, pdfProbe, pdfSearch } from "./pdf-ops.ts";
import { runAntigravitySubagent } from "./antigravity-run.ts";

/**
 * The pdf-reader sub-agent (sources v0, 2026-09): reads a learner-provided
 * PDF on the teacher's behalf — executed via runAntigravitySubagent.
 *
 * System prompt = the pdf-reader skill's reading doctrine, verbatim in
 * strategy: triage with pdf_info FIRST, then size-based strategy — short
 * PDFs render all pages, medium render flagged (math/image-heavy) pages,
 * long ones search for targeted lookups before reading anything at length.
 *
 * Its final text IS the brief (researcher idiom), with (p. N) citations;
 * runPdfJob wraps it into PdfResult with pagesConsulted tracked by the loop.
 */

const INSTRUCTIONS = `You are a PDF reading specialist. You work for a teacher agent inside a learning
application: given a PDF path and a question, read the document on the teacher's behalf and
produce a focused brief that the teacher can teach from, with page citations.

You operate in an isolated context. The task gives you the PDF path and the question — that is
everything you know.

Reading doctrine — always in this order:
1. TRIAGE FIRST: call pdf_info. It returns page count plus per-page signals (text_length,
   image_count, math_density). Never read or render anything before this.
2. Pick a strategy by document size:
   - SHORT (≤ 10 pages): extract the full text; render every page that has meaningful
     math_density or images (you read equations and diagrams visually, not as extracted text).
   - MEDIUM (11-40 pages): extract promising pages; render only flagged pages (math- or
     image-heavy, or where extraction looks thin).
   - LONG (> 40 pages): pdf_search for the question's key terms first; extract and render only
     the pages that hit. Never read a long document front-to-back.
3. When the extracted text of a page looks math- or diagram-heavy, or garbled, RENDER that
   page and read it visually before drawing conclusions from it.
4. Render DPI guidance: 100 for text-dominant pages, 150 the default, 200 for dense small
   print (math details, fine diagrams).

Tool outputs may be error strings (file unreadable, invalid regex, no hits). Adapt: narrow the
page spec, change the query, lower DPI. If the document genuinely cannot answer the question,
say so in the brief instead of inventing content.

Your FINAL assistant message is your entire deliverable — it must stand alone, in this format:
2-6 sentences (or short sections) answering the teacher's question from the document, each
claim cited as (p. N). End with a line "Pages consulted: N, N, …" listing every page you
extracted or rendered.`;

const MAX_ITERATIONS = 14;
/** Rendered pages per pdf_render call — the skill renders selectively; a
 *  batch cap keeps one over-eager call from flooding the vision context. */
const RENDER_BATCH_CAP = 6;
/** Extract output ceiling — narrow the spec instead of dumping a book. */
const EXTRACT_CAP = 24_000;

export interface PdfReaderOptions {
	engine?: PiEngine;
	abortSignal?: AbortSignal;
	onUsage?: (usage: Usage) => void;
	onActivity?: (line: string) => void;
	headless?: HeadlessApi;
	maxIterations?: number;
	/** Debug: raw provider-event recording key (LH_PROVIDER_EVENTS=1). */
	chatId?: string;
}

export interface PdfReaderInput extends PdfToolInput {}

export interface PdfReaderState {
	consulted: Set<number>;
	read: Set<number>;
}

/** The PDF reading tools declared as native AgentTools. */
export function createPdfTools(
	pdfPath: string,
	state?: PdfReaderState,
	headless?: HeadlessApi,
	onActivity?: (line: string) => void,
): Record<string, AgentTool<any>> {
	return {
		pdf_info: {
			name: "pdf_info",
			label: "pdf_info",
			description: "Metadata + per-page triage signals for the PDF (page count, text length, image count, math density). ALWAYS call this first.",
			parameters: Type.Object({}),
			execute: async () => {
				onActivity?.("pdf_info: triaging");
				const r = await pdfInfoText(pdfPath);
				return {
					content: [{ type: "text", text: String(r) }],
					details: {},
				};
			},
		},
		pdf_extract: {
			name: "pdf_extract",
			label: "pdf_extract",
			description: "Extract text from pages (spec: 'all', '1-5', '1,3,7', '3'). Use pdf_info first; narrow the spec for big documents.",
			parameters: Type.Object({
				pages: Type.String({ description: "Page spec, e.g. 'all', '1-5', '1,3,7'" }),
			}),
			execute: async (_toolCallId, args) => {
				const spec = String((args as { pages?: unknown })?.pages ?? "all");
				onActivity?.(`pdf_extract: ${spec}`);
				const r = await pdfExtractText(pdfPath, spec);
				if (state) {
					for (const p of specNumbers(spec, Infinity)) {
						state.consulted.add(p);
						state.read.add(p);
					}
				}
				return {
					content: [{ type: "text", text: String(r) }],
					details: {},
				};
			},
		},
		pdf_render: {
			name: "pdf_render",
			label: "pdf_render",
			description:
				"Render pages to images and show them to you for visual reading (equations, diagrams, layout). DPI: 100 text, 150 default, 200 dense small print. Max 6 pages per call.",
			parameters: Type.Object({
				pages: Type.String({ description: "Page spec, e.g. '1-3' or '2,5,8'" }),
				dpi: Type.Optional(
					Type.Integer({ minimum: 72, maximum: 300, description: "Render DPI (100 text / 150 default / 200 dense)" }),
				),
			}),
			execute: async (_toolCallId, args) => {
				const spec = String((args as { pages?: unknown })?.pages ?? "1");
				const dpi = numOr((args as { dpi?: unknown })?.dpi, 150);
				const wanted = specNumbers(spec, RENDER_BATCH_CAP);
				onActivity?.(`pdf_render: ${spec} @${dpi}dpi`);
				const effectiveHeadless = headless ?? getHeadless();
				const reason = effectiveHeadless.unavailableReason();
				if (reason) {
					return {
						content: [{ type: "text", text: `RENDER UNAVAILABLE: ${reason}` }],
						isError: true,
						details: {},
					};
				}
				try {
					const pages = await effectiveHeadless.renderPdfPages(pdfPath, wanted, { dpi });
					if (state) {
						for (const p of pages) {
							state.consulted.add(p.page);
							state.read.add(p.page);
						}
					}
					if (pages.length === 0) {
						return {
							content: [{ type: "text", text: "ERROR: no pages rendered (spec matched nothing?)" }],
							isError: true,
							details: {},
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `Rendered ${pages.length} page(s) at ${dpi} DPI — the images follow below. Read them carefully (equations, diagrams, layout).`,
							},
							...pages.map((p) => ({
								type: "image" as const,
								data: p.png.toString("base64"),
								mimeType: "image/png",
							})),
						],
						details: {},
					};
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text", text: `ERROR: ${msg}` }],
						isError: true,
						details: {},
					};
				}
			},
		},
		pdf_search: {
			name: "pdf_search",
			label: "pdf_search",
			description: "Search the PDF's text by keyword or regex (case-insensitive); returns hits with context lines. Use for long documents before reading anything at length.",
			parameters: Type.Object({
				query: Type.String({ description: "Keyword or regex" }),
				context_lines: Type.Optional(
					Type.Integer({ minimum: 0, maximum: 8, description: "Context lines around each hit (default 3)" }),
				),
				literal: Type.Optional(Type.Boolean({ description: "true = treat the query literally (no regex; default false)" })),
			}),
			execute: async (_toolCallId, args) => {
				const query = String((args as { query?: unknown })?.query ?? "");
				const contextLines = numOr((args as { context_lines?: unknown })?.context_lines, 3);
				const literal = Boolean((args as { literal?: unknown })?.literal);
				onActivity?.(`pdf_search: "${query}"`);
				const { hits } = await pdfSearch(pdfPath, query, { contextLines, literal });
				if (state) {
					for (const h of hits) state.consulted.add(h.page);
				}
				const cap = hits.slice(0, 40);
				const body =
					cap.length === 0
						? "No hits."
						: cap.map((h) => `=== Page ${h.page}, line ${h.line} ===\n${h.context}`).join("\n") +
							(hits.length > cap.length ? `\n\n[${hits.length - cap.length} more hits — narrow the query.]` : "");
				return {
					content: [{ type: "text", text: body }],
					details: {},
				};
			},
		},
	};
}

/** pdf_info's body: the triage readout. */
async function pdfInfoText(pdfPath: string): Promise<string> {
	const info = await pdfInfo(pdfPath);
	const lines = [
		`File: ${info.path}`,
		`Pages: ${info.page_count} (mean text length/page: ${info.mean_text_length})`,
		...info.pages.map(
			(p) =>
				`p${p.page}: len=${p.text_length} img=${p.image_count} math=${p.math_density.toFixed(2)}`,
		),
	];
	return lines.join("\n");
}

/** pdf_extract's body: capped text extraction with the narrow-the-spec notice. */
async function pdfExtractText(pdfPath: string, pages: string): Promise<string> {
	const text = await pdfExtract(pdfPath, pages);
	if (text.length > EXTRACT_CAP) {
		return `${text.slice(0, EXTRACT_CAP)}\n\n[Output truncated at ${EXTRACT_CAP} chars — narrow the page spec and extract in smaller batches.]`;
	}
	return text;
}

/** Doctrine gate: never deliver a brief that consulted nothing — an unread PDF brief is made-up
 *  content, exactly the class of failure the gate exists for. */
const UNREAD_FINISH_MESSAGE =
	"You finished without consulting any page of the PDF — your brief would be invention, not reading. Extract or render the relevant pages first, then write the brief from what you actually saw.";

export async function runPdfReaderAgent(
	input: PdfReaderInput,
	opts: PdfReaderOptions = {},
): Promise<PdfResult> {
	const headless = opts.headless ?? getHeadless();
	const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;
	const pdfPath = input.path;

	// Deterministic upfront failure: unreadable / unparseable
	const openError = await probeReadable(pdfPath);
	if (openError) {
		return { path: pdfPath, question: input.question, brief: `PDF failed: ${openError}`, pagesRead: [], pagesConsulted: [] };
	}

	const state: PdfReaderState = { consulted: new Set<number>(), read: new Set<number>() };
	const tools = Object.values(createPdfTools(pdfPath, state, headless, opts.onActivity));

	const prompt = [
		`PDF path: ${pdfPath}`,
		`Question (what the teacher needs from this document): ${input.question || "(no question — give a structural overview)"}`,
		"",
		"Read the document per your doctrine, then produce your final brief in the required format.",
	].join("\n");

	let messages: AgentMessage[] = [];
	let finalText = "";
	let nudged = false;
	let turnsLeft = maxIterations;

	try {
		while (turnsLeft > 0) {
			const result = await runAntigravitySubagent(tools, {
				role: "pdfReader",
				engine: opts.engine,
				systemPrompt: INSTRUCTIONS,
				prompt: messages.length === 0 ? prompt : undefined,
				messages: messages.length > 0 ? messages : undefined,
				maxTurns: turnsLeft,
				abortSignal: opts.abortSignal,
				onUsage: opts.onUsage,
				chatId: opts.chatId,
			});

			messages = [...messages, ...result.newMessages];
			finalText = result.text.trim();
			const assistantTurns = result.newMessages.filter((m) => (m as { role?: string }).role === "assistant").length;
			turnsLeft -= Math.max(1, assistantTurns);

			// Doctrine gate on CONSULTED, not read
			if (state.consulted.size === 0 && !nudged && turnsLeft > 0) {
				nudged = true;
				messages.push({
					role: "user",
					content: UNREAD_FINISH_MESSAGE,
					timestamp: Date.now(),
				});
				continue;
			}

			break;
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			path: pdfPath,
			question: input.question,
			brief: `PDF failed: the reader crashed — ${msg}`,
			pagesRead: [...state.read].sort((a, b) => a - b),
			pagesConsulted: [...state.consulted].sort((a, b) => a - b),
		};
	}

	return {
		path: pdfPath,
		question: input.question,
		brief: finalText || `PDF failed: iteration limit (${maxIterations}) reached without a brief.`,
		pagesRead: [...state.read].sort((a, b) => a - b),
		pagesConsulted: [...state.consulted].sort((a, b) => a - b),
	};
}

// ─── small helpers ───────────────────────────────────────────────────────────

/** Parse a page spec into concrete page numbers, capped. */
function specNumbers(spec: string, cap: number): number[] {
	const parts = spec.trim().toLowerCase() === "all" ? [`${cap}`] : spec.split(",");
	const out = new Set<number>();
	for (const part of parts) {
		const p = part.trim();
		if (!p) continue;
		if (p.includes("-")) {
			const [s, e] = p.split("-", 2) as [string, string];
			const start = Math.max(1, parseInt(s, 10) || 1);
			const end = Math.min(parseInt(e, 10) || start, start + cap - 1);
			for (let pg = start; pg <= end && out.size < cap; pg++) out.add(pg);
		} else {
			const pg = parseInt(p, 10);
			if (Number.isFinite(pg) && pg >= 1 && out.size < cap) out.add(pg);
		}
	}
	return [...out].sort((a, b) => a - b);
}

function numOr(v: unknown, dflt: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

/** Cheap upfront readability probe — real parsing happens inside the tools. */
async function probeReadable(pdfPath: string): Promise<string | null> {
	try {
		const fs = await import("node:fs/promises");
		const stat = await fs.stat(pdfPath);
		if (!stat.isFile()) return "not a regular file";
		if (stat.size === 0) return "file is empty";
		await pdfProbe(pdfPath);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}
