# PDF Search in Note

An Obsidian plugin that searches **only the PDFs in the note you have open**, not your whole vault.
It works on **Android, iPhone/iPad and desktop**.

Open a note that embeds or links a PDF, run **Search PDFs in current note**, start typing, and tap a result to jump straight to that page.

## Features

- Finds PDFs that are embedded (`![[handout.pdf]]`), wiki-linked (`[[handout.pdf]]`), Markdown-linked (`[handout](handout.pdf)`) or linked in frontmatter.
- If a note has several PDFs, you can search all of them or pick one from a dropdown.
- If the open file is a PDF itself, it searches that PDF.
- Shows results as you type, with the page number and a highlighted snippet.
- Tap or click a result to open the PDF at that page. If the PDF is already open in a tab, that tab is reused.
- Finds phrases even when the PDF breaks them across lines, and handles Chinese text where PDFs often insert stray spaces. You can turn this off in settings.
- Remembers your last search for the note, so you can jump to a page, come back and pick the next result.
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

Press **Enter** to open the first result.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Ignore spaces and line breaks | On | Robust matching across line wraps and for Chinese text. Turn off to match spacing exactly. |
| Maximum results | 300 | Stops after this many matches. |
| Snippet length | 50 | Characters of context shown on each side of a match. |
| Open results in a new tab (desktop) | On | On mobile, results open in the current tab. Use Back to return. |

## Notes

- The first search in a PDF reads its text. Large PDFs can take a few seconds on a phone, and a progress message shows while this happens. After that, searches are instant until you close Obsidian.
- Scanned PDFs need a text layer. Run OCR on them first, for example with Adobe Acrobat, or with OCRmyPDF on a PC.

## Development

```bash
npm install
npm test        # unit tests for the matching logic
npm run build   # produces main.js
npm run dev     # rebuilds on change
```

To publish a new version, bump `version` in `manifest.json`, `package.json` and `versions.json`, commit, and push a tag with the same number (for example `0.1.1`). GitHub Actions builds the files and creates the release.
