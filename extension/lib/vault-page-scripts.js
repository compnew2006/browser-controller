/**
 * The functions chrome.scripting serializes into a page's isolated world for a vault inspect or
 * fill. Each one is self-contained: nothing from this module's scope reaches the page.
 */

/**
 * Runs in one document's isolated world and retains only the element identity. With
 * `withIdentifier` (specs/006 FR-012) it also keeps the username field before the password, and
 * on a page with no password field it may keep a lone username field: a first sign-in step.
 */
export function inspectPasswordField(nonce, deadline, withIdentifier = false) {
  // Chrome serializes only this function when using chrome.scripting. Keep all
  // page-side helpers nested so no extension module scope is required.
  const collect = (root, fields = []) => {
    for (const field of root.querySelectorAll?.('input[type="password"]') ?? []) if (!fields.includes(field)) fields.push(field);
    for (const element of root.querySelectorAll?.('*') ?? []) if (element.shadowRoot) collect(element.shadowRoot, fields);
    return fields;
  };
  const visible = (field) => {
    if (!(field instanceof HTMLInputElement) || field.type.toLowerCase() !== 'password'
      || field.disabled || field.readOnly || !field.isConnected || field.ownerDocument !== document) return false;
    const autocomplete = String(field.autocomplete || field.getAttribute('autocomplete') || '').trim().toLowerCase().split(/\s+/);
    if (autocomplete.includes('new-password')) return false;
    const fieldContext = [
      field.name || field.getAttribute('name'), field.id || field.getAttribute('id'),
      field.placeholder || field.getAttribute('placeholder'), field.getAttribute('aria-label'),
      ...(field.labels ? [...field.labels].map((label) => label.textContent || '') : []),
      field.form?.name, field.form?.id, field.form?.getAttribute?.('autocomplete'),
    ].filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[_-]+/g, ' ');
    const submitIntent = [...(field.form?.querySelectorAll?.('button, input[type="submit"], input[type="button"]') ?? [])]
      .map((control) => control.innerText || control.textContent || control.value || control.getAttribute?.('aria-label') || '')
      .join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[_-]+/g, ' ');
    const passwordChange = /\b(?:new|confirm(?:ation)?|repeat|reset|register|signup|sign\s+up|create|change|update)\s+(?:your\s+)?password\b|\bpassword\s+(?:reset|confirmation|confirm|again)\b/;
    const accountCreation = /\b(?:register|sign\s+up|create\s+(?:an?\s+)?account|reset\s+password|change\s+password|update\s+password)\b/;
    if (passwordChange.test(fieldContext) || accountCreation.test(submitIntent)) return false;
    const style = getComputedStyle(field);
    const rect = field.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
      && rect.width > 0 && rect.height > 0 && field.getClientRects().length > 0;
  };
  // One slot per nonce: parallel vault calls on one tab must not replace each other's inspection.
  const keep = (inspection) => {
    const saved = globalThis.__bcVaultInspections instanceof Map ? globalThis.__bcVaultInspections : new Map();
    saved.set(nonce, inspection);
    while (saved.size > 4) saved.delete(saved.keys().next().value);
    globalThis.__bcVaultInspections = saved;
  };
  const candidates = collect(document).filter(visible);
  if (Date.now() > deadline) return { suitable: false, candidateCount: 0, documentOrigin: location.origin };
  if (!withIdentifier) {
    if (candidates.length !== 1) return { suitable: false, candidateCount: candidates.length, documentOrigin: location.origin };
    keep({ nonce, field: candidates[0] });
    return { suitable: true, candidateCount: 1, documentOrigin: location.origin };
  }
  const normalize = (parts) => parts.filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[_-]+/g, ' ');
  const inputsIn = (root, inputs = []) => {
    for (const input of root.querySelectorAll?.('input') ?? []) if (!inputs.includes(input)) inputs.push(input);
    for (const element of root.querySelectorAll?.('*') ?? []) if (element.shadowRoot) inputsIn(element.shadowRoot, inputs);
    return inputs;
  };
  const editableText = (field) => {
    if (!(field instanceof HTMLInputElement) || !['', 'text', 'email', 'tel'].includes(String(field.type || '').toLowerCase())
      || field.disabled || field.readOnly || !field.isConnected || field.ownerDocument !== document) return false;
    const style = getComputedStyle(field);
    const rect = field.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
      && rect.width > 0 && rect.height > 0 && field.getClientRects().length > 0;
  };
  const autocompleteOf = (field) => String(field.autocomplete || field.getAttribute('autocomplete') || '').trim().toLowerCase().split(/\s+/);
  const wordsOf = (field) => normalize([
    field.name || field.getAttribute('name'), field.id || field.getAttribute('id'),
    field.placeholder || field.getAttribute('placeholder'), field.getAttribute('aria-label'),
    ...(field.labels ? [...field.labels].map((label) => label.textContent || '') : []),
  ]);
  const loginWords = /\b(?:user\s*name|user|login|log\s*in|sign\s*in|e\s*mail|email|account|identifier|phone|mobile)\b|اسم المستخدم|البريد|الإيميل|الهاتف|الجوال|الموبايل|تسجيل الدخول|الحساب/;
  const otherWords = /\b(?:search|query|coupon|promo|captcha|otp|one time|verification|code|zip|postal|city|address|first name|last name|full name|subscribe|newsletter)\b|بحث|كود|رمز التحقق|اشتراك/;
  const namesSomethingElse = (field) => autocompleteOf(field).includes('one-time-code') || otherWords.test(wordsOf(field));
  const identifierLike = (field) => {
    const autocomplete = autocompleteOf(field);
    if (autocomplete.includes('username') || autocomplete.includes('email')) return true;
    if (namesSomethingElse(field)) return false;
    return String(field.type || '').toLowerCase() === 'email' || loginWords.test(wordsOf(field));
  };
  if (candidates.length === 1) {
    // The username of a classic form: the one identifier-like text field before the password in the
    // same form, else the only text field of that <form> when it names nothing else. Several
    // identifier-like fields are ambiguous, so the password is filled alone (specs/006 US4).
    const password = candidates[0];
    const scope = password.form ?? (typeof password.getRootNode === 'function' ? password.getRootNode() : document);
    const before = typeof password.compareDocumentPosition === 'function'
      ? inputsIn(scope).filter((field) => field !== password && (field.form ?? null) === (password.form ?? null) && editableText(field)
        && (password.compareDocumentPosition(field) & 2) !== 0)
      : [];
    const likely = before.filter(identifierLike);
    const identifier = likely.length === 1 ? likely[0]
      : likely.length === 0 && password.form && before.length === 1 && !namesSomethingElse(before[0]) ? before[0] : undefined;
    keep({ nonce, field: password, ...(identifier ? { identifier } : {}) });
    return { suitable: true, candidateCount: 1, identifierField: !!identifier, documentOrigin: location.origin };
  }
  if (candidates.length > 0) return { suitable: false, candidateCount: candidates.length, documentOrigin: location.origin };
  // A first sign-in step: one username field and something that says this is a sign-in.
  const identifiers = inputsIn(document).filter((field) => editableText(field) && identifierLike(field));
  if (identifiers.length !== 1) return { suitable: false, candidateCount: 0, identifierCount: identifiers.length, documentOrigin: location.origin };
  const field = identifiers[0];
  const submitText = normalize([...(field.form?.querySelectorAll?.('button, input[type="submit"]') ?? [])]
    .map((control) => control.innerText || control.textContent || control.value || control.getAttribute?.('aria-label') || ''));
  const signInStep = autocompleteOf(field).includes('username')
    || /\b(?:next|continue|sign\s*in|log\s*in|login)\b|التالي|متابعة|استمرار|تسجيل الدخول|دخول/.test(submitText)
    || /(?:^|[/._-])(?:login|log-?in|sign-?in|signin|auth|account|accounts|sso)(?:$|[/._-])/i.test(String(location.pathname || ''));
  if (!signInStep) return { suitable: false, candidateCount: 0, identifierCount: 0, documentOrigin: location.origin };
  keep({ nonce, field: null, identifier: field, mode: 'identifier' });
  return { suitable: false, candidateCount: 0, identifierCount: 1, documentOrigin: location.origin };
}

export function clearPasswordInspection(nonce) {
  if (globalThis.__bcVaultInspections instanceof Map) globalThis.__bcVaultInspections.delete(nonce);
  return true;
}

/**
 * Runs once in the same isolated document and never submits the surrounding form. With `identifier`
 * it writes the inspected username field too (before the password), or only that field on a first
 * sign-in step; `password` is null then.
 */
export function fillInspectedPassword(nonce, password, expectedOrigin, deadline, identifier = null) {
  if (location.origin !== expectedOrigin) return { success: false, code: 'VAULT_ORIGIN_MISMATCH' };
  if (Date.now() > deadline) return { success: false, code: 'VAULT_PERMISSION_DENIED' };
  const writable = (field) => {
    if (!(field instanceof HTMLInputElement) || !['', 'text', 'email', 'tel'].includes(String(field.type || '').toLowerCase())
      || field.disabled || field.readOnly || !field.isConnected || field.ownerDocument !== document) return false;
    const style = getComputedStyle(field);
    const rect = field.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
      && rect.width > 0 && rect.height > 0 && field.getClientRects().length > 0;
  };
  const write = (field, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return field.value === value;
  };
  const collect = (root, fields = []) => {
    for (const field of root.querySelectorAll?.('input[type="password"]') ?? []) if (!fields.includes(field)) fields.push(field);
    for (const element of root.querySelectorAll?.('*') ?? []) if (element.shadowRoot) collect(element.shadowRoot, fields);
    return fields;
  };
  const visible = (field) => {
    if (!(field instanceof HTMLInputElement) || field.type.toLowerCase() !== 'password'
      || field.disabled || field.readOnly || !field.isConnected || field.ownerDocument !== document) return false;
    const autocomplete = String(field.autocomplete || field.getAttribute('autocomplete') || '').trim().toLowerCase().split(/\s+/);
    if (autocomplete.includes('new-password')) return false;
    const context = [
      field.name || field.getAttribute('name'), field.id || field.getAttribute('id'),
      field.placeholder || field.getAttribute('placeholder'), field.getAttribute('aria-label'),
      ...(field.labels ? [...field.labels].map((label) => label.textContent || '') : []),
      field.form?.name, field.form?.id, field.form?.getAttribute?.('autocomplete'),
      field.form?.innerText, field.form?.textContent,
    ].filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[_-]+/g, ' ');
    if (/\b(?:new|confirm(?:ation)?|repeat|reset|register|signup|sign\s+up|create|change|update)\s+(?:your\s+)?password\b|\bpassword\s+(?:reset|confirmation|confirm|again)\b/.test(context)) return false;
    const style = getComputedStyle(field);
    const rect = field.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
      && rect.width > 0 && rect.height > 0 && field.getClientRects().length > 0;
  };
  const inspections = globalThis.__bcVaultInspections instanceof Map ? globalThis.__bcVaultInspections : null;
  const saved = inspections?.get(nonce);
  if (saved?.mode === 'identifier') {
    // A first sign-in step: the username only. A password field appearing since means the page moved on.
    if (saved.nonce !== nonce || typeof identifier !== 'string' || password !== null || !writable(saved.identifier)) {
      return { success: false, code: 'VAULT_DOCUMENT_CHANGED' };
    }
    if (collect(document).some(visible)) return { success: false, code: 'VAULT_DOCUMENT_CHANGED' };
    if (Date.now() > deadline || location.origin !== expectedOrigin) return { success: false, code: 'VAULT_PERMISSION_DENIED' };
    inspections.delete(nonce);
    const retained = write(saved.identifier, identifier);
    return { success: retained, retained, filled_fields: 1, identifier_filled: retained };
  }
  if (!saved || saved.nonce !== nonce || !saved.field || !saved.field.isConnected
    || saved.field.ownerDocument !== document || !visible(saved.field) || typeof password !== 'string') {
    return { success: false, code: 'VAULT_DOCUMENT_CHANGED' };
  }
  const candidates = collect(document).filter(visible);
  if (candidates.length !== 1 || candidates[0] !== saved.field) return { success: false, code: 'VAULT_TARGET_UNSAFE' };
  if (Date.now() > deadline || location.origin !== expectedOrigin) return { success: false, code: 'VAULT_PERMISSION_DENIED' };
  const field = saved.field;
  inspections.delete(nonce);
  if (!Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set) return { success: false, code: 'VAULT_TARGET_UNSAFE' };
  // The username goes first: some pages reveal or reset the password field on username input.
  const identifierFilled = typeof identifier === 'string' && !!saved.identifier
    && (saved.identifier.form ?? null) === (field.form ?? null) && writable(saved.identifier) && write(saved.identifier, identifier);
  // The page's input handlers ran during that write: the password still goes only into the one field inspected.
  if (identifierFilled) {
    const now = collect(document).filter(visible);
    if (now.length !== 1 || now[0] !== field) return { success: false, code: 'VAULT_DOCUMENT_CHANGED' };
  }
  const retained = write(field, password);
  return {
    success: retained, retained, filled_fields: identifierFilled ? 2 : 1,
    ...(typeof identifier === 'string' ? { identifier_filled: identifierFilled } : {}),
  };
}
