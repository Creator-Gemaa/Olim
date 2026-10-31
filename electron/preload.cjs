const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vyraDesktop', {
  installUpdate: () => ipcRenderer.send('vyra:install-update')
});

ipcRenderer.on('vyra:desktop-update-ready', () => {
  window.dispatchEvent(new Event('vyra:desktop-update-ready'));
});
ipcRenderer.on('vyra:desktop-update-error', (_event, message) => {
  window.dispatchEvent(new CustomEvent('vyra:desktop-update-error', { detail: String(message || '') }));
});
