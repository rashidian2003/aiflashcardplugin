import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import { GeneratedCard, VaultCard } from "./types";

/**
 * Three card syntaxes are recognized, unified into one VaultCard type:
 *
 * 1. Block format (used by the AI Studio save path):
 *
 *      #flashcard
 *      Q: What is Le Chatelier's Principle?
 *      A: When a system at equilibrium is disturbed, it shifts to counteract it.
 *      Tags: #chemie
 *      Type: basic
 *      ^card-a1b2c3d4
 *
 * 2. RemNote/Obsidian-SR style inline cards — the line itself is the card:
 *
 *      Le Chatelier :: system shifts to counteract a disturbance
 *
 * 3. Anki-style cloze deletions, several per line allowed:
 *
 *      Das {{c1::chemische Gleichgewicht}} ist {{c2::dynamisch}}.
 *
 * Inline and cloze cards carry no stored id; their SRS identity is a hash of
 * the card text alone (deliberately NOT the file path, so review history
 * survives moving/renaming the note between decks — Addendum 5). Editing the
 * text re-keys the card: the note text IS the card (RemNote philosophy), and
 * a materially changed card starts fresh in the scheduler. Identical card
 * text in two notes shares one schedule.
 *
 * Decks (Anki-style `Parent::Child` paths):
 * - default: derived from the file's location under the configured deck root,
 *   e.g. root "Flashcards" + file "Flashcards/Chemie/Anorganik.md" →
 *   deck "Chemie::Anorganik";
 * - override: a `deck: Chemie::Toxikologie` frontmatter property assigns every
 *   card in that note to the given deck path explicitly.
 */

export function newCardId(): string {
	return "card-" + Math.random().toString(36).slice(2, 10);
}

/** FNV-1a 32-bit — tiny stable hash for text-native card ids. */
export function fnv1a(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

export const CLOZE_RE = /\{\{c(\d+)::(.+?)\}\}/g;

/**
 * Position of the `::` separator of an inline card in `line`, or -1.
 * Ignores separators inside `inline code` and cloze `{{cN::…}}` markers.
 */
export function findInlineSeparator(line: string): number {
	// Blank out code spans and cloze bodies so their :: don't match.
	const masked = line
		.replace(/`[^`]*`/g, (m) => " ".repeat(m.length))
		.replace(CLOZE_RE, (m) => " ".repeat(m.length));
	let idx = -1;
	for (let i = 0; (i = masked.indexOf("::", i)) !== -1; i += 2) {
		const front = masked.slice(0, i).trim();
		const back = masked.slice(i + 2).trim();
		if (front.length > 0 && back.length > 0) {
			idx = i;
			break;
		}
	}
	return idx;
}

/** Derive an Anki-style `A::B::C` deck path from a vault file path. */
export function deckFromPath(filePath: string, deckRoot: string): string {
	let rel = filePath;
	const root = (deckRoot || "").replace(/^\/+|\/+$/g, "");
	if (root && (filePath === root || filePath.startsWith(root + "/"))) {
		rel = filePath.slice(root.length).replace(/^\/+/, "");
	}
	return rel.replace(/\.md$/i, "").split("/").filter(Boolean).join("::");
}

/** Anki parent-deck semantics: `filter` matches itself and all sub-decks. */
export function deckMatches(cardDeck: string, filter: string): boolean {
	if (!filter) return true;
	return cardDeck === filter || cardDeck.startsWith(filter + "::");
}

/** All deck paths present in `cards`, plus every ancestor path, sorted. */
export function collectDeckPaths(cards: { deck: string }[]): string[] {
	const paths = new Set<string>();
	for (const card of cards) {
		const parts = card.deck.split("::");
		for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join("::"));
	}
	return [...paths].filter(Boolean).sort();
}

function lineTags(line: string): string[] {
	return [...line.matchAll(/#([\p{L}\p{N}_/-]+)/gu)]
		.map((m) => m[1])
		.filter((t) => t !== "flashcard");
}

export function cardToMarkdown(card: GeneratedCard, id: string): string {
	const lines = ["#flashcard", `Q: ${card.front}`, `A: ${card.back}`];
	if (card.tags.length > 0) lines.push("Tags: " + card.tags.map((t) => `#${t}`).join(" "));
	lines.push(`Type: ${card.cardType}`, `^${id}`);
	return lines.join("\n");
}

export function parseCardsFromMarkdown(
	content: string,
	filePath: string,
	deck?: string
): VaultCard[] {
	const lines = content.split("\n");
	deck = deck ?? deckFromPath(filePath, "");
	const consumed = new Array<boolean>(lines.length).fill(false);

	const cards = parseBlockCards(lines, filePath, deck, consumed);

	// Pass 2: text-native cards (inline `::` and cloze) on lines not already
	// part of a #flashcard block, skipping fenced code blocks and headings.
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		if (consumed[i]) continue;
		const line = lines[i];
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence || /^#{1,6}\s/.test(line) || !line.trim()) continue;

		const sep = findInlineSeparator(line);
		if (sep !== -1) {
			const front = line.slice(0, sep).trim().replace(/^[-*+]\s+/, "");
			const back = line.slice(sep + 2).trim();
			cards.push({
				id: `inline-${fnv1a(`${front}::${back}`)}`,
				front,
				back,
				tags: lineTags(line),
				cardType: "inline",
				filePath,
				deck,
				startLine: i,
				endLine: i,
			});
			continue; // a `::` line is one card; don't also cloze-parse it
		}

		const clozes = [...line.matchAll(CLOZE_RE)];
		if (clozes.length === 0) continue;
		const plain = line.replace(CLOZE_RE, (_, _n, answer: string) => answer).trim();
		const lineKey = fnv1a(line.trim());
		for (const match of clozes) {
			const n = match[1];
			// Front: target cloze blanked, siblings revealed. Back: target highlighted.
			const front = line
				.replace(CLOZE_RE, (_, num: string, answer: string) =>
					num === n ? "**[...]**" : answer
				)
				.trim()
				.replace(/^[-*+]\s+/, "");
			const back = line
				.replace(CLOZE_RE, (_, num: string, answer: string) =>
					num === n ? `==${answer}==` : answer
				)
				.trim()
				.replace(/^[-*+]\s+/, "");
			cards.push({
				id: `cloze-${lineKey}-c${n}`,
				front,
				back: back || plain,
				tags: lineTags(line),
				cardType: "cloze",
				filePath,
				deck,
				startLine: i,
				endLine: i,
				clozeIndex: parseInt(n, 10),
				rawLine: line,
			});
		}
	}
	return cards;
}

function parseBlockCards(
	lines: string[],
	filePath: string,
	deck: string,
	consumed: boolean[]
): VaultCard[] {
	const cards: VaultCard[] = [];
	let i = 0;
	while (i < lines.length) {
		if (lines[i].trim() !== "#flashcard") {
			i++;
			continue;
		}
		// Collect the block until its ^card-... anchor (or give up at blank #flashcard restart).
		let front = "";
		let back = "";
		let tags: string[] = [];
		let cardType = "basic";
		let id = "";
		let field: "front" | "back" | null = null;
		let j = i + 1;
		for (; j < lines.length; j++) {
			const line = lines[j];
			const anchor = line.trim().match(/^\^(card-[a-z0-9]+)$/);
			if (anchor) {
				id = anchor[1];
				break;
			}
			if (line.trim() === "#flashcard") break; // malformed block: restart
			if (line.startsWith("Q: ")) {
				front = line.slice(3);
				field = "front";
			} else if (line.startsWith("A: ")) {
				back = line.slice(3);
				field = "back";
			} else if (line.startsWith("Tags: ")) {
				tags = line
					.slice(6)
					.split(/\s+/)
					.map((t) => t.replace(/^#/, ""))
					.filter((t) => t.length > 0);
				field = null;
			} else if (line.startsWith("Type: ")) {
				cardType = line.slice(6).trim();
				field = null;
			} else if (field === "front") {
				front += "\n" + line;
			} else if (field === "back") {
				back += "\n" + line;
			}
		}
		if (id && front.trim() && back.trim()) {
			cards.push({
				id,
				front: front.trim(),
				back: back.trim(),
				tags,
				cardType,
				filePath,
				deck,
				startLine: i,
				endLine: j,
			});
			for (let k = i; k <= j; k++) consumed[k] = true;
			i = j + 1;
		} else {
			i = i + 1;
		}
	}
	return cards;
}

const SCAN_CACHE_TTL_MS = 15_000;

export class CardStore {
	private scanCache: { cards: VaultCard[]; at: number } | null = null;

	constructor(private app: App, private getDeckRoot: () => string) {}

	/**
	 * Deck path for a file: frontmatter `deck:` override, else folder-derived
	 * for files under the deck root. Notes elsewhere in the vault get just
	 * their basename as a flat deck — their unrelated folder structure must
	 * not leak into the deck tree.
	 */
	deckForFile(file: TFile): string {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const override = fm?.deck;
		if (typeof override === "string" && override.trim()) {
			return override
				.split("::")
				.map((s: string) => s.trim())
				.filter(Boolean)
				.join("::");
		}
		const root = (this.getDeckRoot() || "").replace(/^\/+|\/+$/g, "");
		if (root && (file.path === root || file.path.startsWith(root + "/"))) {
			return deckFromPath(file.path, root);
		}
		return file.basename;
	}

	/**
	 * Scan every markdown file in the vault for all three card syntaxes.
	 * Results are cached briefly since the badge, dashboard and review queue
	 * often ask in quick succession.
	 */
	async scanVault(force = false): Promise<VaultCard[]> {
		if (!force && this.scanCache && Date.now() - this.scanCache.at < SCAN_CACHE_TTL_MS) {
			return this.scanCache.cards;
		}
		const cards: VaultCard[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const content = await this.app.vault.cachedRead(file);
			// Cheap pre-filter: skip files that can't contain any card syntax.
			if (
				!content.includes("#flashcard") &&
				!content.includes("::")
			) {
				continue;
			}
			cards.push(...parseCardsFromMarkdown(content, file.path, this.deckForFile(file)));
		}
		this.scanCache = { cards, at: Date.now() };
		return cards;
	}

	invalidateCache(): void {
		this.scanCache = null;
	}

	/**
	 * Append cards to the file of deck `deckPath` (an Anki-style `A::B::C`
	 * path), creating the folder chain and file under the deck root as needed —
	 * typing a new nested path auto-creates that deck. Purely additive.
	 * Returns the ids assigned to the saved cards.
	 */
	async saveCards(cards: GeneratedCard[], deckPath: string): Promise<string[]> {
		const ids: string[] = [];
		const blocks = cards.map((card) => {
			const id = newCardId();
			ids.push(id);
			return cardToMarkdown(card, id);
		});
		const filePath = await this.appendRawToDeck(deckPath, blocks.join("\n\n") + "\n");
		new Notice(`Saved ${cards.length} card${cards.length === 1 ? "" : "s"} to ${filePath}`);
		return ids;
	}

	/**
	 * Append raw markdown (already-formatted card text) to the deck's file,
	 * creating the folder chain and file as needed. Shared by the Studio save
	 * path and card moves. Returns the deck file's path.
	 */
	async appendRawToDeck(deckPath: string, payload: string): Promise<string> {
		const root = (this.getDeckRoot() || "Flashcards").replace(/^\/+|\/+$/g, "");
		const segments = deckPath
			.split("::")
			.map((s) => s.replace(/[\\/:*?"<>|]/g, "-").trim())
			.filter(Boolean);
		// Never invent placeholder names — a real deck name is required.
		if (segments.length === 0) throw new Error("Enter a deck name before saving.");
		const fileName = segments.pop()!;

		// Create the folder chain root/A/B one level at a time.
		let folderPath = root;
		const folderChain = [root, ...segments];
		for (let i = 0; i < folderChain.length; i++) {
			folderPath = normalizePath(folderChain.slice(0, i + 1).join("/"));
			const existing = this.app.vault.getAbstractFileByPath(folderPath);
			if (!existing) {
				await this.app.vault.createFolder(folderPath).catch(() => {
					/* created concurrently — fine */
				});
			} else if (!(existing instanceof TFolder)) {
				throw new Error(`"${folderPath}" exists but is not a folder.`);
			}
		}

		const filePath = normalizePath(`${folderPath}/${fileName}.md`);
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile) {
			const current = await this.app.vault.read(file);
			const sep = current.endsWith("\n") ? "\n" : "\n\n";
			await this.app.vault.modify(file, current + sep + payload);
		} else if (file) {
			throw new Error(`"${filePath}" exists but is not a markdown file.`);
		} else {
			await this.app.vault.create(filePath, `# ${fileName}\n\n${payload}`);
		}
		this.invalidateCache();
		return filePath;
	}
}
