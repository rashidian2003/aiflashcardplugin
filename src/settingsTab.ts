import { App, PluginSettingTab, Setting } from "obsidian";
import type AIFlashcardPlugin from "./main";
import { CardStyle, KNOWN_MODELS, LanguageMode } from "./types";

export class AIFlashcardSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: AIFlashcardPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.data.settings;
		containerEl.empty();

		new Setting(containerEl).setName("Gemini API").setHeading();

		new Setting(containerEl)
			.setName("API key")
			.setDesc(
				"⚠️ Stored in plain text in this vault's plugin data (data.json). " +
					"Don't sync this vault to untrusted services, and never commit data.json to git."
			)
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("AIza…")
					.setValue(s.apiKey)
					.onChange(async (v) => {
						s.apiKey = v.trim();
						await this.plugin.savePluginData();
					});
			});

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Pick a known model or type any Gemini model id — new models work as Google ships them.")
			.addDropdown((dd) => {
				for (const m of KNOWN_MODELS) dd.addOption(m, m);
				dd.addOption("__custom__", "Custom (type below)");
				dd.setValue(KNOWN_MODELS.includes(s.model) ? s.model : "__custom__");
				dd.onChange(async (v) => {
					if (v !== "__custom__") {
						s.model = v;
						await this.plugin.savePluginData();
						this.display();
					}
				});
			})
			.addText((t) =>
				t
					.setPlaceholder("gemini-…")
					.setValue(s.model)
					.onChange(async (v) => {
						if (v.trim()) {
							s.model = v.trim();
							await this.plugin.savePluginData();
						}
					})
			);

		new Setting(containerEl).setName("Generation defaults").setHeading();

		new Setting(containerEl)
			.setName("Default card style")
			.addDropdown((dd) =>
				dd
					.addOptions({
						basic: "Basic (Q&A)",
						cloze: "Cloze deletion",
						definition: "Definition",
						concept: "Concept explanation",
					})
					.setValue(s.defaultCardStyle)
					.onChange(async (v) => {
						s.defaultCardStyle = v as CardStyle;
						await this.plugin.savePluginData();
					})
			);

		new Setting(containerEl)
			.setName("Default language behavior")
			.setDesc("Bilingual mode keeps German technical terms and explains in Persian.")
			.addDropdown((dd) =>
				dd
					.addOptions({
						auto: "Auto-detect source language",
						target: "Force a target language",
						bilingual: "Bilingual (German terms / Persian explanations)",
					})
					.setValue(s.defaultLanguageMode)
					.onChange(async (v) => {
						s.defaultLanguageMode = v as LanguageMode;
						await this.plugin.savePluginData();
					})
			);

		new Setting(containerEl)
			.setName("Default target language")
			.setDesc('Used when language behavior is "Force a target language".')
			.addText((t) =>
				t.setValue(s.defaultTargetLanguage).onChange(async (v) => {
					s.defaultTargetLanguage = v;
					await this.plugin.savePluginData();
				})
			);

		new Setting(containerEl)
			.setName("Chunk size threshold (tokens)")
			.setDesc(
				"Long text is split into chunks of roughly this many tokens before being sent to Gemini. " +
					"On mobile the effective maximum is capped at 3000 to save memory."
			)
			.addText((t) => {
				t.inputEl.type = "number";
				t.setValue(String(s.chunkTokenThreshold)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n >= 500 && n <= 100000) {
						s.chunkTokenThreshold = n;
						await this.plugin.savePluginData();
					}
				});
			});

		new Setting(containerEl).setName("Storage & review").setHeading();

		new Setting(containerEl)
			.setName("Deck root folder")
			.setDesc(
				"Root folder of the deck hierarchy. A deck path like Chemie::Anorganik maps to " +
					"<root>/Chemie/Anorganik.md — folders under this root ARE your deck tree."
			)
			.addText((t) =>
				t
					.setPlaceholder("Flashcards")
					.setValue(s.deckFolder)
					.onChange(async (v) => {
						s.deckFolder = v.trim() || "Flashcards";
						await this.plugin.savePluginData();
					})
			);

		new Setting(containerEl)
			.setName("Suggest flashcard on “→” while typing")
			.setDesc(
				"When you type `Front -> Back` in a note (with spaces around the arrow), a popup offers to turn it into a flashcard."
			)
			.addToggle((tg) =>
				tg.setValue(s.arrowSuggest).onChange(async (v) => {
					s.arrowSuggest = v;
					await this.plugin.savePluginData();
				})
			);

		new Setting(containerEl)
			.setName("Open review queue on startup")
			.setDesc("Automatically open the review session when Obsidian starts and cards are due.")
			.addToggle((tg) =>
				tg.setValue(s.autoOpenReview).onChange(async (v) => {
					s.autoOpenReview = v;
					await this.plugin.savePluginData();
				})
			);
	}
}
