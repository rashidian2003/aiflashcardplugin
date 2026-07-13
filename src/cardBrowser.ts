import { App, Modal, Notice, Platform, Setting } from "obsidian";
import type AIFlashcardPlugin from "./main";
import { applyCardEdit, moveCardToDeck } from "./cardEdit";
import { collectDeckPaths } from "./cardStore";
import { DeckPathSuggest } from "./deckOps";
import { renderCardMarkdown } from "./render";
import { VaultFileSuggestModal } from "./studioModal";
import { CardStyle, VaultCard } from "./types";

const IMAGE_PICK_EXTS = ["png", "jpg", "jpeg", "webp", "heic", "gif", "svg", "bmp", "avif"];

/** Insert text at the textarea cursor and fire input so bound state updates. */
function insertAtCursor(ta: HTMLTextAreaElement, text: string): void {
	const start = ta.selectionStart ?? ta.value.length;
	const end = ta.selectionEnd ?? start;
	ta.setRangeText(text, start, end, "end");
	ta.dispatchEvent(new Event("input"));
	ta.focus();
}

/**
 * "Insert image" controls under a card text field: pick from the vault, or
 * import from device/camera (the file is saved into the vault's attachment
 * location first, then embedded as ![[…]]).
 */
function addImageRow(app: App, container: HTMLElement, ta: HTMLTextAreaElement): void {
	const row = container.createDiv({ cls: "afs-img-row" });

	const vaultBtn = row.createEl("button", { text: "🖼 Image from vault", cls: "afs-img-btn" });
	vaultBtn.addEventListener("click", () => {
		const images = app.vault
			.getFiles()
			.filter((f) => IMAGE_PICK_EXTS.includes(f.extension.toLowerCase()));
		if (images.length === 0) {
			new Notice("No image files found in this vault.");
			return;
		}
		new VaultFileSuggestModal(app, images, (file) => {
			insertAtCursor(ta, `![[${file.path}]]`);
		}).open();
	});

	const devBtn = row.createEl("button", {
		text: Platform.isMobile ? "📷 Camera / device" : "Image from device",
		cls: "afs-img-btn",
	});
	const input = row.createEl("input", {
		attr: { type: "file", accept: "image/*", style: "display: none" },
	});
	if (Platform.isMobile) input.setAttribute("capture", "environment");
	input.addEventListener("change", () => {
		const picked = input.files?.[0];
		if (!picked) return;
		void (async () => {
			try {
				const buf = await picked.arrayBuffer();
				// Respect the vault's configured attachment location when available.
				const fm = app.fileManager as unknown as {
					getAvailablePathForAttachment?: (name: string) => Promise<string>;
				};
				const path = fm.getAvailablePathForAttachment
					? await fm.getAvailablePathForAttachment(picked.name)
					: picked.name;
				const created = await app.vault.createBinary(path, buf);
				insertAtCursor(ta, `![[${created.path}]]`);
			} catch (e) {
				new Notice(`Could not import image: ${(e as Error).message}`, 8000);
			}
		})();
		input.value = "";
	});
	devBtn.addEventListener("click", () => input.click());
}

/** Generic destructive-action confirmation. */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private body: string,
		private confirmLabel: string,
		private onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h3", { text: this.title });
		this.contentEl.createEl("p", { text: this.body });
		new Setting(this.contentEl)
			.addButton((b) =>
				b
					.setButtonText(this.confirmLabel)
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Manual card creation — no AI involved. A blank form (Basic Q&A or Cloze)
 * that writes a real card into the chosen deck, the Anki "Add" workflow.
 * "Save & add another" keeps the deck/type so you can enter many in a row.
 */
export class NewCardModal extends Modal {
	private cardType: "basic" | "cloze" = "basic";
	private front = "";
	private back = "";
	private clozeText = "";
	private tags = "";
	private deck: string;
	private allDecks: string[] = [];

	constructor(
		app: App,
		private plugin: AIFlashcardPlugin,
		initialDeck: string,
		private onSaved: () => void
	) {
		super(app);
		this.deck = initialDeck;
	}

	onOpen(): void {
		this.modalEl.addClass("afs-card-editor");
		void this.plugin.cardStore.scanVault().then((cards) => {
			this.allDecks = collectDeckPaths(cards);
		});
		this.build();
	}

	private build(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Add flashcard" });

		new Setting(contentEl).setName("Type").addDropdown((dd) =>
			dd
				.addOptions({ basic: "Basic (Q&A)", cloze: "Cloze deletion" })
				.setValue(this.cardType)
				.onChange((v) => {
					this.cardType = v as "basic" | "cloze";
					this.build();
				})
		);

		if (this.cardType === "basic") {
			contentEl.createDiv({ cls: "afs-editor-label", text: "Front (question)" });
			const frontTa = contentEl.createEl("textarea", { cls: "afs-textarea afs-editor-field" });
			frontTa.value = this.front;
			frontTa.addEventListener("input", () => (this.front = frontTa.value));
			addImageRow(this.app, contentEl, frontTa);

			contentEl.createDiv({ cls: "afs-editor-label", text: "Back (answer)" });
			const backTa = contentEl.createEl("textarea", { cls: "afs-textarea afs-editor-field" });
			backTa.value = this.back;
			backTa.addEventListener("input", () => (this.back = backTa.value));
			addImageRow(this.app, contentEl, backTa);
		} else {
			contentEl.createDiv({ cls: "afs-editor-label", text: "Text with clozes" });
			contentEl.createDiv({
				cls: "afs-hint",
				text: "Write a sentence, select a word and press “Wrap as cloze” — each {{cN::…}} becomes its own card.",
			});
			const ta = contentEl.createEl("textarea", { cls: "afs-textarea afs-editor-field" });
			ta.value = this.clozeText;
			ta.addEventListener("input", () => (this.clozeText = ta.value));
			const wrapBtn = contentEl.createEl("button", { text: "Wrap selection as cloze" });
			wrapBtn.addEventListener("click", () => {
				const start = ta.selectionStart;
				const end = ta.selectionEnd;
				if (start === end) {
					new Notice("Select the word or phrase to hide first.");
					return;
				}
				const existing = [...ta.value.matchAll(/\{\{c(\d+)::/g)].map((m) => parseInt(m[1], 10));
				const n = (existing.length ? Math.max(...existing) : 0) + 1;
				const sel = ta.value.slice(start, end);
				ta.setRangeText(`{{c${n}::${sel}}}`, start, end, "end");
				this.clozeText = ta.value;
				ta.focus();
			});
			addImageRow(this.app, contentEl, ta);
		}

		contentEl.createDiv({ cls: "afs-editor-label", text: "Tags (space-separated)" });
		const tagsIn = contentEl.createEl("input", { cls: "afs-editor-tags", attr: { type: "text" } });
		tagsIn.value = this.tags;
		tagsIn.addEventListener("input", () => (this.tags = tagsIn.value));

		new Setting(contentEl)
			.setName("Deck")
			.setDesc("Anki-style path, e.g. Chemie::Anorganik — created if new.")
			.addText((t) => {
				t.setValue(this.deck).onChange((v) => (this.deck = v));
				new DeckPathSuggest(this.app, t.inputEl, () => this.allDecks);
			});

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText("Save")
					.setCta()
					.onClick(() => void this.save(false))
			)
			.addButton((b) =>
				b.setButtonText("Save & add another").onClick(() => void this.save(true))
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	private parseTags(): string[] {
		return this.tags
			.split(/\s+/)
			.map((t) => t.replace(/^#/, ""))
			.filter(Boolean);
	}

	private async save(again: boolean): Promise<void> {
		try {
			if (!this.deck.trim()) throw new Error("Choose a deck first.");
			const tags = this.parseTags();

			if (this.cardType === "basic") {
				const front = this.front.trim();
				const back = this.back.trim();
				if (!front || !back) throw new Error("Front and back must both be filled in.");
				await this.plugin.cardStore.saveCards(
					[{ front, back, tags, cardType: "basic" as CardStyle, include: true }],
					this.deck.trim()
				);
			} else {
				const text = this.clozeText.trim();
				if (!/\{\{c\d+::.+?\}\}/.test(text)) {
					throw new Error("Add at least one {{cN::…}} cloze to the text.");
				}
				const tagSuffix = tags.length ? " " + tags.map((t) => `#${t}`).join(" ") : "";
				await this.plugin.cardStore.appendRawToDeck(this.deck.trim(), text + tagSuffix + "\n");
				new Notice("Cloze card saved.");
			}

			await this.plugin.refreshDueBadge();
			this.onSaved();

			if (again) {
				// Keep deck + type, clear the content fields for the next card.
				this.front = this.back = this.clozeText = this.tags = "";
				this.build();
			} else {
				this.close();
			}
		} catch (e) {
			new Notice((e as Error).message, 8000);
		}
	}
}

/**
 * Full card editor (Addendum 7B/7D): every card — AI-generated, `::` inline,
 * or cloze — is editable here; saving writes back to the note's markdown.
 * Images go in as normal `![[image.png]]` embeds and preview live below.
 */
export class CardEditorModal extends Modal {
	private front: string;
	private back: string;
	private tags: string;
	private rawLine: string;
	private deck: string;

	constructor(
		app: App,
		private plugin: AIFlashcardPlugin,
		private card: VaultCard,
		private allDecks: string[],
		private onSaved: () => void
	) {
		super(app);
		this.front = card.front;
		this.back = card.back;
		this.tags = card.tags.join(" ");
		this.rawLine = card.rawLine ?? "";
		this.deck = card.deck;
	}

	onOpen(): void {
		this.modalEl.addClass("afs-card-editor");
		const { contentEl } = this;
		contentEl.createEl("h3", { text: `Edit card (${this.card.cardType})` });

		const preview = () => {
			previewEl.empty();
			const text =
				this.card.cardType === "cloze"
					? this.rawLine
					: `${this.front}\n\n---\n\n${this.back}`;
			void renderCardMarkdown(this.app, text, previewEl, this.card.filePath, this.plugin);
		};

		if (this.card.cardType === "cloze") {
			contentEl.createDiv({
				cls: "afs-hint",
				text: "Cloze cards edit the raw source line — keep the {{cN::…}} markers. All clozes on this line share the text.",
			});
			const ta = contentEl.createEl("textarea", { cls: "afs-textarea afs-editor-field" });
			ta.value = this.rawLine;
			ta.addEventListener("input", () => {
				this.rawLine = ta.value;
				preview();
			});
			addImageRow(this.app, contentEl, ta);
		} else {
			contentEl.createDiv({ cls: "afs-editor-label", text: "Front" });
			const frontTa = contentEl.createEl("textarea", { cls: "afs-textarea afs-editor-field" });
			frontTa.value = this.front;
			frontTa.addEventListener("input", () => {
				this.front = frontTa.value;
				preview();
			});
			addImageRow(this.app, contentEl, frontTa);
			contentEl.createDiv({ cls: "afs-editor-label", text: "Back" });
			const backTa = contentEl.createEl("textarea", { cls: "afs-textarea afs-editor-field" });
			backTa.value = this.back;
			backTa.addEventListener("input", () => {
				this.back = backTa.value;
				preview();
			});
			addImageRow(this.app, contentEl, backTa);
			if (this.card.cardType !== "inline") {
				contentEl.createDiv({ cls: "afs-editor-label", text: "Tags (space-separated)" });
				const tagsIn = contentEl.createEl("input", {
					cls: "afs-editor-tags",
					attr: { type: "text" },
				});
				tagsIn.value = this.tags;
				tagsIn.addEventListener("input", () => (this.tags = tagsIn.value));
			}
			contentEl.createDiv({
				cls: "afs-hint",
				text: "Markdown works here — including image embeds like ![[photo.png]].",
			});
		}

		new Setting(contentEl).setName("Deck").addText((t) => {
			t.setValue(this.deck).onChange((v) => (this.deck = v));
			new DeckPathSuggest(this.app, t.inputEl, () => this.allDecks);
		});

		contentEl.createDiv({ cls: "afs-editor-label", text: "Preview" });
		const previewEl = contentEl.createDiv({ cls: "afs-editor-preview markdown-rendered" });
		preview();

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText("Save")
					.setCta()
					.onClick(() => void this.save())
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async save(): Promise<void> {
		try {
			await applyCardEdit(this.app, this.plugin.data.srs, this.card, {
				front: this.front,
				back: this.back,
				tags: this.tags
					.split(/\s+/)
					.map((t) => t.replace(/^#/, ""))
					.filter(Boolean),
				rawLine: this.rawLine,
			});
			if (this.deck.trim() && this.deck.trim() !== this.card.deck) {
				// Re-scan to pick up the (possibly re-keyed) card, then move it.
				this.plugin.cardStore.invalidateCache();
				const cards = await this.plugin.cardStore.scanVault(true);
				const updated = cards.find(
					(c) => c.filePath === this.card.filePath && c.startLine === this.card.startLine
				);
				if (updated) {
					await moveCardToDeck(this.app, this.plugin.cardStore, updated, this.deck.trim());
				}
			}
			await this.plugin.savePluginData();
			this.plugin.cardStore.invalidateCache();
			this.close();
			this.onSaved();
		} catch (e) {
			new Notice((e as Error).message, 8000);
		}
	}
}
