import { Editor, EditorPosition, MarkdownRenderer, Notice, setIcon } from "obsidian";
import type AIFlashcardPlugin from "./main";

/**
 * A sliding drawer that shows Gemini's explanation of a text selection
 * without modifying the note. Slides in from the right on desktop and from
 * the bottom (sheet style) on mobile — see styles.css, keyed off Obsidian's
 * `body.is-mobile` class.
 *
 * Singleton per plugin instance: opening a new explanation reuses the drawer.
 */
export class ExplainDrawer {
	private rootEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private footerEl: HTMLElement | null = null;
	private markdown = "";

	constructor(private plugin: AIFlashcardPlugin) {
		plugin.register(() => this.destroy());
	}

	/** Open the drawer in loading state. */
	open(selectionPreview: string): void {
		this.ensureElements(selectionPreview);
		this.bodyEl!.empty();
		this.footerEl!.empty();
		const loading = this.bodyEl!.createDiv({ cls: "afs-drawer-loading" });
		loading.createSpan({ cls: "afs-drawer-spinner" });
		loading.createSpan({ text: "Asking Gemini…" });
		// Next frame so the slide-in transition actually plays.
		requestAnimationFrame(() => this.rootEl?.addClass("is-open"));
	}

	/** Replace the loading state with the rendered explanation. */
	showExplanation(
		markdown: string,
		sourcePath: string,
		insertTarget: { editor: Editor; endPos: EditorPosition } | null
	): void {
		if (!this.rootEl) return;
		this.markdown = markdown;
		this.bodyEl!.empty();
		void MarkdownRenderer.render(this.plugin.app, markdown, this.bodyEl!, sourcePath, this.plugin);

		this.footerEl!.empty();
		const copyBtn = this.footerEl!.createEl("button", { text: "Copy" });
		copyBtn.addEventListener("click", () => {
			void navigator.clipboard.writeText(this.markdown).then(
				() => new Notice("Explanation copied."),
				() => new Notice("Could not copy to clipboard.")
			);
		});
		if (insertTarget) {
			const insertBtn = this.footerEl!.createEl("button", { text: "Insert into note" });
			insertBtn.addEventListener("click", () => {
				const callout = [
					"> [!note] Explain",
					...this.markdown.split("\n").map((l) => `> ${l}`),
				].join("\n");
				const { editor, endPos } = insertTarget;
				const line = Math.min(endPos.line, editor.lineCount() - 1);
				const ch = editor.getLine(line).length;
				editor.replaceRange(`\n\n${callout}`, { line, ch });
				new Notice("Inserted below the selection.");
				this.close();
			});
		}
	}

	showError(message: string): void {
		if (!this.rootEl) return;
		this.bodyEl!.empty();
		this.footerEl!.empty();
		this.bodyEl!.createDiv({ cls: "afs-drawer-error", text: message });
	}

	close(): void {
		this.rootEl?.removeClass("is-open");
	}

	private ensureElements(selectionPreview: string): void {
		if (!this.rootEl) {
			this.rootEl = document.body.createDiv({ cls: "afs-drawer" });
			const header = this.rootEl.createDiv({ cls: "afs-drawer-header" });
			header.createSpan({ cls: "afs-drawer-title", text: "Explain" });
			const closeBtn = header.createEl("button", { cls: "afs-drawer-close" });
			setIcon(closeBtn, "x");
			closeBtn.addEventListener("click", () => this.close());
			this.rootEl.createDiv({ cls: "afs-drawer-selection" });
			this.bodyEl = this.rootEl.createDiv({ cls: "afs-drawer-body markdown-rendered" });
			this.footerEl = this.rootEl.createDiv({ cls: "afs-drawer-footer" });
		}
		const preview =
			selectionPreview.length > 120 ? selectionPreview.slice(0, 120) + "…" : selectionPreview;
		this.rootEl.querySelector<HTMLElement>(".afs-drawer-selection")?.setText(`“${preview}”`);
	}

	private destroy(): void {
		this.rootEl?.remove();
		this.rootEl = null;
		this.bodyEl = null;
		this.footerEl = null;
	}
}
