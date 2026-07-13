import { Editor, EditorPosition, Notice } from "obsidian";
import type AIFlashcardPlugin from "./main";
import { CLOZE_RE, cardToMarkdown, newCardId } from "./cardStore";
import { GeminiError } from "./geminiClient";

/**
 * RemNote-style inline actions on the current text selection, registered in
 * the native editor context menu (right-click on desktop, long-press on
 * mobile — Obsidian fires the same `editor-menu` event on both).
 *
 * Results are inserted with a single `editor.replaceRange`, so one
 * Ctrl/Cmd+Z (or the mobile undo button) removes them cleanly.
 */
export function registerEditorActions(plugin: AIFlashcardPlugin): void {
	plugin.registerEvent(
		plugin.app.workspace.on("editor-menu", (menu, editor) => {
			const selection = editor.getSelection();
			if (!selection || !selection.trim()) return;

			menu.addItem((item) =>
				item
					.setTitle("Explain with AI")
					.setIcon("sparkles")
					.setSection("selection")
					.onClick(() => void explainSelection(plugin, editor, selection))
			);
			menu.addItem((item) =>
				item
					.setTitle("Make flashcard with AI")
					.setIcon("layers")
					.setSection("selection")
					.onClick(() => void makeFlashcardFromSelection(plugin, editor, selection))
			);
			menu.addItem((item) =>
				item
					.setTitle("Make cloze")
					.setIcon("brackets")
					.setSection("selection")
					.onClick(() => makeCloze(editor))
			);
		})
	);
}

/**
 * Wrap the selection in `{{cN::…}}` in place — RemNote-style manual cloze,
 * fully offline. N is one above the highest cloze index already on the
 * selected line(s), so one sentence can hold c1, c2, … as separate cards.
 */
export function makeCloze(editor: Editor): void {
	const selection = editor.getSelection();
	if (!selection || !selection.trim()) {
		new Notice("Select the word or phrase to turn into a cloze first.");
		return;
	}
	if (selection.includes("{{") || selection.includes("}}")) {
		new Notice("Selection already contains cloze markers.");
		return;
	}
	const from = editor.getCursor("from");
	const to = editor.getCursor("to");
	let maxIndex = 0;
	for (let line = from.line; line <= to.line; line++) {
		for (const m of editor.getLine(line).matchAll(CLOZE_RE)) {
			maxIndex = Math.max(maxIndex, parseInt(m[1], 10));
		}
	}
	editor.replaceSelection(`{{c${maxIndex + 1}::${selection}}}`);
}

/** Insert `block` on its own paragraph after the line the selection ends on. */
function insertBlockAfter(editor: Editor, endPos: EditorPosition, block: string): void {
	const line = Math.min(endPos.line, editor.lineCount() - 1);
	const ch = editor.getLine(line).length;
	editor.replaceRange(`\n\n${block}`, { line, ch });
}

async function explainSelection(
	plugin: AIFlashcardPlugin,
	editor: Editor,
	selection: string
): Promise<void> {
	const s = plugin.data.settings;
	// Capture the position now in case the user later hits "Insert into note" —
	// the selection is gone once the menu closes.
	const endPos = editor.getCursor("to");
	const sourcePath = plugin.app.workspace.getActiveFile()?.path ?? "";
	plugin.explainDrawer.open(selection);
	try {
		const explanation = await plugin.gemini.explainText(
			selection,
			s.defaultLanguageMode,
			s.defaultTargetLanguage
		);
		plugin.explainDrawer.showExplanation(explanation, sourcePath, { editor, endPos });
	} catch (e) {
		const msg = e instanceof GeminiError ? e.message : `Explain failed: ${(e as Error).message}`;
		plugin.explainDrawer.showError(msg);
	}
}

async function makeFlashcardFromSelection(
	plugin: AIFlashcardPlugin,
	editor: Editor,
	selection: string
): Promise<void> {
	const s = plugin.data.settings;
	const endPos = editor.getCursor("to");
	const notice = new Notice("Generating flashcard…", 0);
	try {
		const cards = await plugin.gemini.generateFlashcards([{ text: selection }], {
			cardStyle: s.defaultCardStyle,
			countMode: "manual",
			cardCount: 1,
			languageMode: s.defaultLanguageMode,
			targetLanguage: s.defaultTargetLanguage,
			depth: 3,
		});
		// Same block format as the Studio save path — the review scanner picks
		// it up from this note automatically.
		const block = cardToMarkdown(cards[0], newCardId());
		insertBlockAfter(editor, endPos, block);
		void plugin.refreshDueBadge();
	} catch (e) {
		showError(e, "Flashcard generation failed");
	} finally {
		notice.hide();
	}
}

function showError(e: unknown, prefix: string): void {
	const msg = e instanceof GeminiError ? e.message : `${prefix}: ${(e as Error).message}`;
	new Notice(msg, 8000);
}
