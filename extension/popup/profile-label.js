import { bindDebouncedInput } from './settings-input.js';

export function updateProfileLabel(state) {
  if (typeof state.browserLabel === 'string' && state.browserLabel) {
    document.getElementById('browserLabelCurrent').textContent = state.browserLabel;
  }
  if (typeof state.browserId === 'string' && state.browserId) {
    document.getElementById('browserId').textContent = state.browserId;
  }
}

export function bindProfileLabel(addLog, refreshStatus) {
  const input = document.getElementById('browserLabel');
  chrome.storage.local.get('bcBrowserLabel', (stored) => {
    input.value = typeof stored.bcBrowserLabel === 'string' ? stored.bcBrowserLabel : '';
  });

  bindDebouncedInput(input, 600, () => {
    chrome.runtime.sendMessage({ type: 'setBrowserLabel', label: input.value }, (response) => {
      if (chrome.runtime.lastError || !response?.success) {
        addLog(response?.error || 'Profile name could not be saved', 'err');
        return;
      }
      document.getElementById('browserLabelCurrent').textContent = response.browserLabel || 'Automatic name unavailable';
      addLog('Profile name saved; reconnecting', 'warn');
      refreshStatus();
    });
  });
}
