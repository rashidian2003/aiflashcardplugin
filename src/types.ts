export type CardStyle = "basic" | "cloze" | "definition" | "concept";
export type LanguageMode = "auto" | "target" | "bilingual";
export type CardCountMode = "auto" | "manual";

export interface GeneratedCard {
	front: string;
	back: string;
	tags: string[];
	cardType: CardStyle;
	/** UI state in the preview list: include this card when saving. */
	include?: boolean;
}

export interface GenerationOptions {
	cardStyle: CardStyle;
	countMode: CardCountMode;
	/** Only used when countMode === "manual". */
	cardCount: number;
	languageMode: LanguageMode;
	/** Output language when languageMode === "target". */
	targetLanguage: string;
	/** 1 = surface recall … 5 = deep understanding. */
	depth: number;
}

export interface CardSchedule {
	ease: number;
	/** Interval in days. 0 = learning / due immediately. */
	interval: number;
	/** ISO date string (YYYY-MM-DD) when the card is next due. */
	due: string;
	reps: number;
	lapses: number;
}

export interface ReviewLogEntry {
	/** ISO date (YYYY-MM-DD). */
	date: string;
	cardId: string;
	rating: number;
}

export interface VaultCard {
	id: string;
	front: string;
	back: string;
	tags: string[];
	cardType: string;
	/** Vault path of the file containing the card. */
	filePath: string;
	/** Anki-style `Parent::Child` deck path. */
	deck: string;
	/** 0-based line range of the card's source text (block: whole block; inline/cloze: the line). */
	startLine: number;
	endLine: number;
	/** For cloze cards: which {{cN::…}} index this card blanks. */
	clozeIndex?: number;
	/** For cloze cards: the raw source line including all cloze markers. */
	rawLine?: string;
}

export interface AIFlashcardSettings {
	apiKey: string;
	model: string;
	defaultCardStyle: CardStyle;
	defaultLanguageMode: LanguageMode;
	defaultTargetLanguage: string;
	/** Approximate token threshold above which input is chunked. */
	chunkTokenThreshold: number;
	deckFolder: string;
	autoOpenReview: boolean;
	/** Suggest turning `Front -> Back` into a flashcard while typing. */
	arrowSuggest: boolean;
}

export interface PluginData {
	settings: AIFlashcardSettings;
	srs: Record<string, CardSchedule>;
	reviewLog: ReviewLogEntry[];
}

export const DEFAULT_SETTINGS: AIFlashcardSettings = {
	apiKey: "",
	model: "gemini-2.0-flash",
	defaultCardStyle: "basic",
	defaultLanguageMode: "auto",
	defaultTargetLanguage: "German",
	chunkTokenThreshold: 6000,
	deckFolder: "Flashcards",
	autoOpenReview: false,
	arrowSuggest: true,
};

export const KNOWN_MODELS = [
	"gemini-2.0-flash",
	"gemini-2.0-flash-lite",
	"gemini-2.5-flash",
	"gemini-2.5-pro",
];

export function todayISO(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
		d.getDate()
	).padStart(2, "0")}`;
}
