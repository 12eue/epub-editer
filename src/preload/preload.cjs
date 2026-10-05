'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studio', {
  openEpubDialog: () => ipcRenderer.invoke('dialog:open-epub'),
  readEpub: (filePath) => ipcRenderer.invoke('file:read-epub', filePath),
  saveEpub: (data, currentPath, saveCopy = false) => ipcRenderer.invoke('dialog:save-epub', { data, currentPath, saveCopy }),
  saveText: (content, defaultName, filters) => ipcRenderer.invoke('dialog:save-text', { content, defaultName, filters }),
  openTextFiles: (filters, multiple = true) => ipcRenderer.invoke('dialog:open-text', { filters, multiple }),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  removeRecent: (filePath) => ipcRenderer.invoke('settings:remove-recent', filePath),
  clearRecent: () => ipcRenderer.invoke('settings:clear-recent'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  print: () => ipcRenderer.invoke('print:preview'),
  exportPdf: () => ipcRenderer.invoke('print:pdf'),
  onCommand: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:command', listener);
    return () => ipcRenderer.removeListener('app:command', listener);
  },
});
