// options.js — settings UI logic (CSP compliant: no inline handlers).
// Provider (Gemini / OpenAI) + model + per-provider API keys are persisted
// via chrome.storage.sync. Theme via chrome.storage.sync too (falls back to
// OS prefers-color-scheme). Connection tests are routed through
// background.js (AIFF_TEST) so that ALL network calls stay in the service
// worker per project rules.

// Mirrors PROVIDERS in background.js. background.js additionally accepts
// sane future model ids per provider, so a saved value not listed here
// still works (shown as "(saved)").
const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    models: ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'],
    defaultModel: 'gemini-2.5-flash',
    keyLabel: 'Gemini API Key',
    keyPlaceholder: 'AIza...',
    keyLink: 'https://aistudio.google.com/app/apikey',
    keyLinkText: 'Get a Gemini key'
  },
  openai: {
    label: 'OpenAI',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
    defaultModel: 'gpt-4o-mini',
    keyLabel: 'OpenAI API Key',
    keyPlaceholder: 'sk-...',
    keyLink: 'https://platform.openai.com/api-keys',
    keyLinkText: 'Get an OpenAI key'
  }
};
const DEFAULT_PROVIDER = 'gemini';
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

function normalizeProvider(value) {
  return value === 'openai' ? 'openai' : DEFAULT_PROVIDER;
}

function defaultModelFor(provider) {
  return (PROVIDERS[provider] || PROVIDERS[DEFAULT_PROVIDER]).defaultModel;
}

function modelLabel(provider, id) {
  if (id === defaultModelFor(provider)) return `${id} (Recommended)`;
  return id;
}

document.addEventListener('DOMContentLoaded', () => {
  const providerSelect = document.getElementById('providerSelect');
  const apiKeyLabel = document.getElementById('apiKeyLabel');
  const apiKeyInput = document.getElementById('apiKey');
  const modelSelect = document.getElementById('modelSelect');
  const keyLink = document.getElementById('keyLink');
  const saveBtn = document.getElementById('saveBtn');
  const clearBtn = document.getElementById('clearBtn');
  const testBtn = document.getElementById('testBtn');
  const toggleBtn = document.getElementById('toggleVisibility');
  const themeToggle = document.getElementById('themeToggle');
  const statusEl = document.getElementById('status');

  let statusTimer = 0;
  let currentProvider = DEFAULT_PROVIDER;
  // Per-provider keys held in memory; persisted on Save.
  // Legacy single `apiKey` slot migrates into the Gemini slot on load.
  const providerKeys = { gemini: '', openai: '' };

  // ---- Build model dropdown for a provider ----
  function buildModelOptions(provider, selected) {
    const catalog = PROVIDERS[provider] || PROVIDERS[DEFAULT_PROVIDER];
    modelSelect.textContent = '';
    for (const id of catalog.models) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = modelLabel(provider, id);
      modelSelect.appendChild(opt);
    }
    // Keep a previously-saved (possibly newer) model selectable even if not listed.
    if (selected && ![...modelSelect.options].some((o) => o.value === selected)) {
      const opt = document.createElement('option');
      opt.value = selected;
      opt.textContent = `${selected} (saved)`;
      modelSelect.appendChild(opt);
    }
    modelSelect.value = selected && [...modelSelect.options].some((o) => o.value === selected)
      ? selected
      : catalog.defaultModel;
  }

  function currentModel() {
    return modelSelect.value || defaultModelFor(currentProvider);
  }

  // ---- Apply provider to the whole form ----
  function applyProvider(provider, modelToSelect) {
    currentProvider = normalizeProvider(provider);
    const catalog = PROVIDERS[currentProvider];
    providerSelect.value = currentProvider;
    apiKeyLabel.textContent = catalog.keyLabel;
    apiKeyInput.placeholder = catalog.keyPlaceholder;
    apiKeyInput.value = providerKeys[currentProvider] || '';
    buildModelOptions(currentProvider, modelToSelect || defaultModelFor(currentProvider));
    keyLink.href = catalog.keyLink;
    keyLink.textContent = catalog.keyLinkText;
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

  // ---- Load saved settings (with legacy single-key migration) ----
  applyProvider(DEFAULT_PROVIDER, defaultModelFor(DEFAULT_PROVIDER));
  try {
    chrome.storage.sync.get(
      ['provider', 'model', 'geminiApiKey', 'openaiApiKey', 'apiKey', 'theme'],
      (result) => {
        if (chrome.runtime.lastError) {
          setStatus(`Could not load settings: ${chrome.runtime.lastError.message}`, 'error');
          initTheme(null);
          setFavicon(false);
          return;
        }
        const res = result || {};
        initTheme(res.theme);
        const provider = normalizeProvider(res.provider);
        providerKeys.gemini =
          (typeof res.geminiApiKey === 'string' && res.geminiApiKey.trim()) ||
          (typeof res.apiKey === 'string' && res.apiKey.trim()) ||
          '';
        providerKeys.openai =
          (typeof res.openaiApiKey === 'string' && res.openaiApiKey.trim()) || '';
        const savedModel =
          typeof res.model === 'string' && res.model.trim()
            ? res.model.trim()
            : defaultModelFor(provider);
        applyProvider(provider, savedModel);
        setFavicon(Boolean(providerKeys[provider]));
        if (res.provider || res.model || res.geminiApiKey || res.openaiApiKey || res.apiKey) {
          setStatus('Settings loaded from storage.', 'info');
        }
      }
    );
  } catch {
    setStatus(
      'The extension was reloaded. Please close and reopen this settings page.',
      'error'
    );
    initTheme(null);
  }

  // ---- Show / Hide toggle (icon button inside the input) ----
  toggleBtn.addEventListener('click', () => {
    const showing = apiKeyInput.type === 'text';
    apiKeyInput.type = showing ? 'password' : 'text';
    toggleBtn.innerHTML = showing ? ICON_EYE : ICON_EYE_OFF;
    toggleBtn.setAttribute('aria-label', showing ? 'Show API key' : 'Hide API key');
    apiKeyInput.focus();
  });

  // Model remembered per provider choice: if the user already picked a model
  // for the newly selected provider in this session, keep it; else default.
  const lastModelByProvider = {};
  function currentModelBelongingTo(provider) {
    if (provider === currentProvider) return currentModel();
    return lastModelByProvider[provider] || defaultModelFor(provider);
  }

  // ---- Provider switch (stashes current input, restores the other slot) ----
  providerSelect.addEventListener('change', () => {
    providerKeys[currentProvider] = apiKeyInput.value.trim();
    lastModelByProvider[currentProvider] = currentModel();
    const next = normalizeProvider(providerSelect.value);
    applyProvider(next, currentModelBelongingTo(next));
    chrome.storage.sync.set({ provider: next }, () => {
      if (chrome.runtime.lastError) {
        setStatus(`Could not save provider: ${chrome.runtime.lastError.message}`, 'error');
        return;
      }
      setStatus(
        `Provider set to ${PROVIDERS[next].label}. Paste its key and click Save.`,
        'info'
      );
    });
  });

  // ---- Save provider + model + key ----
  saveBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    const model = currentModel();
    if (!key) {
      setStatus(`Please paste your ${PROVIDERS[currentProvider].label} API key first.`, 'error');
      apiKeyInput.focus();
      return;
    }
    providerKeys[currentProvider] = key;
    setBusy(true, 'Saving…');
    const payload = {
      provider: currentProvider,
      model,
      geminiApiKey: providerKeys.gemini,
      openaiApiKey: providerKeys.openai
    };
    // Legacy mirror: old single `apiKey` slot always reflects the Gemini key.
    payload.apiKey = providerKeys.gemini;
    chrome.storage.sync.set(payload, () => {
      setBusy(false);
      if (chrome.runtime.lastError) {
        setStatus(`Save failed: ${chrome.runtime.lastError.message}`, 'error');
        return;
      }
      setStatus(`Settings saved. ${PROVIDERS[currentProvider].label}: ${model}.`, 'success');
      setFavicon(true);
    });
  });

  // ---- Remove current provider key (keeps model + theme + other key) ----
  clearBtn.addEventListener('click', () => {
    setBusy(true, 'Saving…');
    providerKeys[currentProvider] = '';
    apiKeyInput.value = '';
    const payload = { geminiApiKey: providerKeys.gemini, openaiApiKey: providerKeys.openai };
    payload.apiKey = providerKeys.gemini;
    chrome.storage.sync.set(payload, () => {
      setBusy(false);
      if (chrome.runtime.lastError) {
        setStatus(`Remove failed: ${chrome.runtime.lastError.message}`, 'error');
        return;
      }
      setStatus(
        `${PROVIDERS[currentProvider].label} key removed. Other settings kept.`,
        'info'
      );
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
    setStatus(`Testing ${PROVIDERS[currentProvider].label} ${model}…`, 'info');
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'AIFF_TEST',
        provider: currentProvider,
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
      const msg = String((err && err.message) || err || '');
      if (/extension context invalidated|context invalidated/i.test(msg)) {
        setStatus(
          'The extension was reloaded. Please close and reopen this settings page.',
          'error'
        );
      } else {
        setStatus(`Test error: ${msg}`, 'error');
      }
    } finally {
      setBusy(false);
    }
  });

  // ---- Persist model immediately on change (key untouched) ----
  modelSelect.addEventListener('change', () => {
    const model = currentModel();
    lastModelByProvider[currentProvider] = model;
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
