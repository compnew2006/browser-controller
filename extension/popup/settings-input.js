export function bindDebouncedInput(element, delayMs, onChange) {
  let timer = null;
  element.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, delayMs);
  });
}

export function bindBooleanSetting(element, key, onChange = () => {}) {
  chrome.storage.local.get(key, (stored) => {
    element.checked = stored?.[key] === true;
  });
  element.addEventListener('change', () => {
    const enabled = element.checked;
    chrome.storage.local.set({ [key]: enabled });
    onChange(enabled);
  });
}
