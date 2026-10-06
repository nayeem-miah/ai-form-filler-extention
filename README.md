# AI Form Filler Assistant

## Download

[**Download the latest release (v1.5.0)**](https://github.com/nayeem-miah/ai-form-filler-extention/releases/tag/v1.5.0)

A Chrome extension that fills web forms using AI. Bring your own API key and it writes
realistic values into text inputs, textareas, standard dropdowns, and modern
React/Tailwind custom dropdowns.

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

1. Click the extension icon in the toolbar. The settings page opens directly.
2. Choose a **Provider** (see below).
3. Paste your API key, pick a **Model**, and click **Save & Test**. This saves your
   settings and checks the connection in one step.
4. A green confirmation means you are ready to fill forms.

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

- **Fill one field**: hover over or focus any text field, then click **AI Fill**.
- **Fill the whole form**: click **Fill All Fields**. Every visible field is filled in
  one request.
- **Randomize values** is on by default, so each run returns different data. Turn it
  off for predictable values.

Password, file, hidden, checkbox, radio, and disabled fields are skipped.

## Providers and models

**Google Gemini** (13 models, default `gemini-3.5-flash-lite`)

| Model | Notes |
| --- | --- |
| `gemini-2.5-flash` | Fast, widely available |
| `gemini-3.8-flash` | Newest in the 3.x Flash family |
| `gemini-3.7-flash` | |
| `gemini-3.6-flash` | |
| `gemini-3.5-flash` | |
| `gemini-3.5-flash-lite` | Default. Cheapest and fastest |
| `gemini-3-flash` | |
| `gemini-3.1-flash-lite` | |
| `gemini-2.5-flash-lite` | |
| `gemini-2.5-pro` | Highest quality, slower |
| `gemini-3.1-pro-preview` | Preview build |
| `gemini-1.5-flash` | Legacy |
| `gemini-1.5-pro` | Legacy |

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

- Keys are saved with `chrome.storage.sync`, which means they sync with your Google
  account across devices and are not end-to-end encrypted.
- There is no analytics or telemetry.
- Extensions cannot run on `chrome://` pages, the Chrome Web Store, or PDFs.

## Author

**MD Nayeem Miah** - <nayeem5113a@gmail.com> - <https://nayeem-miah.me/>

## License

MIT