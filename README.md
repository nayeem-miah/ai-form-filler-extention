# AI Form Filler Assistant

## Download

[**Download the latest release**](https://github.com/nayeem-miah/ai-form-filler-extention/releases/latest)

A Chrome extension that fills web forms using AI. Click the toolbar icon and it writes
realistic values into text inputs, textareas, standard dropdowns, and modern
React/Tailwind custom dropdowns. Every install gets **10 free requests per day**; after
that, bring your own API key.

## Install

1. Download the release `.zip` from the link above and unzip it anywhere on your
   computer.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped folder, the one containing
   `manifest.json`.
5. Pin the extension: click the puzzle-piece icon in the toolbar, then pin
   _AI Form Filler Assistant_.

## Setup

You can start without any setup: each browser install gets **10 free requests per
day**. Click the extension icon on a form and it fills everything. When the daily
free requests run out, add your own key (below) to keep going.

1. Right-click the extension icon and choose **Options** (or click **Open Settings**
   in any notification).
2. Choose a **Provider** (see below).
3. Paste your API key, pick a **Model**, and click **Save & Test**. This saves your
   settings and checks the connection in one step.
4. A green confirmation means you are ready to fill forms.

Your free requests are used first; once the daily allowance runs out, your own key
takes over automatically. (If the trial key ever fails, the request is retried with
your own key.)

Where to get a key:

| Provider   | Where                                    |
| ---------- | ---------------------------------------- |
| Gemini     | <https://aistudio.google.com/app/apikey> |
| OpenAI     | <https://platform.openai.com/api-keys>   |
| OpenRouter | <https://openrouter.ai/keys>             |
| Groq       | <https://console.groq.com/keys>          |
| DeepSeek   | <https://platform.deepseek.com/api_keys> |

> Your key is only ever sent to the provider you selected. It is never exposed to
> website scripts and never logged.

## How to use

- **Fill the whole form**: click the extension icon in the toolbar. Every visible field
  is filled in one request — text inputs, textareas, selects, and custom dropdowns.
- **Passwords**: password and confirm-password fields are always filled with the same
  fixed default password (`Password123$`, set by `DEFAULT_PASSWORD` in `content.js`).
  It is filled locally and is never sent to the AI. "Current / old password" fields are
  left untouched.
- **Randomize values** is on by default, so each run returns different data. Turn it
  off for predictable values.
- **Settings**: right-click the extension icon → **Options**. The toolbar badge shows
  how many free requests are left today.

File, hidden, checkbox, radio, and disabled fields are skipped.

## Providers and models

**Google Gemini** (13 models, default `gemini-3.5-flash-lite`)

| Model                    | Notes                          |
| ------------------------ | ------------------------------ |
| `gemini-2.5-flash`       | Fast, widely available         |
| `gemini-3.8-flash`       | Newest in the 3.x Flash family |
| `gemini-3.7-flash`       |                                |
| `gemini-3.6-flash`       |                                |
| `gemini-3.5-flash`       |                                |
| `gemini-3.5-flash-lite`  | Default. Cheapest and fastest  |
| `gemini-3-flash`         |                                |
| `gemini-3.1-flash-lite`  |                                |
| `gemini-2.5-flash-lite`  |                                |
| `gemini-2.5-pro`         | Highest quality, slower        |
| `gemini-3.1-pro-preview` | Preview build                  |
| `gemini-1.5-flash`       | Legacy                         |
| `gemini-1.5-pro`         | Legacy                         |

**OpenAI (official)** (3 models, default `gpt-4o-mini`)

`gpt-4o-mini`, `gpt-4o`, `gpt-3.5-turbo`

**OpenAI compatible / custom API**

Works with any server exposing `POST {base}/chat/completions`, including OpenRouter,
Groq, Together AI, DeepSeek, Ollama, LM Studio, and vLLM. You type the model id
yourself, so any model that provider offers will work.

Set these two fields:

- **API Base URL**: the `v1`-style base, without `/chat/completions`.
  Examples: `https://openrouter.ai/api/v1` (OpenRouter),
  `https://api.groq.com/openai/v1` (Groq), `https://api.deepseek.com/v1` (DeepSeek),
  `http://localhost:11434/v1` (Ollama).
- **Model Name**: your provider's model id, for example `deepseek/deepseek-chat`,
  `llama-3.3-70b-versatile`, or `mistral-7b-instruct`.

Leave the API key blank for local servers like Ollama. Chrome asks for permission to
the host the first time you save.

## Notes

- The free tier is served by the trial key at `FREE_TIER.apiKey` in
  `background.js` (provider/model `FREE_TIER.provider` / `FREE_TIER.model`). Usage is
  tracked per browser install (not per account) and resets at local midnight. Because
  the key ships inside the extension, it can be extracted — monitor and rotate it.
- Keys are saved with `chrome.storage.sync`, which means they sync with your Google
  account across devices and are not end-to-end encrypted.
- There is no analytics or telemetry.
- Extensions cannot run on `chrome://` pages, the Chrome Web Store, or PDFs.

## License

MIT
