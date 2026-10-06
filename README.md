# AI Form Filler Assistant

A Manifest V3 Chrome extension that fills web forms with AI-generated content.
Bring your own API key (Gemini, OpenAI, or any OpenAI-compatible endpoint) and the
extension writes sensible values into text inputs, textareas, standard `<select>`
dropdowns, and modern React/Tailwind custom dropdowns.

---

## Features

**Two fill modes**

| Button | When it appears | What it does |
| --- | --- | --- |
| ✨ AI Fill | Hover over or focus any text field | Fills just that one field |
| ⚡ Fill All Fields | Always pinned bottom-right (drag to move) | Batch-fills every visible field on the page |

**Multi-provider**

- **Google Gemini** — 13 models. Default: `gemini-3.5-flash-lite`. Also includes
  `gemini-2.5-flash`, the Gemini 3.x Flash family (`gemini-3.8-flash` down to
  `gemini-3-flash`), Flash-Lite variants, `gemini-2.5-pro`, `gemini-3.1-pro-preview`
  and the `gemini-1.5-*` legacy entries
- **OpenAI (Official)** — `gpt-4o-mini` (default), `gpt-4o`, `gpt-3.5-turbo`
- **OpenAI Compatible / Custom API** — OpenRouter, Groq, Together AI, DeepSeek,
  Ollama, LM Studio, vLLM, or any server exposing `POST {base}/chat/completions`

**Dropdown intelligence**

- Reads the full `<option>` list from native `<select>` elements
- Detects custom comboboxes via `role="combobox"`, `aria-haspopup="listbox"`, and
  `select`/`dropdown` class names — including portals and virtualized popups
- Opens closed dropdowns at collect time so the model sees the real option list
- Only ever selects values that already exist in the list (placeholders, disabled
  items, and "Add new…" action rows are excluded). If the model asks for something
  absent, the closest existing option is used and reported back to you
- Filters through popup search boxes for server-filtered lists like "Search clients…"

**Framework compatibility**

Every write dispatches synthetic `input` + `change` events (plus `click` for custom
dropdowns), using the native value setter, so React, Vue, and Angular all detect
the change. Contenteditable / rich-text editors are supported too.

**Other details**

- All API calls run in the service worker, never from page scripts
- **Randomize values** toggle — a fresh persona anchor per run, so repeated runs
  return different data (see [Privacy & data storage](#privacy-and-data-storage))
- Draggable ⚡ button — grab it anywhere; the position is remembered per device
- Styled toast notifications instead of blocking browser dialogs
- Dark / light theme, minimal Vercel-style settings UI
- **In-app update checker** — compares your installed version against the latest
  GitHub release

---

## Installation

### From GitHub Releases

1. Open the repository's **Releases** page.
2. Download the latest release's `.zip` (Source code archives work too).
3. Unzip it anywhere on your computer.
4. Open Chrome and go to `chrome://extensions`.
5. Enable **Developer mode** (top-right toggle).
6. Click **Load unpacked** and select the unzipped folder (the one containing
   `manifest.json`).
7. Pin the extension: click the puzzle-piece icon in the toolbar and pin
   *AI Form Filler Assistant*.

### Configure your API key

1. Click the extension icon in the toolbar (this opens the settings page directly).
2. Choose a **Provider**.
3. Paste your key, pick a **Model**, and click **Save & Test** — this saves your
   settings and verifies the connection in one step.
4. A green confirmation means you are ready to fill forms.

Get a key:

| Provider | Where |
| --- | --- |
| Gemini | <https://aistudio.google.com/app/apikey> |
| OpenAI | <https://platform.openai.com/api-keys> |
| OpenRouter | <https://openrouter.ai/keys> |
| Groq | <https://console.groq.com/keys> |
| DeepSeek | <https://platform.deepseek.com/api_keys> |

> **Your key is never sent anywhere except the provider you selected.** It is read
> only by the extension's service worker, which sends it to that provider's API to
> make your request. It is never exposed to page scripts and never logged.
> Do not paste keys into chat, issues, or commits.

---

## Privacy and data storage

This section is deliberately precise, because the difference matters.

**Where your key is stored**

Keys are saved with `chrome.storage.sync`. Two consequences matter:

1. **They are not end-to-end encrypted.** Chrome syncs this data to the Google
   account attached to your browser profile. Anyone who can access that profile —
   including on any device you are signed into — can read the stored value.
2. **`sync` means "across your devices", not "local only".** Sign into the same
   Google account on another machine and your settings come with you (after you
   load the extension there, since unpacked extensions themselves are not synced).

What is **not** synced: the ⚡ button position (kept in `chrome.storage.local`) and
the in-memory list of recently used values behind Randomize, which never leaves the
tab and is discarded on reload.

**If you prefer keys on a single machine**, they can be moved to
`chrome.storage.local` so they never sync — the trade-off is re-entering them on
each new device.

**What goes where**

| Data | Sent to |
| --- | --- |
| Your API key | The provider you selected, from the service worker |
| Field labels, placeholders, surrounding form text, page title and URL | The same provider, inside the prompt, so it can generate realistic values |

There is no analytics or telemetry. Declared host permissions are limited to the
provider APIs plus `api.github.com` for the update check; custom API hosts are
requested on demand, only when you enter one.

---

### Using the OpenAI-compatible option

Pick **OpenAI Compatible / Custom API**, then set:

- **API Base URL** — the `v1`-style base, without `/chat/completions`.
  Examples:
  - `https://openrouter.ai/api/v1` (OpenRouter)
  - `https://api.groq.com/openai/v1` (Groq)
  - `https://api.deepseek.com/v1` (DeepSeek)
  - `http://localhost:11434/v1` (Ollama)
- **Model Name** — your provider's model id, e.g. `deepseek/deepseek-chat`,
  `llama-3.3-70b-versatile`, `mistral-7b-instruct`, `llama3.1:8b`

The extension requests `{base}/chat/completions`. Leave the API key blank for local
servers like Ollama — no `Authorization` header is sent when the field is empty.
On the first save, Chrome asks you to allow access to that host.

---

## Usage

**Fill one field** — hover over or focus any text field; the ✨ AI Fill button appears
next to it. Click to generate content from the field's label, placeholder, ARIA text,
surrounding form text, and page context.

**Fill the whole form** — click ⚡ Fill All Fields. All visible text inputs, textareas,
and dropdowns are collected, sent as one batch request, and filled. The summary tells
you how many fields were filled and flags any dropdown that needed a substitute value.

The ⚡ button is draggable — grab it anywhere and drop it in a convenient corner. Its
position is remembered per device.

**Fields that are skipped:** `password`, `file`, `hidden`, `checkbox`, `radio`,
`submit`, `button`, `reset`, `image`, `range`, `color`, plus disabled and read-only
inputs.

---

## Options

The settings page is intentionally small. Everything it contains:

| Control | What it does |
| --- | --- |
| Theme toggle | Light / dark. Saved, and initialised from your OS preference |
| **Provider** | Gemini, OpenAI, or a custom OpenAI-compatible endpoint |
| **Base URL** + **Model** | Shown only for the custom provider |
| **API Key** | Per provider, so switching providers does not lose your other keys |
| Eye icon | Shows or hides the key while typing |
| **Save & Test** | Saves everything, then verifies the connection — one click |
| **Remove** | Clears the key for the active provider only |
| **Randomize values** | See below |
| **Check updates** | Compares your version against the latest GitHub release |

### Randomize values

**On (default)** — each run gets a random but internally consistent anchor (a person,
a company, an industry, a city, a project), and the previous run's values are sent as
a "do not repeat these" list. Every ✨ and ⚡ run therefore returns different names,
numbers and text, which is what you usually want when testing a form or seeding demo
data.

**Off** — no anchor is injected and the output temperature is lower, so the model
falls back to its most typical answer. Use this when you want predictable values, or
when filling a real form where you do not want existing entries overwritten.

Dropdowns are unaffected either way: their value must come from the fixed option list,
so they stay the same by design.

---

## Updating

1. Download the new release and unzip it (or replace the files in your existing
   folder).
2. Go to `chrome://extensions`.
3. Find *AI Form Filler Assistant* and click the **↻ Reload** button.

Or use the built-in checker: **Options → Updates → Check for Updates**. It reports
either `✅ Up to date (vX.Y.Z)` or `🚀 New Version Available!` with a download link.

> After reloading the extension, refresh any already-open tabs (Ctrl+R). Chrome
> disconnects old tabs from an updated extension; the extension tells you if this
> happens. Your saved keys and settings are preserved.

---

## Project structure

```
ai-form-filler/
├── manifest.json      # MV3 manifest
├── background.js      # Service worker: provider router, Gemini/OpenAI/compatible calls,
│                      #   GitHub update check, dynamic toolbar icon
├── content.js         # DOM layer: floating buttons, context extraction,
│                      #   dropdown handling, framework-safe value insertion
├── options.html       # Settings UI
├── options.js         # Settings logic: provider/model/key state, update checker
├── style.css          # Options design system (light + dark themes)
├── icons/             # active/idle PNG sets (16/48/128)
└── README.md
```

### Architecture notes

- **All network calls live in `background.js`** (service worker) to avoid CORS
  issues and to keep API keys out of page context. The UI never calls a provider
  directly; it sends messages (`AIFF_FILL`, `AIFF_FILL_ALL`, `AIFF_TEST`,
  `AIFF_CHECK_UPDATE`) and receives plain results.
- **Content-script UI is isolated in a Shadow DOM host** (`#ai-form-filler-root`)
  with the highest practical z-index, so host-page CSS can't break it and it can't
  pollute the page.
- **Model catalogs live in two places** (`PROVIDERS` in `background.js` and
  `options.js`). Keep them in sync — `background.js` additionally accepts
  pattern-valid future model ids (e.g. any `gemini-*`, `gpt-*`, `o*`).

### Permissions

| Permission | Why |
| --- | --- |
| `storage` | Save API keys, model, theme, button position |
| `activeTab` | Minimal page access for the current tab |
| `scripting` | Inject/manage the content script UI |
| `generativelanguage.googleapis.com` | Gemini API |
| `api.openai.com` | OpenAI API |
| `api.github.com` | Release/version check |
| optional host permissions | Requested on demand for custom API base URLs |

---

## Troubleshooting

**"Extension context invalidated"** — the extension was reloaded or updated while
this tab was open. Refresh the tab and try again.

**A dropdown is skipped** — the model requested a value that isn't in the list and
the dropdown had no usable options to substitute. Open DevTools → Console and look
for `[AIFF]` logs, which report the available options and the requested value.

**Test fails with 401/403** — the key is invalid, revoked, or belongs to a different
provider than the one selected.

**Nothing happens on a site** — internal pages (`chrome://`), the Chrome Web Store,
and PDFs don't allow extensions to run.

---

## Development

```bash
# After editing any file:
#  1. chrome://extensions → click ↻ Reload on the extension
#  2. refresh any open tabs
```

Useful checks:

```bash
node --check background.js
node --check content.js
node --check options.js
```

---

## License

MIT