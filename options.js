// options.js — settings UI logic (CSP compliant: no inline handlers).
// The API key + model are persisted via chrome.storage.sync. Theme via
// chrome.storage.sync too (falls back to OS prefers-color-scheme).
// Connection tests are routed through background.js (AIFF_TEST) so that
// ALL Gemini network calls stay in the service worker per project rules.

// Mirrors MODEL_GROUPS in background.js (text-output models from
// https://ai.google.dev/gemini-api/docs/models). background.js additionally
// accepts any sane `gemini-*` id, so a saved value not in this list still works.
const MODEL_GROUPS = [
  { label: 'Recommended', models: ['gemini-2.5-flash'] },
  {
    label: 'Stable',
    models: [
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3-flash',
      'gemini-3.1-flash-lite',
      'gemini-2.5-flash-lite',
      'gemini-2.5-pro'
    ]
  },
  { label: 'Preview', models: ['gemini-3.1-pro-preview'] },
  { label: 'Legacy', models: ['gemini-1.5-flash', 'gemini-1.5-pro'] }
];
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_THEME = 'light';

// Static SVG icon strings (no emojis in the UI; CSP-safe — no code execution).
const ICON_EYE =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_EYE_OFF =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="23" x2="23" y2="1"/></svg>';
const ICON_SUN =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
const ICON_MOON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

function modelLabel(id) {
  if (id === DEFAULT_MODEL) return `${id} (Recommended)`;
  return id;
}

document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKey');
  const modelSelect = document.getElementById('modelSelect');
  const saveBtn = document.getElementById('saveBtn');
  const clearBtn = document.getElementById('clearBtn');
  const testBtn = document.getElementById('testBtn');
  const toggleBtn = document.getElementById('toggleVisibility');
  const themeToggle = document.getElementById('themeToggle');
  const statusEl = document.getElementById('status');

  let statusTimer = 0;

  // ---- Build grouped model dropdown ----
  function buildModelOptions(selected) {
    modelSelect.textContent = '';
    for (const group of MODEL_GROUPS) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.label;
      for (const id of group.models) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = modelLabel(id);
        optgroup.appendChild(opt);
      }
      modelSelect.appendChild(optgroup);
    }
    // Keep a previously-saved (possibly newer) model selectable even if not listed.
    if (selected && ![...modelSelect.options].some((o) => o.value === selected)) {
      const opt = document.createElement('option');
      opt.value = selected;
      opt.textContent = `${selected} (saved)`;
      modelSelect.appendChild(opt);
    }
    if (selected) modelSelect.value = selected;
  }

  function currentModel() {
    return modelSelect.value || DEFAULT_MODEL;
  }

  // ---- Theme ----
  function applyTheme(theme) {
    const t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    themeToggle.innerHTML = t === 'dark' ? ICON_SUN : ICON_MOON;
    themeToggle.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    return t;
  }

  function initTheme(saved) {
    if (saved === 'dark' || saved === 'light') return applyTheme(saved);
    const prefersDark =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return applyTheme(prefersDark ? 'dark' : DEFAULT_THEME);
  }

  themeToggle.addEventListener('click', () => {
    const next =
      document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    chrome.storage.sync.set({ theme: next }, () => {
      if (chrome.runtime.lastError) {
        setStatus(`Theme applied, but could not persist: ${chrome.runtime.lastError.message}`, 'error');
      }
    });
  });

  // ---- Status ----
  function setStatus(message, kind = '') {
    statusEl.textContent = message;
    statusEl.className = `aiff-status${kind ? ` aiff-status-${kind}` : ''}`;
    window.clearTimeout(statusTimer);
    if (message && (kind === 'success' || kind === 'info')) {
      statusTimer = window.setTimeout(() => {
        statusEl.textContent = '';
        statusEl.className = 'aiff-status';
      }, 5000);
    }
  }

  function setBusy(busy, saveLabel = '') {
    for (const b of [saveBtn, clearBtn, testBtn]) b.disabled = busy;
    saveBtn.textContent = busy && saveLabel ? saveLabel : 'Save';
    testBtn.textContent = busy ? 'Working…' : 'Test';
  }

  // ---- Dynamic favicon (code-driven, no manifest change needed) ----
  function setFavicon(hasKey) {
    try {
      const file = hasKey ? 'active-16.png' : 'idle-16.png';
      let link = document.querySelector('link[rel="icon"]');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = chrome.runtime.getURL(`icons/${file}`);
    } catch {
      /* favicon is cosmetic; ignore failures */
    }
  }

  // ---- Load saved settings ----
  buildModelOptions(DEFAULT_MODEL);
  chrome.storage.sync.get(['apiKey', 'model', 'theme'], (result) => {
    if (chrome.runtime.lastError) {
      setStatus(`Could not load settings: ${chrome.runtime.lastError.message}`, 'error');
      initTheme(null);
      setFavicon(false);
      return;
    }
    initTheme(result && result.theme);
    if (result && typeof result.apiKey === 'string' && result.apiKey) {
      apiKeyInput.value = result.apiKey;
      setFavicon(true);
    } else {
      setFavicon(false);
    }
    buildModelOptions(
      result && typeof result.model === 'string' && result.model.trim()
        ? result.model.trim()
        : DEFAULT_MODEL
    );
    if (result && (result.apiKey || result.model)) {
      setStatus('Settings loaded from storage.', 'info');
    }
  });

  // ---- Show / Hide toggle (icon button inside the input) ----
  toggleBtn.addEventListener('click', () => {
    const showing = apiKeyInput.type === 'text';
    apiKeyInput.type = showing ? 'password' : 'text';
    toggleBtn.innerHTML = showing ? ICON_EYE : ICON_EYE_OFF;
    toggleBtn.setAttribute('aria-label', showing ? 'Show API key' : 'Hide API key');
    apiKeyInput.focus();
  });

  // ---- Save key + model ----
  saveBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    const model = currentModel();
    if (!key) {
      setStatus('Please paste your Gemini API key first.', 'error');
      apiKeyInput.focus();
      return;
    }
    setBusy(true, 'Saving…');
    chrome.storage.sync.set({ apiKey: key, model }, () => {
      setBusy(false);
      if (chrome.runtime.lastError) {
        setStatus(`Save failed: ${chrome.runtime.lastError.message}`, 'error');
        return;
      }
      setStatus(`Settings saved. Model: ${model}.`, 'success');
      setFavicon(true);
    });
  });

  // ---- Remove key (keeps model + theme) ----
  clearBtn.addEventListener('click', () => {
    setBusy(true, 'Saving…');
    chrome.storage.sync.remove('apiKey', () => {
      setBusy(false);
      if (chrome.runtime.lastError) {
        setStatus(`Remove failed: ${chrome.runtime.lastError.message}`, 'error');
        return;
      }
      apiKeyInput.value = '';
      setStatus('API key removed. Model and theme kept.', 'info');
      setFavicon(false);
    });
  });

  // ---- Test connection via background service worker ----
  testBtn.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    const model = currentModel();
    if (!key) {
      setStatus('Paste a key first, then click Test.', 'error');
      apiKeyInput.focus();
      return;
    }
    setBusy(true);
    setStatus(`Testing ${model}…`, 'info');
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'AIFF_TEST',
        apiKey: key,
        model
      });
      if (response && response.ok) {
        setStatus(
          `Connection works! ${response.model || model} replied: ${(response.text || 'ok').slice(0, 80)}`,
          'success'
        );
      } else if (response && response.error === 'NO_API_KEY') {
        setStatus('No API key available for testing.', 'error');
      } else {
        const detail = response && response.detail ? ` ${response.detail}` : '';
        setStatus(`Test failed.${detail}`.slice(0, 600), 'error');
      }
    } catch (err) {
      setStatus(`Test error: ${(err && err.message) || err}`, 'error');
    } finally {
      setBusy(false);
    }
  });

  // ---- Persist model immediately on change (key untouched) ----
  modelSelect.addEventListener('change', () => {
    const model = currentModel();
    chrome.storage.sync.set({ model }, () => {
      if (chrome.runtime.lastError) {
        setStatus(`Could not save model: ${chrome.runtime.lastError.message}`, 'error');
        return;
      }
      setStatus(`Model set to ${model}. Click Save to store it with your key.`, 'info');
    });
  });

  // ---- Enter key saves ----
  apiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveBtn.click();
    }
  });
});
