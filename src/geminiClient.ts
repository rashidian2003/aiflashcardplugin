import { requestUrl } from "obsidian";
import { CardStyle, GeneratedCard, GenerationOptions, LanguageMode } from "./types";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** One part of a multimodal Gemini request. */
export type GeminiPart =
	| { text: string }
	| { inline_data: { mime_type: string; data: string } };

export class GeminiError extends Error {
	constructor(message: string, public readonly kind: "auth" | "quota" | "network" | "parse" | "api") {
		super(message);
	}
}

const STYLE_INSTRUCTIONS: Record<CardStyle, string> = {
	basic: "Create Basic question/answer cards. The front is a clear question, the back is a concise answer.",
	cloze:
		"Create cloze deletion cards. The front is a sentence from the material with the key term replaced by {{...}}, the back is the deleted term (plus a one-line clarification if helpful).",
	definition:
		"Create definition cards. The front is a term or concept name, the back is its precise definition.",
	concept:
		"Create concept-explanation cards. The front asks to explain a concept, mechanism or relationship ('Why...', 'How...', 'Compare...'), the back gives a compact but complete explanation.",
};

function depthInstruction(depth: number): string {
	if (depth <= 2)
		return "Focus on surface recall: facts, terms, formulas, names — quick-recall material.";
	if (depth >= 4)
		return "Focus on deep understanding: mechanisms, why-questions, relationships between concepts, applications and edge cases — not mere fact recall.";
	return "Mix factual recall cards with understanding-oriented cards.";
}

function languageInstruction(opts: GenerationOptions): string {
	switch (opts.languageMode) {
		case "target":
			return `Write ALL card fronts and backs in ${opts.targetLanguage}, regardless of the source language.`;
		case "bilingual":
			return (
				"BILINGUAL MODE (German/Persian): Keep all German technical terms (Fachbegriffe) in German exactly as they appear in the source, " +
				"but write the explanations on the back in Persian (Farsi). Card fronts should show the German term or a German question; " +
				"backs explain the concept in Persian while quoting the German key terms inline. " +
				"Do NOT translate technical terms into Persian — the goal is to learn the German terminology with Persian conceptual understanding."
			);
		default:
			return "Detect the language of the source material and write the cards in that same language.";
	}
}

export function buildPrompt(opts: GenerationOptions, chunkInfo?: { index: number; total: number }): string {
	const count =
		opts.countMode === "manual"
			? `Create exactly ${opts.cardCount} cards.`
			: "Decide the number of cards yourself based on how information-dense the material is (typically 1 card per distinct fact or concept; skip filler).";

	const chunkNote = chunkInfo
		? `\nThis is part ${chunkInfo.index + 1} of ${chunkInfo.total} of a longer document; create cards only for THIS part.`
		: "";

	return [
		"You are a flashcard author for spaced-repetition study (Anki-style).",
		"Create flashcards from the provided material.",
		STYLE_INSTRUCTIONS[opts.cardStyle],
		count,
		depthInstruction(opts.depth),
		languageInstruction(opts),
		"Each card must be self-contained and unambiguous without seeing the source.",
		"Suggest 1-3 short topic tags per card (lowercase, no spaces, no # prefix).",
		chunkNote,
		"",
		"Respond with STRICT JSON only — no markdown, no code fences, no commentary.",
		'Format: {"cards":[{"front":"...","back":"...","tags":["tag1"],"cardType":"' +
			opts.cardStyle +
			'"}]}',
	].join("\n");
}

export class GeminiClient {
	constructor(private getApiKey: () => string, private getModel: () => string) {}

	/**
	 * Generate flashcards from arbitrary content parts (text, PDF bytes,
	 * image bytes). Retries once on malformed JSON before failing.
	 */
	async generateFlashcards(
		contentParts: GeminiPart[],
		opts: GenerationOptions,
		chunkInfo?: { index: number; total: number }
	): Promise<GeneratedCard[]> {
		const prompt = buildPrompt(opts, chunkInfo);
		const parts: GeminiPart[] = [{ text: prompt }, ...contentParts];

		let lastErr: GeminiError | null = null;
		for (let attempt = 0; attempt < 2; attempt++) {
			const raw = await this.callApi(parts, true);
			try {
				return parseCards(raw);
			} catch (e) {
				lastErr = new GeminiError(
					`Gemini returned a malformed response: ${(e as Error).message}`,
					"parse"
				);
			}
		}
		throw lastErr;
	}

	/**
	 * Concise plain-text explanation of a text snippet, for the inline
	 * "Explain" editor action. Honors the same language modes as generation.
	 */
	async explainText(text: string, mode: LanguageMode, targetLanguage: string): Promise<string> {
		let lang: string;
		switch (mode) {
			case "target":
				lang = `Answer in ${targetLanguage}.`;
				break;
			case "bilingual":
				lang =
					"Answer in Persian (Farsi), but keep all German technical terms (Fachbegriffe) in German, quoted inline — do not translate the terms themselves.";
				break;
			default:
				lang = "Answer in the same language as the text.";
		}
		const prompt = [
			"Explain the following text from a student's study material concisely (3-6 sentences).",
			"Focus on what it means and why it matters; add a tiny concrete example only if it genuinely clarifies.",
			lang,
			"Respond with the explanation only — no preamble, no headings.",
			"",
			"Text:",
			text,
		].join("\n");
		const raw = await this.callApi([{ text: prompt }], false);
		return raw.trim();
	}

	private async callApi(parts: GeminiPart[], jsonResponse: boolean): Promise<string> {
		const apiKey = this.getApiKey().trim();
		if (!apiKey) {
			throw new GeminiError(
				"No Gemini API key configured. Add one in Settings → AI Flashcard Studio.",
				"auth"
			);
		}
		const model = this.getModel().trim() || "gemini-2.0-flash";
		const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent`;

		let response;
		try {
			response = await requestUrl({
				url,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-goog-api-key": apiKey,
				},
				body: JSON.stringify({
					contents: [{ parts }],
					generationConfig: {
						temperature: 0.4,
						...(jsonResponse ? { response_mime_type: "application/json" } : {}),
					},
				}),
				throw: false,
			});
		} catch (e) {
			throw new GeminiError(
				`Network error while contacting Gemini: ${(e as Error).message}`,
				"network"
			);
		}

		if (response.status === 401 || response.status === 403) {
			throw new GeminiError("Gemini rejected the API key (401/403). Check it in settings.", "auth");
		}
		if (response.status === 429) {
			throw new GeminiError(
				"Gemini rate limit / quota exceeded (429). Wait a bit and try again, or check your quota in Google AI Studio.",
				"quota"
			);
		}
		if (response.status >= 400) {
			let detail = "";
			try {
				detail = response.json?.error?.message ?? "";
			} catch {
				/* body not JSON */
			}
			throw new GeminiError(
				`Gemini API error ${response.status}${detail ? `: ${detail}` : ""}`,
				"api"
			);
		}

		const body = response.json;
		const text: string | undefined =
			body?.candidates?.[0]?.content?.parts
				?.map((p: { text?: string }) => p.text ?? "")
				.join("") ?? undefined;
		if (!text) {
			const reason = body?.candidates?.[0]?.finishReason ?? body?.promptFeedback?.blockReason;
			throw new GeminiError(
				`Gemini returned no text${reason ? ` (reason: ${reason})` : ""}.`,
				"api"
			);
		}
		return text;
	}
}

/**
 * Parse Gemini's response into cards. Tolerates markdown code fences and a
 * bare top-level array; throws on anything unusable.
 */
export function parseCards(raw: string): GeneratedCard[] {
	let text = raw.trim();
	const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	if (fence) text = fence[1].trim();

	// Some models wrap JSON in prose; grab the outermost object/array.
	if (!text.startsWith("{") && !text.startsWith("[")) {
		const start = text.search(/[[{]/);
		if (start >= 0) text = text.slice(start);
	}

	const parsed = JSON.parse(text);
	const arr: unknown = Array.isArray(parsed) ? parsed : parsed?.cards;
	if (!Array.isArray(arr)) throw new Error("no 'cards' array found");

	const cards: GeneratedCard[] = [];
	for (const item of arr) {
		if (typeof item !== "object" || item === null) continue;
		const c = item as Record<string, unknown>;
		const front = typeof c.front === "string" ? c.front.trim() : "";
		const back = typeof c.back === "string" ? c.back.trim() : "";
		if (!front || !back) continue;
		const tags = Array.isArray(c.tags)
			? c.tags.filter((t): t is string => typeof t === "string").map((t) => t.replace(/^#/, ""))
			: [];
		const cardType = typeof c.cardType === "string" ? c.cardType : "basic";
		cards.push({ front, back, tags, cardType: cardType as CardStyle, include: true });
	}
	if (cards.length === 0) throw new Error("response contained no valid cards");
	return cards;
}
