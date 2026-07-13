import { ItemView, Notice, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type AIFlashcardPlugin from "./main";
import { CardEditorModal, ConfirmModal } from "./cardBrowser";
import { deleteCard, moveCardToDeck } from "./cardEdit";
import { collectDeckPaths, deckMatches } from "./cardStore";
import { DeckNode, DeckPathPromptModal, DeleteDeckModal, buildDeckTree } from "./deckOps";
import { ReviewModal } from "./reviewModal";
import { isDue } from "./srs";
import { VaultCard } from "./types";

export const DECK_MANAGER_VIEW_TYPE = "afs-deck-manager";

/** Prune the tree to nodes whose path matches `query`, keeping ancestors. */
function filterDeckTree(nodes: DeckNode[], query: string): DeckNode[] {
	const result: DeckNode[] = [];
	for (const node of nodes) {
		const children = filterDeckTree(node.children, query);
		if (node.path.toLowerCase().includes(query) || children.length > 0) {
			result.push({ ...node, children });
		}
	}
	return result;
}

/**
 * Standalone deck browser for structural management (Addendum 6): build the
 * whole deck tree — including empty decks with no cards yet — before ever
 * creating a card, exactly like Anki's deck screen. All CRUD goes through the
 * shared DeckManager; the dashboard stays the place for stats/review.
 */
export class DeckManagerView extends ItemView {
	private expanded = new Set<string>();
	private expandedInitialized = false;
	/** When set, the view shows the card list of this deck (browse mode). */
	private selectedDeck: string | null = null;
	private deckSearch = "";
	private cardSearch = "";
	private typeFilter = "all";
	private sortMode: "position" | "due" = "position";
	private dragSource: string | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: AIFlashcardPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return DECK_MANAGER_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Deck manager";
	}

	getIcon(): string {
		return "folder-tree";
	}

	async onOpen(): Promise<void> {
		await this.render();
	}

	async render(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("afs-dashboard"); // shares the dashboard's base styling

		if (this.selectedDeck !== null) {
			await this.renderCardList(root, this.selectedDeck);
			return;
		}

		const header = root.createDiv({ cls: "afs-dash-header" });
		header.createEl("h2", { text: "Deck manager" });
		const actions = header.createDiv({ cls: "afs-deckmgr-actions" });
		const newBtn = actions.createEl("button", { text: "New deck", cls: "mod-cta" });
		newBtn.addEventListener("click", () => this.promptNewDeck(""));
		const refreshBtn = actions.createEl("button", { text: "Refresh" });
		refreshBtn.addEventListener("click", () => void this.refresh());
		root.createDiv({
			cls: "afs-hint",
			text: "Folders are parent decks: create one with New deck (e.g. Deutsch), then use + for subdecks — or drag & drop a deck onto another to nest it.",
		});

		const cards = await this.plugin.cardStore.scanVault();
		// Union of card-bearing decks and empty folders under the deck root.
		const emptyDecks = this.plugin.deckManager.listDecksFromVault();
		let tree = buildDeckTree(cards, this.plugin.data.srs, emptyDecks);

		if (!this.expandedInitialized) {
			for (const node of tree) this.expanded.add(node.path);
			this.expandedInitialized = true;
		}

		// Toolbar: search + expand/collapse all.
		const toolbar = root.createDiv({ cls: "afs-deckmgr-toolbar" });
		const search = toolbar.createEl("input", {
			cls: "afs-deckmgr-search",
			attr: { type: "search", placeholder: "Search decks…" },
		});
		search.value = this.deckSearch;
		search.addEventListener("input", () => {
			this.deckSearch = search.value;
			void this.render().then(() => {
				const el = this.contentEl.querySelector<HTMLInputElement>(".afs-deckmgr-search");
				el?.focus();
				el?.setSelectionRange(el.value.length, el.value.length);
			});
		});
		const expandAll = toolbar.createEl("button", { text: "Expand all" });
		expandAll.addEventListener("click", () => {
			const addAll = (nodes: DeckNode[]) => {
				for (const n of nodes) {
					this.expanded.add(n.path);
					addAll(n.children);
				}
			};
			addAll(tree);
			void this.render();
		});
		const collapseAll = toolbar.createEl("button", { text: "Collapse all" });
		collapseAll.addEventListener("click", () => {
			this.expanded.clear();
			void this.render();
		});

		if (this.deckSearch.trim()) tree = filterDeckTree(tree, this.deckSearch.trim().toLowerCase());

		if (tree.length === 0) {
			root.createDiv({
				cls: "afs-dash-empty",
				text: this.deckSearch.trim()
					? "No decks match the search."
					: 'No decks yet. Click "New deck" to build your structure — cards can come later.',
			});
			return;
		}

		const treeEl = root.createDiv({ cls: "afs-deck-tree" });
		const allDecks = [...new Set([...collectDeckPaths(cards), ...emptyDecks])].sort();
		const searching = this.deckSearch.trim().length > 0;
		for (const node of tree) this.renderNode(treeEl, node, 0, searching, allDecks, cards);
	}

	private async refresh(): Promise<void> {
		this.plugin.cardStore.invalidateCache();
		await this.render();
		await this.plugin.refreshDueBadge();
	}

	private renderNode(
		parentEl: HTMLElement,
		node: DeckNode,
		depth: number,
		forceExpand: boolean,
		allDecks: string[],
		cards: { deck: string }[]
	): void {
		const row = parentEl.createDiv({ cls: "afs-deck-row" });
		row.style.paddingInlineStart = `${depth * 22}px`;
		const isExpanded = forceExpand || this.expanded.has(node.path);

		// Drag & drop re-parenting: drop deck A onto deck B → B::A.
		row.draggable = true;
		row.addEventListener("dragstart", (evt) => {
			this.dragSource = node.path;
			evt.dataTransfer?.setData("text/plain", node.path);
		});
		row.addEventListener("dragover", (evt) => {
			if (!this.dragSource || this.dragSource === node.path) return;
			if (deckMatches(node.path, this.dragSource)) return; // no drop into own subtree
			evt.preventDefault();
			row.addClass("afs-drop-target");
		});
		row.addEventListener("dragleave", () => row.removeClass("afs-drop-target"));
		row.addEventListener("drop", (evt) => {
			evt.preventDefault();
			row.removeClass("afs-drop-target");
			const source = this.dragSource;
			this.dragSource = null;
			if (!source || source === node.path || deckMatches(node.path, source)) return;
			const leaf = source.split("::").pop()!;
			void this.plugin.deckManager
				.renameDeck(source, `${node.path}::${leaf}`)
				.then(() => {
					this.expanded.add(node.path);
					return this.refresh();
				})
				.catch((e: Error) => new Notice(e.message, 8000));
		});

		const chevron = row.createSpan({ cls: "afs-deck-chevron" });
		if (node.children.length > 0) {
			setIcon(chevron, isExpanded ? "chevron-down" : "chevron-right");
			chevron.addEventListener("click", () => {
				if (this.expanded.has(node.path)) this.expanded.delete(node.path);
				else this.expanded.add(node.path);
				void this.render();
			});
		} else {
			chevron.addClass("afs-deck-chevron-empty");
		}

		// Clicking the deck name opens browse mode — the card list (Addendum 7B).
		const nameEl = row.createSpan({ cls: "afs-dash-deck-name afs-deck-name-link", text: node.name });
		nameEl.addEventListener("click", () => {
			this.selectedDeck = node.path;
			this.cardSearch = "";
			this.typeFilter = "all";
			void this.render();
		});
		row.createSpan({
			cls: "afs-deck-counts afs-deckmgr-counts",
			text: node.total === 0 ? "empty" : `${node.total} cards · ${node.due} due`,
		});

		const btns = row.createDiv({ cls: "afs-deckmgr-btns" });
		const action = (icon: string, tooltip: string, onClick: () => void) => {
			const btn = btns.createSpan({ cls: "afs-deck-more" });
			setIcon(btn, icon);
			setTooltip(btn, tooltip);
			btn.addEventListener("click", onClick);
		};
		action("plus", "New subdeck", () => this.promptNewDeck(node.path));
		action("wand-sparkles", "Add cards (AI Studio)", () => this.plugin.openStudio(node.path));
		action("pencil", "Rename / move", () => {
			new DeckPathPromptModal(this.app, "Rename or move deck", node.path, allDecks, (newPath) => {
				void this.plugin.deckManager
					.renameDeck(node.path, newPath)
					.then(() => this.refresh())
					.catch((e: Error) => new Notice(e.message, 8000));
			}).open();
		});
		action("trash", "Delete deck", () => {
			const count = cards.filter((c) => deckMatches(c.deck, node.path)).length;
			new DeleteDeckModal(this.app, node.path, count, (mode) => {
				void this.plugin.deckManager
					.deleteDeck(node.path, mode)
					.then(() => this.refresh())
					.catch((e: Error) => new Notice(e.message, 8000));
			}).open();
		});

		if (isExpanded) {
			for (const child of node.children) {
				this.renderNode(parentEl, child, depth + 1, forceExpand, allDecks, cards);
			}
		}
	}

	// ---- browse mode: card list of one deck (Addendum 7B) ----

	private async renderCardList(root: HTMLElement, deckPath: string): Promise<void> {
		const header = root.createDiv({ cls: "afs-dash-header" });
		const titleWrap = header.createDiv({ cls: "afs-deckmgr-actions" });
		const backBtn = titleWrap.createEl("button", { text: "← Decks" });
		backBtn.addEventListener("click", () => {
			this.selectedDeck = null;
			void this.render();
		});
		header.createEl("h2", { text: deckPath });

		const allCards = await this.plugin.cardStore.scanVault();
		const deckCards = allCards.filter((c) => deckMatches(c.deck, deckPath));
		const allDecks = collectDeckPaths(allCards);
		const dueCount = deckCards.filter((c) => isDue(this.plugin.data.srs[c.id])).length;

		const bar = root.createDiv({ cls: "afs-deckmgr-actions afs-browse-bar" });
		if (dueCount > 0) {
			const reviewBtn = bar.createEl("button", {
				text: `Start review (${dueCount} due)`,
				cls: "mod-cta",
			});
			reviewBtn.addEventListener("click", () =>
				new ReviewModal(this.app, this.plugin, deckPath).open()
			);
		}
		const addBtn = bar.createEl("button", { text: "Add cards" });
		addBtn.addEventListener("click", () => this.plugin.openStudio(deckPath));
		bar.createSpan({
			cls: "afs-deckmgr-counts",
			text: `${deckCards.length} card${deckCards.length === 1 ? "" : "s"} (incl. sub-decks)`,
		});

		if (deckCards.length === 0) {
			root.createDiv({ cls: "afs-dash-empty", text: "No cards in this deck yet." });
			return;
		}

		// Filter/sort toolbar for the card list.
		const toolbar = root.createDiv({ cls: "afs-deckmgr-toolbar" });
		const search = toolbar.createEl("input", {
			cls: "afs-deckmgr-search",
			attr: { type: "search", placeholder: "Search cards…" },
		});
		search.value = this.cardSearch;
		search.addEventListener("input", () => {
			this.cardSearch = search.value;
			void this.render().then(() => {
				const el = this.contentEl.querySelector<HTMLInputElement>(".afs-deckmgr-search");
				el?.focus();
				el?.setSelectionRange(el.value.length, el.value.length);
			});
		});
		const typeSel = toolbar.createEl("select", { cls: "dropdown" });
		typeSel.createEl("option", { text: "All types", value: "all" });
		for (const t of [...new Set(deckCards.map((c) => c.cardType))].sort()) {
			typeSel.createEl("option", { text: t, value: t });
		}
		typeSel.value = this.typeFilter;
		typeSel.addEventListener("change", () => {
			this.typeFilter = typeSel.value;
			void this.render();
		});
		const sortSel = toolbar.createEl("select", { cls: "dropdown" });
		sortSel.createEl("option", { text: "Note order", value: "position" });
		sortSel.createEl("option", { text: "Due first", value: "due" });
		sortSel.value = this.sortMode;
		sortSel.addEventListener("change", () => {
			this.sortMode = sortSel.value as "position" | "due";
			void this.render();
		});

		let cards = deckCards;
		const q = this.cardSearch.trim().toLowerCase();
		if (q) {
			cards = cards.filter(
				(c) => c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q)
			);
		}
		if (this.typeFilter !== "all") cards = cards.filter((c) => c.cardType === this.typeFilter);
		if (this.sortMode === "due") {
			cards = [...cards].sort((a, b) => {
				const dueA = isDue(this.plugin.data.srs[a.id]) ? 0 : 1;
				const dueB = isDue(this.plugin.data.srs[b.id]) ? 0 : 1;
				if (dueA !== dueB) return dueA - dueB;
				return (this.plugin.data.srs[a.id]?.due ?? "").localeCompare(
					this.plugin.data.srs[b.id]?.due ?? ""
				);
			});
		}
		if (cards.length === 0) {
			root.createDiv({ cls: "afs-dash-empty", text: "No cards match the filter." });
			return;
		}

		const list = root.createDiv({ cls: "afs-browse-list" });
		for (const card of cards) {
			const row = list.createDiv({ cls: "afs-browse-row" });
			row.createSpan({ cls: `afs-browse-type afs-type-${card.cardType}`, text: card.cardType });
			const frontText = card.front.replace(/\s+/g, " ").trim();
			const frontEl = row.createSpan({
				cls: "afs-browse-front",
				text: frontText.length > 90 ? frontText.slice(0, 90) + "…" : frontText,
			});
			frontEl.addEventListener("click", () => this.openEditor(card, allDecks));

			const s = this.plugin.data.srs[card.id];
			row.createSpan({
				cls: `afs-browse-due ${isDue(s) ? "is-due" : ""}`,
				text: !s || s.reps === 0 ? "new" : isDue(s) ? "due" : s.due,
			});

			const btns = row.createDiv({ cls: "afs-deckmgr-btns" });
			const action = (icon: string, tooltip: string, onClick: () => void) => {
				const btn = btns.createSpan({ cls: "afs-deck-more" });
				setIcon(btn, icon);
				setTooltip(btn, tooltip);
				btn.addEventListener("click", onClick);
			};
			action("pencil", "Edit card", () => this.openEditor(card, allDecks));
			action("folder-input", "Move to deck…", () => {
				new DeckPathPromptModal(this.app, "Move card to deck", card.deck, allDecks, (target) => {
					void moveCardToDeck(this.app, this.plugin.cardStore, card, target)
						.then(() => this.refreshBrowse())
						.catch((e: Error) => new Notice(e.message, 8000));
				}).open();
			});
			action("trash", "Delete card", () => {
				const body =
					card.cardType === "cloze"
						? "This removes only this cloze marker — the sentence and its other clozes stay in the note."
						: "This removes the card's text from the note. The note itself is kept.";
				new ConfirmModal(this.app, "Delete this card?", body, "Delete card", () => {
					void deleteCard(this.app, this.plugin.data.srs, card)
						.then(() => this.plugin.savePluginData())
						.then(() => this.refreshBrowse())
						.catch((e: Error) => new Notice(e.message, 8000));
				}).open();
			});
		}
	}

	private openEditor(card: VaultCard, allDecks: string[]): void {
		new CardEditorModal(this.app, this.plugin, card, allDecks, () => void this.refreshBrowse()).open();
	}

	private async refreshBrowse(): Promise<void> {
		this.plugin.cardStore.invalidateCache();
		await this.render();
		await this.plugin.refreshDueBadge();
	}

	private promptNewDeck(parentPath: string): void {
		new DeckPathPromptModal(
			this.app,
			parentPath ? `New subdeck under "${parentPath}"` : "New deck",
			parentPath ? parentPath + "::" : "",
			[],
			(path) => {
				void this.plugin.deckManager
					.createDeck(path)
					.then(() => {
						if (parentPath) this.expanded.add(parentPath);
						return this.refresh();
					})
					.catch((e: Error) => new Notice(e.message, 8000));
			}
		).open();
	}
}
