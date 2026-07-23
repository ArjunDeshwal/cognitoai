const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    selectFile: () => ipcRenderer.invoke('dialog:openFile'),
    getBackendConfig: () => ipcRenderer.invoke('backend:getConfig')
});
