# AI Flashcard Studio

An Obsidian plugin that generates spaced-repetition flashcards from **pasted text, PDFs, your notes, selected text, or photos/screenshots** using the Google Gemini API — then lets you review them with a built-in **SM-2 (Anki-style) scheduler**, fully inside Obsidian.

Works on **desktop and mobile** (Android/iOS): all file access goes through the Obsidian Vault API, all networking through `requestUrl`, and PDFs/images are understood by Gemini server-side, so no Node.js or native libraries are needed anywhere.

## Features

- **AI Studio** modal with five input sources: paste text, vault PDF, current note, editor selection, image (vault, device file, or **camera on mobile** — snap a photo of a printed page).
- **Card styles**: Basic Q&A, cloze deletion, definition, concept-explanation.
- **Language control**: auto-detect, force a target language, or **bilingual mode** — German technical terms kept as-is, explanations in Persian (built for German-lecture / Persian-understanding study workflows).
- **Depth slider**: surface recall ↔ deep understanding.
- **Smart chunking** for long inputs (heading/paragraph boundaries, never mid-sentence), with smaller chunks on mobile to save memory.
- **Preview & edit** every generated card (with include/exclude checkboxes) before anything is written to your vault — nothing is ever saved without confirmation.
- **Plain-Markdown storage**: cards live as readable blocks in normal notes, so search, backlinks and sync all keep working. Scheduling state lives separately in the plugin's data file, keeping notes clean.
- **SM-2 review sessions** with Again / Hard / Good / Easy, per-deck filtering, a due-count badge on the ribbon icon, and simple session stats (reviewed today, streak).
- **Manual RemNote-style cards, no AI needed (fully offline)**:
  - Type `Front :: Back` on any line — the line itself becomes a card, picked up automatically by the review queue (same `::` convention as the Obsidian Spaced Repetition plugin). No save step, no tag needed.
  - Select a word and run **"Make cloze"** (right-click, or `Cmd/Ctrl+Shift+K`) to wrap it as `{{c1::word}}` in place — the sentence stays readable, each `c1`/`c2`/… becomes its own card showing `[...]` for the blanked part during review.
  - **Live bidirectional sync**: these cards *are* the note text — edit the note and the next review shows the updated text. (Materially editing a card's text re-keys its scheduling, since the text is its identity.)
  - `::` lines and cloze spans are subtly highlighted in both Live Preview and Reading mode; raw Markdown in the file is never altered.
- **Click-to-flip review cards**: tap/click anywhere on the card for a 3D flip (500 ms) revealing the answer; rating buttons appear only after the flip and show Anki-style interval previews ("1d", "6d", "2mo") per button. Keyboard: `Space` flips, `1/2/3/4` = Again/Hard/Good/Easy.
- **Dashboard (Übersicht)**: the ribbon badge opens a dashboard with due-today counts per deck (each with a Start Review button), a 7-day due forecast bar chart, per-deck new/learning/mature breakdown (mature = interval ≥ 21 days), retention rate over 7/30/90 days, streak, and a GitHub-style review-activity heatmap — all computed from the existing review log, no chart library.
- **Anki-style nested decks**: every card belongs to a `Parent::Child` deck path. By default the vault's folder structure under your deck root *is* the hierarchy (`Flashcards/Chemie/Anorganik.md` → `Chemie::Anorganik`); a `deck:` frontmatter property overrides it per note. The Studio's deck picker autocompletes existing paths and auto-creates new nested ones (`Mathematik::Analysis::Grenzwerte` just works); the **"Assign note to deck…"** command sets the frontmatter for manually-authored `::`/cloze cards. Reviewing a parent deck includes all sub-decks, the dashboard shows a collapsible deck tree with rolled-up due/new/learning/mature counts, and each deck row has rename/move/delete (delete offers "move cards to parent" or vault trash — never silent loss). Moving or renaming a note keeps its cards' review history: block cards are anchored by `^card-id`, and text-native cards are keyed by their content, not their path.
- **Deck Manager**: a dedicated view (third ribbon icon, or "Open deck manager" command) for structure-first organization like Anki's deck screen — create decks and subdecks **before any cards exist** (empty folders count as decks), with per-row New Subdeck / Rename / Move / Delete actions and card + due counts. Deletion always warns with the exact card count and offers "move cards to parent" instead. The Studio's "New deck…" button uses the same underlying creation logic — one source of truth for deck CRUD.
- **Browse mode (Anki's Browse window)**: in the Deck Manager, click a deck's name to open its card list — every card with a type badge, truncated front text, and per-card edit / move-to-deck / delete (with confirmation; deleting a cloze card only unwraps its `{{cN::…}}` marker, siblings survive). Clicking a card opens a full editor (front, back, tags, deck) with live preview — saving writes straight back into the note's markdown, and re-keyed text cards keep their review history automatically. Every card is editable this way, whether it came from AI generation, `::` syntax, or a cloze — there are no locked cards.
- **Images in cards**: embed vault images with `![[photo.png]]` in any card front/back (or paste them into the note for `::`/cloze cards, as usual in Obsidian) — they render inside the flip-card review UI, the editor preview, and reading mode. Cloze deletions never hide images, only text.
- **Inline selection actions (RemNote-style)**: select text in any note, right-click (long-press on mobile) and choose **"Explain with AI"** — a concise explanation opens in a sliding drawer (right side on desktop, bottom sheet on mobile) without touching the note, with **Copy** and **Insert into note** buttons — or **"Make flashcard with AI"** — one card in the standard `#flashcard` format is inserted right after the selection and immediately enters the review queue. Both honor your default language mode (including bilingual), skip the preview step for speed, and are removed by a single undo.

## Getting a Gemini API key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey) and sign in with a Google account.
2. Click **Create API key** and copy the key (starts with `AIza…`).
3. In Obsidian: **Settings → AI Flashcard Studio → API key** and paste it.

> ⚠️ The key is stored in plain text in `.obsidian/plugins/ai-flashcard-studio/data.json` inside your vault. Don't sync that vault to services you don't trust, and never commit `data.json` to a public repository (this repo's `.gitignore` already excludes it).

The free tier of the Gemini API is enough for normal study use. The default model is `gemini-2.0-flash`; you can pick another or type any model id in settings.

## Installation (manual / unlisted plugin)

Build the plugin, then copy three files into your vault (fish shell):

```fish
cd ai-flashcard-studio
npm install
npm run build

set VAULT ~/path/to/YourVault
mkdir -p $VAULT/.obsidian/plugins/ai-flashcard-studio
cp main.js manifest.json styles.css $VAULT/.obsidian/plugins/ai-flashcard-studio/
```

Then in Obsidian: **Settings → Community plugins → turn off Restricted mode → enable "AI Flashcard Studio."**

For mobile, let your synced vault (Obsidian Sync, iCloud, Syncthing, …) carry the same three files to the device — the plugin runs identically there.

### Development

```fish
cd ai-flashcard-studio
npm install
npm run dev    # watch mode — rebuilds main.js on every change
```

## How cards are stored

Each generated deck is a normal Markdown note in your deck folder (default `Flashcards/`, configurable). Cards are appended, never overwritten:

```markdown
#flashcard
Q: What is Le Chatelier's Principle?
A: When a system at equilibrium is disturbed, it shifts to counteract the disturbance.
Tags: #chemie #gleichgewicht
Type: basic
^card-a1b2c3d4
```

- The `^card-…` anchor is a standard Obsidian block reference, so you can link to individual cards.
- **Decks** = one file per deck; the review UI filters by deck. Tags give you a second axis (e.g. `#chemie`, `#mathe`, `#programmieren`).
- **Scheduling data** (ease, interval, due date, review log) lives in the plugin's `data.json`, keyed by card id — your notes stay clean, and deleting a card's block simply retires it from review.
- You can also write card blocks by hand in any note; the review scanner picks up every `#flashcard` block in the vault.

## Folder structure

```
ai-flashcard-studio/
├── manifest.json        # plugin manifest (isDesktopOnly: false)
├── styles.css           # UI styles (touch-friendly sizing for mobile)
├── esbuild.config.mjs   # build pipeline
├── src/
│   ├── main.ts          # plugin entry: ribbon icons, commands, due badge
│   ├── studioModal.ts   # AI Studio: inputs, controls, preview/edit/save
│   ├── reviewModal.ts   # flip-card review session (Again/Hard/Good/Easy)
│   ├── geminiClient.ts  # Gemini REST client (requestUrl), JSON parsing, retries
│   ├── cardStore.ts     # markdown card format: serialize, parse, vault scan, save
│   ├── srs.ts           # SM-2 scheduling algorithm
│   ├── chunker.ts       # heading/paragraph-aware text chunking
│   ├── settingsTab.ts   # settings UI
│   └── types.ts         # shared types & defaults
└── main.js              # bundled output (generated)
```

## Mobile notes

- `manifest.json` does **not** set `isDesktopOnly` — the plugin loads on Android and iOS.
- The bundle's only external dependency is the `obsidian` API itself (no Node built-ins).
- PDFs and images are sent to Gemini as inline file parts (≤ ~19 MB) — parsing happens server-side, so phones never load a PDF parser.
- On mobile, chunk size is capped at 3000 tokens and the image input offers the camera directly.

## Troubleshooting

- **"Gemini rejected the API key"** — re-copy the key from AI Studio; check for stray spaces.
- **"rate limit / quota exceeded (429)"** — free-tier per-minute limits; wait a minute, or use a lighter model like `gemini-2.0-flash-lite` for big documents.
- **PDF too large** — inline uploads cap around 19 MB; split the PDF (e.g. by chapter) and generate per part.
- **Cards not appearing in review** — the scanner looks for `#flashcard` blocks terminated by a `^card-…` anchor; check the block format if you edited by hand.
