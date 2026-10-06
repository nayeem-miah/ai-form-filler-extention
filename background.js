// background.js — MV3 Service Worker (module)
// All LLM API calls live here (avoids CORS, keeps API keys out of content scripts).
// Supports: single-field fill, batch form fill (JSON), connection test, open options.
// Providers: Google Gemini, OpenAI, and any OpenAI-compatible API
// (OpenRouter, Groq, Together AI, DeepSeek, Ollama, custom local servers).

// Per-provider catalogs shown in the options UI.
// `custom` has no fixed model list — the user types the model id.
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
    defaultModel: 'gemini-3.5-flash-lite'
  },
  openai: {
    label: 'OpenAI (Official)',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
    defaultModel: 'gpt-4o-mini'
  },
  custom: {
    label: 'OpenAI Compatible / Custom API',
    models: [],
    defaultModel: '',
    freeModel: true
  }
};
const DEFAULT_PROVIDER = 'gemini';

function normalizeProvider(value) {
  if (value === 'openai' || value === 'custom') return value;
  return DEFAULT_PROVIDER;
}

// Allowlist + safe-pattern fallback: accept listed models plus any sane
// future id for that provider (gemini-*, gpt-*, o-series, chatgpt-*).
// For `custom`, any safe-looking id is accepted — including slashes and
// colons used by model ids like `deepseek/deepseek-r1` or `llama3:8b`.
function normalizeModel(provider, value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const catalog = PROVIDERS[provider] || PROVIDERS[DEFAULT_PROVIDER];

  if (provider === 'custom') {
    return /^[a-z0-9][a-z0-9._\-/:]{0,120}$/i.test(raw) ? raw : '';
  }

  if (raw) {
    if (catalog.models.includes(raw)) return raw;
    if (/^[a-z0-9][a-z0-9._:-]{2,64}$/i.test(raw)) {
      if (provider === 'openai' && /^(gpt-|chatgpt-|o\d)/i.test(raw)) return raw;
      if (provider === 'gemini' && /gemini/i.test(raw)) return raw;
    }
  }
  return catalog.defaultModel;
}

const geminiEndpointFor = (model, apiKey) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_COMPATIBLE_BASE_URL = 'https://openrouter.ai/api/v1';

function cleanKey(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

// Strip trailing slashes so `${base}/chat/completions` never doubles up.
function normalizeBaseUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw ? raw.replace(/\/+$/, '') : '';
}

function compatibleEndpointFor(apiBaseUrl) {
  return `${normalizeBaseUrl(apiBaseUrl)}/chat/completions`;
}

async function getSettings() {
  const stored = await chrome.storage.sync.get([
    'provider',
    'model',
    'geminiApiKey',
    'openaiApiKey',
    'apiKey', // legacy single-key slot (always Gemini) — migrated on read
    'apiBaseUrl',
    'customModel',
    'customApiKey'
  ]);
  const provider = normalizeProvider(stored.provider);
  const legacyKey = cleanKey(stored.apiKey);

  let apiKey = '';
  let model;
  let apiBaseUrl = '';

  if (provider === 'openai') {
    apiKey = cleanKey(stored.openaiApiKey);
    model = normalizeModel('openai', stored.model);
  } else if (provider === 'custom') {
    apiKey = cleanKey(stored.customApiKey);
    apiBaseUrl = normalizeBaseUrl(stored.apiBaseUrl) || DEFAULT_COMPATIBLE_BASE_URL;
    model = normalizeModel('custom', stored.customModel);
  } else {
    apiKey = cleanKey(stored.geminiApiKey) || legacyKey;
    model = normalizeModel('gemini', stored.model);
  }

  return { provider, apiKey, model, apiBaseUrl };
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

// OpenAI-compatible endpoints: OpenRouter, Groq, Together AI, DeepSeek,
// Ollama, LM Studio, vLLM, or any local server exposing /chat/completions.
async function callOpenAICompatible({
  apiBaseUrl,
  apiKey,
  model,
  prompt,
  temperature,
  maxOutputTokens
}) {
  const base = normalizeBaseUrl(apiBaseUrl);
  if (!base) {
    return {
      ok: false,
      error: 'API_ERROR',
      detail: 'No API Base URL configured. Set one in the extension options (e.g. https://openrouter.ai/api/v1).'
    };
  }
  if (!model) {
    return {
      ok: false,
      error: 'API_ERROR',
      detail: 'No model name configured. Enter the model id used by your provider (e.g. deepseek/deepseek-r1).'
    };
  }

  const headers = { 'Content-Type': 'application/json' };
  // Local servers such as Ollama usually need no auth — only send the
  // Authorization header when a key is actually configured.
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(compatibleEndpointFor(base), {
    method: 'POST',
    headers,
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
      max_tokens: maxOutputTokens || 1024,
      stream: false
    })
  });

  if (!res.ok) {
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
      detail: `${base} rejected the request (HTTP ${res.status}, model ${model}). ${detail}`.slice(0, 1500)
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
        ? `${model} returned no text (finish_reason: ${finishReason}).`
        : `${model} returned no text. Check the model name and base URL.`
    };
  }

  return { ok: true, text, model };
}

// Provider router — single entry point for all LLM calls.
// Some providers (OpenRouter free tiers, Groq on metered plans) reject the
// whole request when the requested max_tokens exceeds the remaining balance
// (HTTP 402). Detect that and retry once with a smaller budget.
const INSUFFICIENT_CREDITS_RE =
  /insufficient_credits|requires more credits|can only afford|payment required|402/i;

function isCreditError(result) {
  return Boolean(result && !result.ok && INSUFFICIENT_CREDITS_RE.test(String(result.detail || '')));
}

// Reasoning models can burn the whole budget on thinking tokens and return
// nothing (finish_reason: length). Retry once with a bigger budget.
function isBudgetStarved(result) {
  return Boolean(
    result &&
      !result.ok &&
      result.error === 'EMPTY_RESPONSE' &&
      /finish_reason:\s*length|no text \(finish_reason: length\)/i.test(String(result.detail || ''))
  );
}

// Retry-friendly hint when the model ran out of output budget.
function emptyTextDetail(model, finishReason) {
  if (/length|max_tokens/i.test(String(finishReason || ''))) {
    return (
      `${model} ran out of output budget before finishing, so no text was returned ` +
      '(finish_reason: length). Reasoning models spend part of the budget thinking. ' +
      'Try a model with a larger context, or a less expensive one.'
    );
  }
  return `${model} returned no text (finish_reason: ${finishReason}).`;
}

async function callLLMWithCreditFallback(args) {
  const requested = typeof args.maxOutputTokens === 'number' ? args.maxOutputTokens : 1024;
  let first = await callLLM(args);

  // 1) Balance too low for the requested budget -> halve and retry once.
  if (isCreditError(first)) {
    const reduced = Math.max(256, Math.floor(requested / 2));
    if (reduced < requested) {
      first = await callLLM({ ...args, maxOutputTokens: reduced });
    } else {
      return {
        ...first,
        detail:
          `${first.detail}\n\nYour provider balance is too low for this request. ` +
          'Add credits, or pick a cheaper or free model in Settings.'
      };
    }
  }

  // 2) Model returned nothing because it ran out of budget -> retry bigger.
  if (isBudgetStarved(first)) {
    const bigger = Math.min(8192, Math.max(1024, requested * 4));
if (bigger > requested) {
      return callLLM({ ...args, maxOutputTokens: bigger });
    }
  }

  return first;
}

async function callLLM({
  provider,
  apiKey,
  model,
  apiBaseUrl,
  prompt,
  temperature,
  maxOutputTokens
}) {
  if (provider === 'openai') {
    return callOpenAI({ apiKey, model, prompt, temperature, maxOutputTokens });
  }
  if (provider === 'custom') {
    return callOpenAICompatible({
      apiBaseUrl,
      apiKey,
      model,
      prompt,
      temperature,
      maxOutputTokens
    });
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

function buildSinglePrompt(context, options = {}) {
  const ctx = context || {};
  const optionsText = formatOptionsForPrompt(ctx.options);

  // Dropdown fields: force an exact option value, nothing else.
  // No random anchor here — the value must come from the fixed option list.
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

  // Variation anchor for single-field fills (same mechanism as batch).
  const persona = options.randomize ? buildRandomPersona() : null;
  if (persona) {
    lines.push(...personaLines(persona));
    lines.push(
      'Ground this value in the anchor above so repeated clicks give different results.'
    );
  }
  lines.push(...avoidLines(options.avoidValues));

  lines.push(
    '',
    'If the field looks like an email, return a plausible email.',
    'If it looks like a name, return a plausible person name.',
    'If it looks like a message / description / comment / cover letter, return 2-4 sentences.',
    'Otherwise return a short, sensible value for the field.'
  );
  return lines.join('\n');
}

// ---------- Variation support (developer form testing) ----------

const RANDOM_POOLS = {
  first: ['Ava', 'Liam', 'Noor', 'Mia', 'Zara', 'Kai', 'Ivy', 'Omar', 'Lena', 'Ravi', 'Nora', 'Eli', 'Sana', 'Theo', 'Maya', 'Idris'],
  last: ['Bennett', 'Okafor', 'Nakamura', 'Silva', 'Khan', 'Weber', 'Rossi', 'Dubois', 'Novak', 'Haddad', 'Lindqvist', 'Ferreira'],
  companyWord: ['Logistics', 'Analytics', 'Systems', 'Partners', 'Labs', 'Supply Co', 'Ventures', 'Industries'],
  industry: ['freight forwarding', 'renewable energy', 'marine logistics', 'agritech', 'urban planning', 'cybersecurity', 'precision manufacturing', 'cold-chain supply'],
  city: ['Rotterdam', 'Valletta', 'Gothenburg', 'Porto', 'Cusco', 'Tashkent', 'Bologna', 'Durban', 'Tampere', 'Valparaiso'],
  project: ['warehouse relocation', 'fleet telemetry rollout', 'supplier consolidation', 'cold-storage upgrade', 'route optimisation pilot', 'packaging redesign']
};

function pickRandom(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}

// One coherent anchor per run: every field in the batch stays consistent
// (same person, same company) while differing between runs.
function buildRandomPersona() {
  const first = pickRandom(RANDOM_POOLS.first);
  const last = pickRandom(RANDOM_POOLS.last);
  return {
    person: `${first} ${last}`,
    company: `${last} ${pickRandom(RANDOM_POOLS.companyWord)}`,
    industry: pickRandom(RANDOM_POOLS.industry),
    city: pickRandom(RANDOM_POOLS.city),
    project: pickRandom(RANDOM_POOLS.project),
    nonce: Math.random().toString(36).slice(2, 8)
  };
}

function personaLines(persona) {
  return [
    '',
    'RANDOM ANCHOR FOR THIS RUN (ground generated values in it so this run differs from previous ones):',
    `- Contact person: ${persona.person}`,
    `- Company: ${persona.company}`,
    `- Industry: ${persona.industry}`,
    `- City: ${persona.city}`,
    `- Current project: ${persona.project}`,
    `- Run id: ${persona.nonce}`,
    'Derive names, emails, addresses, references and descriptions from these. Never output the run id.'
  ];
}

function avoidLines(avoidValues) {
  if (!Array.isArray(avoidValues) || avoidValues.length === 0) return [];
  const cleaned = avoidValues
    .filter((v) => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim().slice(0, 40))
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, 60);
  if (cleaned.length === 0) return [];
  return [
    '',
    'PREVIOUSLY USED VALUES — do not repeat these, pick different ones:',
    cleaned.map((v) => `- ${v}`).join('\n')
  ];
}

function generateFullFormSuggestion(fields, pageMeta, options = {}) {
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

  // Variation anchor: without it the model returns its single most "typical"
  // answer every time, so repeated runs produce identical data.
  const persona = options.randomize ? buildRandomPersona() : null;

  return [
    'You are an AI form-filling assistant. Fill EVERY field in the list below with concise, realistic values.',
    '',
    `Page title: ${(pageMeta && pageMeta.title) || 'n/a'}`,
    `Page URL: ${(pageMeta && pageMeta.url) || 'n/a'}`,
    '',
    'Fields:',
    ...fieldLines,
    ...(persona ? personaLines(persona) : []),
    ...avoidLines(options.avoidValues),
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

async function handleSingleFill(context, sendResponse, request) {
  const { provider, apiKey, model, apiBaseUrl } = await getSettings();
  if (!apiKey && provider !== 'custom') {
    sendResponse({ ok: false, error: 'NO_API_KEY' });
    return;
  }
  if (provider === 'custom' && !apiBaseUrl) {
    sendResponse({
      ok: false,
      error: 'API_ERROR',
      detail: 'Set an API Base URL in the extension options first.'
    });
    return;
  }
  // Variation honours the content script's toggle, falling back to the
  // stored preference when the flag is absent.
  const randomize = request && typeof request.randomize === 'boolean' ? request.randomize : true;
  try {
    const result = await callLLMWithCreditFallback({
      provider,
      apiKey,
      model,
      apiBaseUrl,
      prompt: buildSinglePrompt(context || {}, {
        randomize,
        avoidValues: request && request.avoidValues
      }),
      // Higher temperature when randomising so clicks diverge visibly.
      temperature: randomize ? 1.0 : 0.85,
      // 512 leaves room for reasoning models, whose thinking tokens count
      // against the budget and otherwise return empty content.
      maxOutputTokens: 768
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
  const { provider, apiKey, model, apiBaseUrl } = await getSettings();
  if (!apiKey && provider !== 'custom') {
    sendResponse({ ok: false, error: 'NO_API_KEY' });
    return;
  }
  if (provider === 'custom' && !apiBaseUrl) {
    sendResponse({
      ok: false,
      error: 'API_ERROR',
      detail: 'Set an API Base URL in the extension options first.'
    });
    return;
  }
  const fields = Array.isArray(payload?.fields) ? payload.fields : [];
  if (fields.length === 0) {
    sendResponse({ ok: false, error: 'NO_FIELDS', detail: 'No fillable fields were found on the page.' });
    return;
  }
  // Cap batch size to keep prompts bounded.
  const capped = fields.slice(0, 40);
  const randomize = payload?.randomize !== false;
  try {
    const result = await callLLMWithCreditFallback({
      provider,
      apiKey,
      model,
      apiBaseUrl,
      prompt: generateFullFormSuggestion(capped, payload?.page, {
        randomize,
        avoidValues: payload?.avoidValues
      }),
      // Higher temperature when randomising so runs diverge more visibly.
      temperature: randomize ? 1.0 : 0.75,
      // 1536 is enough for a 40-field JSON response without tripping the
      // credit checks on free tiers (callLLM halves this automatically on 402).
      maxOutputTokens: 1536
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
  const { provider: storedProvider, apiKey, model: storedModel, apiBaseUrl: storedBase } =
    await getSettings();
  const provider = normalizeProvider(request?.provider || storedProvider);
  const keyToTest =
    typeof request?.apiKey === 'string' && request.apiKey.trim()
      ? request.apiKey.trim()
      : provider === storedProvider
        ? apiKey
        : '';

  // Custom provider: base URL + free-text model come from their own fields.
  let modelToTest;
  let baseUrlToTest = '';
  if (provider === 'custom') {
    const requestedBase = request?.apiBaseUrl ? normalizeBaseUrl(request.apiBaseUrl) : '';
    baseUrlToTest = requestedBase || (provider === storedProvider ? storedBase : '');
    const requestedModel = request?.customModel ? String(request.customModel).trim() : '';
    modelToTest = requestedModel
      ? normalizeModel('custom', requestedModel)
      : provider === storedProvider
        ? storedModel
        : '';
  } else {
    modelToTest =
      request?.model && request.model.trim()
        ? normalizeModel(provider, request.model)
        : provider === storedProvider
          ? storedModel
          : normalizeModel(provider, '');
  }

  // Local servers (Ollama, LM Studio) often need no API key.
  if (!keyToTest && provider !== 'custom') {
    sendResponse({ ok: false, error: 'NO_API_KEY', detail: 'Paste an API key first.' });
    return;
  }
  if (provider === 'custom' && !baseUrlToTest) {
    sendResponse({
      ok: false,
      error: 'API_ERROR',
      detail: 'Enter an API Base URL (e.g. https://openrouter.ai/api/v1) and click Save.'
    });
    return;
  }
  try {
    const result = await callLLMWithCreditFallback({
      provider,
      apiKey: keyToTest,
      model: modelToTest,
      apiBaseUrl: baseUrlToTest,
      prompt: 'Reply with the single word: ok',
      temperature: 0,
      // 16 was too small: reasoning models spend the budget on thinking
      // tokens and return empty content (finish_reason: length).
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

// ---------- GitHub release update checker ----------

// Point these at your own repository to power the "Check for Updates" button.
const GITHUB_REPO = { owner: 'nayeen-miah', repo: 'ai-form-filler-extention' };
const GITHUB_LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPO.owner}/${GITHUB_REPO.repo}/releases/latest`;

async function handleCheckUpdate(sendResponse) {
  try {
    const res = await fetch(GITHUB_LATEST_RELEASE_URL, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json' }
    });

    if (res.status === 404) {
      sendResponse({
        ok: false,
        error: 'NO_RELEASE',
        detail: `No releases published yet in ${GITHUB_REPO.owner}/${GITHUB_REPO.repo}.`
      });
      return;
    }
    if (res.status === 403 || res.status === 429) {
      sendResponse({
        ok: false,
        error: 'RATE_LIMITED',
        detail: 'GitHub API rate limit reached. Try again in a few minutes.'
      });
      return;
    }
    if (!res.ok) {
      sendResponse({ ok: false, error: 'API_ERROR', detail: `GitHub HTTP ${res.status}.` });
      return;
    }

    const data = await res.json();
    const tag = String(data?.tag_name || '').trim();
    if (!tag) {
      sendResponse({ ok: false, error: 'API_ERROR', detail: 'Release tag missing from GitHub response.' });
      return;
    }
    // Only ever hand back a github.com URL.
    const rawUrl = String(data?.html_url || '');
    const releaseUrl = /^https:\/\/github\.com\//.test(rawUrl) ? rawUrl : '';
    sendResponse({ ok: true, tag, releaseUrl, current: chrome.runtime.getManifest().version });
  } catch (err) {
    sendResponse({
      ok: false,
      error: 'NETWORK_ERROR',
      detail: String((err && err.message) || err)
    });
  }
}

// ---------- Toolbar icon click -> open settings ----------

// No default_popup is declared, so this listener receives the click and we
// send the user straight to the Options page.
if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(() => {
    chrome.runtime.openOptionsPage().catch(() => {
      chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
    });
  });
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
      Object.hasOwn(changes, 'openaiApiKey') ||
      Object.hasOwn(changes, 'customApiKey'))
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
    handleSingleFill(message.context || {}, sendResponse, {
      randomize: message.randomize,
      avoidValues: message.avoidValues
    });
    return true;
  }

  if (message.type === 'AIFF_FILL_ALL') {
    handleBatchFill(message.payload || {}, sendResponse);
    return true;
  }

  if (message.type === 'AIFF_CHECK_UPDATE') {
    handleCheckUpdate(sendResponse);
    return true;
  }

  if (message.type === 'AIFF_TEST') {
    handleTest(
      {
        provider: message.provider,
        apiKey: message.apiKey,
        model: message.model,
        apiBaseUrl: message.apiBaseUrl,
        customModel: message.customModel
      },
      sendResponse
    );
    return true;
  }

  return false;
});
