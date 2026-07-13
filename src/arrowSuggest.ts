import {
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	TFile,
} from "obsidian";
import type AIFlashcardPlugin from "./main";
import { cardToMarkdown, newCardId } from "./cardStore";

interface ArrowSuggestion {
	action: "inline" | "block";
	front: string;
	back: string;
}

/**
 * While typing, `Front -> Back` (literal " -> " with spaces) offers a popup to
 * turn the line into a flashcard — no AI, fully offline. Accepting either
 * rewrites the arrow into a real card the SRS engine already understands:
 *  - inline: `Front :: Back` (the note text stays the card, RemNote-style);
 *  - block:  a `#flashcard` block with a stable id.
 *
 * The `->` is only a typing shortcut; nothing is stored as an arrow.
 */
export class ArrowCardSuggest extends EditorSuggest<ArrowSuggestion> {
	// Require spaces around the arrow so it never fires on -->, <-, => etc.
	private static readonly RE = /^(\s*(?:[-*+]\s+)?)(.+?) -> (.+)$/;
	// Parsed on trigger; front/back can contain spaces, so we don't round-trip
	// them through the suggest query string.
	private pending: { front: string; back: string } | null = null;

	constructor(private plugin: AIFlashcardPlugin) {
		super(plugin.app);
	}

	onTrigger(
		cursor: EditorPosition,
		editor: Editor,
		_file: TFile | null
	): EditorSuggestTriggerInfo | null {
		if (!this.plugin.data.settings.arrowSuggest) return null;
		const before = editor.getLine(cursor.line).slice(0, cursor.ch);
		// Skip headings and lines with inline code, where an arrow isn't a card.
		if (/^#{1,6}\s/.test(before) || before.includes("`")) return null;

		const m = before.match(ArrowCardSuggest.RE);
		if (!m) return null;
		const front = m[2].trim();
		const back = m[3].trim();
		if (!front || !back) return null;

		this.pending = { front, back };
		return {
			start: { line: cursor.line, ch: m[1].length },
			end: { line: cursor.line, ch: cursor.ch },
			query: before,
		};
	}

	getSuggestions(_context: EditorSuggestContext): ArrowSuggestion[] {
		if (!this.pending) return [];
		const { front, back } = this.pending;
		return [
			{ action: "inline", front, back },
			{ action: "block", front, back },
		];
	}

	renderSuggestion(s: ArrowSuggestion, el: HTMLElement): void {
		el.addClass("afs-arrow-suggestion");
		el.createDiv({
			cls: "afs-arrow-title",
			text: s.action === "inline" ? "⚡ Make flashcard" : "⚡ Make flashcard (#flashcard block)",
		});
		el.createDiv({ cls: "afs-arrow-preview", text: `${s.front}  →  ${s.back}` });
	}

	selectSuggestion(s: ArrowSuggestion): void {
		const ctx = this.context;
		if (!ctx) return;
		const replacement =
			s.action === "inline"
				? `${s.front} :: ${s.back}`
				: cardToMarkdown({ front: s.front, back: s.back, tags: [], cardType: "basic" }, newCardId());
		ctx.editor.replaceRange(replacement, ctx.start, ctx.end);
		// Put the cursor at the end of the inserted text.
		const segs = replacement.split("\n");
		ctx.editor.setCursor({
			line: ctx.start.line + segs.length - 1,
			ch: (segs[segs.length - 1] ?? "").length,
		});
		this.pending = null;
		this.plugin.cardStore.invalidateCache();
		void this.plugin.refreshDueBadge();
	}
}
