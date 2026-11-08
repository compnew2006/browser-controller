export function bindDebouncedInput(element, delayMs, onChange) {
  let timer = null;
  element.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, delayMs);
  });
}
