import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { ArrowCardSuggest } from "./arrowSuggest";
import { NewCardModal } from "./cardBrowser";
import { CardStore, collectDeckPaths } from "./cardStore";
import { DASHBOARD_VIEW_TYPE, DashboardView } from "./dashboardView";
import { DECK_MANAGER_VIEW_TYPE, DeckManagerView } from "./deckManagerView";
import { DeckManager, DeckPathPromptModal } from "./deckOps";
import { makeCloze, registerEditorActions } from "./editorActions";
import { ExplainDrawer } from "./explainDrawer";
import { cardDecorationExtension, cardPostProcessor } from "./liveDecorations";
import { GeminiClient } from "./geminiClient";
import { ReviewModal } from "./reviewModal";
import { AIFlashcardSettingTab } from "./settingsTab";
import { isDue } from "./srs";
import { StudioModal } from "./studioModal";
import { DEFAULT_SETTINGS, PluginData } from "./types";

const DEFAULT_DATA: PluginData = {
	settings: DEFAULT_SETTINGS,
	srs: {},
	reviewLog: [],
};

export default class AIFlashcardPlugin extends Plugin {
	data: PluginData = DEFAULT_DATA;
	gemini!: GeminiClient;
	cardStore!: CardStore;
	deckManager!: DeckManager;
	explainDrawer!: ExplainDrawer;
	private reviewRibbonEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadPluginData();

		this.gemini = new GeminiClient(
			() => this.data.settings.apiKey,
			() => this.data.settings.model
		);
		this.cardStore = new CardStore(this.app, () => this.data.settings.deckFolder);
		this.deckManager = new DeckManager(
			this.app,
			() => this.data.settings.deckFolder,
			(file) => this.cardStore.deckForFile(file)
		);
		this.explainDrawer = new ExplainDrawer(this);

		this.registerView(DASHBOARD_VIEW_TYPE, (leaf) => new DashboardView(leaf, this));
		this.registerView(DECK_MANAGER_VIEW_TYPE, (leaf) => new DeckManagerView(leaf, this));

		this.addRibbonIcon("sparkles", "AI Flashcard Studio", () => this.openStudio());
		// The badge icon opens the dashboard (overview first); review sessions
		// are launched from there or via the command.
		this.reviewRibbonEl = this.addRibbonIcon("layers", "Flashcard dashboard", () =>
			void this.openDashboard()
		);
		this.reviewRibbonEl.addClass("afs-ribbon-review");
		this.addRibbonIcon("folder-tree", "Deck manager", () =>
			void this.openView(DECK_MANAGER_VIEW_TYPE)
		);
		this.addRibbonIcon("file-plus", "Add flashcard (manual)", () => this.addCardManual());

		this.addCommand({
			id: "open-studio",
			name: "Open AI Flashcard Studio",
			callback: () => this.openStudio(),
		});
		this.addCommand({
			id: "generate-from-selection",
			name: "Generate flashcards from selection",
			editorCallback: () => this.openStudio(),
		});
		this.addCommand({
			id: "open-review",
			name: "Review due flashcards",
			callback: () => this.openReview(),
		});
		this.addCommand({
			id: "open-dashboard",
			name: "Open flashcard dashboard",
			callback: () => void this.openDashboard(),
		});
		this.addCommand({
			id: "open-deck-manager",
			name: "Open deck manager",
			callback: () => void this.openView(DECK_MANAGER_VIEW_TYPE),
		});
		this.addCommand({
			id: "add-card-manual",
			name: "Add flashcard (manual, no AI)",
			callback: () => this.addCardManual(),
		});

		this.addCommand({
			id: "assign-note-deck",
			name: "Assign note to deck…",
			callback: () => void this.assignNoteToDeck(),
		});
		this.addCommand({
			id: "make-cloze",
			name: "Make cloze from selection",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "k" }],
			editorCallback: (editor) => makeCloze(editor),
		});

		this.addSettingTab(new AIFlashcardSettingTab(this.app, this));
		registerEditorActions(this);
		this.registerEditorSuggest(new ArrowCardSuggest(this));
		this.registerEditorExtension(cardDecorationExtension);
		this.registerMarkdownPostProcessor(cardPostProcessor);

		// Defer vault-wide scanning until the vault index is ready.
		this.app.workspace.onLayoutReady(() => {
			void this.refreshDueBadge().then(async () => {
				if (this.data.settings.autoOpenReview) {
					const due = await this.dueCount();
					if (due > 0) this.openReview();
				}
			});
		});
		// Keep the badge roughly current without rescanning on every file event.
		this.registerInterval(
			window.setInterval(() => void this.refreshDueBadge(), 5 * 60 * 1000)
		);
	}

	openStudio(initialDeck?: string): void {
		new StudioModal(this.app, this, initialDeck).open();
	}

	openReview(): void {
		new ReviewModal(this.app, this).open();
	}

	/**
	 * Deck picker for manually-authored cards (`::` / cloze), which live inside
	 * normal notes: writes a `deck:` frontmatter override on the active note.
	 */
	async assignNoteToDeck(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") {
			new Notice("Open a markdown note first.");
			return;
		}
		const decks = collectDeckPaths(await this.cardStore.scanVault());
		const current = this.cardStore.deckForFile(file);
		new DeckPathPromptModal(this.app, `Deck for "${file.basename}"`, current, decks, (deck) => {
			void this.app.fileManager
				.processFrontMatter(file, (fm) => {
					fm.deck = deck;
				})
				.then(() => {
					this.cardStore.invalidateCache();
					new Notice(`Note assigned to deck "${deck}".`);
				});
		}).open();
	}

	/** Open the manual add-card form, no AI, defaulting to the active note's deck. */
	addCardManual(): void {
		const file = this.app.workspace.getActiveFile();
		const initialDeck = file ? this.cardStore.deckForFile(file) : this.data.settings.deckFolder;
		new NewCardModal(this.app, this, initialDeck, () => {
			this.cardStore.invalidateCache();
			void this.refreshDeckManager();
		}).open();
	}

	/** Re-render an open Deck Manager after cards change. */
	async refreshDeckManager(): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType(DECK_MANAGER_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof DeckManagerView) await view.render();
		}
	}

	async openDashboard(): Promise<void> {
		await this.openView(DASHBOARD_VIEW_TYPE);
	}

	async openView(viewType: string): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(viewType);
		let leaf: WorkspaceLeaf;
		if (existing.length > 0) {
			leaf = existing[0];
			const view = leaf.view;
			if (view instanceof DashboardView || view instanceof DeckManagerView) {
				await view.render();
			}
		} else {
			leaf = this.app.workspace.getLeaf(true);
			await leaf.setViewState({ type: viewType, active: true });
		}
		this.app.workspace.revealLeaf(leaf);
	}

	async dueCount(): Promise<number> {
		const cards = await this.cardStore.scanVault();
		return cards.filter((c) => isDue(this.data.srs[c.id])).length;
	}

	/** Update the due-card count badge on the review ribbon icon. */
	async refreshDueBadge(): Promise<void> {
		if (!this.reviewRibbonEl) return;
		let due = 0;
		try {
			due = await this.dueCount();
		} catch {
			return; // vault busy — try again on next interval
		}
		this.reviewRibbonEl.setAttribute("aria-label", `Review flashcards (${due} due)`);
		let badge = this.reviewRibbonEl.querySelector<HTMLElement>(".afs-badge");
		if (due > 0) {
			if (!badge) badge = this.reviewRibbonEl.createSpan({ cls: "afs-badge" });
			badge.setText(due > 99 ? "99+" : String(due));
		} else {
			badge?.remove();
		}
	}

	async loadPluginData(): Promise<void> {
		const stored = (await this.loadData()) as Partial<PluginData> | null;
		this.data = {
			settings: { ...DEFAULT_SETTINGS, ...(stored?.settings ?? {}) },
			srs: stored?.srs ?? {},
			reviewLog: stored?.reviewLog ?? [],
		};
	}

	async savePluginData(): Promise<void> {
		try {
			await this.saveData(this.data);
		} catch (e) {
			new Notice(`AI Flashcard Studio: failed to save data — ${(e as Error).message}`);
			throw e;
		}
	}
}
