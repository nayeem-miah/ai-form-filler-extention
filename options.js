// options.js — settings UI logic (CSP compliant: no inline handlers).
// Provider (Gemini / OpenAI) + model + per-provider API keys are persisted
// via chrome.storage.sync. Theme via chrome.storage.sync too (falls back to
// OS prefers-color-scheme). Connection tests are routed through
// background.js (AIFF_TEST) so that ALL network calls stay in the service
// worker per project rules.

// Mirrors PROVIDERS in background.js. background.js additionally accepts
// sane future model ids per provider, so a saved value not listed here
// still works (shown as "(saved)").
// ---------------------------------------------------------------------------
// Feedback form (Web3Forms)
// ---------------------------------------------------------------------------
// Replace this with your own key from https://web3forms.com (Dashboard →
// Access Key). Leave it blank to disable in-app submissions: the button then
// tells the user to use the GitHub Issues link instead.
const WEB3FORMS_ENDPOINT = 'https://api.web3forms.com/submit';
const WEB3FORMS_ACCESS_KEY = 'YOUR_WEB3FORMS_ACCESS_KEY';
const REPO_ISSUES_URL = 'https://github.com/nayeem-miah/ai-form-filler-extention/issues/new';

// ---------------------------------------------------------------------------
// Feedback page shortcuts
// ---------------------------------------------------------------------------
// When your feedback text mentions one of these keywords, a clickable chip
// appears under the textarea that opens the matching page in a new tab.
// EDIT THIS to match your own routes — add, remove or retarget entries freely.
//
//   label    -> text shown on the chip
//   keywords -> matched against the feedback text (case-insensitive)
//   url      -> opened in a new tab when the chip is clicked
const PAGE_LINKS = [
  { label: 'Contract', url: 'https://quick-bus-bd.web.app/contract', keywords: ['contract', 'agreement'] },
  { label: 'Support', url: 'https://quick-bus-bd.web.app/support', keywords: ['support', 'help'] },
  { label: 'Invoices', url: 'https://quick-bus-bd.web.app/invoices', keywords: ['invoice', 'invoices'] },
  { label: 'Clients', url: 'https://quick-bus-bd.web.app/clients', keywords: ['client', 'clients'] },
  { label: 'Items', url: 'https://quick-bus-bd.web.app/items', keywords: ['item', 'items'] },
  { label: 'Checkout', url: 'https://quick-bus-bd.web.app/checkout', keywords: ['checkout', 'cart'] },
  { label: 'Settings', url: 'https://quick-bus-bd.web.app/settings', keywords: ['settings', 'config'] }
];

const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    models: [
      'gemini-2.5-flash',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3-flash',
      'gemini-3.1-flash-lite',
      'gemini-2.5-flash-lite',
      'gemini-2.5-pro',
      'gemini-3.1-pro-preview',
      'gemini-1.5-flash',
      'gemini-1.5-pro'
    ],
    defaultModel: 'gemini-3.5-flash-lite',
    keyLabel: 'Gemini API Key',
    keyPlaceholder: 'AIza...',
    keyLink: 'https://aistudio.google.com/app/apikey',
    keyLinkText: 'Get a Gemini key',
    modelsLink: 'https://ai.google.dev/gemini-api/docs/models'
  },
  openai: {
    label: 'OpenAI (Official)',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
    defaultModel: 'gpt-4o-mini',
    keyLabel: 'OpenAI API Key',
    keyPlaceholder: 'sk-...',
    keyLink: 'https://platform.openai.com/api-keys',
    keyLinkText: 'Get an OpenAI key',
    modelsLink: 'https://platform.openai.com/docs/models'
  },
  custom: {
    label: 'OpenAI Compatible / Custom API',
    models: [],
    defaultModel: '',
    freeModel: true,
    keyLabel: 'API Key (optional)',
    keyPlaceholder: 'sk-or-v1-...',
    keyLink: 'https://openrouter.ai/models',
    keyLinkText: 'Browse compatible providers',
    modelsLink: 'https://openrouter.ai/models'
  }
};
const DEFAULT_PROVIDER = 'gemini';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
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
  if (value === 'openai' || value === 'custom') return value;
  return DEFAULT_PROVIDER;
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
  const customSection = document.getElementById('customSection');
  const baseUrlInput = document.getElementById('apiBaseUrl');
  const customModelInput = document.getElementById('customModel');
  const apiKeyLabel = document.getElementById('apiKeyLabel');
  const apiKeyInput = document.getElementById('apiKey');
  const modelSelect = document.getElementById('modelSelect');
  const modelLabelEl = document.getElementById('modelLabel');
  const modelRow = document.getElementById('modelRow');
  const keyLink = document.getElementById('keyLink');
  const modelsLink = document.getElementById('modelsLink');
  const updateBtn = document.getElementById('updateBtn');
  const updateResult = document.getElementById('updateResult');
  const randomizeToggle = document.getElementById('randomizeToggle');
  const feedbackBtn = document.getElementById('feedbackBtn');
  const feedbackEmail = document.getElementById('feedbackEmail');
  const feedbackMessage = document.getElementById('feedbackMessage');
  const feedbackStatus = document.getElementById('feedbackStatus');
  const feedbackLinks = document.getElementById('feedbackLinks');
  const supportLink = document.getElementById('supportLink');
  const supportModal = document.getElementById('supportModal');
  const supportModalClose = document.getElementById('supportModalClose');
  const feedbackKey = document.getElementById('feedbackKey');
  const feedbackKeyToggle = document.getElementById('feedbackKeyToggle');
  const feedbackKeySave = document.getElementById('feedbackKeySave');
  const feedbackKeyStatus = document.getElementById('feedbackKeyStatus');
  const githubIssueLink = document.getElementById('githubIssueLink');
  const saveBtn = document.getElementById('saveBtn');
  const clearBtn = document.getElementById('clearBtn');
  const toggleBtn = document.getElementById('toggleVisibility');
  const themeToggle = document.getElementById('themeToggle');
  const statusEl = document.getElementById('status');

  let statusTimer = 0;
  let currentProvider = DEFAULT_PROVIDER;
  // Per-provider keys held in memory; persisted on Save.
  // Legacy single `apiKey` slot migrates into the Gemini slot on load.
  const providerKeys = { gemini: '', openai: '', custom: '' };

  // ---- Build model dropdown for a provider (custom uses free-text instead) ----
  function buildModelOptions(provider, selected) {
    const catalog = PROVIDERS[provider] || PROVIDERS[DEFAULT_PROVIDER];
    modelSelect.textContent = '';

    // Custom providers have an open-ended model list -> hide the dropdown
    // (and its label) and use the dedicated "Model Name" text field instead.
    const useCustomModel = Boolean(catalog.freeModel);
    modelSelect.hidden = useCustomModel;
    modelLabelEl.hidden = useCustomModel;
    modelRow.hidden = useCustomModel;
    if (useCustomModel) return;

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
    modelSelect.value =
      selected && [...modelSelect.options].some((o) => o.value === selected)
        ? selected
        : catalog.defaultModel;
  }

  function currentModel() {
    const catalog = PROVIDERS[currentProvider] || PROVIDERS[DEFAULT_PROVIDER];
    if (catalog.freeModel) return customModelInput.value.trim();
    return modelSelect.value || catalog.defaultModel;
  }

  // ---- Apply provider to the whole form ----
  function applyProvider(provider, modelToSelect) {
    currentProvider = normalizeProvider(provider);
    const catalog = PROVIDERS[currentProvider];
    providerSelect.value = currentProvider;
    apiKeyLabel.textContent = catalog.keyLabel;
    apiKeyInput.placeholder = catalog.keyPlaceholder;
    apiKeyInput.value = providerKeys[currentProvider] || '';
    customSection.hidden = !catalog.freeModel;
    buildModelOptions(currentProvider, modelToSelect || catalog.defaultModel);
    keyLink.href = catalog.keyLink;
    keyLink.textContent = catalog.keyLinkText;
    modelsLink.href = catalog.modelsLink;
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

  function setBusy(busy, label = 'Save & Test') {
    for (const b of [saveBtn, clearBtn]) b.disabled = busy;
    saveBtn.textContent = busy && label ? label : 'Save & Test';
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

  // ---- Host permission for custom endpoints (requested on Save) ----
function originPatternFor(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

function hasHostPermission(url) {
  return new Promise((resolve) => {
    const origin = originPatternFor(url);
    if (!origin || !chrome.permissions) {
      resolve(false);
      return;
    }
    try {
      chrome.permissions.contains({ origins: [origin] }, (has) => {
        resolve(Boolean(has));
      });
    } catch {
      resolve(false);
    }
  });
}

// Must run inside the Save click's user gesture, so it uses the callback form
// of chrome.permissions.request directly.
function requestHostPermission(url, onResult) {
  const origin = originPatternFor(url);
  if (!origin || !chrome.permissions) {
    onResult(false, 'Could not read that URL. Use a full URL, e.g. https://openrouter.ai/api/v1');
    return;
  }
  try {
    chrome.permissions.request({ origins: [origin] }, (granted) => {
      const err = chrome.runtime.lastError;
      if (err) {
        onResult(false, err.message);
        return;
      }
      onResult(Boolean(granted), granted ? '' : 'Permission denied for that host.');
    });
  } catch (e) {
    onResult(false, String((e && e.message) || e));
  }
}

// ---- Load saved settings (with legacy single-key migration) ----
  applyProvider(DEFAULT_PROVIDER, defaultModelFor(DEFAULT_PROVIDER));
  try {
    chrome.storage.sync.get(
      [
        'provider',
        'model',
        'geminiApiKey',
        'openaiApiKey',
        'customApiKey',
        'apiBaseUrl',
        'customModel',
        'apiKey',
        'theme',
        'randomize'
      ],
      (result) => {
        if (chrome.runtime.lastError) {
          setStatus(`Could not load settings: ${chrome.runtime.lastError.message}`, 'error');
          initTheme(null);
          setFavicon(false);
          return;
        }
        const res = result || {};
        initTheme(res.theme);
        applyRandomize(res.randomize !== false);
        const provider = normalizeProvider(res.provider);
        providerKeys.gemini =
          (typeof res.geminiApiKey === 'string' && res.geminiApiKey.trim()) ||
          (typeof res.apiKey === 'string' && res.apiKey.trim()) ||
          '';
        providerKeys.openai =
          (typeof res.openaiApiKey === 'string' && res.openaiApiKey.trim()) || '';
        providerKeys.custom =
          (typeof res.customApiKey === 'string' && res.customApiKey.trim()) || '';
        baseUrlInput.value =
          (typeof res.apiBaseUrl === 'string' && res.apiBaseUrl.trim()) || DEFAULT_BASE_URL;
        customModelInput.value =
          (typeof res.customModel === 'string' && res.customModel.trim()) || '';

        if (provider === 'custom') {
          // Custom model lives in its own field, not the dropdown.
          applyProvider(provider, '');
          customModelInput.value = customModelInput.value || '';
        } else {
          const savedModel =
            typeof res.model === 'string' && res.model.trim()
              ? res.model.trim()
              : defaultModelFor(provider);
          applyProvider(provider, savedModel);
        }
        setFavicon(Boolean(providerKeys[provider]));
        if (
          res.provider ||
          res.model ||
          res.geminiApiKey ||
          res.openaiApiKey ||
          res.customApiKey ||
          res.apiKey
        ) {
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
    const catalog = PROVIDERS[provider] || PROVIDERS[DEFAULT_PROVIDER];
    if (catalog.freeModel) return ''; // free-text model field
    if (provider === currentProvider) return modelSelect.value;
    return lastModelByProvider[provider] || catalog.defaultModel;
  }

  // ---- Provider switch (stashes current input, restores the other slot) ----
  providerSelect.addEventListener('change', () => {
    providerKeys[currentProvider] = apiKeyInput.value.trim();
    if (!PROVIDERS[currentProvider].freeModel) {
      lastModelByProvider[currentProvider] = modelSelect.value;
    }
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

  // ---- Validate the current form; returns {key, model, baseUrl, isCustom} or null ----
  function validateForm() {
    const catalog = PROVIDERS[currentProvider];
    const key = apiKeyInput.value.trim();
    const model = currentModel();
    const isCustom = Boolean(catalog.freeModel);
    const baseUrl = baseUrlInput.value.trim();

    if (isCustom) {
      if (!baseUrl) {
        setStatus('Enter an API Base URL, e.g. https://openrouter.ai/api/v1', 'error');
        baseUrlInput.focus();
        return null;
      }
      if (!originPatternFor(baseUrl)) {
        setStatus('That API Base URL is not valid. Include https:// and the host.', 'error');
        baseUrlInput.focus();
        return null;
      }
      if (!model) {
        setStatus('Enter a model name, e.g. deepseek/deepseek-r1', 'error');
        customModelInput.focus();
        return null;
      }
    } else if (!key) {
      setStatus(`Paste your ${catalog.label} API key first.`, 'error');
      apiKeyInput.focus();
      return null;
    }
    return { key, model, baseUrl, isCustom, catalog };
  }

  // ---- Test connection via background service worker ----
  async function runConnectionTest(form) {
    const { key, model, isCustom, catalog } = form;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'AIFF_TEST',
        provider: currentProvider,
        apiKey: key,
        model,
        apiBaseUrl: isCustom ? form.baseUrl : '',
        customModel: isCustom ? customModelInput.value.trim() : ''
      });
      if (response && response.ok) {
        setStatus(
          `Saved and connected — ${catalog.label} is working with ${response.model || model}.`,
          'success'
        );
      } else if (response && response.error === 'NO_API_KEY') {
        setStatus('Saved, but no API key was available to test with.', 'error');
      } else {
        setStatus(
          `Saved, but the connection test failed — ${String((response && response.detail) || 'unknown error').slice(0, 300)}`,
          'error'
        );
      }
    } catch (err) {
      const msg = String((err && err.message) || err || '');
      if (/extension context invalidated|context invalidated/i.test(msg)) {
        setStatus(
          'Settings saved. The extension was reloaded — reopen this page to finish testing.',
          'info'
        );
      } else {
        setStatus(`Settings saved, but the test errored — ${msg.slice(0, 200)}`, 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  // ---- Save + Test in one action ----
  saveBtn.addEventListener('click', () => {
    const form = validateForm();
    if (!form) return;

    const { key, model, isCustom, catalog } = form;
    providerKeys[currentProvider] = key;
    setBusy(true, 'Saving…');

    const persist = () => {
      const payload = {
        provider: currentProvider,
        model: isCustom ? currentModel() : model,
        geminiApiKey: providerKeys.gemini,
        openaiApiKey: providerKeys.openai,
        customApiKey: providerKeys.custom,
        apiBaseUrl: baseUrlInput.value.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL,
        customModel: customModelInput.value.trim()
      };
      // Legacy mirror: old single `apiKey` slot always reflects the Gemini key.
      payload.apiKey = providerKeys.gemini;
      chrome.storage.sync.set(payload, () => {
        if (chrome.runtime.lastError) {
          setBusy(false);
          setStatus(`Save failed: ${chrome.runtime.lastError.message}`, 'error');
          return;
        }
        setFavicon(true);
        // Saved successfully — now verify the connection in the same click.
        setBusy(true, 'Testing…');
        setStatus(`Saved. Testing ${catalog.label} ${model}…`, 'info');
        runConnectionTest(form);
      });
    };

    if (isCustom) {
      // Custom endpoints need a host permission — ask inside this click.
      hasHostPermission(form.baseUrl).then((has) => {
        if (has) {
          persist();
          return;
        }
        requestHostPermission(form.baseUrl, (granted, errMessage) => {
          if (granted) {
            persist();
            return;
          }
          setBusy(false);
          setStatus(
            `Cannot reach ${originPatternFor(form.baseUrl) || form.baseUrl} — ${errMessage || 'permission denied'}`,
            'error'
          );
        });
      });
    } else {
      persist();
    }
  });

  // ---- Remove current provider key (keeps model + theme + other keys) ----
  clearBtn.addEventListener('click', () => {
    setBusy(true, 'Removing…');
    providerKeys[currentProvider] = '';
    apiKeyInput.value = '';
    const payload = {
      geminiApiKey: providerKeys.gemini,
      openaiApiKey: providerKeys.openai,
      customApiKey: providerKeys.custom
    };
    payload.apiKey = providerKeys.gemini;
    chrome.storage.sync.set(payload, () => {
      setBusy(false);
      if (chrome.runtime.lastError) {
        setStatus(`Remove failed: ${chrome.runtime.lastError.message}`, 'error');
        return;
      }
      setStatus(`${PROVIDERS[currentProvider].label} key removed. Other settings kept.`, 'info');
      setFavicon(false);
    });
  });

  // ---- Persist dropdown model immediately on change (custom uses its own field) ----
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

  // ---- Custom model name (saved together with the key on Save) ----
  customModelInput.addEventListener('change', () => {
    const model = customModelInput.value.trim();
    if (!model) return;
    chrome.storage.sync.set({ customModel: model }, () => {
      if (chrome.runtime.lastError) {
        setStatus(`Could not save model name: ${chrome.runtime.lastError.message}`, 'error');
        return;
      }
      setStatus(`Model name set to ${model}. Click Save to store it with your key.`, 'info');
    });
  });

  // ---- Enter key saves ----
  apiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveBtn.click();
    }
  });

  // ---- Randomize toggle (stored in sync so content scripts can read it) ----
  function applyRandomize(enabled) {
    randomizeToggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
    randomizeToggle.classList.toggle('is-on', enabled);
  }

  randomizeToggle.addEventListener('click', () => {
    const next = randomizeToggle.getAttribute('aria-checked') !== 'true';
    applyRandomize(next);
    chrome.storage.sync.set({ randomize: next }, () => {
      if (chrome.runtime.lastError) {
        setStatus(`Could not save preference: ${chrome.runtime.lastError.message}`, 'error');
      }
    });
  });

  // ---- GitHub update checker ----

  // Parse "v1.2.3" / "1.2.3" / "1.2.3-beta.1" into a comparable tuple.
  function parseVersion(raw) {
    const m = String(raw || '').match(/(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
  }

  // Returns -1 / 0 / 1 for a vs b.
  function compareVersions(a, b) {
    if (!a || !b) return 0;
    for (const key of ['major', 'minor', 'patch']) {
      if (a[key] > b[key]) return 1;
      if (a[key] < b[key]) return -1;
    }
    return 0;
  }

  function currentVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return '0.0.0';
    }
  }

  function setUpdateStatus(kind, text, linkText, linkHref) {
    updateResult.textContent = '';
    updateResult.className = `aiff-update-result aiff-update-${kind}`;

    const line = document.createElement('span');
    line.textContent = text;
    updateResult.appendChild(line);

    if (linkText && linkHref) {
      const a = document.createElement('a');
      a.href = linkHref;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'aiff-update-link';
      a.textContent = linkText;
      updateResult.appendChild(document.createTextNode(' '));
      updateResult.appendChild(a);
    }
  }

  updateBtn.addEventListener('click', async () => {
    updateBtn.disabled = true;
    updateBtn.textContent = 'Checking…';
    setUpdateStatus('pending', 'Checking GitHub for the latest release…');

    try {
      const response = await chrome.runtime.sendMessage({ type: 'AIFF_CHECK_UPDATE' });
      const installed = currentVersion();

      if (response && response.ok) {
        const remote = parseVersion(response.tag);
        const local = parseVersion(installed);
        const remoteLabel = response.tag.replace(/^v/, '');

        if (remote && compareVersions(remote, local) > 0) {
          setUpdateStatus(
            'available',
            `🚀 New Version Available! (installed v${installed})`,
            `Download v${remoteLabel}`,
            response.releaseUrl
          );
        } else {
          setUpdateStatus(
            'current',
            `✅ Up to date (v${installed})`,
            '',
            ''
          );
        }
      } else if (response && response.error === 'NO_RELEASE') {
        setUpdateStatus(
          'neutral',
          `ℹ️ No published releases yet — you're on the latest (v${installed}).`,
          'View repository',
          'https://github.com/nayeem-miah/ai-form-filler-extention'
        );
      } else if (response && response.error === 'RATE_LIMITED') {
        setUpdateStatus('error', '⚠️ GitHub rate limit reached. Try again shortly.', '', '');
      } else {
        const detail = response && response.detail ? ` ${response.detail}` : '';
        setUpdateStatus('error', `⚠️ Could not check for updates.${detail}`.slice(0, 300), '', '');
      }
    } catch (err) {
      const msg = String((err && err.message) || err || '');
      if (/extension context invalidated|context invalidated/i.test(msg)) {
        setUpdateStatus('error', '⚠️ Extension reloaded — reopen this page to check again.', '', '');
      } else {
        setUpdateStatus('error', `⚠️ Update check failed: ${msg}`.slice(0, 300), '', '');
      }
    } finally {
      updateBtn.disabled = false;
      updateBtn.textContent = 'Check for Updates';
    }
  });

  // ---- Feedback delivery key (stored on this device only) ----

  // Key belongs to the extension author, not the end user, so it is kept out of
  // the repository and in chrome.storage.local (device-local, never synced).
  // Committing it would let anyone exhaust the 250/month free quota by spamming.
  const FEEDBACK_KEY_STORE = 'web3formsAccessKey';
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function readFeedbackKey(cb) {
    chrome.storage.local.get(FEEDBACK_KEY_STORE, (r) => {
      cb(String((r && r[FEEDBACK_KEY_STORE]) || '').trim());
    });
  }

  function setFeedbackKeyStatus(msg, kind) {
    if (feedbackKeyStatus) feedbackKeyStatus.textContent = msg || '';
    if (feedbackKeyStatus) {
      feedbackKeyStatus.classList.toggle('is-error', kind === 'error');
      feedbackKeyStatus.classList.toggle('is-success', kind === 'success');
    }
  }

  readFeedbackKey((k) => {
    if (feedbackKey && k) feedbackKey.value = k;
  });

  feedbackKeyToggle.addEventListener('click', () => {
    const showing = feedbackKey.type === 'text';
    feedbackKey.type = showing ? 'password' : 'text';
    feedbackKeyToggle.setAttribute('aria-label', showing ? 'Show access key' : 'Hide access key');
  });

  feedbackKeySave.addEventListener('click', () => {
    const value = feedbackKey.value.trim();
    if (!value) {
      setFeedbackKeyStatus('Paste your access key first.', 'error');
      feedbackKey.focus();
      return;
    }
    if (!UUID_RE.test(value)) {
      setFeedbackKeyStatus('That does not look like a Web3Forms access key.', 'error');
      feedbackKey.focus();
      return;
    }
    chrome.storage.local.set({ [FEEDBACK_KEY_STORE]: value }, () => {
      if (chrome.runtime.lastError) {
        setFeedbackKeyStatus('Could not save: ' + chrome.runtime.lastError.message, 'error');
        return;
      }
      setFeedbackKeyStatus('Saved. You can send feedback now.', 'success');
    });
  });

  // ---- Support modal (open / close) ----

  let lastFocusedBeforeModal = null;

  function openSupportModal() {
    if (!supportModal) return;
    lastFocusedBeforeModal = document.activeElement;
    supportModal.hidden = false;
    document.body.classList.add('aiff-modal-open');
    try {
      feedbackEmail.focus();
    } catch {
      /* ignore */
    }
  }

  function closeSupportModal() {
    if (!supportModal) return;
    supportModal.hidden = true;
    document.body.classList.remove('aiff-modal-open');
    if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === 'function') {
      try {
        lastFocusedBeforeModal.focus();
      } catch {
        /* ignore */
      }
    }
    lastFocusedBeforeModal = null;
  }

  supportLink.addEventListener('click', openSupportModal);
  supportModalClose.addEventListener('click', closeSupportModal);

  // Clicking the backdrop (but not the modal panel itself) closes it.
  supportModal.addEventListener('mousedown', (e) => {
    if (e.target === supportModal) closeSupportModal();
  });

  // Escape closes too.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && supportModal && !supportModal.hidden) closeSupportModal();
  });

  // ---- Feedback page shortcuts (keyword -> clickable chip) ----

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Entries in PAGE_LINKS whose keywords appear in the text (word-boundary). */
  function detectPageLinks(text) {
    const haystack = ' ' + String(text || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
    const found = [];
    for (const entry of PAGE_LINKS) {
      const hit = (entry.keywords || []).some((word) => {
        const pattern = new RegExp('(^|[^a-z0-9])' + escapeRegExp(word) + '([^a-z0-9]|$)', 'i');
        return pattern.test(haystack);
      });
      if (hit) found.push(entry);
    }
    return found;
  }

  function openExternal(url) {
    try {
      // Extension pages can create tabs without the "tabs" permission.
      chrome.tabs.create({ url, active: true });
    } catch {
      window.open(url, '_blank', 'noopener');
    }
  }

  function renderFeedbackLinks() {
    if (!feedbackLinks) return;
    const matches = detectPageLinks(feedbackMessage.value);
    feedbackLinks.textContent = '';

    if (matches.length === 0) {
      feedbackLinks.hidden = true;
      return;
    }
    feedbackLinks.hidden = false;

    const lead = document.createElement('span');
    lead.className = 'aiff-links-lead';
    lead.textContent = 'Jump to:';
    feedbackLinks.appendChild(lead);

    for (const entry of matches) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'aiff-link-chip';
      chip.textContent = entry.label;
      chip.title = `Open ${entry.url} in a new tab`;
      chip.addEventListener('mousedown', (e) => e.preventDefault());
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        openExternal(entry.url);
      });
      feedbackLinks.appendChild(chip);
    }
  }

  feedbackMessage.addEventListener('input', renderFeedbackLinks);

  // ---- Feedback form (Web3Forms) ----

  function setFeedbackStatus(message, kind) {
    feedbackStatus.textContent = message;
    feedbackStatus.className = 'aiff-status' + (kind ? ' aiff-status-' + kind : '');
  }

  function extensionVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return 'unknown';
    }
  }

  feedbackBtn.addEventListener('click', async () => {
    const message = feedbackMessage.value.trim();
    if (!message) {
      setFeedbackStatus('Please describe your feedback or the bug first.', 'error');
      feedbackMessage.focus();
      return;
    }

    const email = feedbackEmail.value.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFeedbackStatus('That email address does not look valid.', 'error');
      feedbackEmail.focus();
      return;
    }

    const storedKey = await new Promise((resolve) => readFeedbackKey(resolve));
    const accessKey = storedKey || WEB3FORMS_ACCESS_KEY;
    if (!accessKey || accessKey === 'YOUR_WEB3FORMS_ACCESS_KEY') {
      setFeedbackStatus(
        'No feedback key saved yet. Open "Email delivery not working?" below and paste your free Web3Forms access key, or use the GitHub Issues link.',
        'error'
      );
      return;
    }

    feedbackBtn.disabled = true;
    setFeedbackStatus('Sending…');
    try {
      const res = await fetch(WEB3FORMS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          access_key: accessKey,
          subject: 'AI Form Filler Assistant — feedback (v' + extensionVersion() + ')',
          from_name: 'AI Form Filler Assistant',
          email: email || 'not provided',
          message: message,
          // Custom fields show up as columns in the Web3Forms dashboard.
          extension_version: extensionVersion(),
          user_agent: navigator.userAgent,
          source: 'chrome-extension-options'
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data && data.success) {
        setFeedbackStatus('Thanks! Your feedback was sent.', 'success');
        feedbackMessage.value = '';
      } else {
        const why = (data && (data.message || data.error)) || 'HTTP ' + res.status;
        setFeedbackStatus('Could not send feedback: ' + String(why).slice(0, 200), 'error');
      }
    } catch (err) {
      setFeedbackStatus(
        'Could not send feedback: ' + String((err && err.message) || err).slice(0, 200),
        'error'
      );
    } finally {
      feedbackBtn.disabled = false;
    }
  });
});
