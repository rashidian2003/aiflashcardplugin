import { App, TFile } from "obsidian";
import { CLOZE_RE, CardStore, cardToMarkdown, fnv1a, parseCardsFromMarkdown } from "./cardStore";
import { CardSchedule, CardStyle, VaultCard } from "./types";

/**
 * Editing operations for existing cards (Addendum 7B). Cards ARE note text,
 * so every edit writes back to the underlying markdown. Each operation
 * re-parses the file and relocates the card by id first — never trusting
 * possibly-stale line numbers from an earlier scan — and fails loudly if the
 * card is gone rather than mangling unrelated text.
 *
 * Text-native cards (inline/cloze) are keyed by content hash, so edits re-key
 * them; these helpers migrate the SRS schedule to the new id so review
 * history follows the edit.
 */

export interface CardEdits {
	front: string;
	back: string;
	tags: string[];
	/** For cloze cards: the full raw line including {{cN::…}} markers. */
	rawLine?: string;
}

async function loadCard(
	app: App,
	card: VaultCard
): Promise<{ file: TFile; lines: string[]; fresh: VaultCard }> {
	const file = app.vault.getAbstractFileByPath(card.filePath);
	if (!(file instanceof TFile)) throw new Error(`File not found: ${card.filePath}`);
	const content = await app.vault.read(file);
	const fresh = parseCardsFromMarkdown(content, card.filePath).find((c) => c.id === card.id);
	if (!fresh) {
		throw new Error("This card has changed on disk since it was loaded — refresh and try again.");
	}
	return { file, lines: content.split("\n"), fresh };
}

function migrateSrsKeys(
	srs: Record<string, CardSchedule>,
	remap: Array<[string, string]>
): void {
	for (const [oldId, newId] of remap) {
		if (oldId === newId || !(oldId in srs)) continue;
		srs[newId] = srs[oldId];
		delete srs[oldId];
	}
}

/** Remap every cloze sibling id when a cloze line's text changes. */
function clozeLineRemap(
	srs: Record<string, CardSchedule>,
	oldLine: string,
	newLine: string
): Array<[string, string]> {
	const oldPrefix = `cloze-${fnv1a(oldLine.trim())}-`;
	const newPrefix = `cloze-${fnv1a(newLine.trim())}-`;
	return Object.keys(srs)
		.filter((id) => id.startsWith(oldPrefix))
		.map((id) => [id, newPrefix + id.slice(oldPrefix.length)]);
}

export async function applyCardEdit(
	app: App,
	srs: Record<string, CardSchedule>,
	card: VaultCard,
	edits: CardEdits
): Promise<void> {
	const { file, lines, fresh } = await loadCard(app, card);

	if (fresh.cardType === "inline") {
		const front = edits.front.trim();
		const back = edits.back.trim();
		if (!front || !back) throw new Error("Front and back must both be non-empty.");
		lines.splice(fresh.startLine, 1, `${front} :: ${back}`);
		migrateSrsKeys(srs, [[fresh.id, `inline-${fnv1a(`${front}::${back}`)}`]]);
	} else if (fresh.cardType === "cloze") {
		const rawLine = (edits.rawLine ?? "").trim();
		if (!rawLine) throw new Error("The card text must not be empty.");
		if (![...rawLine.matchAll(CLOZE_RE)].length) {
			throw new Error("The text must keep at least one {{cN::…}} cloze marker.");
		}
		const remap = clozeLineRemap(srs, fresh.rawLine ?? "", rawLine);
		lines.splice(fresh.startLine, 1, rawLine);
		migrateSrsKeys(srs, remap);
	} else {
		// Block card: rebuild the block, keeping the anchored id — no re-key.
		const front = edits.front.trim();
		const back = edits.back.trim();
		if (!front || !back) throw new Error("Front and back must both be non-empty.");
		const block = cardToMarkdown(
			{ front, back, tags: edits.tags, cardType: (fresh.cardType as CardStyle) ?? "basic" },
			fresh.id
		);
		lines.splice(fresh.startLine, fresh.endLine - fresh.startLine + 1, ...block.split("\n"));
	}

	await app.vault.modify(file, lines.join("\n"));
}

/**
 * Delete a card. Block cards: the whole block is removed. Inline cards: the
 * line is removed. Cloze cards: only this card's {{cN::…}} marker is
 * unwrapped back to plain text — sibling clozes on the line survive (and
 * their schedules are migrated to the line's new hash).
 */
export async function deleteCard(
	app: App,
	srs: Record<string, CardSchedule>,
	card: VaultCard
): Promise<void> {
	const { file, lines, fresh } = await loadCard(app, card);

	if (fresh.cardType === "cloze") {
		const oldLine = lines[fresh.startLine];
		const newLine = oldLine.replace(CLOZE_RE, (whole, num: string, answer: string) =>
			parseInt(num, 10) === fresh.clozeIndex ? answer : whole
		);
		delete srs[fresh.id];
		const remap = clozeLineRemap(srs, oldLine, newLine);
		lines.splice(fresh.startLine, 1, newLine);
		migrateSrsKeys(srs, remap);
	} else {
		lines.splice(fresh.startLine, fresh.endLine - fresh.startLine + 1);
		// Collapse the doubled blank line the removal may leave behind.
		if (
			fresh.startLine > 0 &&
			fresh.startLine < lines.length &&
			lines[fresh.startLine - 1].trim() === "" &&
			lines[fresh.startLine].trim() === ""
		) {
			lines.splice(fresh.startLine, 1);
		}
		delete srs[fresh.id];
	}

	await app.vault.modify(file, lines.join("\n"));
}

/**
 * Move a card to another deck by relocating its source text into that deck's
 * file. Ids are content-based, so review history moves with the card for
 * free. For cloze cards the whole line moves — sibling clozes travel together.
 */
export async function moveCardToDeck(
	app: App,
	cardStore: CardStore,
	card: VaultCard,
	targetDeck: string
): Promise<void> {
	const { file, lines, fresh } = await loadCard(app, card);
	const extracted = lines.slice(fresh.startLine, fresh.endLine + 1).join("\n");
	lines.splice(fresh.startLine, fresh.endLine - fresh.startLine + 1);
	if (
		fresh.startLine > 0 &&
		fresh.startLine < lines.length &&
		lines[fresh.startLine - 1].trim() === "" &&
		lines[fresh.startLine].trim() === ""
	) {
		lines.splice(fresh.startLine, 1);
	}
	await app.vault.modify(file, lines.join("\n"));
	await cardStore.appendRawToDeck(targetDeck, extracted + "\n");
}
