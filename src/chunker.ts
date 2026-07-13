/**
 * Rough token estimate: ~4 characters per token works well enough for
 * chunk-size decisions across Latin scripts; Persian/Arabic scripts run a
 * little denser but the margin in the default threshold absorbs that.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Split long text into chunks of at most `maxTokens` (approximate), preferring
 * markdown heading boundaries, then blank-line (paragraph) boundaries, then
 * sentence boundaries. Never splits mid-sentence unless a single sentence
 * exceeds the limit.
 */
export function chunkText(text: string, maxTokens: number): string[] {
	if (estimateTokens(text) <= maxTokens) return [text];

	const maxChars = maxTokens * 4;
	const sections = splitKeepingDelimiter(text, /^#{1,6}\s/m);
	const chunks: string[] = [];
	let current = "";

	const flush = () => {
		const trimmed = current.trim();
		if (trimmed.length > 0) chunks.push(trimmed);
		current = "";
	};

	const pieces: string[] = [];
	for (const section of sections) {
		if (section.length <= maxChars) {
			pieces.push(section);
		} else {
			// Section itself too big: fall back to paragraphs, then sentences.
			for (const para of section.split(/\n\s*\n/)) {
				if (para.length <= maxChars) {
					pieces.push(para + "\n\n");
				} else {
					for (const sentence of para.split(/(?<=[.!?؟。])\s+/)) {
						pieces.push(sentence + " ");
					}
				}
			}
		}
	}

	for (const piece of pieces) {
		if (current.length + piece.length > maxChars && current.length > 0) flush();
		current += piece;
		// A single piece longer than the limit gets emitted as its own chunk.
		if (current.length > maxChars) flush();
	}
	flush();

	return chunks.length > 0 ? chunks : [text];
}

/** Split text before each match of `re` (multiline anchor), keeping content. */
function splitKeepingDelimiter(text: string, re: RegExp): string[] {
	const lines = text.split("\n");
	const sections: string[] = [];
	let current: string[] = [];
	for (const line of lines) {
		if (re.test(line) && current.length > 0) {
			sections.push(current.join("\n") + "\n");
			current = [];
		}
		current.push(line);
	}
	if (current.length > 0) sections.push(current.join("\n"));
	return sections;
}
