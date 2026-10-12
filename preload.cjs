const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  loadDatabase: () => ipcRenderer.invoke('load-database'),
  saveDeckNames: (deckNames) => ipcRenderer.invoke('save-deck-names', deckNames),
  saveCardTemplate: (template, imageBuffer) => ipcRenderer.invoke('save-card-template', template, imageBuffer),
  deleteCardTemplate: (id) => ipcRenderer.invoke('delete-card-template', id),
  saveCardBack: (id, imageBuffer) => ipcRenderer.invoke('save-card-back', id, imageBuffer),
  deleteCardBack: (id) => ipcRenderer.invoke('delete-card-back', id),
  saveBoardState: (cards, counters, nextZIndex) => ipcRenderer.invoke('save-board-state', cards, counters, nextZIndex)
});
