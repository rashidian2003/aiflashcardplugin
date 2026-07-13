import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type AIFlashcardPlugin from "./main";
import { collectDeckPaths, deckMatches } from "./cardStore";
import { DeckNode, DeckPathPromptModal, DeleteDeckModal, buildDeckTree } from "./deckOps";
import { ReviewModal } from "./reviewModal";
import { isDue } from "./srs";
import { VaultCard, todayISO } from "./types";

export const DASHBOARD_VIEW_TYPE = "afs-dashboard";

const HEATMAP_WEEKS = 16;

function isoOf(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
		d.getDate()
	).padStart(2, "0")}`;
}

/**
 * Read-only overview of the whole flashcard system (Addendum 4B). All stats
 * are aggregated from the existing card scan + review log — review itself
 * always happens in the flip-card ReviewModal, launched per deck from here.
 */
export class DashboardView extends ItemView {
	private retentionWindow = 30;
	/** Which deck-tree nodes are expanded; top level starts expanded. */
	private expanded = new Set<string>();
	private expandedInitialized = false;

	constructor(leaf: WorkspaceLeaf, private plugin: AIFlashcardPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return DASHBOARD_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Flashcard dashboard";
	}

	getIcon(): string {
		return "layout-dashboard";
	}

	async onOpen(): Promise<void> {
		await this.render();
	}

	async render(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("afs-dashboard");

		const header = root.createDiv({ cls: "afs-dash-header" });
		header.createEl("h2", { text: "Flashcard dashboard" });
		const refreshBtn = header.createEl("button", { text: "Refresh" });
		refreshBtn.addEventListener("click", () => void this.refresh());

		const cards = await this.plugin.cardStore.scanVault();
		const log = this.plugin.data.reviewLog;

		this.renderDeckTree(root, cards);
		this.renderForecast(root, cards);
		this.renderRetention(root, cards, log);
		this.renderHeatmap(root, log);
	}

	private async refresh(): Promise<void> {
		this.plugin.cardStore.invalidateCache();
		await this.render();
	}

	// ---- Deck tree (Anki-style, collapsible) ----

	private renderDeckTree(root: HTMLElement, cards: VaultCard[]): void {
		const section = this.section(root, "Decks");
		const tree = buildDeckTree(cards, this.plugin.data.srs);
		const totalDue = cards.filter((c) => isDue(this.plugin.data.srs[c.id])).length;

		if (!this.expandedInitialized) {
			for (const node of tree) this.expanded.add(node.path);
			this.expandedInitialized = true;
		}

		section.createDiv({
			cls: "afs-dash-total",
			text: totalDue > 0 ? `${totalDue} cards due today` : "Nothing due — enjoy the free time 🎉",
		});
		if (tree.length === 0) {
			section.createDiv({ cls: "afs-dash-empty", text: "No cards yet. Create some in the Studio or type `Front :: Back` in any note." });
			return;
		}

		const treeEl = section.createDiv({ cls: "afs-deck-tree" });
		for (const node of tree) this.renderDeckNode(treeEl, node, 0, cards);

		if (totalDue > 0) {
			const allBtn = section.createEl("button", {
				text: "Review all decks",
				cls: "afs-dash-all-btn mod-cta",
			});
			allBtn.addEventListener("click", () => new ReviewModal(this.app, this.plugin).open());
		}
	}

	private renderDeckNode(
		parentEl: HTMLElement,
		node: DeckNode,
		depth: number,
		cards: VaultCard[]
	): void {
		const row = parentEl.createDiv({ cls: "afs-deck-row" });
		row.style.paddingInlineStart = `${depth * 22}px`;

		const chevron = row.createSpan({ cls: "afs-deck-chevron" });
		if (node.children.length > 0) {
			setIcon(chevron, this.expanded.has(node.path) ? "chevron-down" : "chevron-right");
			chevron.addEventListener("click", () => {
				if (this.expanded.has(node.path)) this.expanded.delete(node.path);
				else this.expanded.add(node.path);
				void this.render();
			});
		} else {
			chevron.addClass("afs-deck-chevron-empty");
		}

		row.createSpan({ cls: "afs-dash-deck-name", text: node.name });

		const counts = row.createSpan({ cls: "afs-deck-counts" });
		const count = (value: number, cls: string, label: string) => {
			const el = counts.createSpan({ cls: `afs-deck-count ${cls}`, text: String(value) });
			el.setAttribute("aria-label", label);
		};
		count(node.due, "afs-count-due", "due");
		count(node.newCount, "afs-count-new", "new");
		count(node.learning, "afs-count-learning", "learning");
		count(node.mature, "afs-count-mature", "mature");

		if (node.due > 0) {
			const btn = row.createEl("button", { text: "Review", cls: "afs-deck-review-btn" });
			btn.addEventListener("click", () =>
				new ReviewModal(this.app, this.plugin, node.path).open()
			);
		}

		const moreBtn = row.createSpan({ cls: "afs-deck-more" });
		setIcon(moreBtn, "more-vertical");
		moreBtn.addEventListener("click", (evt) => this.showDeckMenu(evt, node, cards));

		if (this.expanded.has(node.path)) {
			for (const child of node.children) this.renderDeckNode(parentEl, child, depth + 1, cards);
		}
	}

	private showDeckMenu(evt: MouseEvent, node: DeckNode, cards: VaultCard[]): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Rename / move deck…")
				.setIcon("pencil")
				.onClick(() => {
					const decks = collectDeckPaths(cards);
					new DeckPathPromptModal(this.app, "Rename or move deck", node.path, decks, (newPath) => {
						void this.plugin.deckManager
							.renameDeck(node.path, newPath)
							.then(() => this.refresh())
							.catch((e: Error) => new Notice(e.message, 8000));
					}).open();
				})
		);
		menu.addItem((item) =>
			item
				.setTitle("Delete deck…")
				.setIcon("trash")
				.onClick(() => {
					const cardCount = cards.filter((c) => deckMatches(c.deck, node.path)).length;
					new DeleteDeckModal(this.app, node.path, cardCount, (mode) => {
						void this.plugin.deckManager
							.deleteDeck(node.path, mode)
							.then(() => this.refresh())
							.catch((e: Error) => new Notice(e.message, 8000));
					}).open();
				})
		);
		menu.showAtMouseEvent(evt);
	}

	// ---- 7-day forecast ----

	private renderForecast(root: HTMLElement, cards: VaultCard[]): void {
		const section = this.section(root, "Upcoming (next 7 days)");
		const today = todayISO();
		const counts = new Array<number>(7).fill(0);
		const labels: string[] = [];
		const dates: string[] = [];
		const d = new Date();
		for (let i = 0; i < 7; i++) {
			dates.push(isoOf(d));
			labels.push(i === 0 ? "Today" : d.toLocaleDateString(undefined, { weekday: "short" }));
			d.setDate(d.getDate() + 1);
		}
		for (const card of cards) {
			const s = this.plugin.data.srs[card.id];
			const dueDate = s?.due ?? today; // new cards are due now
			if (dueDate <= today) counts[0]++;
			else {
				const idx = dates.indexOf(dueDate);
				if (idx > 0) counts[idx]++;
			}
		}
		const max = Math.max(1, ...counts);
		const chart = section.createDiv({ cls: "afs-dash-chart" });
		counts.forEach((count, i) => {
			const col = chart.createDiv({ cls: "afs-dash-bar-col" });
			col.createDiv({ cls: "afs-dash-bar-value", text: count > 0 ? String(count) : "" });
			const bar = col.createDiv({ cls: "afs-dash-bar" });
			bar.style.height = `${Math.max(count > 0 ? 6 : 2, Math.round((count / max) * 80))}px`;
			col.createDiv({ cls: "afs-dash-bar-label", text: labels[i] });
		});
	}

	// ---- Retention ----

	private renderRetention(
		root: HTMLElement,
		cards: VaultCard[],
		log: { date: string; cardId: string; rating: number }[]
	): void {
		const section = this.section(root, "Retention");

		const selector = section.createEl("select", { cls: "dropdown" });
		for (const w of [7, 30, 90]) {
			selector.createEl("option", { text: `Last ${w} days`, value: String(w) });
		}
		selector.value = String(this.retentionWindow);
		const body = section.createDiv();
		selector.addEventListener("change", () => {
			this.retentionWindow = parseInt(selector.value, 10);
			renderBody();
		});

		const cardDeck = new Map(cards.map((c) => [c.id, c.deck]));
		const renderBody = () => {
			body.empty();
			const cutoff = new Date();
			cutoff.setDate(cutoff.getDate() - this.retentionWindow);
			const cutoffISO = isoOf(cutoff);
			const windowLog = log.filter((r) => r.date >= cutoffISO);

			const pct = (ok: number, total: number) =>
				total === 0 ? "—" : `${Math.round((ok / total) * 100)}%`;
			const ok = windowLog.filter((r) => r.rating >= 2).length;
			body.createDiv({
				cls: "afs-dash-total",
				text: `Overall: ${pct(ok, windowLog.length)} (${windowLog.length} reviews) · Streak: ${this.streak(log)} day(s)`,
			});

			const byDeck = new Map<string, { ok: number; total: number }>();
			for (const r of windowLog) {
				const deck = cardDeck.get(r.cardId) ?? "(deleted cards)";
				const entry = byDeck.get(deck) ?? { ok: 0, total: 0 };
				entry.total++;
				if (r.rating >= 2) entry.ok++;
				byDeck.set(deck, entry);
			}
			const list = body.createDiv({ cls: "afs-dash-deck-list" });
			for (const [deck, { ok: deckOk, total }] of [...byDeck.entries()].sort()) {
				const row = list.createDiv({ cls: "afs-dash-deck-row" });
				row.createSpan({ cls: "afs-dash-deck-name", text: deck });
				row.createSpan({ cls: "afs-dash-deck-count", text: `${pct(deckOk, total)} (${total})` });
			}
		};
		renderBody();
	}

	private streak(log: { date: string }[]): number {
		const days = new Set(log.map((r) => r.date));
		let streak = 0;
		const d = new Date();
		while (days.has(isoOf(d))) {
			streak++;
			d.setDate(d.getDate() - 1);
		}
		return streak;
	}

	// ---- Activity heatmap ----

	private renderHeatmap(root: HTMLElement, log: { date: string }[]): void {
		const section = this.section(root, "Recent activity");
		const perDay = new Map<string, number>();
		for (const r of log) perDay.set(r.date, (perDay.get(r.date) ?? 0) + 1);

		// GitHub-style: columns = weeks, rows = weekdays, ending today.
		const grid = section.createDiv({ cls: "afs-dash-heatmap" });
		const end = new Date();
		const start = new Date();
		start.setDate(end.getDate() - (HEATMAP_WEEKS * 7 - 1) - end.getDay());
		const d = new Date(start);
		for (let week = 0; week <= HEATMAP_WEEKS; week++) {
			const col = grid.createDiv({ cls: "afs-dash-heat-col" });
			for (let day = 0; day < 7; day++) {
				if (d > end) break;
				const count = perDay.get(isoOf(d)) ?? 0;
				const level = count === 0 ? 0 : count < 5 ? 1 : count < 15 ? 2 : count < 30 ? 3 : 4;
				const cell = col.createDiv({ cls: `afs-dash-heat-cell afs-heat-${level}` });
				cell.setAttribute("aria-label", `${isoOf(d)}: ${count} reviews`);
				d.setDate(d.getDate() + 1);
			}
		}
	}

	private section(root: HTMLElement, title: string): HTMLElement {
		const section = root.createDiv({ cls: "afs-dash-section" });
		section.createEl("h3", { text: title });
		return section;
	}
}
