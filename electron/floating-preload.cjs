const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('floatingLyrics', {
  state: () => ipcRenderer.invoke('floating-lyrics:state'),
  lock: () => ipcRenderer.invoke('floating-lyrics:lock'),
  beginResize: (direction, x, y) => ipcRenderer.invoke('floating-lyrics:resize-start', { direction, x, y }),
  resize: (x, y) => ipcRenderer.send('floating-lyrics:resize-move', { x, y }),
  endResize: () => ipcRenderer.send('floating-lyrics:resize-end'),
  beginMove: (x, y) => ipcRenderer.invoke('floating-lyrics:move-start', { x, y }),
  move: (x, y) => ipcRenderer.send('floating-lyrics:move-move', { x, y }),
  endMove: () => ipcRenderer.send('floating-lyrics:move-end'),
  onUpdate: (callback) => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('floating-lyrics:update', listener)
    return () => ipcRenderer.removeListener('floating-lyrics:update', listener)
  },
  onConfig: (callback) => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('floating-lyrics:config', listener)
    return () => ipcRenderer.removeListener('floating-lyrics:config', listener)
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    getSettings: (id) => ipcRenderer.invoke('plugins:get-settings', id),
    setSettings: (id, patch) => ipcRenderer.invoke('plugins:set-settings', { id, patch }),
    storage: {
      get: (id, key) => ipcRenderer.invoke('plugins:storage-get', { id, key }),
      set: (id, key, value) => ipcRenderer.invoke('plugins:storage-set', { id, key, value }),
      delete: (id, key) => ipcRenderer.invoke('plugins:storage-delete', { id, key }),
      all: (id) => ipcRenderer.invoke('plugins:storage-all', id),
      clear: (id) => ipcRenderer.invoke('plugins:storage-clear', id),
    },
    invokeBackend: (pluginId, method, payload) => ipcRenderer.invoke('plugins:invoke-backend', { pluginId, method, payload }),
    invokeService: (serviceName, method, payload) => ipcRenderer.invoke('plugins:invoke-service', { serviceName, method, payload }),
    onChanged: (callback) => {
      const listener = (_event, value) => callback(value)
      ipcRenderer.on('plugins:changed', listener)
      return () => ipcRenderer.removeListener('plugins:changed', listener)
    },
    onSettingsChanged: (callback) => {
      const listener = (_event, value) => callback(value)
      ipcRenderer.on('plugins:settings-changed', listener)
      return () => ipcRenderer.removeListener('plugins:settings-changed', listener)
    },
    onBackendEvent: (callback) => {
      const listener = (_event, value) => callback(value)
      ipcRenderer.on('plugins:backend-event', listener)
      return () => ipcRenderer.removeListener('plugins:backend-event', listener)
    },
  },
})
