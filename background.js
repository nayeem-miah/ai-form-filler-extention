// background.js — MV3 Service Worker (module)
// All LLM API calls live here (avoids CORS, keeps API keys out of content scripts).
// Supports: single-field fill, batch form fill (JSON), connection test, open options.
// Providers: Google Gemini and OpenAI — routed by the user's saved `provider`.

// Per-provider catalogs shown in the options UI.
const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    models: ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'],
    defaultModel: 'gemini-2.5-flash'
  },
  openai: {
    label: 'OpenAI',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
    defaultModel: 'gpt-4o-mini'
  }
};
const DEFAULT_PROVIDER = 'gemini';

function normalizeProvider(value) {
  return value === 'openai' ? 'openai' : DEFAULT_PROVIDER;
}

// Allowlist + safe-pattern fallback: accept listed models plus any sane
// future id for that provider (gemini-*, gpt-*, o-series, chatgpt-*).
function normalizeModel(provider, value) {
  const catalog = PROVIDERS[provider] || PROVIDERS[DEFAULT_PROVIDER];
  if (typeof value === 'string') {
    const v = value.trim();
    if (catalog.models.includes(v)) return v;
    if (/^[a-z0-9][a-z0-9._:-]{2,64}$/i.test(v)) {
      if (provider === 'openai' && /^(gpt-|chatgpt-|o\d)/i.test(v)) return v;
      if (provider === 'gemini' && /gemini/i.test(v)) return v;
    }
  }
  return catalog.defaultModel;
}

const geminiEndpointFor = (model, apiKey) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

function cleanKey(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

async function getSettings() {
  const stored = await chrome.storage.sync.get([
    'provider',
    'model',
    'geminiApiKey',
    'openaiApiKey',
    'apiKey' // legacy single-key slot (always Gemini) — migrated on read
  ]);
  const provider = normalizeProvider(stored.provider);
  const legacyKey = cleanKey(stored.apiKey);
  const apiKey =
    provider === 'openai'
      ? cleanKey(stored.openaiApiKey)
      : cleanKey(stored.geminiApiKey) || legacyKey;
  const model = normalizeModel(provider, stored.model);
  return { provider, apiKey, model };
}

function extractText(data) {
  try {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      const text = parts
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .join('')
        .trim();
      if (text) return text;
    }
    if (typeof data?.candidates?.[0]?.content === 'string') {
      return data.candidates[0].content.trim();
    }
    return '';
  } catch {
    return '';
  }
}

/** Strip ```json ... ``` / ``` ... ``` wrappers the model sometimes adds. */
function stripMarkdownFences(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw.trim();
  // Remove leading/trailing fences: ```json ... ``` or ``` ... ```
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '');
    text = text.replace(/\s*```\s*$/i, '');
  }
  return text.trim();
}

/** Extract the first {...} JSON object substring as a fallback. */
function extractJsonObjectSubstring(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1);
  }
  return text;
}

async function callGemini({ apiKey, model, prompt, temperature, maxOutputTokens }) {
  const res = await fetch(geminiEndpointFor(model, apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: typeof temperature === 'number' ? temperature : 0.7,
        maxOutputTokens: maxOutputTokens || 1024
      }
    })
  });

  if (res.status === 400 || res.status === 401 || res.status === 403) {
    let detail = '';
    try {
      const errJson = await res.json();
      detail = errJson?.error?.message || JSON.stringify(errJson);
    } catch {
      try {
        detail = await res.text();
      } catch {
        detail = '';
      }
    }
    return {
      ok: false,
      error: 'API_ERROR',
      detail: `Gemini rejected the request (HTTP ${res.status}, model ${model}). ${detail}`.slice(0, 1500)
    };
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      detail = '';
    }
    return {
      ok: false,
      error: 'API_ERROR',
      detail: `Gemini HTTP ${res.status} (model ${model}): ${detail}`.slice(0, 1500)
    };
  }

  const data = await res.json();
  const text = extractText(data);

  if (!text) {
    const blockReason =
      data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || '';
    return {
      ok: false,
      error: 'EMPTY_RESPONSE',
      detail: blockReason
        ? `Model ${model} returned no text (reason: ${blockReason}).`
        : `Model ${model} returned no text.`
    };
  }

  return { ok: true, text, model };
}

async function callOpenAI({ apiKey, model, prompt, temperature, maxOutputTokens }) {
  const res = await fetch(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are an AI form-filling assistant. Follow the user instructions exactly, especially the STRICT OUTPUT RULES.'
        },
        { role: 'user', content: prompt }
      ],
      temperature: typeof temperature === 'number' ? temperature : 0.7,
      max_tokens: maxOutputTokens || 1024
    })
  });

  if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
    let detail = '';
    try {
      const errJson = await res.json();
      detail = errJson?.error?.message || JSON.stringify(errJson);
    } catch {
      try {
        detail = await res.text();
      } catch {
        detail = '';
      }
    }
    return {
      ok: false,
      error: 'API_ERROR',
      detail: `OpenAI rejected the request (HTTP ${res.status}, model ${model}). ${detail}`.slice(0, 1500)
    };
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      detail = '';
    }
    return {
      ok: false,
      error: 'API_ERROR',
      detail: `OpenAI HTTP ${res.status} (model ${model}): ${detail}`.slice(0, 1500)
    };
  }

  const data = await res.json();
  let text = '';
  try {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') text = content.trim();
  } catch {
    text = '';
  }

  if (!text) {
    const finishReason = data?.choices?.[0]?.finish_reason || '';
    return {
      ok: false,
      error: 'EMPTY_RESPONSE',
      detail: finishReason
        ? `Model ${model} returned no text (finish_reason: ${finishReason}).`
        : `Model ${model} returned no text.`
    };
  }

  return { ok: true, text, model };
}

// Provider router — single entry point for all LLM calls.
async function callLLM({ provider, apiKey, model, prompt, temperature, maxOutputTokens }) {
  if (provider === 'openai') {
    return callOpenAI({ apiKey, model, prompt, temperature, maxOutputTokens });
  }
  return callGemini({ apiKey, model, prompt, temperature, maxOutputTokens });
}

// ---------- Prompt builders ----------

function formatOptionsForPrompt(options, maxOptions = 40, maxLen = 80) {
  if (!Array.isArray(options) || options.length === 0) return '';
  const clean = (s) =>
    String(s == null ? '' : s)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLen);
  const items = options.slice(0, maxOptions).map((o) => {
    const v = clean(o && o.value);
    const t = clean(o && o.text);
    if (v && t && v !== t) return `${v} (${t})`;
    return v || t;
  });
  return items.join(' | ');
}

function buildSinglePrompt(context) {
  const ctx = context || {};
  const optionsText = formatOptionsForPrompt(ctx.options);

  // Dropdown fields: force an exact option value, nothing else.
  if (ctx.kind === 'select' || ctx.type === 'select' || optionsText) {
    return [
      'You are an AI form-filling assistant. Pick the best option for a dropdown field.',
      '',
      `Field tag: ${ctx.tagName || 'unknown'} (kind: ${ctx.kind || 'select'})`,
      `Field name: ${ctx.name || 'n/a'}`,
      `Field id: ${ctx.id || 'n/a'}`,
      `Label text: ${ctx.label || 'n/a'}`,
      `ARIA label: ${ctx.ariaLabel || 'n/a'}`,
      `Current value: ${ctx.currentValue || '(empty)'}`,
      `Page title: ${ctx.pageTitle || 'n/a'}`,
      '',
      `Available options (value, or value (label)): ${optionsText || '(none provided — reply with a short standard choice)'}`,
      '',
      'STRICT: Return ONLY the exact option VALUE from the list above — copy it verbatim.',
      'Only a value already in the list may be returned. Never invent, combine, or rephrase into something new.',
      'No quotes, no markdown, no explanation, no preamble.'
    ].join('\n');
  }

  const lines = [
    'You are an AI form-filling assistant.',
    'Generate concise, realistic text to fill into a web form field.',
    'Return ONLY the text to insert — no quotes, no markdown, no explanation, no preamble.',
    '',
    `Field tag: ${ctx.tagName || 'unknown'}`,
    `Input type: ${ctx.type || 'n/a'}`,
    `Field name: ${ctx.name || 'n/a'}`,
    `Field id: ${ctx.id || 'n/a'}`,
    `Placeholder: ${ctx.placeholder || 'n/a'}`,
    `Label text: ${ctx.label || 'n/a'}`,
    `ARIA label: ${ctx.ariaLabel || 'n/a'}`,
    `Current value: ${ctx.currentValue || '(empty)'}`,
    `Page title: ${ctx.pageTitle || 'n/a'}`,
    `Page URL: ${ctx.pageUrl || 'n/a'}`
  ];
  if (ctx.formContext) {
    lines.push(`Surrounding form text: ${String(ctx.formContext).slice(0, 500)}`);
  }
  lines.push(
    '',
    'If the field looks like an email, return a plausible email.',
    'If it looks like a name, return a plausible person name.',
    'If it looks like a message / description / comment / cover letter, return 2-4 sentences.',
    'Otherwise return a short, sensible value for the field.'
  );
  return lines.join('\n');
}

function generateFullFormSuggestion(fields, pageMeta) {
  const fieldLines = fields.map((f) => {
    const pos = f.position ? ` position=[${String(f.position).slice(0, 160)}]` : '';
    const base =
      `- uid "${f.uid}": tag=${f.tagName || 'n/a'} kind=${f.kind || 'text'} type=${f.type || 'n/a'} name=${f.name || 'n/a'} id=${f.id || 'n/a'} placeholder=${f.placeholder || 'n/a'} label=${f.label || 'n/a'} current=${f.currentValue || '(empty)'}${pos}`;
    const optionsText = formatOptionsForPrompt(f.options);
    if ((f.kind === 'select' || f.type === 'select') && optionsText) {
      return `${base} options=[${optionsText}]`;
    }
    if (f.kind === 'combobox') {
      return optionsText
        ? `${base} options=[${optionsText}] (custom dropdown — prefer one of these)`
        : `${base} (custom dropdown, options not rendered — give a short standard choice)`;
    }
    return base;
  });
  return [
    'You are an AI form-filling assistant. Fill EVERY field in the list below with concise, realistic values.',
    '',
    `Page title: ${(pageMeta && pageMeta.title) || 'n/a'}`,
    `Page URL: ${(pageMeta && pageMeta.url) || 'n/a'}`,
    '',
    'Fields:',
    ...fieldLines,
    '',
    'STRICT OUTPUT RULES:',
    '1. Return ONLY a single valid JSON object mapping each uid to its fill value.',
    '2. Example: {"f0": "John Doe", "f1": "john@example.com", "f2": "us"}',
    '3. Include EVERY uid exactly once. Values must be plain strings (use "" for a field you truly cannot fill).',
    '4. VARIETY IS MANDATORY for repeated rows: fields marked "item X of N with the same label" are DISTINCT fields. NEVER repeat the same value across them. Example for 3 item-name fields: row 1 "Web Development", row 2 "UI/UX Design", row 3 "SEO Optimization" — each clearly different. Same for descriptions, quantities, and rates: vary every row realistically.',
    '5. Dropdowns in repeated rows are the ONLY exception: if the same option genuinely fits all rows (e.g. the same tax rate), it may repeat — but only when it truly fits.',
    '6. If a field already has a meaningful non-empty current value (not empty, not just "0"), keep it by returning that same value verbatim.',
    '7. For input type "number": return digits only (e.g. "10", "150.00") — no currency symbols, no commas, no text.',
    '8. For fields with type "select" (or kind "select") that list an options=[...] array: the value MUST be exactly one option value present in that array — copy it verbatim. NEVER invent a value for select fields. If no option fits, use "".',
    '9. For kind "combobox" fields WITH an options list: the value MUST be exactly one of the listed options (exact value, verbatim) — only values already in the list may be selected, never anything new. With NO options list (unrendered popup): return a short, standard choice as plain text (e.g. a country name or category).',
    '10. NO markdown, NO code fences, NO explanation, NO surrounding text — raw JSON only.'
  ].join('\n');
}

// ---------- Handlers ----------

async function handleSingleFill(context, sendResponse) {
  const { provider, apiKey, model } = await getSettings();
  if (!apiKey) {
    sendResponse({ ok: false, error: 'NO_API_KEY' });
    return;
  }
  try {
    const result = await callLLM({
      provider,
      apiKey,
      model,
      prompt: buildSinglePrompt(context || {}),
      temperature: 0.85,
      maxOutputTokens: 512
    });
    if (!result.ok) {
      sendResponse(result);
      return;
    }
    sendResponse({ ok: true, text: result.text, model: result.model });
  } catch (err) {
    sendResponse({
      ok: false,
      error: 'NETWORK_ERROR',
      detail: String((err && err.message) || err)
    });
  }
}

async function handleBatchFill(payload, sendResponse) {
  const { provider, apiKey, model } = await getSettings();
  if (!apiKey) {
    sendResponse({ ok: false, error: 'NO_API_KEY' });
    return;
  }
  const fields = Array.isArray(payload?.fields) ? payload.fields : [];
  if (fields.length === 0) {
    sendResponse({ ok: false, error: 'NO_FIELDS', detail: 'No fillable fields were found on the page.' });
    return;
  }
  // Cap batch size to keep prompts bounded.
  const capped = fields.slice(0, 40);
  try {
    const result = await callLLM({
      provider,
      apiKey,
      model,
      prompt: generateFullFormSuggestion(capped, payload?.page),
      temperature: 0.75,
      maxOutputTokens: 2048
    });
    if (!result.ok) {
      sendResponse(result);
      return;
    }
    const cleaned = stripMarkdownFences(result.text);
    let values = null;
    try {
      values = JSON.parse(cleaned);
    } catch {
      try {
        values = JSON.parse(extractJsonObjectSubstring(cleaned));
      } catch (parseErr) {
        sendResponse({
          ok: false,
          error: 'BAD_JSON',
          detail: `Model did not return valid JSON. Raw output: ${cleaned.slice(0, 800)}`
        });
        return;
      }
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      sendResponse({
        ok: false,
        error: 'BAD_JSON',
        detail: `Model did not return a JSON object. Raw output: ${cleaned.slice(0, 800)}`
      });
      return;
    }
    // Normalize: keep only known uids, coerce values to strings.
    const knownUids = new Set(capped.map((f) => f.uid));
    const normalized = {};
    for (const [uid, val] of Object.entries(values)) {
      if (knownUids.has(uid)) normalized[uid] = val == null ? '' : String(val);
    }
    sendResponse({ ok: true, values: normalized, model: result.model });
  } catch (err) {
    sendResponse({
      ok: false,
      error: 'NETWORK_ERROR',
      detail: String((err && err.message) || err)
    });
  }
}

async function handleTest(request, sendResponse) {
  const { provider: storedProvider, apiKey, model: storedModel } = await getSettings();
  const provider = normalizeProvider(request?.provider || storedProvider);
  const keyToTest =
    typeof request?.apiKey === 'string' && request.apiKey.trim()
      ? request.apiKey.trim()
      : provider === storedProvider
        ? apiKey
        : '';
  const modelToTest =
    request?.model && request.model.trim()
      ? normalizeModel(provider, request.model)
      : provider === storedProvider
        ? storedModel
        : normalizeModel(provider, '');

  if (!keyToTest) {
    sendResponse({ ok: false, error: 'NO_API_KEY', detail: 'Paste an API key first.' });
    return;
  }
  try {
    const result = await callLLM({
      provider,
      apiKey: keyToTest,
      model: modelToTest,
      prompt: 'Reply with the single word: ok',
      temperature: 0,
      maxOutputTokens: 8
    });
    if (!result.ok) {
      sendResponse(result);
      return;
    }
    sendResponse({ ok: true, text: result.text, model: result.model });
  } catch (err) {
    sendResponse({
      ok: false,
      error: 'NETWORK_ERROR',
      detail: String((err && err.message) || err)
    });
  }
}

// ---------- Dynamic toolbar icon (active/idle based on API key) ----------

const ICON_SETS = {
  active: { 16: 'icons/active-16.png', 48: 'icons/active-48.png', 128: 'icons/active-128.png' },
  idle: { 16: 'icons/idle-16.png', 48: 'icons/idle-48.png', 128: 'icons/idle-128.png' }
};

async function refreshActionIcon() {
  try {
    const { apiKey } = await getSettings();
    const hasKey = typeof apiKey === 'string' && apiKey.trim().length > 0;
    await chrome.action.setIcon({ path: hasKey ? ICON_SETS.active : ICON_SETS.idle });
  } catch {
    /* icon update is best-effort; core fill logic unaffected */
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (
    area === 'sync' &&
    changes &&
    (Object.hasOwn(changes, 'apiKey') ||
      Object.hasOwn(changes, 'geminiApiKey') ||
      Object.hasOwn(changes, 'openaiApiKey'))
  ) {
    refreshActionIcon();
  }
});

refreshActionIcon();

// ---------- Message router ----------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'AIFF_OPEN_OPTIONS') {
    try {
      const p = chrome.runtime.openOptionsPage();
      if (p && typeof p.catch === 'function') {
        p.catch(() => chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }));
      }
    } catch {
      chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
    }
    return false;
  }

  if (message.type === 'AIFF_FILL') {
    handleSingleFill(message.context || {}, sendResponse);
    return true;
  }

  if (message.type === 'AIFF_FILL_ALL') {
    handleBatchFill(message.payload || {}, sendResponse);
    return true;
  }

  if (message.type === 'AIFF_TEST') {
    handleTest(
      { provider: message.provider, apiKey: message.apiKey, model: message.model },
      sendResponse
    );
    return true;
  }

  return false;
});
