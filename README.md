# PDF Search in Note

An Obsidian plugin that searches **only the PDFs in the note you have open**, not your whole vault.
It works on **Android, iPhone/iPad and desktop**.

Open a note that embeds or links a PDF, run **Search PDFs in current note**, start typing, and tap a result to jump straight to that page.

## Features

- Finds PDFs that are embedded (`![[handout.pdf]]`), wiki-linked (`[[handout.pdf]]`), Markdown-linked (`[handout](handout.pdf)`) or linked in frontmatter.
- If a note has several PDFs, you can search all of them or pick one from a dropdown.
- If the open file is a PDF itself, it searches that PDF.
- Shows results as you type, with the page number and a highlighted snippet.
- Tap or click a result to open the PDF at that page, with the matched words **highlighted** on the page. The highlight stays in place when you zoom in or out. If the PDF is already open in a tab, that tab is reused.
- Finds phrases even when the PDF breaks them across lines, and handles Chinese text where PDFs often insert stray spaces. You can turn this off in settings.
- After you open a result, a **◀ 3 / 12 ▶** bar over the PDF steps through every match: across pages, and across PDFs when the note has several. It also has buttons to go back to the results list or close the bar.
- **Go to next match** and **Go to previous match** commands, for hotkeys (for example `F3` / `Shift+F3`) or the mobile toolbar.
- Remembers your last search for the note.
- Warns you when a PDF is a scanned image with no text layer (it needs OCR first).

## Install

### Android (and iPhone/iPad) using BRAT

1. In Obsidian, go to **Settings → Community plugins**, turn off Restricted mode, and install **BRAT** (by TfTHacker). Enable it.
2. Open **Settings → BRAT → Add beta plugin**.
3. Paste `wangsherman2010-code/search-in-pdf-Obsidian` and choose **Add plugin**.
4. Go to **Settings → Community plugins** and enable **PDF Search in Note**.

Do the same on your PC, or use the manual method below. BRAT can also keep the plugin updated.

### PC (manual)

1. Download `main.js`, `manifest.json` and `styles.css` from the latest [release](https://github.com/wangsherman2010-code/search-in-pdf-Obsidian/releases).
2. Put them in `<your vault>/.obsidian/plugins/pdf-search-in-note/`.
3. Restart Obsidian, then enable **PDF Search in Note** under **Settings → Community plugins**.

If you use Obsidian Sync or another sync service that syncs the `.obsidian` folder, installing on one device can carry the plugin to the others.

## How to use

- **Ribbon icon:** tap the 🔍 file-search icon. On Android it's in the left sidebar or the toolbar menu.
- **Command palette:** run **PDF Search in Note: Search PDFs in current note**.
- **Mobile toolbar:** *Settings → Toolbar* lets you add the command for one-tap access.
- **Desktop hotkey:** *Settings → Hotkeys* lets you bind a hotkey, for example `Ctrl+Shift+F`.

Press **Enter** to open the first result. Then use the **◀ ▶** bar at the bottom of the PDF to move between matches.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Ignore spaces and line breaks | On | Robust matching across line wraps and for Chinese text. Turn off to match spacing exactly. |
| Maximum results | 300 | Stops after this many matches. |
| Snippet length | 50 | Characters of context shown on each side of a match. |
| Highlight the match in the PDF | On | Selects the matched words when a result opens. |
| Hide Obsidian's search button in the mobile bottom bar | Off | Hides the magnifying glass in Obsidian's bottom bar on phones, which searches the vault rather than the PDF. |
| Save extracted text | On | Keeps each PDF's text so later searches start instantly. *Clear saved text* frees the space. |
| Open results in a new tab (desktop) | On | On mobile, results open in the current tab. Use Back to return. |

## Notes

- The first search in a PDF reads its text. Large PDFs can take a few seconds on a phone, and a progress message shows while this happens. The text is then saved in `.obsidian/plugins/pdf-search-in-note/saved-text/`, so later searches are instant, even after a restart. Saved text is matched by a fingerprint of the PDF's contents, so it carries across synced devices and renames, and an edited PDF is read again automatically. You can clear it in settings at any time.
- Scanned PDFs need a text layer. Run OCR on them first, for example with Adobe Acrobat, or with OCRmyPDF on a PC.

## Development

```bash
npm install
npm test        # unit tests for the matching logic
npm run build   # produces main.js
npm run dev     # rebuilds on change
```

To publish a new version, bump `version` in `manifest.json`, `package.json` and `versions.json`, then commit and push to `main`. GitHub Actions builds the plugin and creates a release for that version automatically.
