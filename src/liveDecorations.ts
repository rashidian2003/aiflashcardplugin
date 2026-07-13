import {
	Decoration,
	DecorationSet,
	EditorView,
	PluginValue,
	ViewPlugin,
	ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { MarkdownPostProcessor } from "obsidian";
import { CLOZE_RE, findInlineSeparator } from "./cardStore";

/**
 * Purely-visual markers for the manual card syntaxes (Addendum 2). The raw
 * text in the file is never changed — these only style what's on screen:
 * - a line containing `Front :: Back` gets a card-like tint + the `::`
 *   separator is emphasized;
 * - `{{cN::…}}` spans get a subtle highlight/underline.
 *
 * Live Preview / source mode → CodeMirror 6 ViewPlugin (below).
 * Reading mode → markdown post-processor (bottom of file).
 */

const inlineLineDeco = Decoration.line({ class: "afs-inline-card-line" });
const sepDeco = Decoration.mark({ class: "afs-inline-sep" });
const clozeDeco = Decoration.mark({ class: "afs-cloze" });

function buildDecorations(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	for (const { from, to } of view.visibleRanges) {
		let pos = from;
		while (pos <= to) {
			const line = view.state.doc.lineAt(pos);
			const text = line.text;

			const sep = findInlineSeparator(text);
			if (sep !== -1) {
				builder.add(line.from, line.from, inlineLineDeco);
				builder.add(line.from + sep, line.from + sep + 2, sepDeco);
			} else {
				for (const m of text.matchAll(CLOZE_RE)) {
					const start = line.from + (m.index ?? 0);
					builder.add(start, start + m[0].length, clozeDeco);
				}
			}
			pos = line.to + 1;
		}
	}
	return builder.finish();
}

class CardDecorationPlugin implements PluginValue {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = buildDecorations(view);
	}

	update(update: ViewUpdate): void {
		if (update.docChanged || update.viewportChanged) {
			this.decorations = buildDecorations(update.view);
		}
	}
}

export const cardDecorationExtension = ViewPlugin.fromClass(CardDecorationPlugin, {
	decorations: (v) => v.decorations,
});

/**
 * Reading-mode rendering: replace `{{cN::answer}}` with a styled span showing
 * the answer, and tint paragraphs/list items that are inline `::` cards.
 */
export const cardPostProcessor: MarkdownPostProcessor = (el) => {
	// Cloze spans: rewrite matching text nodes in place.
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	const targets: Text[] = [];
	let node: Node | null;
	while ((node = walker.nextNode())) {
		if ((node as Text).data.includes("{{c")) targets.push(node as Text);
	}
	for (const textNode of targets) {
		if (textNode.parentElement?.closest("code, pre")) continue;
		const parts = textNode.data.split(/(\{\{c\d+::.+?\}\})/g);
		if (parts.length < 2) continue;
		const frag = document.createDocumentFragment();
		for (const part of parts) {
			const m = part.match(/^\{\{c\d+::(.+?)\}\}$/);
			if (m) {
				const span = document.createElement("span");
				span.className = "afs-cloze";
				span.textContent = m[1];
				frag.appendChild(span);
			} else if (part) {
				frag.appendChild(document.createTextNode(part));
			}
		}
		textNode.replaceWith(frag);
	}

	// Inline `::` card lines: tint the rendered paragraph / list item.
	for (const p of Array.from(el.querySelectorAll("p, li"))) {
		if (p.querySelector("code, pre")) continue;
		const text = p.textContent ?? "";
		if (findInlineSeparator(text) !== -1) p.classList.add("afs-inline-card-line");
	}
};
