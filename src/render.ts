import { App, Component, MarkdownRenderer, TFile } from "obsidian";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic", "avif"];

/**
 * Render card markdown with working `![[image.png]]` embeds (Addendum 7C).
 * MarkdownRenderer.render leaves internal embeds as placeholder spans outside
 * a real markdown view, so image embeds are resolved to <img> tags manually
 * via the vault's resource URLs. Works identically on mobile.
 */
export async function renderCardMarkdown(
	app: App,
	markdown: string,
	el: HTMLElement,
	sourcePath: string,
	component: Component
): Promise<void> {
	await MarkdownRenderer.render(app, markdown, el, sourcePath, component);
	for (const embed of Array.from(el.querySelectorAll<HTMLElement>(".internal-embed"))) {
		const src = embed.getAttribute("src");
		if (!src) continue;
		const file = app.metadataCache.getFirstLinkpathDest(src, sourcePath);
		if (!(file instanceof TFile) || !IMAGE_EXTS.includes(file.extension.toLowerCase())) continue;
		const img = document.createElement("img");
		img.src = app.vault.getResourcePath(file);
		img.className = "afs-card-img";
		img.alt = file.name;
		embed.replaceWith(img);
	}
}
