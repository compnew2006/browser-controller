export function bindVaultOpenButton(addLog) {
  document.getElementById('openVault').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'openVault' }, (response) => {
      if (chrome.runtime.lastError || response?.success !== true) addLog('Credential vault is unavailable', 'err');
      else addLog('Opened the private credential vault', 'ok');
    });
  });
}
