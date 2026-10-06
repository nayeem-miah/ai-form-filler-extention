/* content.js — Dual fill capabilities:
 *  1. Single Field Fill: floating "✨ AI Fill" button near any focused <input>,
 *     <textarea>, <select>, or custom dropdown trigger.
 *  2. Entire Form Fill: fixed "⚡ Fill All Fields" button at bottom-right; batch-fills
 *     all visible fields (text inputs, selects, custom comboboxes) seamlessly.
 * Shadow DOM is used for both buttons to avoid CSS collisions with host pages.
 * Event delegation (focusin) handles SPA / dynamically-rendered inputs.
 * Every programmatic fill dispatches synthetic events (input + change, plus click
 * for custom dropdowns) so React/Vue/Angular detect the value change.
 */
(() => {
  'use strict';

  const HOST_ID = 'ai-form-filler-root';
  const IGNORED_INPUT_TYPES = new Set([
    'password',
    'file',
    'hidden',
    'checkbox',
    'radio',
    'submit',
    'button',
    'reset',
    'image',
    'range',
    'color'
  ]);
  const MAX_BATCH_FIELDS = 40;
  // Cap popups opened just for option harvesting (each costs ~1s).
  const MAX_HARVEST_FIELDS = 12;

  let host = null;
  let shadow = null;
  let singleBtn = null;
  let fillAllBtn = null;
  let activeField = null;
  let hideTimer = null;
  let isSingleLoading = false;
  let isBatchLoading = false;

  const SHARED_CSS = `
    .aiff-btn {
      pointer-events: auto;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      font-weight: 600;
      color: #fff;
      background: linear-gradient(135deg, #6e56cf, #3e63dd);
      border: none;
      border-radius: 999px;
      box-shadow: 0 4px 16px rgba(62, 99, 221, 0.45);
      cursor: pointer;
      white-space: nowrap;
      user-select: none;
      transition: transform 0.12s ease, box-shadow 0.12s ease, opacity 0.12s ease, filter 0.12s ease;
    }
    .aiff-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(62,99,221,0.55); }
    .aiff-btn:disabled { opacity: 0.85; cursor: wait; }
    .aiff-btn-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 15px;
      height: 15px;
      flex: 0 0 15px;
    }
    .aiff-btn-icon svg { width: 100%; height: 100%; display: block; }
    .aiff-btn-text { white-space: nowrap; }
    .aiff-btn.aiff-error { background: linear-gradient(135deg, #d13415, #e5484d); box-shadow: 0 4px 16px rgba(229,72,77,0.45); }
    .aiff-btn.aiff-success { background: linear-gradient(135deg, #18794e, #30a46c); box-shadow: 0 4px 16px rgba(48,164,108,0.45); }
    .aiff-single {
      position: fixed;
      display: none;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
    }
    .aiff-fill-all {
      position: fixed;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      right: 20px;
      bottom: 20px;
      padding: 11px 16px;
      font-size: 13.5px;
      background: linear-gradient(135deg, #18794e, #30a46c);
      box-shadow: 0 8px 24px rgba(24, 121, 78, 0.45);
      cursor: grab;
    }
    .aiff-fill-all .aiff-btn-icon { width: 14px; height: 14px; flex: 0 0 14px; }
    .aiff-fill-all:active { cursor: grabbing; }
    .aiff-fill-all:hover:not(:disabled) { box-shadow: 0 10px 28px rgba(24,121,78,0.55); }

    /* ---- Toast notifications ---- */
    .aiff-toasts {
      position: fixed;
      right: 20px;
      top: 20px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 380px;
      pointer-events: none;
    }
    .aiff-toast {
      pointer-events: auto;
      display: flex;
      gap: 12px;
      padding: 14px 16px;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-left: 4px solid #3e63dd;
      border-radius: 12px;
      box-shadow: 0 10px 30px rgba(16, 24, 40, 0.14);
      animation: aiff-toast-in 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2);
    }
    .aiff-toast.is-leaving { animation: aiff-toast-out 0.18s ease forwards; }
    @keyframes aiff-toast-in {
      from { opacity: 0; transform: translateY(-8px) scale(0.97); }
      to { opacity: 1; transform: none; }
    }
    @keyframes aiff-toast-out {
      to { opacity: 0; transform: translateY(-6px) scale(0.97); }
    }
    .aiff-toast-icon {
      flex: 0 0 20px;
      width: 20px;
      height: 20px;
      margin-top: 1px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      color: #fff;
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
    }
    .aiff-toast-body { flex: 1; min-width: 0; }
    .aiff-toast-title {
      margin: 0 0 3px;
      font-size: 13.5px;
      font-weight: 650;
      color: #101828;
      line-height: 1.35;
    }
    .aiff-toast-msg {
      margin: 0;
      font-size: 12.5px;
      color: #5b6474;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .aiff-toast-action {
      margin-top: 10px;
      padding: 6px 12px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      color: #fff;
      background: #171717;
      border: none;
      border-radius: 7px;
      cursor: pointer;
    }
    .aiff-toast-action:hover { opacity: 0.88; }
    .aiff-toast-close {
      flex: 0 0 auto;
      align-self: flex-start;
      padding: 0;
      font-size: 16px;
      line-height: 1;
      color: #98a2b3;
      background: none;
      border: none;
      cursor: pointer;
    }
    .aiff-toast-close:hover { color: #101828; }

    .aiff-toast-error { border-left-color: #d13415; }
    .aiff-toast-error .aiff-toast-icon { background: #d13415; }
    .aiff-toast-success { border-left-color: #18794e; }
    .aiff-toast-success .aiff-toast-icon { background: #18794e; }
    .aiff-toast-warn { border-left-color: #b54708; }
    .aiff-toast-warn .aiff-toast-icon { background: #b54708; }
    .aiff-toast-info { border-left-color: #3e63dd; }
    .aiff-toast-info .aiff-toast-icon { background: #3e63dd; }
  `;

  // ---------- Toast notifications ----------

const TOAST_ICON = { error: '!', success: '✓', warn: '!', info: 'i' };

function toastContainer() {
  ensureUI();
  if (!shadow) return null;
  let box = shadow.querySelector('[data-aiff-toasts]');
  if (!box) {
    box = document.createElement('div');
    box.className = 'aiff-toasts';
    box.setAttribute('data-aiff-toasts', 'true');
    shadow.appendChild(box);
  }
  return box;
}

/**
 * showToast({ kind, title, message, duration, action })
 * kind: 'error' | 'success' | 'warn' | 'info'
 */
function showToast(options) {
  const cfg = options || {};
  const kind = TOAST_ICON[cfg.kind] ? cfg.kind : 'info';
  const box = toastContainer();
  if (!box) return;

  const toast = document.createElement('div');
  toast.className = `aiff-toast aiff-toast-${kind}`;

  const icon = document.createElement('div');
  icon.className = 'aiff-toast-icon';
  icon.textContent = TOAST_ICON[kind];
  toast.appendChild(icon);

  const body = document.createElement('div');
  body.className = 'aiff-toast-body';

  const title = document.createElement('p');
  title.className = 'aiff-toast-title';
  title.textContent = cfg.title || 'AI Form Filler';
  body.appendChild(title);

  if (cfg.message) {
    const msg = document.createElement('p');
    msg.className = 'aiff-toast-msg';
    msg.textContent = String(cfg.message);
    body.appendChild(msg);
  }

  if (cfg.action && cfg.action.label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'aiff-toast-action';
    btn.textContent = cfg.action.label;
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      dismissToast(toast);
      try {
        cfg.action.onClick();
      } catch {
        /* noop */
      }
    });
    body.appendChild(btn);
  }

  toast.appendChild(body);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'aiff-toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('mousedown', (e) => e.preventDefault());
  close.addEventListener('click', () => dismissToast(toast));
  toast.appendChild(close);

  box.appendChild(toast);

  // Cap the stack so repeated failures don't cover the page.
  const all = [...box.querySelectorAll('.aiff-toast:not(.is-leaving)')];
  if (all.length > 3) dismissToast(all[0]);

  const duration = typeof cfg.duration === 'number' ? cfg.duration : kind === 'error' ? 9000 : 4500;
  if (duration > 0) setTimeout(() => dismissToast(toast), duration);
}

function dismissToast(toast) {
  if (!toast || !toast.parentNode) return;
  toast.classList.add('is-leaving');
  setTimeout(() => {
    try {
      toast.remove();
    } catch {
      /* noop */
    }
  }, 200);
}

// ---------- Friendly error mapping ----------

/**
 * Turns raw provider errors into an actionable title + message.
 * Falls back to the original detail when nothing matches.
 */
function friendlyApiError(detail, providerLabel) {
  const raw = String(detail || '').trim();
  const provider = providerLabel || 'the provider';

  if (!raw) {
    return {
      title: 'Request failed',
      message: 'The provider did not return an error message. Check your settings and try again.'
    };
  }

  if (/\b401\b/.test(raw)) {
    return {
      title: 'API key not accepted',
      message:
        `${provider} rejected the key (401). This usually means the key is invalid, expired, or not saved yet. Open Settings and re-save it.`
    };
  }
  if (/\b403\b/.test(raw)) {
    return {
      title: 'Access denied',
      message:
        `${provider} refused this request (403). The key may lack access to that model, or the account has no quota left.`
    };
  }
  if (/\b404\b/.test(raw)) {
    return {
      title: 'Model or URL not found',
      message: `${provider} returned 404. Check the model name and the API Base URL in Settings.`
    };
  }
  if (/\b402\b|insufficient_credits|requires more credits|can only afford|payment required/i.test(raw)) {
    return {
      title: 'Out of credits',
      message:
        `${provider} has no balance left for this request. Add credits in your ${provider} account, or switch to a free model (for example one ending in :free).`
    };
  }
  if (/finish_reason:\s*length|ran out of output budget/i.test(raw)) {
    return {
      title: 'Response was cut off',
      message:
        'The model used up its output budget before producing an answer. Try a model with a larger context window, or a less expensive one.'
    };
  }
  if (/\b429\b/.test(raw)) {
    return {
      title: 'Rate limit reached',
      message: 'Too many requests. Wait a minute, then try again — or use a model with a higher quota.'
    };
  }
  if (/\b5\d\d\b/.test(raw) || /overloaded|unavailable|internal error/i.test(raw)) {
    return {
      title: 'Provider temporarily unavailable',
      message: 'The AI service returned a server error. Try again in a few moments.'
    };
  }
  if (/failed to fetch|networkerror|network error|load failed/i.test(raw)) {
    return {
      title: 'No connection',
      message: 'Could not reach the provider. Check your internet connection, then retry.'
    };
  }
  if (/context invalidated|extension context/i.test(raw)) {
    return {
      title: 'Extension reloaded',
      message: 'Refresh this page (Ctrl+R) so the extension can reconnect, then try again.'
    };
  }
  if (/auth cookie|org id/i.test(raw)) {
    return {
      title: 'Key not sent correctly',
      message:
        `${provider} did not receive a usable API key. Save the key again in Settings, and make sure the provider matches the key type.`
    };
  }
  if (/did not return valid json|BAD_JSON|valid JSON/i.test(raw)) {
    return {
      title: 'Unexpected AI response',
      message: 'The model replied with something other than the expected format. Try again.'
    };
  }

  // Unknown: show a trimmed raw message so nothing is silently swallowed.
  return { title: 'Something went wrong', message: raw.slice(0, 300) };
}

function openOptionsPage() {
  try {
    chrome.runtime.sendMessage({ type: 'AIFF_OPEN_OPTIONS' });
  } catch {
    /* ignore */
  }
}

// Status-only SVG glyphs for the floating buttons. The idle labels are plain
  // text with no icon; these appear only while busy, on success, and on failure.
  const ICONS = {
    spinner:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9" opacity="0.25"/><path d="M21 12a9 9 0 0 0-9-9"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
    warning:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>'
  };

  /** Build button internals: an optional icon span plus a text span. */
  function buildButtonContent(btn, iconSvg, label) {
    btn.textContent = '';
    // Idle state has no icon; busy/success/error states do.
    if (iconSvg) {
      const icon = document.createElement('span');
      icon.className = 'aiff-btn-icon';
      icon.innerHTML = iconSvg;
      btn.appendChild(icon);
    }
    const text = document.createElement('span');
    text.className = 'aiff-btn-text';
    text.textContent = label;
    btn.appendChild(text);
  }

  /** Update icon + label without rebuilding the button. */
  function setButtonFace(btn, iconSvg, label) {
    if (!btn) return;
    const text = btn.querySelector('.aiff-btn-text');
    if (!text) {
      buildButtonContent(btn, iconSvg, label);
      return;
    }
    const icon = btn.querySelector('.aiff-btn-icon');
    // Icons come and go between states, so add or remove the span as needed.
    if (iconSvg) {
      if (icon) {
        icon.innerHTML = iconSvg;
      } else {
        const fresh = document.createElement('span');
        fresh.className = 'aiff-btn-icon';
        fresh.innerHTML = iconSvg;
        btn.insertBefore(fresh, text);
      }
    } else if (icon) {
      icon.remove();
    }
    if (label != null) text.textContent = label;
  }

  // ---------- Shadow DOM setup ----------

  function ensureUI() {
    if (host && shadow && singleBtn && fillAllBtn) return;

    host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      host.style.cssText =
        'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
      document.documentElement.appendChild(host);
    }
    shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });

    if (!shadow.querySelector('style[data-aiff]')) {
      const style = document.createElement('style');
      style.setAttribute('data-aiff', 'true');
      style.textContent = SHARED_CSS;
      shadow.appendChild(style);
    }

    if (!shadow.querySelector('[data-aiff-single]')) {
      singleBtn = document.createElement('button');
      singleBtn.type = 'button';
      singleBtn.className = 'aiff-btn aiff-single';
      singleBtn.setAttribute('data-aiff-single', 'true');
      buildButtonContent(singleBtn, null, 'AI Fill');
      singleBtn.addEventListener('mousedown', (e) => e.preventDefault());
      singleBtn.addEventListener('click', onSingleFillClick);
      trackPointerOnButton(singleBtn);
      shadow.appendChild(singleBtn);
    } else {
      singleBtn = shadow.querySelector('[data-aiff-single]');
    }

    if (!shadow.querySelector('[data-aiff-fill-all]')) {
      fillAllBtn = document.createElement('button');
      fillAllBtn.type = 'button';
      fillAllBtn.className = 'aiff-btn aiff-fill-all';
      fillAllBtn.setAttribute('data-aiff-fill-all', 'true');
      buildButtonContent(fillAllBtn, null, 'Fill All Fields');
      fillAllBtn.title = 'Drag to move';
      fillAllBtn.addEventListener('mousedown', (e) => e.preventDefault());
      fillAllBtn.addEventListener('click', onFillAllClickCapture, true);
      shadow.appendChild(fillAllBtn);
      makeFillAllDraggable();
      restoreFillAllPosition();
    } else {
      fillAllBtn = shadow.querySelector('[data-aiff-fill-all]');
    }
  }

  // ---------- Draggable Fill All button (position persisted per device) ----------

  let fillAllDrag = null;
  let suppressFillAllClick = false;

  function fillAllPosKey() {
    return 'fillAllPos';
  }

  function clampFillAllPos(right, bottom) {
    const w = 190;
    const h = 48;
    return {
      right: Math.min(Math.max(8, right), Math.max(8, window.innerWidth - w)),
      bottom: Math.min(Math.max(8, bottom), Math.max(8, window.innerHeight - h))
    };
  }

  function applyFillAllPos(right, bottom) {
    if (!fillAllBtn) return;
    const p = clampFillAllPos(right, bottom);
    fillAllBtn.style.right = `${p.right}px`;
    fillAllBtn.style.bottom = `${p.bottom}px`;
    fillAllBtn.style.left = 'auto';
    fillAllBtn.style.top = 'auto';
  }

  function restoreFillAllPosition() {
    try {
      chrome.storage.local.get([fillAllPosKey()], (result) => {
        if (chrome.runtime.lastError) return;
        const saved = result && result[fillAllPosKey()];
        if (saved && typeof saved.right === 'number' && typeof saved.bottom === 'number') {
          applyFillAllPos(saved.right, saved.bottom);
        }
      });
    } catch {
      /* storage unavailable — keep default corner */
    }
  }

  function makeFillAllDraggable() {
    if (!fillAllBtn || fillAllBtn.dataset.aiffDrag === '1') return;
    fillAllBtn.dataset.aiffDrag = '1';
    fillAllBtn.style.touchAction = 'none';

    fillAllBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const rect = fillAllBtn.getBoundingClientRect();
      fillAllDrag = {
        startX: e.clientX,
        startY: e.clientY,
        startRight: window.innerWidth - rect.right,
        startBottom: window.innerHeight - rect.bottom,
        moved: false
      };
      try {
        fillAllBtn.setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    });

    fillAllBtn.addEventListener('pointermove', (e) => {
      if (!fillAllDrag) return;
      const dx = e.clientX - fillAllDrag.startX;
      const dy = e.clientY - fillAllDrag.startY;
      if (!fillAllDrag.moved && Math.hypot(dx, dy) > 6) fillAllDrag.moved = true;
      if (fillAllDrag.moved) {
        e.preventDefault();
        applyFillAllPos(fillAllDrag.startRight - dx, fillAllDrag.startBottom - dy);
      }
    });

    const endDrag = (e) => {
      if (!fillAllDrag) return;
      if (fillAllDrag.moved) {
        suppressFillAllClick = true;
        try {
          const rect = fillAllBtn.getBoundingClientRect();
          const pos = {
            right: window.innerWidth - rect.right,
            bottom: window.innerHeight - rect.bottom
          };
          chrome.storage.local.set({ [fillAllPosKey()]: pos }, () => {});
        } catch {
          /* noop */
        }
        setTimeout(() => {
          suppressFillAllClick = false;
        }, 50);
      }
      fillAllDrag = null;
    };
    fillAllBtn.addEventListener('pointerup', endDrag);
    fillAllBtn.addEventListener('pointercancel', endDrag);

    window.addEventListener('resize', () => {
      if (!fillAllBtn) return;
      try {
        const rect = fillAllBtn.getBoundingClientRect();
        applyFillAllPos(window.innerWidth - rect.right, window.innerHeight - rect.bottom);
      } catch {
        /* noop */
      }
    });
  }

  // Capture-phase click: swallows the click that ends a drag so a drag
  // never triggers a fill.
  function onFillAllClickCapture(e) {
    if (suppressFillAllClick) {
      e.stopPropagation();
      e.preventDefault();
      suppressFillAllClick = false;
      return;
    }
    onFillAllClick();
  }

  // ---------- Field detection ----------

  // Rich-text editors (Gemini / ChatGPT / Docs use these instead of <input>)
  const RICH_TEXT_ROLES = new Set(['textbox', 'searchbox']);
  const COMBOBOX_ROLE = 'combobox';

  function hasSelectLikeClass(el) {
    try {
      const cls =
        typeof el.className === 'string'
          ? el.className
          : (el.getAttribute && el.getAttribute('class')) || '';
      const lower = String(cls).toLowerCase();
      return lower.includes('select') || lower.includes('dropdown');
    } catch {
      return false;
    }
  }

  // Custom JS/React dropdown triggers: Radix / Shadcn / Tailwind / headless-ui
  // popups are usually a button or div with role="combobox" or
  // aria-haspopup="listbox", or a class containing "select"/"dropdown".
  function isDropdownTrigger(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.disabled) return false;
    const role = el.getAttribute && el.getAttribute('role');
    if (role === COMBOBOX_ROLE) return true;
    const popup = el.getAttribute && el.getAttribute('aria-haspopup');
    if (popup === 'listbox' || popup === 'menu') return true;
    const tag = el.tagName.toLowerCase();
    if (
      hasSelectLikeClass(el) &&
      (tag === 'button' ||
        tag === 'div' ||
        tag === 'span' ||
        (tag === 'input' && el.getAttribute('readonly') !== null))
    ) {
      return true;
    }
    return false;
  }

  function isRichText(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const role = el.getAttribute && el.getAttribute('role');
    if (RICH_TEXT_ROLES.has(role)) {
      // A combobox-role element is handled as a dropdown, not a text editor.
      if (role === COMBOBOX_ROLE) return false;
      return true;
    }
    return false;
  }

  function isFillable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.disabled) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return !el.readOnly;
    if (tag === 'select') return true;
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (IGNORED_INPUT_TYPES.has(type)) return false;
      // Readonly inputs backing a custom dropdown are filled via the trigger path.
      if (el.readOnly) return hasSelectLikeClass(el) || isDropdownTrigger(el);
      return true;
    }
    if (el.isContentEditable) return true;
    // ARIA editors: <div role="textbox"> etc. (e.g. gemini.google.com prompt box)
    if (RICH_TEXT_ROLES.has(el.getAttribute && el.getAttribute('role'))) return true;
    // Custom dropdown triggers (Radix / Shadcn / Tailwind popups)
    if (isDropdownTrigger(el)) return true;
    return false;
  }

  function fieldKind(el) {
    if (!el || el.nodeType !== 1) return 'text';
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') return 'select';
    if (tag !== 'input' && tag !== 'textarea' && !el.isContentEditable && isDropdownTrigger(el)) {
      return 'combobox';
    }
    return 'text';
  }

  // Query across light DOM + open shadow roots (many modern apps render
  // editors inside web components). Bounded to avoid perf issues.
  function queryAllDeep(selector, limit = 500) {
    const out = [];
    const seenRoots = new Set();
    function walk(root) {
      if (!root || seenRoots.has(root) || out.length >= limit) return;
      seenRoots.add(root);
      let nodes = [];
      try {
        nodes = root.querySelectorAll ? root.querySelectorAll(selector) : [];
      } catch {
        nodes = [];
      }
      for (const n of nodes) {
        if (out.length >= limit) break;
        out.push(n);
      }
      let all = [];
      try {
        all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      } catch {
        all = [];
      }
      for (const el of all) {
        if (out.length >= limit) break;
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    }
    walk(document);
    // Dedupe (same node reachable via multiple roots is harmless but wasteful)
    return [...new Set(out)];
  }

  const BATCH_SELECTOR = [
    'input',
    'textarea',
    'select',
    '[contenteditable]:not([contenteditable="false"])',
    'div[role="textbox"]',
    'div[role="searchbox"]',
    '[role="combobox"]',
    '[aria-haspopup="listbox"]',
    '[aria-haspopup="menu"]'
  ].join(', ');

  function isVisible(el) {
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      // Offset-parent check catches hidden ancestors (null for fixed elements, which are visible).
      if (el.offsetParent === null && style.position !== 'fixed') return false;
      return true;
    } catch {
      return false;
    }
  }

  function resolveLabel(el) {
    try {
      if (el.id) {
        const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (forLabel && forLabel.innerText.trim()) return forLabel.innerText.trim().slice(0, 200);
      }
    } catch {
      /* ignore invalid selector */
    }
    const wrapping = el.closest ? el.closest('label') : null;
    if (wrapping) {
      const clone = wrapping.cloneNode(true);
      const inner = clone.querySelector('input, textarea, select');
      if (inner) inner.remove();
      const t = (clone.innerText || '').trim();
      if (t) return t.slice(0, 200);
    }
    const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim().slice(0, 200);
    const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const texts = labelledBy
        .split(/\s+/)
        .map((id) => {
          try {
            const n = document.getElementById(id);
            return n ? n.innerText.trim() : '';
          } catch {
            return '';
          }
        })
        .filter(Boolean);
      if (texts.length) return texts.join(' ').slice(0, 200);
    }
    const prev =
      el.previousElementSibling &&
      /^(label|span|div|p)$/i.test(el.previousElementSibling.tagName)
        ? (el.previousElementSibling.innerText || '').trim()
        : '';
    if (prev && prev.length <= 120) return prev;
    // Table column header fallback (invoice-style grids: QTY / RATE / TAX).
    try {
      const td = el.closest ? el.closest('td, th') : null;
      const tr = td && td.parentElement;
      if (td && tr) {
        const colIdx = [...tr.children].indexOf(td);
        const table = el.closest('table');
        const th =
          (table && table.querySelectorAll('thead th')[colIdx]) ||
          (table && table.querySelectorAll('th')[colIdx]);
        const header = th ? cleanOptionText(th.innerText || th.textContent, 120) : '';
        if (header) return header;
      }
    } catch {
      /* noop */
    }
    return '';
  }

  // Positional context for repeated rows / grids: table row number,
  // column header, and nearest section heading — so the AI treats
  // same-label fields as DISTINCT fields with different values.
  function getPositionContext(el) {
    const parts = [];
    try {
      const td = el.closest ? el.closest('td, th') : null;
      const tr = td && td.parentElement;
      if (td && tr) {
        const rows = [...tr.parentElement.children].filter(
          (n) => n.tagName && n.tagName.toLowerCase() === tr.tagName.toLowerCase()
        );
        const rowIdx = rows.indexOf(tr);
        if (rowIdx >= 0) parts.push(`table row ${rowIdx + 1} of ${rows.length}`);
        const cells = [...tr.children];
        const colIdx = cells.indexOf(td);
        if (colIdx >= 0) parts.push(`column ${colIdx + 1}`);
      }
      // Nearest section heading (walk up, check previous siblings).
      let node = el;
      for (let depth = 0; depth < 7 && node && node !== document.body; depth++) {
        let sib = node.previousElementSibling;
        let steps = 0;
        while (sib && steps < 4) {
          const tag = sib.tagName ? sib.tagName.toLowerCase() : '';
          if (/^h[1-4]$/.test(tag)) {
            const text = cleanOptionText(sib.innerText || sib.textContent, 80);
            if (text) {
              parts.push(`under heading "${text}"`);
              node = document.body; // stop outer loop
              break;
            }
          }
          sib = sib.previousElementSibling;
          steps++;
        }
        node = node.parentElement;
      }
    } catch {
      /* noop */
    }
    return parts.join('; ');
  }

  function getFormContext(el, maxChars = 800) {
    try {
      const form = el.closest ? el.closest('form') : null;
      const scope =
        form || (el.parentElement && el.parentElement.parentElement) || el.parentElement;
      if (!scope || !scope.innerText) return '';
      return scope.innerText.trim().slice(0, maxChars);
    } catch {
      return '';
    }
  }

  // ---------- Dropdown option extraction ----------

  function cleanOptionText(text, maxLen = 120) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLen);
  }

  // Standard <select>: full {value, text} list.
  function getNativeSelectOptions(selectEl, maxOptions = 60) {
    const out = [];
    try {
      for (const opt of selectEl.options) {
        out.push({ value: opt.value, text: cleanOptionText(opt.text) });
        if (out.length >= maxOptions) break;
      }
    } catch {
      /* noop */
    }
    return out;
  }

  // Action rows (e.g. "+ Add New Client", "Create new…") are commands,
  // NOT selectable values — they must never be offered to the AI or clicked.
  const ACTION_ITEM_RE = /^\s*(\+\s*)?(add new|create new|create\b|add\b|manage|view all|see all)\b/i;

  function isActionNode(n) {
    try {
      if (n.getAttribute && n.getAttribute('aria-disabled') === 'true') return true;
      if (n.disabled) return true;
      const text = cleanOptionText(n.innerText || n.textContent, 80);
      return ACTION_ITEM_RE.test(text);
    } catch {
      return false;
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Custom dropdown: collect rendered option texts if the popup is in the DOM.
  // Looks at aria-controls target, then nearby listbox containers.
  // Action rows ("+ Add New Client", …) and disabled options are excluded —
  // only genuinely selectable values are collected.
  function getRenderedListboxOptions(trigger, maxOptions = 60) {
    const out = [];
    const seen = new Set();
    const pushAll = (nodes) => {
      for (const n of nodes) {
        if (out.length >= maxOptions) break;
        if (isActionNode(n)) continue;
        const text = cleanOptionText(n.innerText || n.textContent);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push({
          value: n.getAttribute('data-value') || n.getAttribute('data-option-value') || text,
          text
        });
      }
    };
    try {
      const seenRoots = new Set();
      const pushFrom = (root) => {
        if (!root || seenRoots.has(root)) return;
        seenRoots.add(root);
        pushAll(queryOptionNodes(root));
      };
      const controlsId = trigger.getAttribute && trigger.getAttribute('aria-controls');
      if (controlsId) {
        const popup = document.getElementById(controlsId);
        if (popup) pushFrom(popup);
      }
      if (out.length === 0) {
        const scope =
          (trigger.closest && trigger.closest('[role="dialog"], form, [data-radix-popper-content-wrapper]')) ||
          trigger.parentElement;
        if (scope) pushFrom(scope);
      }
      if (out.length === 0) {
        pushFrom(document);
      }
    } catch {
      /* noop */
    }
    return out;
  }

  function getFieldOptions(el, kind, maxOptions = 60) {
    if (kind === 'select' && el.tagName.toLowerCase() === 'select') {
      return getNativeSelectOptions(el, maxOptions);
    }
    if (kind === 'combobox') {
      return getRenderedListboxOptions(el, maxOptions);
    }
    return [];
  }

  function closePopup(trigger) {
    try {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } catch {
      /* noop */
    }
  }

  // Open a closed custom dropdown, harvest its rendered options, close it
  // again. This is what lets the AI see REAL options (instead of guessing)
  // for popups that only render on open. Best-effort per field.
  async function harvestComboboxOptions(trigger, maxOptions = 60) {
    let options = getRenderedListboxOptions(trigger, maxOptions);
    if (options.length > 0) return options;
    const tag = trigger.tagName.toLowerCase();
    if (tag === 'input' && !trigger.readOnly) return options; // typable: nothing to open
    try {
      clickNode(trigger);
      const nodes = await waitForOptionNodes(trigger, 1200);
      options = getRenderedListboxOptions(trigger, maxOptions);
      if (options.length === 0 && nodes.length > 0) {
        // Nodes exist but produced no data (e.g. empty text) — build manually.
        const seen = new Set();
        for (const n of nodes) {
          if (options.length >= maxOptions) break;
          if (isActionNode(n)) continue;
          const text = cleanOptionText(n.innerText || n.textContent);
          if (!text || seen.has(text)) continue;
          seen.add(text);
          options.push({
            value: n.getAttribute('data-value') || n.getAttribute('data-option-value') || text,
            text
          });
        }
      }
    } catch {
      /* noop */
    } finally {
      closePopup(trigger);
      await sleep(150);
    }
    debug('harvested combobox options', {
      label: fieldDescribe(trigger),
      count: options.length
    });
    return options;
  }

  function extractContext(el) {
    const tag = el.tagName.toLowerCase();
    const kind = fieldKind(el);
    const options = getFieldOptions(el, kind);
    const ctx = {
      tagName: tag,
      kind,
      type:
        kind === 'select'
          ? 'select'
          : kind === 'combobox'
            ? 'combobox'
            : tag === 'input'
              ? (el.getAttribute('type') || 'text').toLowerCase()
              : tag,
      name: el.getAttribute('name') || '',
      id: el.id || '',
      placeholder: el.getAttribute('placeholder') || '',
      label: resolveLabel(el),
      ariaLabel: el.getAttribute('aria-label') || '',
      currentValue: '',
      pageTitle: document.title || '',
      pageUrl: location.href || '',
      formContext: getFormContext(el)
    };
    if (kind === 'select') {
      try {
        const selected = el.options && el.options[el.selectedIndex];
        ctx.currentValue = selected
          ? `${selected.value} — ${cleanOptionText(selected.text, 200)}`
          : '';
      } catch {
        ctx.currentValue = '';
      }
    } else if (isRichText(el)) {
      ctx.currentValue = (el.innerText || '').slice(0, 500);
    } else {
      ctx.currentValue = ((el.value != null ? el.value : el.innerText || '') || '').slice(0, 500);
    }
    if (options.length > 0) ctx.options = options;
    if (tag === 'select' && el.multiple) ctx.multiple = true;
    return ctx;
  }

  // ---------- Single-button positioning ----------

  function positionSingleButton() {
    if (!activeField || !singleBtn) return;
    try {
      const rect = activeField.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        hideSingleButton();
        return;
      }
      singleBtn.style.display = 'inline-flex';
      let top = rect.top - 38;
      if (top < 4) top = rect.bottom + 6;
      let left = rect.right - 96;
      if (left < 4) left = 4;
      singleBtn.style.top = `${Math.max(4, top)}px`;
      singleBtn.style.left = `${Math.max(4, Math.min(left, window.innerWidth - 120))}px`;
    } catch {
      hideSingleButton();
    }
  }

  function showSingleButton(field) {
    ensureUI();
    activeField = field;
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    setSingleState('idle');
    positionSingleButton();
  }

  function hideSingleButton() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    activeField = null;
    if (singleBtn) {
      singleBtn.style.display = 'none';
      setSingleState('idle');
    }
  }

  // The AI Fill button sits just outside the field's box, so travelling from
// the field to the button always fires pointerout first. A grace window plus
// pointer tracking on the button itself keeps it reachable and clickable.
  let pointerOnButton = false;

  function cancelHide() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function scheduleHide() {
    cancelHide();
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (isSingleLoading || pointerOnButton) return;
      hideSingleButton();
    }, 350);
  }

  function trackPointerOnButton(btn) {
    if (!btn) return;
    btn.addEventListener('pointerenter', () => {
      pointerOnButton = true;
      cancelHide();
    });
    btn.addEventListener('pointerleave', () => {
      pointerOnButton = false;
      // Keep it visible if the field is still focused; otherwise dismiss.
      if (activeField && document.activeElement === activeField) return;
      scheduleHide();
    });
  }

  function setSingleState(state, text) {
    if (!singleBtn) return;
    singleBtn.classList.remove('aiff-error', 'aiff-success');
    singleBtn.disabled = false;
    if (state === 'loading') {
      isSingleLoading = true;
      singleBtn.disabled = true;
      setButtonFace(singleBtn, ICONS.spinner, text || 'Generating…');
    } else if (state === 'error') {
      isSingleLoading = false;
      singleBtn.classList.add('aiff-error');
      setButtonFace(singleBtn, ICONS.warning, text || 'Failed');
    } else if (state === 'success') {
      isSingleLoading = false;
      singleBtn.classList.add('aiff-success');
      setButtonFace(singleBtn, ICONS.check, text || 'Filled!');
    } else {
      isSingleLoading = false;
      setButtonFace(singleBtn, null, text || 'AI Fill');
    }
  }

  function setFillAllState(state, text) {
    if (!fillAllBtn) return;
    fillAllBtn.classList.remove('aiff-error', 'aiff-success');
    fillAllBtn.disabled = false;
    if (state === 'loading') {
      isBatchLoading = true;
      fillAllBtn.disabled = true;
      setButtonFace(fillAllBtn, ICONS.spinner, text || 'Filling all…');
    } else if (state === 'error') {
      isBatchLoading = false;
      fillAllBtn.classList.add('aiff-error');
      setButtonFace(fillAllBtn, ICONS.warning, text || 'Fill-all failed');
    } else if (state === 'success') {
      isBatchLoading = false;
      fillAllBtn.classList.add('aiff-success');
      setButtonFace(fillAllBtn, ICONS.check, text || 'All filled!');
    } else {
      isBatchLoading = false;
      setButtonFace(fillAllBtn, null, text || 'Fill All Fields');
    }
  }

  function promptForApiKey() {
    if (isContextInvalidated()) {
      alertContextInvalidated();
      return;
    }
    showToast({
      kind: 'warn',
      title: 'No API key configured',
      message:
        'Pick a provider (Google Gemini, OpenAI, or a compatible API) and add your key to start filling forms.',
      duration: 0,
      action: { label: 'Open Settings', onClick: openOptionsPage }
    });
  }

  // ---------- Extension context lifecycle ----------
  // After the extension is reloaded/updated, old page instances lose their
  // context ("Extension context invalidated") and every chrome.* call throws.
  // The only remedy is a page refresh — detect it early and say so clearly
  // instead of showing raw errors.

  function isContextInvalidated() {
    try {
      return !(chrome && chrome.runtime && chrome.runtime.id);
    } catch {
      return true;
    }
  }

  function isInvalidationError(err) {
    const msg = String((err && err.message) || err || '');
    return /extension context invalidated|context invalidated|could not establish connection|message port closed/i.test(
      msg
    );
  }

  function alertContextInvalidated() {
    showToast({
      kind: 'warn',
      title: 'Extension reloaded',
      message:
        'This page lost its connection when the extension reloaded or updated. Refresh the page, then try again — your settings are safe.',
      duration: 0,
      action: {
        label: 'Refresh page',
        onClick: () => {
          try {
            location.reload();
          } catch {
            /* ignore */
          }
        }
      }
    });
  }

  // Drop-in replacement for chrome.runtime.sendMessage that translates
  // context-invalidation failures into a friendly refresh prompt.
  // Returns { invalidated: true } instead of throwing for that case.
  async function sendToBackground(message) {
    if (isContextInvalidated()) return { invalidated: true };
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      if (isInvalidationError(err)) return { invalidated: true };
      throw err;
    }
  }

  function handleInvalidatedSingle() {
    setSingleState('error', '⚠️ Reload page');
    alertContextInvalidated();
    setTimeout(() => {
      if (activeField) setSingleState('idle');
    }, 2500);
  }

  function handleInvalidatedBatch() {
    setFillAllState('error', '⚠️ Reload page');
    alertContextInvalidated();
    setTimeout(() => setFillAllState('idle'), 2500);
  }

  // ---------- Framework-safe value insertion ----------

  // Common company-name abbreviations, expanded so "Acme Corp" matches
  // a rendered "Acme Corporation" (and vice versa). Applied to BOTH sides,
  // so exact matching keeps working.
  const ABBR_MAP = {
    corp: 'corporation',
    ltd: 'limited',
    inc: 'incorporated',
    co: 'company',
    pvt: 'private',
    plc: 'public limited company',
    llc: 'limited liability company'
  };

  function normalizeChoice(s) {
    const words = String(s == null ? '' : s)
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .split(' ')
      .map((w) => ABBR_MAP[w.replace(/\./g, '')] || w);
    return words.join(' ');
  }

  // Standard <select>: pick the option whose value/text matches best,
  // then dispatch change + input so React/Vue/Angular detect it.
  // Existing options only — we never invent a value. When the model asks for
  // something absent from the list, fall back to the best option that IS in
  // the list (never leave the field empty just because of a mismatch).
  const PLACEHOLDER_RE = /^(select|choose|please|pick|option|--|-|n\/a|none)\b/i;

  function isPlaceholderOption(o) {
    const text = cleanOptionText((o && (o.innerText || o.textContent)) || '', 40);
    const value = String((o && o.value) || '').trim();
    if (value === '' && text === '') return true;
    return value === '' && PLACEHOLDER_RE.test(text);
  }

  // Best in-list fallback: first real (non-placeholder, non-disabled) option.
  function pickFallbackOption(options) {
    if (!Array.isArray(options)) return null;
    for (const o of options) {
      if (!o || o.disabled) continue;
      if (isPlaceholderOption(o)) continue;
      return o;
    }
    return null;
  }

  function optionLabel(o) {
    if (!o) return '';
    const text = cleanOptionText(o.innerText || o.textContent || '', 60);
    const value = String(o.value == null ? '' : o.value).trim();
    if (value && value !== text) return `${value} (${text})`;
    return text || value;
  }

  function meaningfulOptions(selectEl) {
    try {
      return [...selectEl.options].filter(
        (o) => !o.disabled && (String(o.value).trim() !== '' || cleanOptionText(o.text).length > 0)
      );
    } catch {
      return [];
    }
  }

  function describeOptions(selectEl, max = 6) {
    try {
      return [...selectEl.options]
        .slice(0, max)
        .map((o) => {
          const v = String(o.value);
          const t = cleanOptionText(o.text, 40);
          return v && v !== t ? `${v} (${t})` : t || `(value:${v})`;
        })
        .join(' | ');
    } catch {
      return '';
    }
  }

  async function setSelectValue(selectEl, target) {
    const t = normalizeChoice(target);
    if (!t) return false;
    // Dependent dropdowns (Country → State): options may populate only after
    // an earlier field is filled. Wait briefly for meaningful options.
    let opts = meaningfulOptions(selectEl);
    if (opts.length === 0) {
      const start = Date.now();
      while (opts.length === 0 && Date.now() - start < 2000) {
        await sleep(250);
        opts = meaningfulOptions(selectEl);
      }
    }
    // Reuse the same matcher as custom dropdowns (exact → partial → tokens).
    // HTMLOptionElement supports getAttribute/innerText like our row nodes.
    let match = matchNode(opts, t);
    let usedFallback = false;
    if (!match || match.disabled) {
      // Nothing matched → pick the best option that actually exists in the list.
      match = pickFallbackOption(opts);
      usedFallback = Boolean(match);
      debug('select fallback', {
        wanted: String(target).slice(0, 80),
        chosen: match ? optionLabel(match) : null,
        available: describeOptions(selectEl)
      });
      if (!match) return false;
    }
    const chosen = match;
    try {
      selectEl.focus();
    } catch {
      /* noop */
    }
    try {
      // Native setter first so controlled (React) selects pick up the change.
      const proto = window.HTMLSelectElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && typeof descriptor.set === 'function') {
        descriptor.set.call(selectEl, chosen.value);
      } else {
        selectEl.value = chosen.value;
      }
    } catch {
      selectEl.value = chosen.value;
    }
    selectEl.selectedIndex = chosen.index;
    selectEl.dispatchEvent(new Event('input', { bubbles: true }));
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    lastFillInfo = usedFallback
      ? { applied: true, reason: 'fallback', fallback: true, chosen: optionLabel(chosen) }
      : { applied: true, reason: '' };
    return true;
  }

  function clickNode(node) {
    try {
      node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    } catch {
      /* noop */
    }
    try {
      node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    } catch {
      /* noop */
    }
    try {
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    } catch {
      /* noop */
    }
    try {
      if (typeof node.click === 'function') node.click();
    } catch {
      /* noop */
    }
  }

  // Locate the filter/search box inside an open dropdown popup
  // (e.g. the "Search clients…" input in the screenshot).
  function findPopupSearchInput(trigger) {
    const selector =
      'input[type="search"], input[placeholder*="earch" i], input[aria-label*="earch" i]';
    const isCandidate = (found) => found && found !== trigger && isVisible(found);
    try {
      const controlsId = trigger.getAttribute && trigger.getAttribute('aria-controls');
      if (controlsId) {
        const popup = document.getElementById(controlsId);
        if (popup) {
          const found = popup.querySelector(selector) || popup.querySelector('input:not([type="hidden"])');
          if (isCandidate(found)) return found;
        }
      }
      // Radix / headless-ui portals and open-state containers.
      for (const sel of ['[data-radix-popper-content-wrapper]', '[data-state="open"]']) {
        for (const box of document.querySelectorAll(sel)) {
          if (box === trigger || (trigger.contains && trigger.contains(box))) continue;
          const found = box.querySelector(selector) || box.querySelector('input:not([type="hidden"])');
          if (isCandidate(found)) return found;
        }
      }
      // Popup is often a portal sibling right after the trigger container.
      let node = trigger.parentElement;
      for (let depth = 0; depth < 3 && node; depth++) {
        const found = node.querySelector(':scope [role="listbox"] ' + selector.split(',')[0]) ||
          node.querySelector(selector);
        if (isCandidate(found)) return found;
        node = node.parentElement;
      }
      const all = document.querySelectorAll('[role="listbox"] input, [role="dialog"] input[type="search"]');
      for (const input of all) {
        if (isCandidate(input)) return input;
      }
    } catch {
      /* noop */
    }
    return null;
  }

  // Option nodes across libraries: ARIA roles first, then common plain
  // markup (li, data-value divs, Radix collection items). Scoped to popup /
  // listbox / menu containers so random page <li>s are never treated as options.
  const OPTION_INNER_SELECTOR = [
    '[role="option"]',
    '[role="menuitemradio"]',
    '[data-radix-collection-item][data-value]',
    'li[data-value]',
    'li[data-option-value]',
    '[data-option-value]'
  ].join(', ');

  function queryOptionNodes(root) {
    const found = [];
    try {
      if (!root || !root.querySelectorAll) return found;
      for (const n of root.querySelectorAll(OPTION_INNER_SELECTOR)) found.push(n);
      // Plain <li> / item rows inside an explicit listbox/menu container.
      for (const box of root.querySelectorAll('[role="listbox"], [role="menu"]')) {
        for (const n of box.querySelectorAll('li, [data-value], div[data-index]')) {
          found.push(n);
        }
      }
    } catch {
      /* noop */
    }
    return found;
  }

  // Last-resort rows: plain buttons / list items / links inside a KNOWN popup
  // container (portal, open-state, listbox, dialog). Never applied to the
  // general page — only to popups we opened. Action rows are filtered later.
  function queryGenericPopupRows(container) {
    const found = [];
    try {
      if (!container || !container.querySelectorAll) return found;
      for (const n of container.querySelectorAll('button, li, a[href], [role="menuitem"], [role="treeitem"]')) {
        const text = cleanOptionText(n.innerText || n.textContent, 120);
        if (!text || text.length < 2) continue;
        // Skip nested duplicates: keep the outermost clickable row.
        if (n.querySelector && n.querySelector('button, li, a[href], [role="menuitem"]')) continue;
        found.push(n);
      }
    } catch {
      /* noop */
    }
    return found;
  }

  // Containers that are definitely popups (not general page scope).
  function popupOnlyContainers(trigger) {
    const containers = [];
    try {
      const controlsId = trigger.getAttribute && trigger.getAttribute('aria-controls');
      if (controlsId) {
        const popup = document.getElementById(controlsId);
        if (popup) containers.push(popup);
      }
      for (const box of document.querySelectorAll(
        '[data-radix-popper-content-wrapper], [role="listbox"], [role="menu"], [role="dialog"]'
      )) {
        if (box === trigger) continue;
        if (isVisible(box)) containers.push(box);
      }
      for (const box of document.querySelectorAll('[data-state="open"]')) {
        if (box === trigger || (trigger.contains && trigger.contains(box))) continue;
        if (isVisible(box)) containers.push(box);
      }
    } catch {
      /* noop */
    }
    return containers;
  }

  function popupContainers(trigger) {
    const containers = [];
    try {
      const controlsId = trigger.getAttribute && trigger.getAttribute('aria-controls');
      if (controlsId) {
        const popup = document.getElementById(controlsId);
        if (popup) containers.push(popup);
      }
      const scope =
        (trigger.closest && trigger.closest('[role="dialog"], form')) || trigger.parentElement;
      if (scope) containers.push(scope);
    } catch {
      /* noop */
    }
    return containers;
  }

  function collectOptionNodes(trigger) {
    const seen = new Set();
    const nodes = [];
    const add = (list) => {
      for (const n of list) {
        if (seen.has(n)) continue;
        seen.add(n);
        nodes.push(n);
      }
    };
    for (const c of popupContainers(trigger)) add(queryOptionNodes(c));
    add(queryOptionNodes(document));
    // Generic clickable rows, but ONLY inside known popup containers.
    for (const c of popupOnlyContainers(trigger)) add(queryGenericPopupRows(c));
    // Never consider action rows or disabled options as candidates.
    return nodes.filter((n) => !isActionNode(n));
  }

  // Try keyboard open as a fallback (some custom dropdowns ignore synthetic
  // mouse events but respond to Enter / Space / ArrowDown).
  function keyboardOpen(trigger) {
    for (const key of ['Enter', ' ', 'ArrowDown']) {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        try {
          trigger.dispatchEvent(
            new KeyboardEvent(type, { key, bubbles: true, cancelable: true })
          );
        } catch {
          /* noop */
        }
      }
    }
    try {
      if (typeof trigger.click === 'function') trigger.click();
    } catch {
      /* noop */
    }
  }

  // Poll for popup options (portals animate in; filters re-render).
  async function waitForOptionNodes(trigger, timeoutMs = 2000) {
    const start = Date.now();
    let nodes = collectOptionNodes(trigger);
    while (nodes.length === 0 && Date.now() - start < timeoutMs) {
      await sleep(200);
      nodes = collectOptionNodes(trigger);
    }
    return nodes;
  }

  function matchNode(nodes, t) {
    const byText = (n) => normalizeChoice(n.innerText || n.textContent);
    // Native <option> elements expose .value (IDL); custom rows use
    // data-value / data-option-value attributes.
    const byValue = (n) => {
      let v = '';
      try {
        v =
          (n.getAttribute &&
            (n.getAttribute('data-value') || n.getAttribute('data-option-value'))) ||
          '';
        if (!v && n && typeof n.value === 'string') v = n.value;
      } catch {
        v = '';
      }
      return normalizeChoice(v);
    };
    const exact =
      nodes.find((n) => byValue(n) === t || byText(n) === t);
    if (exact) return exact;
    const partial =
      nodes.find((n) => byText(n).includes(t) || (byValue(n) && byValue(n).includes(t)));
    if (partial) return partial;
    // Token overlap: "Acme Corporation" matches rendered "Acme Corp"
    // via the shared significant word "acme". Single shared short words
    // ("ltd", "co") are NOT enough on their own.
    const tWords = new Set(t.split(/\s+/).filter((w) => w.length >= 4));
    if (tWords.size === 0) return null;
    return (
      nodes.find((n) => {
        const words = byText(n).split(/\s+/).filter((w) => w.length >= 4);
        const shared = words.filter((w) => tWords.has(w));
        return shared.length >= 2 || (shared.length === 1 && words.length === 1);
      }) || null
    );
  }

  function findRenderedOption(trigger, target, preNodes) {
    const t = normalizeChoice(target);
    if (!t) return null;
    const nodes = Array.isArray(preNodes) ? preNodes : collectOptionNodes(trigger);
    if (nodes.length === 0) return null;
    return matchNode(nodes, t);
  }

  // Type into a popup search box using the native setter so React/Vue
  // controlled inputs filter the option list.
  function typeIntoSearchBox(searchBox, text) {
    try {
      searchBox.focus();
      const proto = window.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && typeof descriptor.set === 'function') {
        descriptor.set.call(searchBox, text);
      } else {
        searchBox.value = text;
      }
      searchBox.dispatchEvent(new Event('input', { bubbles: true }));
      searchBox.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }

  function debug(...args) {
    try {
      console.debug('[AIFF]', ...args);
    } catch {
      /* noop */
    }
  }

  // Custom dropdowns (Radix / Shadcn / headless-ui): open the popup and click
  // an EXISTING rendered option. Strict rule: if no rendered option matches
  // the requested value, the field is left completely untouched
  // — never invent or display a new value, never click action rows like
  // "+ Add New Client". Synthetic click + input + change events keep
  // React/Vue state in sync.
  // Returns { applied: boolean, reason: string } for diagnostics.
  async function setComboboxValue(trigger, target) {
    const strTarget = target == null ? '' : String(target).trim();
    if (!strTarget) return { applied: false, reason: 'empty-target' };
    try {
      trigger.focus();
    } catch {
      /* noop */
    }
    const tag = trigger.tagName.toLowerCase();

    // Readonly inputs (e.g. a pill showing "Acme Corp") cannot be typed into:
    // delegate to the surrounding dropdown trigger instead.
    if (tag === 'input' && trigger.readOnly) {
      const parentTrigger =
        (trigger.closest &&
          trigger.closest('[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], button')) ||
        null;
      if (parentTrigger && parentTrigger !== trigger) {
        return setComboboxValue(parentTrigger, strTarget);
      }
      return { applied: false, reason: 'readonly-no-trigger' };
    }

    // Case A: the trigger itself is a typable search box (e.g. the focused
    // "Search clients…" input). Type to filter, click the match, restore on miss.
    if (tag === 'input' || trigger.isContentEditable) {
      const original = tag === 'input' ? trigger.value : trigger.innerText;
      clickNode(trigger);
      if (!typeIntoSearchBox(trigger, strTarget)) {
        return { applied: false, reason: 'type-failed' };
      }
      await sleep(500);
      const nodesA = await waitForOptionNodes(trigger, 1500);
      const option = matchNode(nodesA, normalizeChoice(strTarget));
      if (option) {
        clickNode(option);
        trigger.dispatchEvent(new Event('change', { bubbles: true }));
        return { applied: true };
      }
      // No match: restore original text so nothing new is left behind.
      try {
        if (tag === 'input') {
          const proto = window.HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
          if (descriptor && typeof descriptor.set === 'function') {
            descriptor.set.call(trigger, original);
          } else {
            trigger.value = original;
          }
        } else {
          trigger.innerText = original;
        }
        trigger.dispatchEvent(new Event('input', { bubbles: true }));
      } catch {
        /* noop */
      }
      debug('combobox no match, restored', { target: strTarget });
      return { applied: false, reason: 'no-match' };
    }

    // Case B: button/div trigger. Open the popup first, then wait for options
    // (portals animate in; searchable lists re-render after filtering).
    clickNode(trigger);
    let nodes = await waitForOptionNodes(trigger, 1500);
    debug('combobox popup options', { target: strTarget, count: nodes.length });

    // Popup still empty? The site may ignore synthetic mouse events —
    // retry with keyboard open (Enter / Space / ArrowDown).
    if (nodes.length === 0) {
      keyboardOpen(trigger);
      nodes = await waitForOptionNodes(trigger, 1500);
      debug('combobox after keyboard open', { target: strTarget, count: nodes.length });
    }

    // If the popup has its own search box, filter through it, then re-collect.
    // (Server-filtered lists like "Search clients…" only render options
    // once you type.)
    const searchBox = findPopupSearchInput(trigger);
    if (searchBox) {
      typeIntoSearchBox(searchBox, strTarget);
      await sleep(600);
      nodes = await waitForOptionNodes(trigger, 1500);
      debug('combobox after search filter', { target: strTarget, count: nodes.length });
    }

    const option = matchNode(nodes, normalizeChoice(strTarget));
    if (option) {
      clickNode(option);
      trigger.dispatchEvent(new Event('input', { bubbles: true }));
      trigger.dispatchEvent(new Event('change', { bubbles: true }));
      return { applied: true };
    }
    // Nothing matched the requested value. Instead of leaving the field empty,
    // click the best option that IS present in the popup (existing options
    // only — never invent a new value, never click action rows).
    const fallback = pickFallbackOption(nodes);
    if (fallback) {
      debug('combobox fallback', { target: strTarget, chosen: optionLabel(fallback) });
      clickNode(fallback);
      trigger.dispatchEvent(new Event('input', { bubbles: true }));
      trigger.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        applied: true,
        reason: 'fallback',
        fallback: true,
        chosen: optionLabel(fallback)
      };
    }

    // Popup had nothing usable at all: close it and leave the field untouched.
    try {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } catch {
      /* noop */
    }
    debug('combobox untouched', { target: strTarget, seen: nodes.length });
    return { applied: false, reason: 'no-options-rendered' };
  }

  // Model sometimes returns "$1,500.00" for numeric inputs — browsers reject
  // that in <input type="number"> and silently clear the field. Sanitize.
  function sanitizeForNumberInput(strValue) {
    const m = String(strValue).match(/-?\d[\d,]*\.?\d*/);
    if (!m) return '';
    return m[0].replace(/,/g, '');
  }

  function setTextValue(field, strValue) {
    const tag = field.tagName.toLowerCase();
    if (tag === 'input' && (field.getAttribute('type') || '').toLowerCase() === 'number') {
      strValue = sanitizeForNumberInput(strValue);
      if (!strValue) return false;
    }
    if (tag !== 'input' && tag !== 'textarea') {
      // Generic fallback: set text and notify.
      try {
        field.textContent = strValue;
      } catch {
        /* noop */
      }
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    const proto =
      tag === 'textarea'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && typeof descriptor.set === 'function') {
        descriptor.set.call(field, strValue);
      } else {
        field.value = strValue;
      }
    } catch {
      field.value = strValue;
    }
    // Required for React / Vue / Angular controlled inputs.
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Last fill diagnostics (used to explain skips to the user).
  let lastFillInfo = { applied: false, reason: '' };

  function fieldDescribe(el) {
    try {
      const label = resolveLabel(el);
      if (label) return label.slice(0, 60);
      // Native selects often have no label at all — describe via options.
      if (el.tagName && el.tagName.toLowerCase() === 'select') {
        const opts = describeOptions(el, 4);
        if (opts) return `select[${opts}]`.slice(0, 80);
      }
      return (
        el.getAttribute('name') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('aria-label') ||
        el.id ||
        el.tagName.toLowerCase()
      ).slice(0, 60);
    } catch {
      return 'field';
    }
  }

  async function setFieldValue(field, value) {
    const strValue = value == null ? '' : String(value);
    const tag = field.tagName.toLowerCase();
    // 1. Native dropdowns (existing options only).
    if (tag === 'select') {
      const ok = await setSelectValue(field, strValue);
      if (!ok) lastFillInfo = { applied: false, reason: 'no-match' };
      return ok;
    }
    // 2. Custom dropdown triggers (existing options only; may need to wait
    //    for the popup / search filter, hence async).
    if (fieldKind(field) === 'combobox') {
      const res = await setComboboxValue(field, strValue);
      lastFillInfo =
        res && typeof res === 'object' ? res : { applied: !!res, reason: '' };
      return lastFillInfo.applied;
    }
    // 3. Rich-text editors.
    if (isRichText(field)) {
      field.focus();
      let ok = false;
      try {
        ok = document.execCommand ? document.execCommand('insertText', false, strValue) : false;
      } catch {
        ok = false;
      }
      if (!ok) field.textContent = strValue;
      field.dispatchEvent(new InputEvent('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    // 4. Plain inputs / textareas (+ generic fallback inside setTextValue).
    return setTextValue(field, strValue) !== false;
  }

  // ---------- Variation memory (developer form testing) ----------
// Keeps the last two runs' generated values so consecutive Fill All runs
// produce different data instead of the AI's single "typical" answer.
// Kept in memory only — nothing is persisted or sent anywhere but the LLM call.
let recentValues = [];
let randomizeValues = true;
const MAX_REMEMBERED = 120;

// Respect the user's Options toggle (defaults to on).
function loadRandomizePreference() {
  try {
    chrome.storage.sync.get('randomize', (result) => {
      if (chrome.runtime.lastError) return;
      randomizeValues = !result || result.randomize !== false;
    });
  } catch {
    /* default to randomising */
  }
}
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes && Object.hasOwn(changes, 'randomize')) {
      randomizeValues = changes.randomize.newValue !== false;
    }
  });
} catch {
  /* storage unavailable — keep the default */
}
loadRandomizePreference();

function rememberValues(values) {
  const fresh = [];
  for (const v of Object.values(values)) {
    if (typeof v === 'string' && v.trim()) fresh.push(v.trim());
  }
  // Two runs deep: avoids immediate repeats without growing forever.
  recentValues = [...fresh, ...recentValues].slice(0, MAX_REMEMBERED);
}

// ---------- Single fill ----------

  async function onSingleFillClick() {
    if (!activeField || isSingleLoading) return;
    const field = activeField;
    const context = extractContext(field);
    setSingleState('loading');

    // Closed custom dropdown: harvest real options first so the AI picks
    // from the actual list instead of guessing.
    if (context.kind === 'combobox' && (!context.options || context.options.length === 0)) {
      try {
        setSingleState('loading', '⏳ Reading options…');
        const options = await harvestComboboxOptions(field);
        if (options.length > 0) context.options = options;
        setSingleState('loading');
        field.focus();
      } catch {
        /* fall through with whatever context we have */
      }
    }

    let response;
    try {
      response = await sendToBackground({
type: 'AIFF_FILL',
        context,
        // Same variation controls as batch fill, so repeated clicks vary too.
        randomize: randomizeValues,
        avoidValues: recentValues.slice(0, 20)
      });
    } catch (err) {
      if (isInvalidationError(err)) {
        handleInvalidatedSingle();
        return;
      }
      setSingleState('error', '⚠️ No response');
      const friendly = friendlyApiError((err && err.message) || err);
      showToast({ kind: 'error', title: friendly.title, message: friendly.message });
      return;
    }

    if (response && response.invalidated) {
      handleInvalidatedSingle();
      return;
    }

    if (!response || !response.ok) {
      if (response && response.error === 'NO_API_KEY') {
        setSingleState('error', '🔑 Set API key');
        promptForApiKey();
        return;
      }
      setSingleState('error', '⚠️ Failed');
      const friendly = friendlyApiError(response && response.detail);
      showToast({ kind: 'error', title: friendly.title, message: friendly.message });
      return;
    }

    try {
      field.focus();
      // Background may return an exact option `value` for dropdowns; prefer it.
      const fillText =
        response && typeof response.value === 'string' && response.value !== ''
          ? response.value
          : response.text;
      const applied = await setFieldValue(field, fillText);
      // Remember successful single fills so the next click can avoid repeating.
      if (applied && randomizeValues && typeof fillText === 'string' && fillText.trim()) {
        rememberValues({ single: fillText.trim() });
      }
      if (!applied) {
        const kind = fieldKind(field);
        const isDropdown = field.tagName.toLowerCase() === 'select' || kind === 'combobox';
        setSingleState('error', '⚠️ No match');
        if (isDropdown) {
          showToast({
            kind: 'warn',
            title: 'No matching option',
            message: `“${String(fillText).slice(0, 80)}” isn’t in this dropdown, so nothing was changed. Only options already in the list can be selected.`,
            duration: 0
          });
        } else {
          showToast({
            kind: 'warn',
            title: 'Nothing was filled',
            message: 'This field could not be updated. Try again, or pick a different model in Settings.',
            duration: 0
          });
        }
        setTimeout(() => {
          if (activeField === field) setSingleState('idle');
        }, 2000);
        return;
      }
      if (lastFillInfo.fallback) {
        const chosen = lastFillInfo.chosen ? `“${lastFillInfo.chosen}”` : 'the first available option';
        setSingleState('success', '✓ Closest match');
        showToast({
          kind: 'info',
          title: 'Closest option selected',
          message: `“${String(fillText).slice(0, 80)}” isn’t available here, so ${chosen} was selected instead.`
        });
      } else {
        setSingleState('success');
      }
      positionSingleButton();
      setTimeout(() => {
        if (activeField === field) setSingleState('idle');
      }, 1500);
    } catch {
      setSingleState('error', '⚠️ Insert failed');
    }
  }

  // ---------- Batch fill ----------

  async function collectFillableFields() {
    const candidates = queryAllDeep(BATCH_SELECTOR, 500);
    const fillable = [];

    for (const el of candidates) {
      if (!isFillable(el) || !isVisible(el)) continue;
      // Skip hidden honeypot traps (display-friendly but off-screen).
      try {
        const rect = el.getBoundingClientRect();
        if (rect.top < -2000 || rect.left < -2000) continue; // honeypot / off-screen trap
      } catch {
        continue;
      }
      fillable.push(el);
      if (fillable.length >= MAX_BATCH_FIELDS) break;
    }

    // Group identical fields (repeated invoice rows etc.) so each gets a
    // distinct occurrence number: "item 2 of 3 with this label".
    const groupCounts = new Map();
    const groupKey = (ctx) =>
      [ctx.kind, ctx.label, ctx.name, ctx.placeholder].join('|').toLowerCase();
    const contexts = fillable.map((el) => extractContext(el));

    // Harvest REAL options for closed custom dropdowns: open each popup,
    // read its options, close it. Without this the AI would have to guess.
    const previouslyFocused = document.activeElement;
    let harvested = 0;
    for (let i = 0; i < fillable.length && harvested < MAX_HARVEST_FIELDS; i++) {
      if (contexts[i].kind !== 'combobox') continue;
      if (contexts[i].options && contexts[i].options.length > 0) continue;
      try {
        const options = await harvestComboboxOptions(fillable[i]);
        if (options.length > 0) contexts[i].options = options;
        harvested++;
      } catch {
        /* best-effort per field */
      }
    }
    try {
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    } catch {
      /* noop */
    }

    for (const ctx of contexts) {
      const key = groupKey(ctx);
      groupCounts.set(key, (groupCounts.get(key) || 0) + 1);
    }
    const groupSeen = new Map();
    const fields = [];
    const elementByUid = new Map();
    contexts.forEach((ctx, i) => {
      const key = groupKey(ctx);
      const total = groupCounts.get(key) || 1;
      const seen = (groupSeen.get(key) || 0) + 1;
      groupSeen.set(key, seen);
      const uid = `f${i}`;
      const positionBits = [getPositionContext(fillable[i])];
      if (total > 1) positionBits.push(`item ${seen} of ${total} with the same label`);
      const position = positionBits.filter(Boolean).join('; ');
      if (position) ctx.position = position;
      fillable[i].setAttribute('data-aiff-uid', uid);
      fields.push({ uid, ...ctx, currentValue: (ctx.currentValue || '').slice(0, 200) });
      elementByUid.set(uid, fillable[i]);
    });
    return { fields, elementByUid };
  }

  async function onFillAllClick() {
    if (isBatchLoading) return;
    ensureUI();
    setFillAllState('loading', '⏳ Reading fields…');

    const { fields, elementByUid } = await collectFillableFields();
    if (fields.length === 0) {
      setFillAllState('error', '⚠️ No fields found');
      showToast({
        kind: 'warn',
        title: 'No fillable fields found',
        message:
          'This page has no visible text inputs, textareas, or dropdowns. Password, file, and hidden fields are skipped by design.',
        duration: 6000
      });
      setTimeout(() => setFillAllState('idle'), 2000);
      return;
    }

    let response;
    try {
      setFillAllState('loading', '⏳ Generating…');
response = await sendToBackground({
type: 'AIFF_FILL_ALL',
        payload: {
          fields,
          randomize: randomizeValues,
          // Previously generated values, so the model can avoid repeating them
          avoidValues: recentValues.slice(0, 60),
          page: { title: document.title || '', url: location.href || '' }
        }
      });
    } catch (err) {
      if (isInvalidationError(err)) {
        handleInvalidatedBatch();
        return;
      }
      setFillAllState('error', '⚠️ No response');
      const friendly = friendlyApiError((err && err.message) || err);
      showToast({ kind: 'error', title: friendly.title, message: friendly.message });
      setTimeout(() => setFillAllState('idle'), 2000);
      return;
    }

    if (response && response.invalidated) {
      handleInvalidatedBatch();
      return;
    }

    if (!response || !response.ok) {
      if (response && response.error === 'NO_API_KEY') {
        setFillAllState('error', '🔑 Set API key');
        promptForApiKey();
        setTimeout(() => setFillAllState('idle'), 2500);
        return;
      }
      setFillAllState('error', '⚠️ Fill-all failed');
      const friendly = friendlyApiError(response && response.detail);
      showToast({ kind: 'error', title: friendly.title, message: friendly.message });
      setTimeout(() => setFillAllState('idle'), 2500);
      return;
    }

    try {
      const values = response.values || {};
      let filled = 0;
      const skippedLabels = [];
      const fallbackLabels = [];
      // Remember what we just generated so the next run can avoid it.
      if (randomizeValues) rememberValues(values);
      for (const [uid, text] of Object.entries(values)) {
        const el = elementByUid.get(uid);
        if (!el || !el.isConnected) continue;
        if (typeof text !== 'string' || text === '') continue;
        try {
          // Dropdowns resolve to false only when the popup had no usable
          // option at all — those are counted as skipped, never force-filled.
          lastFillInfo = { applied: false, reason: '' };
          const applied = await setFieldValue(el, text);
          if (applied) {
            filled += 1;
            // Requested value wasn't in the list, so an existing option was
            // chosen instead — surface that so the user knows why.
            if (lastFillInfo.fallback) {
              const chosen = lastFillInfo.chosen ? `"${lastFillInfo.chosen}"` : 'first available option';
              fallbackLabels.push(
                `${fieldDescribe(el)}: "${String(text).slice(0, 40)}" not in list → selected ${chosen}`
              );
            }
          } else {
            const why = lastFillInfo.reason ? ` (${lastFillInfo.reason})` : '';
            const wanted = `wanted "${String(text).slice(0, 40)}"`;
            skippedLabels.push(`${fieldDescribe(el)} — ${wanted}${why}`);
          }
        } catch {
          /* skip failing field, continue with the rest */
          skippedLabels.push(fieldDescribe(el));
        }
      }
      // Clean up tracking attributes.
      for (const el of elementByUid.values()) {
        try {
          el.removeAttribute('data-aiff-uid');
        } catch {
          /* noop */
        }
      }
      const skipped = skippedLabels.length;
      if (filled === 0) {
        setFillAllState('error', '⚠️ Nothing filled');
        showToast({
          kind: 'error',
          title: 'Nothing was filled',
          message:
            skipped > 0
              ? `No field could be updated. ${skippedLabels.slice(0, 3).join('; ')}.`
              : 'The model did not return usable values for the fields on this page. Try again or pick another model in Settings.',
          duration: 0
        });
      } else if (skipped > 0) {
        setFillAllState('success', `✓ Filled ${filled} field${filled === 1 ? '' : 's'}!`);
        showToast({
          kind: 'warn',
          title: `Filled ${filled} of ${filled + skipped} fields`,
          message: `${skipped} dropdown${skipped === 1 ? '' : 's'} had no selectable options: ${skippedLabels.slice(0, 3).join('; ')}.`,
          duration: 0
        });
      } else if (fallbackLabels.length > 0) {
        setFillAllState('success', `✓ Filled ${filled} field${filled === 1 ? '' : 's'}!`);
        showToast({
          kind: 'info',
          title: `Filled ${filled} field${filled === 1 ? '' : 's'}`,
          message: `${fallbackLabels.length} dropdown${fallbackLabels.length === 1 ? '' : 's'} used the closest available option:\n${fallbackLabels.slice(0, 3).join('\n')}`,
          duration: 0
        });
      } else {
        setFillAllState('success', `✓ Filled ${filled} field${filled === 1 ? '' : 's'}!`);
        showToast({
          kind: 'success',
          title: `Filled ${filled} field${filled === 1 ? '' : 's'}`,
          message: 'Every field was updated successfully.',
          duration: 3500
        });
      }
      if (activeField) positionSingleButton();
      setTimeout(() => setFillAllState('idle'), 2500);
    } catch {
      setFillAllState('error', '⚠️ Insert failed');
      setTimeout(() => setFillAllState('idle'), 2500);
    }
  }

  // ---------- Listeners (delegated for SPAs) ----------

  document.addEventListener(
    'focusin',
    (e) => {
      if (isFillable(e.target)) showSingleButton(e.target);
    },
    true
  );

  // Hover support: reveal the button when the pointer enters a fillable field,
  // even before it is focused. `pointerover` bubbles and is paired with
  // `pointerout` for the matching hide.
  document.addEventListener(
    'pointerover',
    (e) => {
      if (!isFillable(e.target)) return;
      // Ignore the synthetic events we dispatch while filling.
      if (isBatchLoading || isSingleLoading) return;
      showSingleButton(e.target);
    },
    true
  );

  document.addEventListener(
    'pointerout',
    (e) => {
      if (!isFillable(e.target)) return;
      // Moving within the same field should not dismiss the button.
      const to = e.relatedTarget;
      if (to && e.target.contains && e.target.contains(to)) return;
      // Shadow-DOM events retarget to our host; moving onto the button must
      // never dismiss it. The button's own pointerenter cancels the timer.
      if (to && host && (to === host || (host.contains && host.contains(to)))) return;
      scheduleHide();
    },
    true
  );

  document.addEventListener(
    'focusout',
    (e) => {
      if (e.relatedTarget && host && e.relatedTarget === host) return;
      scheduleHide();
    },
    true
  );

  window.addEventListener(
    'scroll',
    () => {
      if (activeField && singleBtn && singleBtn.style.display !== 'none') {
        positionSingleButton();
      }
    },
    true
  );

  window.addEventListener('resize', () => {
    if (activeField && singleBtn && singleBtn.style.display !== 'none') {
      positionSingleButton();
    }
  });

  document.addEventListener(
    'mousedown',
    (e) => {
      if (host && (e.target === host || host.contains(e.target))) return;
      if (activeField && e.target !== activeField && !activeField.contains(e.target)) {
        if (!isFillable(e.target)) hideSingleButton();
      }
    },
    true
  );

  // Boot: render the persistent Fill All button.
  ensureUI();

  // Re-assert UI if aggressive page scripts remove our host.
  new MutationObserver(() => {
    if (!document.getElementById(HOST_ID) || !singleBtn || !fillAllBtn) {
      host = null;
      shadow = null;
      singleBtn = null;
      fillAllBtn = null;
      ensureUI();
      if (activeField) positionSingleButton();
    }
  }).observe(document.documentElement, { childList: true, subtree: false });
})();
