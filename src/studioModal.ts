import {
	App,
	FuzzySuggestModal,
	MarkdownView,
	Modal,
	Notice,
	Platform,
	Setting,
	TFile,
	arrayBufferToBase64,
} from "obsidian";
import type AIFlashcardPlugin from "./main";
import { chunkText, estimateTokens } from "./chunker";
import { collectDeckPaths } from "./cardStore";
import { DeckPathPromptModal, DeckPathSuggest } from "./deckOps";
import { GeminiError, GeminiPart } from "./geminiClient";
import { CardCountMode, CardStyle, GeneratedCard, GenerationOptions, LanguageMode } from "./types";

type SourceKind = "paste" | "pdf" | "note" | "selection" | "image";

/** Inline uploads to Gemini are capped at ~20MB per request. */
const MAX_INLINE_BYTES = 19 * 1024 * 1024;

export class VaultFileSuggestModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private files: TFile[], private onPick: (file: TFile) => void) {
		super(app);
	}
	getItems(): TFile[] {
		return this.files;
	}
	getItemText(file: TFile): string {
		return file.path;
	}
	onChooseItem(file: TFile): void {
		this.onPick(file);
	}
}

export class StudioModal extends Modal {
	private source: SourceKind = "paste";
	private pastedText = "";
	private capturedSelection = "";
	private pdfFile: TFile | null = null;
	private imageBytes: ArrayBuffer | null = null;
	private imageMime = "";
	private imageLabel = "";

	private opts: GenerationOptions;
	private deckName = "";
	private allDecks: string[] = [];
	private cards: GeneratedCard[] = [];
	private generating = false;

	private sourceAreaEl!: HTMLElement;
	private previewEl!: HTMLElement;
	private progressEl!: HTMLElement;
	private generateBtn!: HTMLButtonElement;

	constructor(app: App, private plugin: AIFlashcardPlugin, initialDeck?: string) {
		super(app);
		const s = plugin.data.settings;
		this.opts = {
			cardStyle: s.defaultCardStyle,
			countMode: "auto",
			cardCount: 10,
			languageMode: s.defaultLanguageMode,
			targetLanguage: s.defaultTargetLanguage,
			depth: 3,
		};
		// Capture the editor selection now — it may be gone once the modal has focus.
		const editor = app.workspace.getActiveViewOfType(MarkdownView)?.editor;
		this.capturedSelection = editor?.getSelection() ?? "";
		const activeFile = app.workspace.getActiveFile();
		this.deckName =
			initialDeck ?? (activeFile ? plugin.cardStore.deckForFile(activeFile) : "New deck");
		// Load existing deck paths for the picker's autocomplete.
		void plugin.cardStore.scanVault().then((cards) => {
			this.allDecks = collectDeckPaths(cards);
		});
	}

	onOpen(): void {
		this.modalEl.addClass("afs-studio-modal");
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "AI Flashcard Studio" });

		this.buildSourceTabs(contentEl);
		this.sourceAreaEl = contentEl.createDiv({ cls: "afs-source-area" });
		this.renderSourceArea();
		this.buildControls(contentEl);

		const actions = contentEl.createDiv({ cls: "afs-actions" });
		this.generateBtn = actions.createEl("button", { text: "Generate cards", cls: "mod-cta" });
		this.generateBtn.addEventListener("click", () => void this.generate());
		this.progressEl = actions.createDiv({ cls: "afs-progress" });

		this.previewEl = contentEl.createDiv({ cls: "afs-preview" });
	}

	onClose(): void {
		this.contentEl.empty();
	}

	// ---------- source selection ----------

	private buildSourceTabs(parent: HTMLElement): void {
		const tabs = parent.createDiv({ cls: "afs-tabs" });
		const defs: Array<[SourceKind, string]> = [
			["paste", "Paste text"],
			["pdf", "PDF"],
			["note", "Current note"],
			["selection", "Selection"],
			["image", "Image"],
		];
		for (const [kind, label] of defs) {
			const btn = tabs.createEl("button", { text: label, cls: "afs-tab" });
			if (kind === this.source) btn.addClass("is-active");
			btn.addEventListener("click", () => {
				this.source = kind;
				tabs.findAll(".afs-tab").forEach((el) => el.removeClass("is-active"));
				btn.addClass("is-active");
				this.renderSourceArea();
			});
		}
	}

	private renderSourceArea(): void {
		const el = this.sourceAreaEl;
		el.empty();
		switch (this.source) {
			case "paste": {
				const ta = el.createEl("textarea", {
					cls: "afs-textarea",
					attr: { placeholder: "Paste your notes, lecture text, or any study material here…" },
				});
				ta.value = this.pastedText;
				ta.addEventListener("input", () => (this.pastedText = ta.value));
				break;
			}
			case "pdf": {
				const row = el.createDiv({ cls: "afs-file-row" });
				const btn = row.createEl("button", { text: "Choose PDF from vault" });
				const label = row.createSpan({
					cls: "afs-file-label",
					text: this.pdfFile ? this.pdfFile.path : "No PDF selected",
				});
				btn.addEventListener("click", () => {
					const pdfs = this.app.vault.getFiles().filter((f) => f.extension === "pdf");
					if (pdfs.length === 0) {
						new Notice("No PDF files found in this vault.");
						return;
					}
					new VaultFileSuggestModal(this.app, pdfs, (file) => {
						this.pdfFile = file;
						label.setText(file.path);
						this.deckName = file.basename;
					}).open();
				});
				el.createDiv({
					cls: "afs-hint",
					text: "The PDF is sent directly to Gemini, which reads it server-side — no local parsing needed (max ~19 MB).",
				});
				break;
			}
			case "note": {
				const file = this.app.workspace.getActiveFile();
				el.createDiv({
					cls: "afs-hint",
					text: file
						? `Will use the content of: ${file.path}`
						: "No active note. Open a note, then reopen the Studio.",
				});
				break;
			}
			case "selection": {
				const ta = el.createEl("textarea", { cls: "afs-textarea" });
				ta.value = this.capturedSelection;
				ta.addEventListener("input", () => (this.capturedSelection = ta.value));
				if (!this.capturedSelection) {
					el.createDiv({
						cls: "afs-hint",
						text: "No text was selected when the Studio opened. Select text in a note first, or paste it above.",
					});
				}
				break;
			}
			case "image": {
				const row = el.createDiv({ cls: "afs-file-row" });
				const vaultBtn = row.createEl("button", { text: "Image from vault" });
				const deviceBtn = row.createEl("button", {
					text: Platform.isMobile ? "Camera / device photo" : "Image from device",
				});
				const label = el.createDiv({
					cls: "afs-file-label",
					text: this.imageLabel || "No image selected",
				});

				vaultBtn.addEventListener("click", () => {
					const exts = ["png", "jpg", "jpeg", "webp", "heic", "gif"];
					const images = this.app.vault.getFiles().filter((f) => exts.includes(f.extension.toLowerCase()));
					if (images.length === 0) {
						new Notice("No image files found in this vault.");
						return;
					}
					new VaultFileSuggestModal(this.app, images, (file) => {
						void this.app.vault.readBinary(file).then((buf) => {
							this.imageBytes = buf;
							this.imageMime = mimeForExtension(file.extension);
							this.imageLabel = file.path;
							label.setText(file.path);
						});
					}).open();
				});

				// Hidden file input; on mobile `capture` offers the camera directly,
				// so a student can snap a photo of a printed page.
				const input = el.createEl("input", {
					attr: { type: "file", accept: "image/*", style: "display: none" },
				});
				if (Platform.isMobile) input.setAttribute("capture", "environment");
				input.addEventListener("change", () => {
					const file = input.files?.[0];
					if (!file) return;
					void file.arrayBuffer().then((buf) => {
						this.imageBytes = buf;
						this.imageMime = file.type || "image/jpeg";
						this.imageLabel = file.name;
						label.setText(file.name);
					});
				});
				deviceBtn.addEventListener("click", () => input.click());
				break;
			}
		}
	}

	// ---------- generation controls ----------

	private buildControls(parent: HTMLElement): void {
		const box = parent.createDiv({ cls: "afs-controls" });

		new Setting(box)
			.setName("Card style")
			.addDropdown((dd) =>
				dd
					.addOptions({
						basic: "Basic (Q&A)",
						cloze: "Cloze deletion",
						definition: "Definition",
						concept: "Concept explanation",
					})
					.setValue(this.opts.cardStyle)
					.onChange((v) => (this.opts.cardStyle = v as CardStyle))
			);

		let countInput: HTMLInputElement;
		new Setting(box)
			.setName("Number of cards")
			.addDropdown((dd) =>
				dd
					.addOptions({ auto: "Auto (let Gemini decide)", manual: "Fixed number" })
					.setValue(this.opts.countMode)
					.onChange((v) => {
						this.opts.countMode = v as CardCountMode;
						countInput.toggleClass("afs-hidden", v !== "manual");
					})
			)
			.addText((t) => {
				countInput = t.inputEl;
				t.inputEl.type = "number";
				t.setValue(String(this.opts.cardCount)).onChange((v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n > 0) this.opts.cardCount = Math.min(n, 100);
				});
				t.inputEl.toggleClass("afs-hidden", this.opts.countMode !== "manual");
			});

		let targetInput: HTMLInputElement;
		new Setting(box)
			.setName("Language")
			.setDesc("Bilingual mode keeps German terms and explains in Persian.")
			.addDropdown((dd) =>
				dd
					.addOptions({
						auto: "Auto-detect (same as source)",
						target: "Force output language",
						bilingual: "Bilingual: German terms, Persian explanations",
					})
					.setValue(this.opts.languageMode)
					.onChange((v) => {
						this.opts.languageMode = v as LanguageMode;
						targetInput.toggleClass("afs-hidden", v !== "target");
					})
			)
			.addText((t) => {
				targetInput = t.inputEl;
				t.setPlaceholder("e.g. German")
					.setValue(this.opts.targetLanguage)
					.onChange((v) => (this.opts.targetLanguage = v));
				t.inputEl.toggleClass("afs-hidden", this.opts.languageMode !== "target");
			});

		new Setting(box)
			.setName("Depth")
			.setDesc("Surface recall ← → deep understanding")
			.addSlider((sl) =>
				sl
					.setLimits(1, 5, 1)
					.setValue(this.opts.depth)
					.setDynamicTooltip()
					.onChange((v) => (this.opts.depth = v))
			);

		let deckInput: HTMLInputElement;
		new Setting(box)
			.setName("Deck")
			.setDesc(
				`Anki-style path, e.g. Chemie::Anorganik — new nested decks are created automatically under "${this.plugin.data.settings.deckFolder}".`
			)
			.addText((t) => {
				t.setValue(this.deckName).onChange((v) => (this.deckName = v));
				new DeckPathSuggest(this.app, t.inputEl, () => this.allDecks);
				deckInput = t.inputEl;
			})
			.addButton((b) =>
				b
					.setButtonText("New deck…")
					.setTooltip("Create a deck via the shared deck manager")
					.onClick(() => {
						new DeckPathPromptModal(this.app, "New deck", this.deckName, this.allDecks, (path) => {
							void this.plugin.deckManager
								.createDeck(path)
								.then((clean) => {
									this.deckName = clean;
									deckInput.value = clean;
									if (!this.allDecks.includes(clean)) this.allDecks.push(clean);
								})
								.catch((e: Error) => new Notice(e.message, 8000));
						}).open();
					})
			);
	}

	// ---------- generation ----------

	private setProgress(text: string): void {
		this.progressEl.setText(text);
	}

	private async generate(): Promise<void> {
		if (this.generating) return;
		this.generating = true;
		this.generateBtn.disabled = true;
		try {
			const cards = await this.runGeneration();
			this.cards = cards;
			this.setProgress(`Generated ${cards.length} cards — review below, then save.`);
			this.renderPreview();
		} catch (e) {
			const msg = e instanceof GeminiError ? e.message : `Generation failed: ${(e as Error).message}`;
			this.setProgress("");
			new Notice(msg, 8000);
			this.progressEl.setText(msg);
			this.progressEl.addClass("afs-error");
			window.setTimeout(() => this.progressEl.removeClass("afs-error"), 8000);
		} finally {
			this.generating = false;
			this.generateBtn.disabled = false;
		}
	}

	private async runGeneration(): Promise<GeneratedCard[]> {
		const client = this.plugin.gemini;

		// Binary sources go to Gemini in a single multimodal request.
		if (this.source === "pdf") {
			if (!this.pdfFile) throw new GeminiError("Select a PDF first.", "api");
			if (this.pdfFile.stat.size > MAX_INLINE_BYTES) {
				throw new GeminiError(
					"This PDF is larger than ~19 MB, which exceeds Gemini's inline upload limit. Split the PDF into smaller parts and try again.",
					"api"
				);
			}
			this.setProgress("Uploading PDF to Gemini…");
			const bytes = await this.app.vault.readBinary(this.pdfFile);
			const part: GeminiPart = {
				inline_data: { mime_type: "application/pdf", data: arrayBufferToBase64(bytes) },
			};
			return client.generateFlashcards([part], this.opts);
		}

		if (this.source === "image") {
			if (!this.imageBytes) throw new GeminiError("Select or take an image first.", "api");
			if (this.imageBytes.byteLength > MAX_INLINE_BYTES) {
				throw new GeminiError("Image is too large for the API (max ~19 MB).", "api");
			}
			this.setProgress("Sending image to Gemini…");
			const part: GeminiPart = {
				inline_data: { mime_type: this.imageMime, data: arrayBufferToBase64(this.imageBytes) },
			};
			return client.generateFlashcards([part], this.opts);
		}

		// Text sources: gather, then chunk if long.
		let text = "";
		if (this.source === "paste") text = this.pastedText;
		else if (this.source === "selection") text = this.capturedSelection;
		else {
			const file = this.app.workspace.getActiveFile();
			if (!file || file.extension !== "md")
				throw new GeminiError("No active markdown note to read.", "api");
			text = await this.app.vault.cachedRead(file);
			if (!this.deckName) this.deckName = file.basename;
		}
		text = text.trim();
		if (!text) throw new GeminiError("The selected source is empty.", "api");

		// Phones have far less headroom — keep chunks small there.
		const configured = this.plugin.data.settings.chunkTokenThreshold;
		const maxTokens = Platform.isMobile ? Math.min(configured, 3000) : configured;

		const chunks = chunkText(text, maxTokens);
		if (chunks.length === 1) {
			this.setProgress(`Generating cards (~${estimateTokens(text)} tokens)…`);
			return client.generateFlashcards([{ text }], this.opts);
		}

		const all: GeneratedCard[] = [];
		for (let i = 0; i < chunks.length; i++) {
			this.setProgress(`Processing chunk ${i + 1} of ${chunks.length}…`);
			const cards = await client.generateFlashcards([{ text: chunks[i] }], this.opts, {
				index: i,
				total: chunks.length,
			});
			all.push(...cards);
		}
		return all;
	}

	// ---------- preview & save ----------

	private renderPreview(): void {
		const el = this.previewEl;
		el.empty();
		if (this.cards.length === 0) return;

		el.createEl("h3", { text: "Preview — edit and select cards to keep" });

		for (const card of this.cards) {
			const row = el.createDiv({ cls: "afs-card-row" });
			const check = row.createEl("input", { attr: { type: "checkbox" } });
			check.checked = card.include !== false;
			check.addEventListener("change", () => (card.include = check.checked));

			const fields = row.createDiv({ cls: "afs-card-fields" });
			const front = fields.createEl("textarea", { cls: "afs-card-front" });
			front.value = card.front;
			front.addEventListener("input", () => (card.front = front.value));
			const back = fields.createEl("textarea", { cls: "afs-card-back" });
			back.value = card.back;
			back.addEventListener("input", () => (card.back = back.value));
			const tags = fields.createEl("input", {
				cls: "afs-card-tags",
				attr: { type: "text", placeholder: "tags, space-separated" },
			});
			tags.value = card.tags.join(" ");
			tags.addEventListener("input", () => {
				card.tags = tags.value
					.split(/\s+/)
					.map((t) => t.replace(/^#/, ""))
					.filter((t) => t.length > 0);
			});
		}

		const saveRow = el.createDiv({ cls: "afs-actions" });
		const saveBtn = saveRow.createEl("button", { text: "Save selected cards", cls: "mod-cta" });
		saveBtn.addEventListener("click", () => void this.save(saveBtn));
	}

	private async save(btn: HTMLButtonElement): Promise<void> {
		const selected = this.cards.filter((c) => c.include !== false && c.front.trim() && c.back.trim());
		if (selected.length === 0) {
			new Notice("No cards selected.");
			return;
		}
		if (!this.deckName.trim()) {
			new Notice("Enter a deck name first (e.g. Chemie::Anorganik).");
			return;
		}
		btn.disabled = true;
		try {
			await this.plugin.cardStore.saveCards(selected, this.deckName);
			await this.plugin.refreshDueBadge();
			this.close();
		} catch (e) {
			new Notice(`Failed to save cards: ${(e as Error).message}`, 8000);
			btn.disabled = false;
		}
	}
}

function mimeForExtension(ext: string): string {
	switch (ext.toLowerCase()) {
		case "png":
			return "image/png";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		case "heic":
			return "image/heic";
		default:
			return "image/jpeg";
	}
}
