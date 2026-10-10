/**
 * Pure rendering for the popup's Open Tabs panel: strings in, strings out — no
 * DOM, no chrome.* — so it is unit-tested in Node (tests/popup-open-tabs.test.ts).
 * popup.js owns the DOM: it rebuilds the rows only when openTabsSignature()
 * changes and patches the running/idle control badges in place otherwise.
 */

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** The daemon-roster entry for a sessionId (undefined when it isn't listed). */
export function agentFor(agents, sessionId) {
  return (agents || []).find((a) => a && a.sessionId === sessionId);
}

/**
 * Human label for a sessionId ("name · id"). Falls back to `fallbackName`
 * (e.g. the name the agent sent with its call) when the roster doesn't list
 * the session, then to the bare id.
 */
export function agentLabelFor(agents, sessionId, fallbackName = null) {
  const a = agentFor(agents, sessionId);
  const name = a ? a.name || 'agent' : fallbackName;
  if (!sessionId) return name || 'agent';
  return name ? `${name} · ${sessionId}` : sessionId;
}

/**
 * Badge for a tab an agent is driving without a lock: filled dot while a call
 * runs, hollow during the short linger after it (between calls). Short name in
 * the row; the tooltip carries the full session id.
 */
export function controlBadgeParts(ctrl, agents) {
  const name = agentFor(agents, ctrl.sessionId)?.name || ctrl.agentName || 'agent';
  const who = agentLabelFor(agents, ctrl.sessionId, ctrl.agentName);
  const state = ctrl.active ? 'running a call now' : 'acted on it moments ago';
  return {
    idle: !ctrl.active,
    text: `${ctrl.active ? '●' : '○'} ${name}`,
    title: `Controlled by ${who} (${state}). Not pinned: 📌 locks it to this agent.`,
  };
}

/**
 * Everything that changes the rows' STRUCTURE. The running/idle flag of a
 * controlled tab is deliberately left out: it flips on every agent call, and a
 * rebuild would drop keyboard focus and the user's pending Pin choice — the
 * badge is patched in place instead (controlBadgeParts).
 */
export function openTabsSignature(tabs, agents) {
  return JSON.stringify({
    tabs: tabs.map((t) => [
      t.id, t.title, t.url, t.active, t.lockedBy || null, !!t.otherWindow,
      t.controlledBy ? [t.controlledBy.sessionId, t.controlledBy.agentName] : null,
    ]),
    agents: (agents || []).filter(Boolean).map((a) => [a.sessionId, a.name]),
  });
}

/**
 * The rows' HTML. `picks` (Map tabId → sessionId, '' = none) holds Pin choices
 * the user made but hasn't applied: they win over the default selection (the
 * agent controlling the tab), so a rebuild never retargets the 📌 button.
 */
export function renderOpenTabRows(tabs, agents, picks = new Map()) {
  const roster = (agents || []).filter(Boolean);
  return tabs
    .map((t) => {
      const title = escapeHtml(t.title || t.url || `tab ${t.id}`);
      const cls = `tab-title${t.active ? ' active' : ''}${t.otherWindow ? ' other' : ''}`;
      const tip = escapeHtml(t.otherWindow ? `${t.url || ''} (in another window)` : t.url || '');
      if (t.lockedBy) {
        // Locked: show owner + an unpin (✕) button. No dropdown.
        const ownerName = agentLabelFor(roster, t.lockedBy);
        return `<div class="tab-row" data-tab="${t.id}">
          <span class="${cls}" title="${tip}">${title}</span>
          <span class="tab-pin">
            <span class="lock-owner">🔒 ${escapeHtml(ownerName)}</span>
            <button class="icon-btn unpin" data-action="unlockTab" data-tab="${t.id}" title="Unpin this tab">✕</button>
          </span>
        </div>`;
      }
      // Unlocked but an agent is acting on it (no lock taken): show who, and
      // preselect that agent so 📌 turns the control into a real lock.
      const ctrl = t.controlledBy;
      let badge = '';
      if (ctrl) {
        const b = controlBadgeParts(ctrl, roster);
        badge = `<span class="ctrl-owner${b.idle ? ' idle' : ''}" data-ctrl-tab="${t.id}" title="${escapeHtml(b.title)}">${escapeHtml(b.text)}</span>`;
      }
      const chosen = picks.has(t.id) ? picks.get(t.id) : ctrl?.sessionId ?? '';
      // The unique session id is the lock identity. Display names are not
      // unique when multiple clients run from the same IDE.
      const opts = [`<option value="">${ctrl ? '— not pinned —' : '— free —'}</option>`]
        .concat(roster.map((a) => {
          const label = escapeHtml(`${a.name || 'agent'} · ${a.sessionId}`);
          const sel = a.sessionId === chosen ? ' selected' : '';
          return `<option value="${escapeHtml(a.sessionId)}"${sel}>${label}</option>`;
        }))
        .join('');
      return `<div class="tab-row" data-tab="${t.id}">
        <span class="${cls}" title="${tip}">${title}</span>
        <span class="tab-pin">
          ${badge}
          <select data-action="pickAgent" data-tab="${t.id}">${opts}</select>
          <button class="icon-btn" data-action="lockTab" data-tab="${t.id}" title="Pin to selected agent">📌</button>
        </span>
      </div>`;
    })
    .join('');
}
