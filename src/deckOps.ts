import {
	AbstractInputSuggest,
	App,
	Modal,
	Notice,
	Setting,
	TFile,
	TFolder,
	normalizePath,
} from "obsidian";
import { CardSchedule, VaultCard } from "./types";
import { deckMatches } from "./cardStore";
import { isDue } from "./srs";

const MATURE_DAYS = 21;

// ---------- deck tree (pure, derived from ::-paths — Anki's own approach) ----------

export interface DeckNode {
	name: string;
	path: string;
	children: DeckNode[];
	/** Aggregated over this deck AND all sub-decks. */
	total: number;
	due: number;
	newCount: number;
	learning: number;
	mature: number;
}

export function buildDeckTree(
	cards: VaultCard[],
	srs: Record<string, CardSchedule>,
	/** Deck paths to show even with zero cards (empty decks from the vault). */
	extraPaths: string[] = []
): DeckNode[] {
	const rootChildren: DeckNode[] = [];
	const nodeByPath = new Map<string, DeckNode>();

	const getNode = (path: string): DeckNode => {
		let node = nodeByPath.get(path);
		if (node) return node;
		const parts = path.split("::");
		node = {
			name: parts[parts.length - 1],
			path,
			children: [],
			total: 0,
			due: 0,
			newCount: 0,
			learning: 0,
			mature: 0,
		};
		nodeByPath.set(path, node);
		const siblings =
			parts.length === 1 ? rootChildren : getNode(parts.slice(0, -1).join("::")).children;
		siblings.push(node);
		return node;
	};

	for (const path of extraPaths) {
		if (path) getNode(path);
	}

	for (const card of cards) {
		if (!card.deck) continue;
		const s = srs[card.id];
		const due = isDue(s) ? 1 : 0;
		const isNew = !s || s.reps === 0 ? 1 : 0;
		const mature = s && s.reps > 0 && s.interval >= MATURE_DAYS ? 1 : 0;
		const learning = s && s.reps > 0 && s.interval < MATURE_DAYS ? 1 : 0;
		// Counts roll up: every ancestor of the card's deck sees it.
		const parts = card.deck.split("::");
		for (let i = 1; i <= parts.length; i++) {
			const node = getNode(parts.slice(0, i).join("::"));
			node.total++;
			node.due += due;
			node.newCount += isNew;
			node.learning += learning;
			node.mature += mature;
		}
	}

	const sortRec = (nodes: DeckNode[]) => {
		nodes.sort((a, b) => a.name.localeCompare(b.name));
		nodes.forEach((n) => sortRec(n.children));
	};
	sortRec(rootChildren);
	return rootChildren;
}

// ---------- deck management: rename / move / delete ----------

/**
 * Deck paths are stored implicitly (folder structure under the deck root +
 * frontmatter overrides), so deck operations act on both representations:
 * rename/move the matching folder or file if one exists, and rewrite every
 * `deck:` frontmatter override under the old path. Card review history
 * survives because block ids are anchored and text-native ids are content
 * hashes — neither embeds the path.
 */
export class DeckManager {
	constructor(
		private app: App,
		private getDeckRoot: () => string,
		/** Resolves a file's effective deck — used to find decks backed by notes outside the root. */
		private deckForFile?: (file: TFile) => string
	) {}

	/**
	 * Markdown files OUTSIDE the deck root, without a frontmatter override,
	 * whose derived deck falls under `deckPath` (e.g. a loose "Untitled" note
	 * at the vault root). Deck operations reach these via frontmatter, since
	 * there is no folder to rename.
	 */
	private looseFilesForDeck(deckPath: string): TFile[] {
		if (!this.deckForFile) return [];
		const root = (this.getDeckRoot() || "Flashcards").replace(/^\/+|\/+$/g, "");
		return this.app.vault.getMarkdownFiles().filter((file) => {
			if (file.path === root || file.path.startsWith(root + "/")) return false;
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (typeof fm?.deck === "string" && fm.deck.trim()) return false; // handled via retargetFrontmatter
			return deckMatches(this.deckForFile!(file), deckPath);
		});
	}

	private fsPathFor(deckPath: string): string {
		const root = (this.getDeckRoot() || "Flashcards").replace(/^\/+|\/+$/g, "");
		return normalizePath(`${root}/${deckPath.split("::").join("/")}`);
	}

	private async ensureParentFolders(fsPath: string): Promise<void> {
		const parts = fsPath.split("/").slice(0, -1);
		for (let i = 1; i <= parts.length; i++) {
			const partial = parts.slice(0, i).join("/");
			if (!this.app.vault.getAbstractFileByPath(partial)) {
				await this.app.vault.createFolder(partial).catch(() => {
					/* concurrent creation — fine */
				});
			}
		}
	}

	/** Rewrite frontmatter `deck:` overrides under oldPath to newPath. */
	private async retargetFrontmatter(oldPath: string, newPath: string | null): Promise<number> {
		let changed = 0;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const deck = fm?.deck;
			if (typeof deck !== "string" || !deckMatches(deck.trim(), oldPath)) continue;
			await this.app.fileManager.processFrontMatter(file, (front) => {
				if (newPath === null) delete front.deck;
				else front.deck = newPath + deck.trim().slice(oldPath.length);
			});
			changed++;
		}
		return changed;
	}

	/** Sanitize a user-typed `::` path into safe segments. */
	static cleanPath(path: string): string {
		return path
			.split("::")
			.map((s) => s.replace(/[\\/:*?"<>|]/g, "-").trim())
			.filter(Boolean)
			.join("::");
	}

	/**
	 * Create an empty deck (just the folder chain, no cards) — Anki-style
	 * structure-first workflow. Single source of truth for deck creation:
	 * the Studio picker and the Deck Manager both call this.
	 */
	async createDeck(deckPath: string): Promise<string> {
		const clean = DeckManager.cleanPath(deckPath);
		if (!clean) throw new Error("Deck name is empty.");
		const fsPath = this.fsPathFor(clean);
		await this.ensureParentFolders(fsPath + "/x"); // ensure the chain incl. leaf
		new Notice(`Deck "${clean}" created.`);
		return clean;
	}

	/**
	 * Deck paths present as FOLDERS under the deck root — the structural tree,
	 * including empty decks with no cards yet. Markdown files deliberately do
	 * NOT count here: a stray "Untitled" note in the root is not a deck. Files
	 * that actually contain cards surface through the card scan instead.
	 */
	listDecksFromVault(): string[] {
		const root = (this.getDeckRoot() || "Flashcards").replace(/^\/+|\/+$/g, "");
		const rootFolder = this.app.vault.getAbstractFileByPath(normalizePath(root));
		const paths: string[] = [];
		const walk = (folder: TFolder, prefix: string) => {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					const path = prefix ? `${prefix}::${child.name}` : child.name;
					paths.push(path);
					walk(child, path);
				}
			}
		};
		if (rootFolder instanceof TFolder) walk(rootFolder, "");
		return paths.sort();
	}

	/** Rename or move a deck: `oldPath` → `newPath` (both full `::` paths). */
	async renameDeck(oldPath: string, newPath: string): Promise<void> {
		newPath = DeckManager.cleanPath(newPath);
		if (!newPath || newPath === oldPath) return;
		if (deckMatches(newPath, oldPath)) {
			throw new Error("Cannot move a deck into one of its own sub-decks.");
		}

		const fsOld = this.fsPathFor(oldPath);
		const fsNew = this.fsPathFor(newPath);
		const folder = this.app.vault.getAbstractFileByPath(fsOld);
		const file = this.app.vault.getAbstractFileByPath(fsOld + ".md");
		if (folder instanceof TFolder) {
			await this.ensureParentFolders(fsNew);
			await this.app.fileManager.renameFile(folder, fsNew);
		}
		if (file instanceof TFile) {
			await this.ensureParentFolders(fsNew + ".md");
			await this.app.fileManager.renameFile(file, fsNew + ".md");
		}
		await this.retargetFrontmatter(oldPath, newPath);
		// Loose notes (outside the root) get the new path via frontmatter.
		for (const loose of this.looseFilesForDeck(oldPath)) {
			const currentDeck = this.deckForFile!(loose);
			await this.app.fileManager.processFrontMatter(loose, (fm) => {
				fm.deck = newPath + currentDeck.slice(oldPath.length);
			});
		}
		new Notice(`Deck renamed to "${newPath}".`);
	}

	/**
	 * Delete a deck. mode "trash": files go to the vault trash (recoverable).
	 * mode "toParent": the deck's notes move up into the parent deck instead.
	 */
	async deleteDeck(deckPath: string, mode: "trash" | "toParent"): Promise<void> {
		const fsPath = this.fsPathFor(deckPath);
		const folder = this.app.vault.getAbstractFileByPath(fsPath);
		const file = this.app.vault.getAbstractFileByPath(fsPath + ".md");
		const parentDeck = deckPath.split("::").slice(0, -1).join("::");

		if (mode === "trash") {
			if (folder instanceof TFolder) await this.app.vault.trash(folder, true);
			if (file instanceof TFile) await this.app.vault.trash(file, true);
			for (const loose of this.looseFilesForDeck(deckPath)) {
				await this.app.vault.trash(loose, true);
			}
			await this.retargetFrontmatter(deckPath, null);
			new Notice(`Deck "${deckPath}" moved to trash.`);
			return;
		}

		// toParent: shift contents one level up.
		const parentFs = fsPath.split("/").slice(0, -1).join("/");
		if (folder instanceof TFolder) {
			for (const child of [...folder.children]) {
				await this.app.fileManager.renameFile(
					child,
					normalizePath(`${parentFs}/${child.name}`)
				);
			}
			// Folder is empty now; remove it quietly.
			await this.app.vault.trash(folder, true).catch(() => {});
		}
		if (file instanceof TFile && parentDeck) {
			// A leaf deck file keeps its cards; reassign them via frontmatter.
			await this.app.fileManager.processFrontMatter(file, (front) => {
				front.deck = parentDeck;
			});
		}
		if (parentDeck) {
			for (const loose of this.looseFilesForDeck(deckPath)) {
				await this.app.fileManager.processFrontMatter(loose, (fm) => {
					fm.deck = parentDeck;
				});
			}
		}
		await this.retargetFrontmatter(deckPath, parentDeck || null);
		new Notice(
			parentDeck
				? `Cards from "${deckPath}" moved to "${parentDeck}".`
				: `Deck "${deckPath}" dissolved into the root.`
		);
	}
}

// ---------- small UI helpers ----------

/** Autocomplete over existing deck paths for any text input. */
export class DeckPathSuggest extends AbstractInputSuggest<string> {
	constructor(app: App, private input: HTMLInputElement, private getDecks: () => string[]) {
		super(app, input);
	}
	getSuggestions(query: string): string[] {
		const q = query.toLowerCase();
		return this.getDecks().filter((d) => d.toLowerCase().includes(q));
	}
	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}
	selectSuggestion(value: string): void {
		this.input.value = value;
		this.input.dispatchEvent(new Event("input"));
		this.close();
	}
}

/** Text prompt used for rename/move — pre-filled, with deck autocomplete. */
export class DeckPathPromptModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private initial: string,
		private decks: string[],
		private onSubmit: (value: string) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h3", { text: this.title });
		let value = this.initial;
		new Setting(this.contentEl).setName("Deck path").addText((t) => {
			t.setValue(this.initial).onChange((v) => (value = v));
			new DeckPathSuggest(this.app, t.inputEl, () => this.decks);
			t.inputEl.style.width = "100%";
		});
		this.contentEl.createDiv({
			cls: "afs-hint",
			text: "Use :: for nesting, e.g. Mathematik::Analysis::Grenzwerte — new paths are created automatically.",
		});
		new Setting(this.contentEl)
			.addButton((b) =>
				b
					.setButtonText("Save")
					.setCta()
					.onClick(() => {
						this.close();
						if (value.trim()) this.onSubmit(value.trim());
					})
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Delete confirmation with Anki's choice: trash cards or move them up. */
export class DeleteDeckModal extends Modal {
	constructor(
		app: App,
		private deckPath: string,
		private cardCount: number,
		private onChoose: (mode: "trash" | "toParent") => void
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("h3", { text: `Delete deck "${this.deckPath}"?` });
		this.contentEl.createEl("p", {
			text: `This deck (including sub-decks) contains ${this.cardCount} card${
				this.cardCount === 1 ? "" : "s"
			}. Notes go to the vault trash and can be restored; alternatively move the cards to the parent deck.`,
		});
		const hasParent = this.deckPath.includes("::");
		new Setting(this.contentEl)
			.addButton((b) =>
				b
					.setButtonText("Move cards to trash")
					.setWarning()
					.onClick(() => {
						this.close();
						this.onChoose("trash");
					})
			)
			.addButton((b) =>
				b
					.setButtonText(hasParent ? "Move cards to parent deck" : "Dissolve into root")
					.onClick(() => {
						this.close();
						this.onChoose("toParent");
					})
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
