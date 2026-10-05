# Project Rules: Chrome Extension (Manifest V3)

## Core Technical Stack & Architecture

- Target Platform: Google Chrome Extension using **Manifest V3**.
- JavaScript Standard: Modern ES6+ / Asynchronous JS (async/await, Promises).
- Communication: Always use `chrome.runtime.sendMessage` and `chrome.runtime.onMessage` for cross-context script communication.
- Storage: Use `chrome.storage.sync` for user settings (e.g., API Keys) and `chrome.storage.local` for large cached data.

## Code Generation Guidelines

### 1. Manifest V3 & Security Rules

- NEVER use inline scripts or inline event handlers (e.g., `onclick="..."`) inside HTML files.
- NEVER use `eval()`, `new Function()`, or unsafe dynamic code execution.
- Ensure all API calls (especially external LLM/Gemini API calls) are placed inside the Service Worker (`background.js`) to prevent CORS issues and protect sensitive tokens.
- Keep `manifest.json` permissions strictly minimal (`storage`, `activeTab`, `scripting`).

### 2. Content Script Best Practices

- Prevent DOM pollution: Always scope extension UI styles cleanly (or use Shadow DOM when creating overlays) to avoid CSS collisions with host websites.
- Handle dynamic web apps (SPA / React / Vue): Input fields might render asynchronously; ensure event listeners use delegation or safe lifecycle checks.
- Framework Event Compatibility: When populating input values via script, ALWAYS dispatch synthetic `input` and `change` events so modern frameworks detect the state change:

  ```javascript
  element.value = newValue;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  ```
