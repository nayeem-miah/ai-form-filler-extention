/* content.js — Batch form filling, driven from the toolbar icon.
 *  There are no in-page buttons any more. Clicking the extension icon asks this
 *  script (via the AIFF_FILL_ALL_FIELDS message) to fill EVERY visible field on
 *  the page — text inputs, textareas, selects, and custom comboboxes — in a
 *  single request to the AI provider.
 *  Password fields are handled locally: they are always filled with the fixed
 *  DEFAULT_PASSWORD and are NEVER sent to the AI provider.
 * Shadow DOM is used for the toast notifications so host-page CSS can't leak in.
 * Every programmatic fill dispatches synthetic events (input + change, plus click
 *  for custom dropdowns) so React/Vue/Angular detect the value change.
 */
(() => {
  'use strict';

  const HOST_ID = 'ai-form-filler-root';
  // `password` is intentionally NOT ignored: password inputs are collected and
  // filled locally with a fixed default password (never sent to the AI).
  const IGNORED_INPUT_TYPES = new Set([
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
  let isBatchLoading = false;

  const SHARED_CSS = `
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
  return toast;
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

  // ---------- Shadow DOM setup (toasts only) ----------

  // The only in-page UI is the toast stack. The floating "AI Fill" / "Fill All
  // Fields" buttons were removed — filling is now triggered from the toolbar
  // icon, and results are reported through these toasts.
  function ensureUI() {
    if (host && shadow && shadow.querySelector('[data-aiff-toasts]')) return;

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

    if (!shadow.querySelector('[data-aiff-toasts]')) {
      const box = document.createElement('div');
      box.className = 'aiff-toasts';
      box.setAttribute('data-aiff-toasts', 'true');
      shadow.appendChild(box);
    }
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

  // Links and submit buttons perform navigation/actions. They must never be
  // used as dropdown triggers, otherwise opening a "dropdown" submits the form
  // or follows a link and the page jumps away mid-fill.
  function isNavigationControl(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return true;
    if (tag === 'button') {
      const type = (el.getAttribute('type') || 'submit').toLowerCase();
      if (type === 'submit' && el.closest && el.closest('form')) return true;
    }
    return false;
  }

  // Site-wide search boxes often navigate on input/change (instant search).
  // Header/nav controls are page chrome (search, language, account), not part
  // of the form being filled — typing into them can leave the page.
  function isSiteSearchField(el) {
    try {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'search') return true;
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (role === 'searchbox') return true;
      if (el.closest && el.closest('[role="search"], form[role="search"]')) return true;
      if (el.closest && el.closest('header, nav')) return true;
    } catch {
      /* noop */
    }
    return false;
  }

  // Custom JS/React dropdown triggers: Radix / Shadcn / Tailwind / headless-ui
  // popups are usually a button or div with role="combobox" or
  // aria-haspopup="listbox", or a class containing "select"/"dropdown".
  function isDropdownTrigger(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.disabled) return false;
    // Never treat links/submit buttons as dropdowns (they navigate).
    if (isNavigationControl(el)) return false;
    const role = el.getAttribute && el.getAttribute('role');
    if (role === COMBOBOX_ROLE) return true;
    const popup = el.getAttribute && el.getAttribute('aria-haspopup');
    // `menu` is navigation/actions, not a selectable form value.
    if (popup === 'listbox') return true;
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
    '[aria-haspopup="listbox"]'
    // NOTE: [aria-haspopup="menu"] is deliberately excluded. Menus are
    // navigation/action popups (account, share, nav), not form values, and
    // clicking them can navigate away from the page being filled.
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

  function promptForApiKey(info) {
    if (isContextInvalidated()) {
      alertContextInvalidated();
      return;
    }
    const freeExhausted = Boolean(info && info.freeExhausted);
    showToast({
      kind: 'warn',
      title: freeExhausted ? 'Free daily limit reached' : 'No API key configured',
      message: freeExhausted
        ? 'You have used all your free requests for today. Add your own API key in Settings to keep filling forms, or come back tomorrow for more free requests.'
        : 'Add your own API key in Settings to fill forms. Free daily requests may have run out.',
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

  function handleInvalidatedBatch() {
    alertContextInvalidated();
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

  // Pointer-like click that never performs the browser default action.
  // Dropdown triggers and options can be <a href> or <button type="submit">;
  // letting the default run navigates or submits the page mid-fill. Site
  // handlers still receive the events; preventDefault only cancels the default.
  function clickNode(node) {
    const opts = { bubbles: true, cancelable: true, view: window };
    try {
      node.dispatchEvent(new MouseEvent('mousedown', opts));
    } catch {
      /* noop */
    }
    try {
      node.dispatchEvent(new MouseEvent('mouseup', opts));
    } catch {
      /* noop */
    }
    try {
      const clickEvent = new MouseEvent('click', opts);
      const cancelDefault = (event) => {
        if (event === clickEvent) event.preventDefault();
      };
      document.addEventListener('click', cancelDefault, true);
      try {
        node.dispatchEvent(clickEvent);
      } finally {
        document.removeEventListener('click', cancelDefault, true);
      }
    } catch {
      /* noop */
    }
    // Deliberately no node.click(): it fires a second click and lets the
    // default action navigate/submit.
  }

  // Block form submissions caused by our synthetic input/change events. Some
  // fields have inline handlers like onchange="this.form.submit()" which would
  // otherwise navigate away right after being filled.
  let submitGuardUntil = 0;

  function onFillSubmit(event) {
    if (Date.now() < submitGuardUntil) event.preventDefault();
  }
  document.addEventListener('submit', onFillSubmit, true);

  function beginSubmitGuard() {
    // Hold submissions while our synthetic events are being applied.
    submitGuardUntil = Number.POSITIVE_INFINITY;
  }

  function endSubmitGuard() {
    // Stay on briefly: some sites submit on a debounce after input/change.
    submitGuardUntil = Date.now() + 1500;
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
    // No click here: the caller already clicked, and a second click can toggle
    // the popup back closed (or navigate, before clickNode was hardened).
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
          trigger.closest('[role="combobox"], [aria-haspopup="listbox"], button')) ||
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

  // ---------- Password fields (filled locally, never sent to the AI) ----------

  // Fixed password inserted into every password / confirm-password field.
  // Change this constant to use a different default. It is filled purely
  // locally and is never sent to the AI provider.
  const DEFAULT_PASSWORD = 'Password123$';

  function isPasswordField(el) {
    return (
      el &&
      el.tagName &&
      el.tagName.toLowerCase() === 'input' &&
      (el.getAttribute('type') || '').toLowerCase() === 'password'
    );
  }

  // Never overwrite "current / old / existing password" boxes — those expect the
  // user's real password, not a generated one.
  const CURRENT_PASSWORD_RE = /(current|old|existing|previous|confirm\s+old)\s*password/i;

  function shouldSkipPasswordField(el) {
    // `autocomplete="current-password"` is an explicit signal from the site.
    if ((el.getAttribute('autocomplete') || '').toLowerCase() === 'current-password') {
      return true;
    }
    const text = [
      resolveLabel(el),
      el.getAttribute('name'),
      el.id,
      el.getAttribute('placeholder'),
      el.getAttribute('aria-label')
    ]
      .filter(Boolean)
      .join(' ');
    return CURRENT_PASSWORD_RE.test(text);
  }

  // Fill every collected password field with the same default password, so
  // paired fields (password + confirm password) always match.
  function fillPasswordFields(passwordFields) {
    const targets = (passwordFields || []).filter((el) => el && el.isConnected && isVisible(el));
    if (targets.length === 0) return { filled: 0, password: '' };
    const password = DEFAULT_PASSWORD;
    let filled = 0;
    for (const el of targets) {
      if (shouldSkipPasswordField(el)) continue;
      try {
        if (setTextValue(el, password) !== false) filled += 1;
      } catch {
        /* skip a failing field, keep going with the rest */
      }
    }
    return { filled, password };
  }

  // ---------- Batch fill ----------

  async function collectFillableFields() {
    const candidates = queryAllDeep(BATCH_SELECTOR, 500);
    const fillable = [];

    for (const el of candidates) {
      if (!isFillable(el) || !isVisible(el)) continue;
      // Skip site search / header-nav controls: typing into them can navigate
      // to another page (instant search, language switch, account menu).
      if (isSiteSearchField(el)) continue;
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

    // Password inputs are filled locally with a generated strong password and
    // are never sent to the AI provider, so keep them out of the model input.
    const passwordFields = fillable.filter((el) => isPasswordField(el));
    const aiFillable = fillable.filter((el) => !isPasswordField(el));

    // Group identical fields (repeated invoice rows etc.) so each gets a
    // distinct occurrence number: "item 2 of 3 with this label".
    const groupCounts = new Map();
    const groupKey = (ctx) =>
      [ctx.kind, ctx.label, ctx.name, ctx.placeholder].join('|').toLowerCase();
    const contexts = aiFillable.map((el) => extractContext(el));

    // Harvest REAL options for closed custom dropdowns: open each popup,
    // read its options, close it. Without this the AI would have to guess.
    const previouslyFocused = document.activeElement;
    let harvested = 0;
    for (let i = 0; i < aiFillable.length && harvested < MAX_HARVEST_FIELDS; i++) {
      if (contexts[i].kind !== 'combobox') continue;
      if (contexts[i].options && contexts[i].options.length > 0) continue;
      try {
        const options = await harvestComboboxOptions(aiFillable[i]);
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
      const positionBits = [getPositionContext(aiFillable[i])];
      if (total > 1) positionBits.push(`item ${seen} of ${total} with the same label`);
      const position = positionBits.filter(Boolean).join('; ');
      if (position) ctx.position = position;
      aiFillable[i].setAttribute('data-aiff-uid', uid);
      fields.push({ uid, ...ctx, currentValue: (ctx.currentValue || '').slice(0, 200) });
      elementByUid.set(uid, aiFillable[i]);
    });
    return { fields, elementByUid, passwordFields };
  }

  // Triggered by the toolbar icon (via background.js) OR directly from a page.
  // Fills every AI field and every password field, then reports the result.
  async function fillAllFields() {
    if (isBatchLoading) return { ok: false, reason: 'busy' };
    isBatchLoading = true;
    ensureUI();
    const progress = showToast({
      kind: 'info',
      title: 'Filling all fields…',
      message: 'Reading the page and generating values.',
      duration: 0
    });

    try {
      let collected;
      try {
        collected = await collectFillableFields();
      } catch (err) {
        dismissToast(progress);
        showToast({
          kind: 'error',
          title: 'Could not read this page',
          message: String((err && err.message) || err).slice(0, 300)
        });
        return { ok: false, reason: 'collect-failed' };
      }

      const { fields, elementByUid, passwordFields } = collected;

      if (fields.length === 0 && passwordFields.length === 0) {
        dismissToast(progress);
        showToast({
          kind: 'warn',
          title: 'No fillable fields found',
          message:
            'This page has no visible text inputs, textareas, or dropdowns. File, hidden, checkbox, and radio fields are skipped by design.',
          duration: 6000
        });
        return { ok: false, reason: 'no-fields' };
      }

      // Password boxes are filled locally with the fixed default password —
      // this value is never sent to the AI provider. The submit guard keeps a
      // site's change handler from submitting the form as we type.
      beginSubmitGuard();
      let pw;
      try {
        pw = fillPasswordFields(passwordFields);
      } finally {
        endSubmitGuard();
      }

      // Password-only page: nothing for the AI to do.
      if (fields.length === 0) {
        dismissToast(progress);
        if (pw.filled > 0) {
          showToast({
            kind: 'success',
            title: 'Password filled',
            message: `The default password was inserted into ${pw.filled} password field${pw.filled === 1 ? '' : 's'}.`,
            duration: 4500
          });
        } else {
          showToast({
            kind: 'warn',
            title: 'No password field filled',
            message: 'Only current / old password fields were found, so nothing was changed.',
            duration: 5000
          });
        }
        return { ok: pw.filled > 0, filled: pw.filled };
      }

      let response;
      try {
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
        dismissToast(progress);
        if (isInvalidationError(err)) {
          handleInvalidatedBatch();
          return { ok: false, reason: 'invalidated' };
        }
        const friendly = friendlyApiError((err && err.message) || err);
        showToast({ kind: 'error', title: friendly.title, message: friendly.message });
        return { ok: false, reason: 'no-response' };
      }

      if (response && response.invalidated) {
        dismissToast(progress);
        handleInvalidatedBatch();
        return { ok: false, reason: 'invalidated' };
      }

      if (!response || !response.ok) {
        dismissToast(progress);
        if (response && response.error === 'NO_API_KEY') {
          promptForApiKey(response);
          return { ok: false, reason: 'no-key' };
        }
        const friendly = friendlyApiError(response && response.detail);
        showToast({ kind: 'error', title: friendly.title, message: friendly.message });
        return { ok: false, reason: 'api-error' };
      }

      const values = response.values || {};
      let filled = pw.filled;
      const skippedLabels = [];
      const fallbackLabels = [];
      // Remember what we just generated so the next run can avoid it.
      if (randomizeValues) rememberValues(values);

      beginSubmitGuard();
      try {
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
                const chosen = lastFillInfo.chosen
                  ? `"${lastFillInfo.chosen}"`
                  : 'first available option';
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
      } finally {
        endSubmitGuard();
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
      const pwNote =
        pw.filled > 0
          ? ` (including ${pw.filled} password field${pw.filled === 1 ? '' : 's'})`
          : '';
      const freeNote =
        response.source === 'free' && typeof response.freeRemaining === 'number'
          ? `\n\nFree requests left today: ${response.freeRemaining}.`
          : '';

      dismissToast(progress);

      if (filled === 0) {
        showToast({
          kind: 'error',
          title: 'Nothing was filled',
          message:
            (skipped > 0
              ? `No field could be updated. ${skippedLabels.slice(0, 3).join('; ')}.`
              : 'The model did not return usable values for the fields on this page. Try again or pick another model in Settings.') +
            freeNote,
          duration: 0
        });
        return { ok: false, reason: 'nothing-filled' };
      }

      if (skipped > 0) {
        showToast({
          kind: 'warn',
          title: `Filled ${filled} of ${filled + skipped} fields`,
          message: `${skipped} field${skipped === 1 ? '' : 's'} could not be matched. ${skippedLabels.slice(0, 3).join('; ')}.${freeNote}`,
          duration: 0
        });
      } else if (fallbackLabels.length > 0) {
        showToast({
          kind: 'info',
          title: `Filled ${filled} field${filled === 1 ? '' : 's'}${pwNote}`,
          message: `${fallbackLabels.length} dropdown${fallbackLabels.length === 1 ? '' : 's'} used the closest available option:\n${fallbackLabels.slice(0, 3).join('\n')}${freeNote}`,
          duration: 0
        });
      } else {
        showToast({
          kind: 'success',
          title: `Filled ${filled} field${filled === 1 ? '' : 's'}${pwNote}`,
          message: `Every field was updated successfully.${freeNote}`,
          duration: 4500
        });
      }
      return { ok: true, filled };
    } finally {
      isBatchLoading = false;
    }
  }

  // ---------- Toolbar-icon trigger ----------

  // There are no in-page buttons: clicking the extension icon makes
  // background.js send AIFF_FILL_ALL_FIELDS to the content script of the active
  // tab, and everything is filled here.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'AIFF_FILL_ALL_FIELDS') return false;
    // Reply immediately — background must not wait for the whole fill to finish.
    // Everything the user needs to see is reported through toasts.
    sendResponse({ ok: true });
    fillAllFields().catch(() => {
      /* fallback: errors are surfaced inside fillAllFields */
    });
    return false;
  });

  // Boot: create the toast host up front so the first click can report progress.
  ensureUI();

  // Re-assert our host if aggressive page scripts remove it.
  new MutationObserver(() => {
    if (!document.getElementById(HOST_ID)) {
      host = null;
      shadow = null;
      ensureUI();
    }
  }).observe(document.documentElement, { childList: true, subtree: false });
})();
