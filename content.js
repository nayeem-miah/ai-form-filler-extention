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
    }
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
      fillAllBtn.addEventListener('mousedown', (e) => e.preventDefault());
      fillAllBtn.addEventListener('click', onFillAllClick);
      shadow.appendChild(fillAllBtn);
    } else {
      fillAllBtn = shadow.querySelector('[data-aiff-fill-all]');
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
    return '';
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

  // Custom dropdown: collect rendered option texts if the popup is in the DOM.
  // Looks at aria-controls target, then nearby listbox containers.
  function getRenderedListboxOptions(trigger, maxOptions = 60) {
    const out = [];
    const seen = new Set();
    const pushAll = (nodes) => {
      for (const n of nodes) {
        if (out.length >= maxOptions) break;
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
      const controlsId = trigger.getAttribute && trigger.getAttribute('aria-controls');
      if (controlsId) {
        const popup = document.getElementById(controlsId);
        if (popup) pushAll(popup.querySelectorAll('[role="option"]'));
      }
      if (out.length === 0) {
        const scope =
          (trigger.closest && trigger.closest('[role="dialog"], form, [data-radix-popper-content-wrapper]')) ||
          trigger.parentElement;
        if (scope) pushAll(scope.querySelectorAll('[role="option"]'));
      }
      if (out.length === 0) {
        pushAll(document.querySelectorAll('[role="listbox"] [role="option"]'));
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

  function normalizeChoice(s) {
    return String(s == null ? '' : s)
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // Standard <select>: pick the option whose value/text matches best,
  // then dispatch change + input so React/Vue/Angular detect it.
  function setSelectValue(selectEl, target) {
    const t = normalizeChoice(target);
    const opts = [...selectEl.options];
    let match = null;
    if (t) {
      match =
        opts.find((o) => normalizeChoice(o.value) === t) ||
        opts.find((o) => normalizeChoice(o.text) === t) ||
        opts.find(
          (o) => normalizeChoice(o.text).includes(t) || normalizeChoice(o.value).includes(t)
        ) ||
        null;
    }
    const chosen =
      match || opts.find((o) => o.value !== '' && !o.disabled) || opts[0] || null;
    if (!chosen) return false;
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

  function findRenderedOption(trigger, target) {
    const t = normalizeChoice(target);
    if (!t) return null;
    const candidates = getRenderedListboxOptions(trigger, 200).map((o, i) => ({ ...o, _i: i }));
    // Re-query live nodes for clicking (getRenderedListboxOptions returns data only).
    let nodes = [];
    try {
      const controlsId = trigger.getAttribute && trigger.getAttribute('aria-controls');
      if (controlsId) {
        const popup = document.getElementById(controlsId);
        if (popup) nodes = [...popup.querySelectorAll('[role="option"]')];
      }
      if (nodes.length === 0) {
        const scope =
          (trigger.closest && trigger.closest('[role="dialog"], form')) || trigger.parentElement;
        if (scope) nodes = [...scope.querySelectorAll('[role="option"]')];
      }
      if (nodes.length === 0) nodes = [...document.querySelectorAll('[role="listbox"] [role="option"]')];
    } catch {
      nodes = [];
    }
    if (nodes.length === 0) return null;
    const byText = (n) => normalizeChoice(n.innerText || n.textContent);
    const byValue = (n) =>
      normalizeChoice(n.getAttribute('data-value') || n.getAttribute('data-option-value'));
    return (
      nodes.find((n) => byValue(n) === t || byText(n) === t) ||
      nodes.find((n) => byText(n).includes(t) || (byValue(n) && byValue(n).includes(t))) ||
      null
    );
  }

  // Custom dropdowns (Radix / Shadcn / headless-ui): open the popup, click the
  // best-matching rendered option if present, otherwise set the visible label.
  // Synthetic click + input + change events keep React/Vue state in sync.
  function setComboboxValue(trigger, target) {
    const strTarget = target == null ? '' : String(target);
    try {
      trigger.focus();
    } catch {
      /* noop */
    }
    // Typable combobox (input or editable): type into it.
    const tag = trigger.tagName.toLowerCase();
    if (tag === 'input' || trigger.isContentEditable) {
      clickNode(trigger);
      setTextValue(trigger, strTarget);
      return true;
    }
    // Open the popup, then click the best match if options are rendered.
    clickNode(trigger);
    const option = findRenderedOption(trigger, strTarget);
    if (option) {
      clickNode(option);
    } else if (strTarget) {
      // No rendered options (virtualized / lazy popup): set visible label text
      // so the requested choice is at least displayed and announced.
      const labelNode =
        trigger.querySelector('[data-slot="select-value"], [data-radix-select-value], span') ||
        trigger;
      try {
        labelNode.textContent = strTarget;
      } catch {
        /* noop */
      }
    }
    trigger.dispatchEvent(new Event('input', { bubbles: true }));
    trigger.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function setTextValue(field, strValue) {
    const tag = field.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') {
      // Generic fallback: set text and notify.
      try {
        field.textContent = strValue;
      } catch {
        /* noop */
      }
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return;
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

  function setFieldValue(field, value) {
    const strValue = value == null ? '' : String(value);
    const tag = field.tagName.toLowerCase();
    // 1. Native dropdowns.
    if (tag === 'select') return setSelectValue(field, strValue);
    // 2. Custom dropdown triggers.
    if (fieldKind(field) === 'combobox') return setComboboxValue(field, strValue);
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
    setTextValue(field, strValue);
    return true;
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
      const applied = setFieldValue(field, fillText);
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
    const fields = [];
    const elementByUid = new Map();
    let index = 0;

    for (const el of candidates) {
      if (!isFillable(el) || !isVisible(el)) continue;
      // Skip fields that already have a non-empty value? No — overwrite is expected for demo,
      // but skip hidden honeypot traps (display-friendly but off-screen).
      try {
        const rect = el.getBoundingClientRect();
        if (rect.top < -2000 || rect.left < -2000) continue; // honeypot / off-screen trap
      } catch {
        continue;
      }
      const uid = `f${index++}`;
      if (index > MAX_BATCH_FIELDS) break;
      el.setAttribute('data-aiff-uid', uid);
      const ctx = extractContext(el);
      fields.push({ uid, ...ctx, currentValue: (ctx.currentValue || '').slice(0, 200) });
      elementByUid.set(uid, el);
    }
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
      for (const [uid, text] of Object.entries(values)) {
        const el = elementByUid.get(uid);
        if (!el || !el.isConnected) continue;
        if (typeof text !== 'string' || text === '') continue;
        try {
          setFieldValue(el, text);
          filled += 1;
        } catch {
          /* skip failing field, continue with the rest */
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
      if (filled === 0) {
        setFillAllState('error', '⚠️ Nothing filled');
        alert('The model returned no usable values for the detected fields.');
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
