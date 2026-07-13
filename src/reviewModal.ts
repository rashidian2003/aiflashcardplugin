import { App, Modal, Notice } from "obsidian";
import type AIFlashcardPlugin from "./main";
import { collectDeckPaths, deckMatches } from "./cardStore";
import { renderCardMarkdown } from "./render";
import { Rating, isDue, schedule } from "./srs";
import { CardSchedule, VaultCard, todayISO } from "./types";

/** "3d", "2mo", "1.2y" — Anki-style interval preview shown on rating buttons. */
export function formatIntervalDays(days: number): string {
	if (days <= 0) return "today";
	if (days < 30) return `${days}d`;
	if (days < 365) return `${Math.round(days / 30)}mo`;
	return `${(days / 365).toFixed(1).replace(/\.0$/, "")}y`;
}

export class ReviewModal extends Modal {
	private queue: VaultCard[] = [];
	private allDue: VaultCard[] = [];
	private current: VaultCard | null = null;
	private flipped = false;
	private reviewedCount = 0;
	private deckFilter: string;

	private headerEl!: HTMLElement;
	private cardEl!: HTMLElement;
	private buttonsEl!: HTMLElement;
	private flipEl: HTMLElement | null = null;

	constructor(app: App, private plugin: AIFlashcardPlugin, initialDeck = "") {
		super(app);
		this.deckFilter = initialDeck;
	}

	onOpen(): void {
		this.modalEl.addClass("afs-review-modal");
		const { contentEl } = this;
		contentEl.empty();
		this.headerEl = contentEl.createDiv({ cls: "afs-review-header" });
		this.cardEl = contentEl.createDiv({ cls: "afs-review-card-area" });
		this.buttonsEl = contentEl.createDiv({ cls: "afs-review-buttons" });
		this.cardEl.setText("Loading cards…");

		// Desktop keyboard flow: Space flips, 1-4 rate (Again/Hard/Good/Easy).
		this.scope.register([], " ", (evt) => {
			evt.preventDefault();
			this.toggleFlip();
		});
		const ratings = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];
		ratings.forEach((rating, i) => {
			this.scope.register([], String(i + 1), (evt) => {
				evt.preventDefault();
				if (this.flipped && this.current) void this.rate(rating);
			});
		});

		void this.loadQueue();
	}

	onClose(): void {
		this.contentEl.empty();
		void this.plugin.refreshDueBadge();
	}

	private async loadQueue(): Promise<void> {
		const all = await this.plugin.cardStore.scanVault();
		this.allDue = all.filter((c) => isDue(this.plugin.data.srs[c.id]));
		this.buildHeader(all);
		this.applyFilter();
	}

	private buildHeader(all: VaultCard[]): void {
		this.headerEl.empty();
		this.headerEl.createEl("h2", { text: "Review session" });
		// Every deck path incl. ancestors — picking a parent reviews its sub-decks too.
		const decks = collectDeckPaths(all);
		if (decks.length > 1) {
			const select = this.headerEl.createEl("select", { cls: "dropdown" });
			select.createEl("option", { text: "All decks", value: "" });
			for (const deck of decks) select.createEl("option", { text: deck, value: deck });
			select.value = this.deckFilter;
			select.addEventListener("change", () => {
				this.deckFilter = select.value;
				this.applyFilter();
			});
		}
	}

	private applyFilter(): void {
		this.queue = this.allDue.filter((c) => deckMatches(c.deck, this.deckFilter));
		this.reviewedCount = 0;
		this.next();
	}

	private next(): void {
		this.current = this.queue.shift() ?? null;
		this.flipped = false;
		this.render();
	}

	private toggleFlip(): void {
		if (!this.current || !this.flipEl) return;
		this.flipped = !this.flipped;
		this.flipEl.toggleClass("is-flipped", this.flipped);
		this.buttonsEl.toggleClass("afs-hidden", !this.flipped);
	}

	private render(): void {
		const el = this.cardEl;
		el.empty();
		this.buttonsEl.empty();
		this.buttonsEl.removeClass("afs-hidden");
		this.flipEl = null;

		if (!this.current) {
			this.renderDone();
			return;
		}
		const card = this.current;

		el.createDiv({
			cls: "afs-review-meta",
			text: `${card.deck} · ${this.queue.length + 1} left`,
		});

		// Two stacked faces in one 3D-flipping container; tapping anywhere on
		// the card turns it over (and back — repeated taps just toggle).
		const scene = el.createDiv({ cls: "afs-flip-scene" });
		this.flipEl = scene.createDiv({ cls: "afs-flip" });
		this.flipEl.addEventListener("click", () => this.toggleFlip());

		const frontFace = this.flipEl.createDiv({ cls: "afs-flip-face afs-flip-front" });
		const frontMd = frontFace.createDiv({ cls: "afs-review-front" });
		void renderCardMarkdown(this.app, card.front, frontMd, card.filePath, this.plugin);
		frontFace.createDiv({ cls: "afs-flip-hint", text: "Tap to flip · Space" });

		const backFace = this.flipEl.createDiv({ cls: "afs-flip-face afs-flip-back" });
		const backQ = backFace.createDiv({ cls: "afs-review-back-question" });
		void renderCardMarkdown(this.app, card.front, backQ, card.filePath, this.plugin);
		backFace.createEl("hr");
		const backMd = backFace.createDiv({ cls: "afs-review-back" });
		void renderCardMarkdown(this.app, card.back, backMd, card.filePath, this.plugin);

		// Rating buttons exist from the start but stay hidden until the flip,
		// each previewing the interval that rating would produce.
		this.buttonsEl.addClass("afs-hidden");
		const prev: CardSchedule | undefined = this.plugin.data.srs[card.id];
		const defs: Array<[string, Rating, string]> = [
			["Again", Rating.Again, "afs-again"],
			["Hard", Rating.Hard, "afs-hard"],
			["Good", Rating.Good, "afs-good"],
			["Easy", Rating.Easy, "afs-easy"],
		];
		defs.forEach(([label, rating, cls], i) => {
			const btn = this.buttonsEl.createEl("button", { cls: `afs-rate-btn ${cls}` });
			btn.createDiv({ cls: "afs-rate-label", text: label });
			btn.createDiv({
				cls: "afs-rate-interval",
				text: formatIntervalDays(schedule(prev, rating).interval),
			});
			btn.setAttribute("aria-label", `${label} (${i + 1})`);
			btn.addEventListener("click", () => void this.rate(rating));
		});
	}

	private async rate(rating: Rating): Promise<void> {
		const card = this.current;
		if (!card) return;
		const next = schedule(this.plugin.data.srs[card.id], rating);
		this.plugin.data.srs[card.id] = next;
		this.plugin.data.reviewLog.push({ date: todayISO(), cardId: card.id, rating });
		this.reviewedCount++;
		// Lapsed cards come back at the end of this session.
		if (rating === Rating.Again) this.queue.push(card);
		try {
			await this.plugin.savePluginData();
		} catch (e) {
			new Notice(`Could not save review progress: ${(e as Error).message}`);
		}
		this.next();
	}

	private renderDone(): void {
		const el = this.cardEl;
		const today = todayISO();
		const reviewedToday = this.plugin.data.reviewLog.filter((r) => r.date === today).length;
		el.createDiv({ cls: "afs-review-done", text: "🎉 All done — no more cards due." });
		const stats = el.createDiv({ cls: "afs-review-stats" });
		stats.createDiv({ text: `Reviewed this session: ${this.reviewedCount}` });
		stats.createDiv({ text: `Reviewed today: ${reviewedToday}` });
		stats.createDiv({ text: `Study streak: ${this.streak()} day(s)` });
		const closeBtn = this.buttonsEl.createEl("button", { text: "Close", cls: "mod-cta" });
		closeBtn.addEventListener("click", () => this.close());
	}

	private streak(): number {
		const days = new Set(this.plugin.data.reviewLog.map((r) => r.date));
		let streak = 0;
		const d = new Date();
		for (;;) {
			const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
				d.getDate()
			).padStart(2, "0")}`;
			if (!days.has(iso)) break;
			streak++;
			d.setDate(d.getDate() - 1);
		}
		return streak;
	}
}
