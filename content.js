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
      gap: 8px;
      right: 20px;
      bottom: 20px;
      padding: 12px 18px;
      font-size: 14px;
      background: linear-gradient(135deg, #18794e, #30a46c);
      box-shadow: 0 8px 24px rgba(24, 121, 78, 0.45);
      cursor: grab;
    }
    .aiff-fill-all:active { cursor: grabbing; }
    .aiff-fill-all:hover:not(:disabled) { box-shadow: 0 10px 28px rgba(24,121,78,0.55); }
  `;

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
      singleBtn.textContent = '✨ AI Fill';
      singleBtn.addEventListener('mousedown', (e) => e.preventDefault());
      singleBtn.addEventListener('click', onSingleFillClick);
      shadow.appendChild(singleBtn);
    } else {
      singleBtn = shadow.querySelector('[data-aiff-single]');
    }

    if (!shadow.querySelector('[data-aiff-fill-all]')) {
      fillAllBtn = document.createElement('button');
      fillAllBtn.type = 'button';
      fillAllBtn.className = 'aiff-btn aiff-fill-all';
      fillAllBtn.setAttribute('data-aiff-fill-all', 'true');
      fillAllBtn.textContent = '⚡ Fill All Fields';
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

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!isSingleLoading) hideSingleButton();
    }, 200);
  }

  function setSingleState(state, text) {
    if (!singleBtn) return;
    singleBtn.classList.remove('aiff-error', 'aiff-success');
    singleBtn.disabled = false;
    if (state === 'loading') {
      isSingleLoading = true;
      singleBtn.disabled = true;
      singleBtn.textContent = text || '⏳ Generating…';
    } else if (state === 'error') {
      isSingleLoading = false;
      singleBtn.classList.add('aiff-error');
      singleBtn.textContent = text || '⚠️ Failed';
    } else if (state === 'success') {
      isSingleLoading = false;
      singleBtn.classList.add('aiff-success');
      singleBtn.textContent = text || '✓ Filled!';
    } else {
      isSingleLoading = false;
      singleBtn.textContent = text || '✨ AI Fill';
    }
  }

  function setFillAllState(state, text) {
    if (!fillAllBtn) return;
    fillAllBtn.classList.remove('aiff-error', 'aiff-success');
    fillAllBtn.disabled = false;
    if (state === 'loading') {
      isBatchLoading = true;
      fillAllBtn.disabled = true;
      fillAllBtn.textContent = text || '⏳ Filling all…';
    } else if (state === 'error') {
      isBatchLoading = false;
      fillAllBtn.classList.add('aiff-error');
      fillAllBtn.textContent = text || '⚠️ Fill-all failed';
    } else if (state === 'success') {
      isBatchLoading = false;
      fillAllBtn.classList.add('aiff-success');
      fillAllBtn.textContent = text || '✓ All filled!';
    } else {
      isBatchLoading = false;
      fillAllBtn.textContent = text || '⚡ Fill All Fields';
    }
  }

  function promptForApiKey() {
    const go = confirm(
      'No Gemini API key is configured.\n\nClick OK to open the Options page and add your key.'
    );
    if (go) {
      try {
        chrome.runtime.sendMessage({ type: 'AIFF_OPEN_OPTIONS' });
      } catch {
        /* options page fallback handled in background */
      }
    }
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
  // Strict: with NO match the select is left untouched (return false) —
  // never auto-pick an unrelated option.
  function setSelectValue(selectEl, target) {
    const t = normalizeChoice(target);
    if (!t) return false;
    const opts = [...selectEl.options];
    const match =
      opts.find((o) => normalizeChoice(o.value) === t) ||
      opts.find((o) => normalizeChoice(o.text) === t) ||
      opts.find(
        (o) => normalizeChoice(o.text).includes(t) || normalizeChoice(o.value).includes(t)
      ) ||
      null;
    if (!match || match.disabled) return false;
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
    const byValue = (n) =>
      normalizeChoice(n.getAttribute('data-value') || n.getAttribute('data-option-value'));
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
    if (!option) {
      // No existing option matches: close the popup (Escape) and touch nothing.
      try {
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } catch {
        /* noop */
      }
      debug('combobox no match, untouched', { target: strTarget, seen: nodes.length });
      return { applied: false, reason: nodes.length === 0 ? 'no-options-rendered' : 'no-match' };
    }
    clickNode(option);
    trigger.dispatchEvent(new Event('input', { bubbles: true }));
    trigger.dispatchEvent(new Event('change', { bubbles: true }));
    return { applied: true };
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
    if (tag === 'select') return setSelectValue(field, strValue);
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

  // ---------- Single fill ----------

  async function onSingleFillClick() {
    if (!activeField || isSingleLoading) return;
    const field = activeField;
    const context = extractContext(field);
    setSingleState('loading');

    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'AIFF_FILL', context });
    } catch (err) {
      setSingleState('error', '⚠️ No response');
      alert(`Extension error: ${(err && err.message) || err}`);
      return;
    }

    if (!response || !response.ok) {
      if (response && response.error === 'NO_API_KEY') {
        setSingleState('error', '🔑 Set API key');
        promptForApiKey();
        return;
      }
      const detail = response && response.detail ? `\n\n${response.detail}` : '';
      setSingleState('error', '⚠️ Failed — retry?');
      alert(`AI Fill failed.${detail}`);
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
      if (!applied) {
        const kind = fieldKind(field);
        const isDropdown = field.tagName.toLowerCase() === 'select' || kind === 'combobox';
        const reason = lastFillInfo.reason ? ` (reason: ${lastFillInfo.reason})` : '';
        setSingleState('error', '⚠️ No match');
        alert(
          isDropdown
            ? `No existing dropdown option matches "${String(fillText).slice(0, 120)}"${reason}. Nothing was changed — only options already in the list can be selected. Tip: open DevTools console and look for [AIFF] logs.`
            : 'Could not fill this field. Nothing was changed.'
        );
        setTimeout(() => {
          if (activeField === field) setSingleState('idle');
        }, 2000);
        return;
      }
      setSingleState('success');
      positionSingleButton();
      setTimeout(() => {
        if (activeField === field) setSingleState('idle');
      }, 1500);
    } catch {
      setSingleState('error', '⚠️ Insert failed');
    }
  }

  // ---------- Batch fill ----------

  function collectFillableFields() {
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
    setFillAllState('loading');

    const { fields, elementByUid } = collectFillableFields();
    if (fields.length === 0) {
      setFillAllState('error', '⚠️ No fields found');
      alert('No visible, fillable fields (inputs, textareas, or dropdowns) were found on this page.');
      setTimeout(() => setFillAllState('idle'), 2000);
      return;
    }

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'AIFF_FILL_ALL',
        payload: {
          fields,
          page: { title: document.title || '', url: location.href || '' }
        }
      });
    } catch (err) {
      setFillAllState('error', '⚠️ No response');
      alert(`Extension error: ${(err && err.message) || err}`);
      setTimeout(() => setFillAllState('idle'), 2000);
      return;
    }

    if (!response || !response.ok) {
      if (response && response.error === 'NO_API_KEY') {
        setFillAllState('error', '🔑 Set API key');
        promptForApiKey();
        setTimeout(() => setFillAllState('idle'), 2500);
        return;
      }
      const detail = response && response.detail ? `\n\n${response.detail}` : '';
      setFillAllState('error', '⚠️ Fill-all failed');
      alert(`Fill All Fields failed.${detail}`);
      setTimeout(() => setFillAllState('idle'), 2500);
      return;
    }

    try {
      const values = response.values || {};
      let filled = 0;
      const skippedLabels = [];
      for (const [uid, text] of Object.entries(values)) {
        const el = elementByUid.get(uid);
        if (!el || !el.isConnected) continue;
        if (typeof text !== 'string' || text === '') continue;
        try {
          // Dropdowns resolve to false when no existing option matches —
          // those fields are counted as skipped, never force-filled.
          lastFillInfo = { applied: false, reason: '' };
          const applied = await setFieldValue(el, text);
          if (applied) {
            filled += 1;
          } else {
            const why = lastFillInfo.reason ? ` (${lastFillInfo.reason})` : '';
            skippedLabels.push(`${fieldDescribe(el)}${why}`);
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
        alert(
          skipped > 0
            ? `Nothing filled. Skipped dropdowns: ${skippedLabels.slice(0, 5).join('; ')}. Only existing options can be selected.`
            : 'The model returned no usable values for the detected fields.'
        );
      } else if (skipped > 0) {
        setFillAllState('success', `✓ Filled ${filled} field${filled === 1 ? '' : 's'}!`);
        alert(
          `${filled} field${filled === 1 ? '' : 's'} filled. ${skipped} dropdown${skipped === 1 ? '' : 's'} skipped — no existing option matched, so nothing new was selected there. Skipped: ${skippedLabels.slice(0, 5).join('; ')}.`
        );
      } else {
        setFillAllState('success', `✓ Filled ${filled} field${filled === 1 ? '' : 's'}!`);
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
