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
})
