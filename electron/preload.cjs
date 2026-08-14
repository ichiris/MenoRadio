const { contextBridge, ipcRenderer } = require('electron')

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload)

contextBridge.exposeInMainWorld('menoradio', {
  window: {
    minimize: () => invoke('window:minimize'),
    maximize: () => invoke('window:maximize'),
    close: () => invoke('window:close'),
    isMaximized: () => invoke('window:is-maximized'),
    setFullScreen: (value) => invoke('window:set-fullscreen', Boolean(value)),
    isFullScreen: () => invoke('window:is-fullscreen'),
    onMaximized: (callback) => {
      const listener = (_event, value) => callback(value)
      ipcRenderer.on('window:maximized', listener)
      return () => ipcRenderer.removeListener('window:maximized', listener)
    },
    onFullScreen: (callback) => {
      const listener = (_event, value) => callback(value)
      ipcRenderer.on('window:fullscreen', listener)
      return () => ipcRenderer.removeListener('window:fullscreen', listener)
    },
  },
  auth: {
    state: () => invoke('auth:state'),
    createQr: () => invoke('auth:create-qr'),
    checkQr: (key) => invoke('auth:check-qr', key),
    loginPassword: (account, password) => invoke('auth:login-password', { account, password }),
    importCookie: (cookie) => invoke('auth:import-cookie', cookie),
    logout: () => invoke('auth:logout'),
  },
  data: {
    home: () => invoke('data:home'),
    userPlaylists: (uid) => invoke('data:user-playlists', uid),
    userDetail: (uid) => invoke('data:user-detail', uid),
    playlist: (id) => invoke('data:playlist', id),
    search: (keywords, type = 1, offset = 0) => invoke('data:search', { keywords, type, offset }),
    lyrics: (id) => invoke('data:lyrics', id),
    songUrl: (id, level = 'best') => invoke('data:song-url', { id, level }),
    personalFm: () => invoke('data:personal-fm'),
    daily: () => invoke('data:daily'),
    like: (id, like = true) => invoke('data:like', { id, like }),
    likeList: (uid) => invoke('data:like-list', uid),
    playlistSubscribe: (id, subscribe = true) => invoke('data:playlist-subscribe', { id, subscribe }),
    playlistCreate: (name) => invoke('data:playlist-create', { name }),
    playlistUpdate: (id, name, description, tags = []) => invoke('data:playlist-update', { id, name, description, tags }),
    playlistDelete: (id) => invoke('data:playlist-delete', { id }),
    playlistTrack: (op, pid, trackId) => invoke('data:playlist-track', { op, pid, trackId }),
    playlistReorder: (pid, trackIds) => invoke('data:playlist-reorder', { pid, trackIds }),
  },
  app: {
    version: () => invoke('app:version'),
    cacheSize: () => invoke('app:cache-size'),
    clearCache: () => invoke('app:clear-cache'),
    reset: () => invoke('app:reset'),
    fonts: () => invoke('app:list-fonts'),
    setNetworkRateLimit: (megabytesPerSecond) => invoke('app:set-network-rate-limit', megabytesPerSecond),
    openExternal: (url) => invoke('app:open-external', url),
  },
  images: {
    thumbnail: (url, forceRefresh = false) => invoke('image:thumbnail', { url, forceRefresh }),
  },
  media: {
    preloadNext: (key, urls) => invoke('media:preload-next', { key, urls }),
    cancelPreload: (exceptKey = '') => invoke('media:cancel-preload', exceptKey),
    setPlaybackRateLimit: (bytesPerSecond = 0) => invoke('media:set-playback-rate-limit', bytesPerSecond),
  },
  floatingLyrics: {
    state: () => invoke('floating-lyrics:state'),
    configure: (patch) => invoke('floating-lyrics:configure', patch),
    update: (payload) => invoke('floating-lyrics:update', payload),
    reset: () => invoke('floating-lyrics:reset'),
    onStateChanged: (callback) => {
      const listener = (_event, value) => callback(value)
      ipcRenderer.on('floating-lyrics:state-changed', listener)
      return () => ipcRenderer.removeListener('floating-lyrics:state-changed', listener)
    },
  },
})
