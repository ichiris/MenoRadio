// Main-process Plugin Manager and Backend Extension Runtime for MenoRadio.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { loadManifestFromDir, locatePluginRoot, findManifestFile } = require('./plugin-manifest.cjs')
const { extractZipArchive } = require('./plugin-archive.cjs')

const REGISTRY_VERSION = 1
const MAX_LOGS_PER_PLUGIN = 80

const MIME_TYPES = Object.freeze({
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.lrc': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
})

function safeFolderId(id) {
  return String(id || '').replace(/[^a-z0-9._-]/gi, '_')
}

function copyDirectorySync(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true })
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue
    const src = path.join(sourceDir, entry.name)
    const dst = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      copyDirectorySync(src, dst)
    } else if (entry.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(src)
      fs.symlinkSync(linkTarget, dst)
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst)
    }
  }
}

function isPathInside(parentDir, candidatePath) {
  const parent = path.resolve(parentDir)
  const candidate = path.resolve(candidatePath)
  const rel = path.relative(parent, candidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function formatError(error) {
  if (!error) return { message: '未知错误', stack: '' }
  if (typeof error === 'string') return { message: error, stack: '' }
  return {
    message: String(error.message || error).slice(0, 500),
    stack: String(error.stack || '').slice(0, 4000),
  }
}

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonSafe(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
}

function createPluginManager(options = {}) {
  const appVersion = String(options.appVersion || '0.0.0')
  const userDataDir = path.resolve(options.userDataDir || path.join(os.tmpdir(), 'menoradio-plugins'))
  const pluginsDir = path.resolve(options.pluginsDir || path.join(userDataDir, 'plugins'))
  const pluginDataDir = path.resolve(options.pluginDataDir || path.join(userDataDir, 'plugin-data'))
  const registryPath = path.resolve(options.registryPath || path.join(userDataDir, 'plugins-registry.json'))
  const protocolScheme = String(options.protocolScheme || 'menoradio-plugin')
  const host = options.host || {}

  // Plugin records keyed by plugin id.
  const records = new Map()
  // Active backend runtimes keyed by plugin id.
  const activeBackends = new Map()
  // Renderer-reported runtime states keyed by plugin id.
  const rendererStates = new Map()
  // Diagnostics logs keyed by plugin id.
  const pluginLogs = new Map()

  // Extensibility registries (all auto-cleaned via disposables on plugin deactivate).
  const ipcInterceptors = new Map() // channel -> Array<{ pluginId, priority, handler }>
  const pluginIpcHandlers = new Map() // `${pluginId}:${method}` -> handler
  const hookListeners = new Map() // hookName -> Array<{ pluginId, priority, handler }>
  const eventListeners = new Map() // eventName -> Set<{ pluginId, handler }>
  const allowedMediaHosts = new Set() // { pluginId, matcher }
  const streamProviders = [] // { pluginId, priority, matcher, handler }
  const thumbnailProviders = [] // { pluginId, priority, matcher, handler }
  const protocolRoutes = new Map() // pluginId -> Array<{ prefix, handler }>
  const services = new Map() // serviceName -> { pluginId, implementation }
  const settingsWatchers = new Map() // pluginId -> Set<fn>

  let registry = { version: REGISTRY_VERSION, plugins: {} }

  function ensureDirectories() {
    fs.mkdirSync(pluginsDir, { recursive: true })
    fs.mkdirSync(pluginDataDir, { recursive: true })
  }

  function loadRegistry() {
    const saved = readJsonSafe(registryPath, null)
    if (saved && typeof saved === 'object' && saved.plugins && typeof saved.plugins === 'object') {
      registry = { version: REGISTRY_VERSION, plugins: { ...saved.plugins } }
    } else {
      registry = { version: REGISTRY_VERSION, plugins: {} }
    }
    return registry
  }

  function saveRegistry() {
    writeJsonSafe(registryPath, registry)
  }

  function pushLog(pluginId, level, source, message, stack = '') {
    let list = pluginLogs.get(pluginId)
    if (!list) {
      list = []
      pluginLogs.set(pluginId, list)
    }
    list.push({
      timestamp: Date.now(),
      level,
      source,
      message: String(message || '').slice(0, 600),
      stack: String(stack || '').slice(0, 2000),
    })
    if (list.length > MAX_LOGS_PER_PLUGIN) list.splice(0, list.length - MAX_LOGS_PER_PLUGIN)
  }

  function pluginDataFolder(pluginId) {
    return path.join(pluginDataDir, safeFolderId(pluginId))
  }

  function settingsFilePath(pluginId) {
    return path.join(pluginDataFolder(pluginId), 'settings.json')
  }

  function storageFilePath(pluginId) {
    return path.join(pluginDataFolder(pluginId), 'storage.json')
  }

  function defaultSettingsFor(manifest) {
    const defaults = {}
    for (const item of manifest?.contributes?.settings || []) {
      defaults[item.key] = item.default
    }
    return defaults
  }

  function getPluginSettings(pluginId) {
    const record = records.get(pluginId)
    const defaults = defaultSettingsFor(record?.manifest)
    const saved = readJsonSafe(settingsFilePath(pluginId), {})
    return { ...defaults, ...(saved && typeof saved === 'object' ? saved : {}) }
  }

  function setPluginSettings(pluginId, patch = {}) {
    if (!records.has(pluginId)) throw new Error(`未找到插件：${pluginId}`)
    const current = getPluginSettings(pluginId)
    const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) }
    writeJsonSafe(settingsFilePath(pluginId), next)
    const watchers = settingsWatchers.get(pluginId)
    if (watchers) {
      for (const listener of watchers) {
        try { listener(next, patch) } catch (error) {
          pushLog(pluginId, 'error', 'backend', `settings onChange 异常: ${error?.message || error}`, error?.stack)
        }
      }
    }
    broadcast('plugins:settings-changed', { pluginId, settings: next, patch })
    return next
  }

  function readStorage(pluginId) {
    const data = readJsonSafe(storageFilePath(pluginId), {})
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  }

  function getPluginStorageValue(pluginId, key, defaultValue = undefined) {
    const store = readStorage(pluginId)
    return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : defaultValue
  }

  function setPluginStorageValue(pluginId, key, value) {
    const store = readStorage(pluginId)
    store[String(key)] = value
    writeJsonSafe(storageFilePath(pluginId), store)
    return true
  }

  function deletePluginStorageValue(pluginId, key) {
    const store = readStorage(pluginId)
    delete store[String(key)]
    writeJsonSafe(storageFilePath(pluginId), store)
    return true
  }

  function clearPluginStorage(pluginId) {
    writeJsonSafe(storageFilePath(pluginId), {})
    return true
  }

  function broadcast(channel, payload) {
    try {
      host.onBroadcast?.(channel, payload)
    } catch {}
  }

  function broadcastChanged(reason = 'updated', pluginId = '') {
    broadcast('plugins:changed', {
      reason,
      pluginId,
      plugins: listPlugins(),
    })
  }

  function pluginBaseUrl(pluginId) {
    return `${protocolScheme}://${encodeURIComponent(pluginId)}/`
  }

  function pluginAssetUrl(pluginId, relPath, revision = 1) {
    if (!relPath) return ''
    const clean = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '')
    return `${pluginBaseUrl(pluginId)}${clean}?rev=${revision}`
  }

  function buildPluginDescriptor(record) {
    const manifest = record.manifest
    const backend = activeBackends.get(record.id)
    const renderer = rendererStates.get(record.id)
    const regEntry = registry.plugins[record.id] || {}
    const rev = record.revision || 1
    const backendError = record.backendError || null
    const rendererError = renderer?.error || null
    const combinedError = backendError || rendererError || record.manifestError || null

    let status = 'disabled'
    if (record.missing) status = 'missing'
    else if (record.manifestError) status = 'error'
    else if (record.enabled) {
      if (combinedError) status = 'error'
      else status = 'active'
    } else if (manifest && !manifest.compatibility.compatible) {
      status = 'incompatible'
    }

    return {
      id: record.id,
      name: manifest?.name || record.id,
      author: manifest?.author || '未知作者',
      authorUrl: manifest?.authorUrl || '',
      authorEmail: manifest?.authorEmail || '',
      description: manifest?.description || '',
      version: manifest?.version || '0.0.0',
      supportedVersions: manifest?.supportedVersions || '*',
      compatibility: manifest?.compatibility || {
        status: 'incompatible',
        compatible: false,
        range: '*',
        appVersion,
      },
      homepage: manifest?.homepage || '',
      license: manifest?.license || '',
      keywords: manifest?.keywords || [],
      capabilities: manifest?.capabilities || [],
      source: record.source, // 'installed' | 'linked'
      dir: record.dir,
      enabled: Boolean(record.enabled),
      forceCompatible: Boolean(regEntry.forceCompatible),
      revision: rev,
      status,
      missing: Boolean(record.missing),
      hasMain: Boolean(manifest?.main),
      hasRenderer: Boolean(manifest?.renderer),
      hasFloatingLyrics: Boolean(manifest?.floatingLyrics),
      hasStyles: Boolean(manifest?.styles?.length),
      hasFloatingStyles: Boolean(manifest?.floatingStyles?.length),
      iconUrl: manifest?.icon ? pluginAssetUrl(record.id, manifest.icon, rev) : '',
      rendererUrl: manifest?.renderer ? pluginAssetUrl(record.id, manifest.renderer, rev) : '',
      floatingLyricsUrl: manifest?.floatingLyrics ? pluginAssetUrl(record.id, manifest.floatingLyrics, rev) : '',
      styleUrls: (manifest?.styles || []).map((rel) => pluginAssetUrl(record.id, rel, rev)),
      floatingStyleUrls: (manifest?.floatingStyles || []).map((rel) => pluginAssetUrl(record.id, rel, rev)),
      contributes: manifest ? {
        themes: (manifest.contributes.themes || []).map((theme) => ({
          ...theme,
          cssUrl: theme.css ? pluginAssetUrl(record.id, theme.css, rev) : '',
        })),
        locales: manifest.contributes.locales || {},
        settings: manifest.contributes.settings || [],
      } : { themes: [], locales: {}, settings: [] },
      settings: manifest ? getPluginSettings(record.id) : {},
      backendActive: Boolean(backend),
      rendererActive: Boolean(renderer?.active),
      backendError,
      rendererError,
      error: combinedError,
      logs: (pluginLogs.get(record.id) || []).slice(-30),
      installedAt: regEntry.installedAt || 0,
      updatedAt: regEntry.updatedAt || 0,
    }
  }

  function listPlugins() {
    return [...records.values()]
      .sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
        return String(a.manifest?.name || a.id).localeCompare(String(b.manifest?.name || b.id))
      })
      .map(buildPluginDescriptor)
  }

  function getPlugin(pluginId) {
    const record = records.get(pluginId)
    return record ? buildPluginDescriptor(record) : null
  }

  function clearPluginRequireCache(pluginDir) {
    const root = path.resolve(pluginDir)
    for (const cacheKey of Object.keys(require.cache)) {
      if (isPathInside(root, cacheKey)) {
        delete require.cache[cacheKey]
      }
    }
  }

  function createBackendContext(record) {
    const pluginId = record.id
    const disposables = []
    const track = (dispose) => {
      if (typeof dispose === 'function') disposables.push(dispose)
      return dispose
    }

    const addInterceptor = (channel, handler, priority = 0) => {
      if (typeof handler !== 'function') throw new TypeError('IPC interceptor must be a function')
      let list = ipcInterceptors.get(channel)
      if (!list) {
        list = []
        ipcInterceptors.set(channel, list)
      }
      const entry = { pluginId, priority: Number(priority) || 0, handler }
      list.push(entry)
      list.sort((a, b) => b.priority - a.priority)
      return track(() => {
        const current = ipcInterceptors.get(channel)
        if (!current) return
        const index = current.indexOf(entry)
        if (index >= 0) current.splice(index, 1)
        if (!current.length) ipcInterceptors.delete(channel)
      })
    }

    const addHook = (hookName, handler, priority = 0) => {
      if (typeof handler !== 'function') throw new TypeError('Hook handler must be a function')
      let list = hookListeners.get(hookName)
      if (!list) {
        list = []
        hookListeners.set(hookName, list)
      }
      const entry = { pluginId, priority: Number(priority) || 0, handler }
      list.push(entry)
      list.sort((a, b) => b.priority - a.priority)
      return track(() => {
        const current = hookListeners.get(hookName)
        if (!current) return
        const index = current.indexOf(entry)
        if (index >= 0) current.splice(index, 1)
        if (!current.length) hookListeners.delete(hookName)
      })
    }

    const addEvent = (eventName, handler) => {
      if (typeof handler !== 'function') throw new TypeError('Event handler must be a function')
      let set = eventListeners.get(eventName)
      if (!set) {
        set = new Set()
        eventListeners.set(eventName, set)
      }
      const entry = { pluginId, handler }
      set.add(entry)
      return track(() => {
        set.delete(entry)
        if (!set.size) eventListeners.delete(eventName)
      })
    }

    const ctx = {
      id: pluginId,
      manifest: record.manifest,
      dir: record.dir,
      dataDir: pluginDataFolder(pluginId),
      appVersion,
      baseUrl: pluginBaseUrl(pluginId),
      resolvePath: (...segments) => path.resolve(record.dir, ...segments),
      onDispose: (fn) => track(fn),

      logger: {
        info: (msg) => { pushLog(pluginId, 'info', 'backend', msg); console.log(`[plugin:${pluginId}]`, msg) },
        warn: (msg) => { pushLog(pluginId, 'warn', 'backend', msg); console.warn(`[plugin:${pluginId}]`, msg) },
        error: (msg, err) => {
          const formatted = formatError(err || msg)
          pushLog(pluginId, 'error', 'backend', typeof msg === 'string' ? msg : formatted.message, formatted.stack)
          console.error(`[plugin:${pluginId}]`, msg, err || '')
        },
        debug: (msg) => pushLog(pluginId, 'debug', 'backend', msg),
      },

      settings: {
        get: (key) => getPluginSettings(pluginId)[key],
        getAll: () => getPluginSettings(pluginId),
        set: (key, value) => setPluginSettings(pluginId, typeof key === 'object' ? key : { [key]: value }),
        onChange: (listener) => {
          if (typeof listener !== 'function') throw new TypeError('Settings listener must be a function')
          let set = settingsWatchers.get(pluginId)
          if (!set) {
            set = new Set()
            settingsWatchers.set(pluginId, set)
          }
          set.add(listener)
          return track(() => {
            set.delete(listener)
            if (!set.size) settingsWatchers.delete(pluginId)
          })
        },
      },

      storage: {
        dataDir: pluginDataFolder(pluginId),
        get: (key, defaultValue) => getPluginStorageValue(pluginId, key, defaultValue),
        set: (key, value) => setPluginStorageValue(pluginId, key, value),
        delete: (key) => deletePluginStorageValue(pluginId, key),
        all: () => readStorage(pluginId),
        clear: () => clearPluginStorage(pluginId),
      },

      hooks: {
        tap: addHook,
        beforeApi: (handler, priority = 0) => addHook('api:before', handler, priority),
        afterApi: (handler, priority = 0) => addHook('api:after', handler, priority),
        onApiError: (handler, priority = 0) => addHook('api:error', handler, priority),
      },

      events: {
        on: addEvent,
        emit: (eventName, payload) => emitEvent(eventName, payload),
      },

      ipc: {
        intercept: addInterceptor,
        handle: (method, handler) => {
          if (typeof handler !== 'function') throw new TypeError('IPC handler must be a function')
          const key = `${pluginId}:${String(method)}`
          pluginIpcHandlers.set(key, handler)
          return track(() => {
            if (pluginIpcHandlers.get(key) === handler) pluginIpcHandlers.delete(key)
          })
        },
        send: (event, payload) => {
          broadcast('plugins:backend-event', { pluginId, event: String(event), payload })
        },
        broadcast: (event, payload) => {
          broadcast('plugins:backend-event', { pluginId, event: String(event), payload })
        },
      },

      api: {
        call: (name, params = {}, includeCookie = true) => {
          if (typeof host.callApi !== 'function') throw new Error('Host API unavailable')
          return host.callApi(name, params, includeCookie)
        },
        raw: () => (typeof host.rawApi === 'function' ? host.rawApi() : null),
      },

      auth: {
        getSession: () => (host.auth?.getSession ? host.auth.getSession() : { loggedIn: false, profile: null, cookie: '' }),
        setSession: (cookie, profile) => {
          if (!host.auth?.setSession) throw new Error('Auth host unavailable')
          return host.auth.setSession(cookie, profile)
        },
        clearSession: () => {
          if (!host.auth?.clearSession) throw new Error('Auth host unavailable')
          return host.auth.clearSession()
        },
      },

      media: {
        allowHost: (matcher) => {
          const entry = { pluginId, matcher }
          allowedMediaHosts.add(entry)
          return track(() => allowedMediaHosts.delete(entry))
        },
        registerStreamProvider: (matcher, handler, priority = 0) => {
          if (typeof handler !== 'function') throw new TypeError('Stream provider handler must be a function')
          const entry = { pluginId, priority: Number(priority) || 0, matcher, handler }
          streamProviders.push(entry)
          streamProviders.sort((a, b) => b.priority - a.priority)
          return track(() => {
            const index = streamProviders.indexOf(entry)
            if (index >= 0) streamProviders.splice(index, 1)
          })
        },
        registerThumbnailProvider: (matcher, handler, priority = 0) => {
          if (typeof handler !== 'function') throw new TypeError('Thumbnail provider handler must be a function')
          const entry = { pluginId, priority: Number(priority) || 0, matcher, handler }
          thumbnailProviders.push(entry)
          thumbnailProviders.sort((a, b) => b.priority - a.priority)
          return track(() => {
            const index = thumbnailProviders.indexOf(entry)
            if (index >= 0) thumbnailProviders.splice(index, 1)
          })
        },
      },

      protocol: {
        registerRoute: (prefix, handler) => {
          if (typeof handler !== 'function') throw new TypeError('Protocol route handler must be a function')
          const cleanPrefix = String(prefix || '').replace(/^\/+/, '')
          let list = protocolRoutes.get(pluginId)
          if (!list) {
            list = []
            protocolRoutes.set(pluginId, list)
          }
          const entry = { prefix: cleanPrefix, handler }
          list.push(entry)
          return track(() => {
            const current = protocolRoutes.get(pluginId)
            if (!current) return
            const index = current.indexOf(entry)
            if (index >= 0) current.splice(index, 1)
            if (!current.length) protocolRoutes.delete(pluginId)
          })
        },
      },

      floatingLyrics: {
        getState: () => host.floatingLyrics?.getState?.() || null,
        configure: (patch) => host.floatingLyrics?.configure?.(patch),
        update: (payload) => host.floatingLyrics?.update?.(payload),
      },

      windows: {
        getMain: () => host.windows?.getMain?.() || null,
        getFloatingLyrics: () => host.windows?.getFloatingLyrics?.() || null,
        create: (windowOptions) => {
          if (!host.windows?.create) throw new Error('Window creation unavailable')
          const win = host.windows.create(windowOptions)
          track(() => {
            try { if (win && !win.isDestroyed?.()) win.destroy() } catch {}
          })
          return win
        },
      },

      network: {
        fetch: (...args) => {
          if (host.electron?.net?.fetch) return host.electron.net.fetch(...args)
          return fetch(...args)
        },
      },

      electron: host.electron || {},

      services: {
        provide: (name, implementation) => {
          const serviceName = String(name || '').trim()
          if (!serviceName) throw new Error('Service name is required')
          const entry = { pluginId, implementation }
          services.set(serviceName, entry)
          return track(() => {
            if (services.get(serviceName) === entry) services.delete(serviceName)
          })
        },
        get: (name) => services.get(String(name || ''))?.implementation ?? null,
        list: () => [...services.keys()],
      },

      plugins: {
        list: () => listPlugins(),
        get: (id) => getPlugin(id),
      },
    }

    return { ctx, disposables }
  }

  async function activateBackend(record) {
    if (!record || record.missing || record.manifestError || !record.manifest?.main) {
      record.backendError = null
      return true
    }
    await deactivateBackend(record.id)

    const entryPath = path.resolve(record.dir, record.manifest.main)
    if (!isPathInside(record.dir, entryPath) || !fs.existsSync(entryPath)) {
      const error = new Error(`后端入口文件不存在：${record.manifest.main}`)
      record.backendError = formatError(error)
      pushLog(record.id, 'error', 'backend', record.backendError.message)
      return false
    }

    const { ctx, disposables } = createBackendContext(record)
    let pluginExports
    try {
      clearPluginRequireCache(record.dir)
      pluginExports = require(entryPath)
    } catch (error) {
      record.backendError = formatError(error)
      pushLog(record.id, 'error', 'backend', `加载失败: ${record.backendError.message}`, record.backendError.stack)
      return false
    }

    const runtime = {
      id: record.id,
      exports: pluginExports,
      ctx,
      disposables,
    }
    activeBackends.set(record.id, runtime)

    try {
      const activateFn = typeof pluginExports === 'function'
        ? pluginExports
        : typeof pluginExports?.activate === 'function'
          ? pluginExports.activate
          : typeof pluginExports?.default?.activate === 'function'
            ? pluginExports.default.activate
            : typeof pluginExports?.default === 'function'
              ? pluginExports.default
              : null
      if (activateFn) {
        const result = await activateFn(ctx)
        if (typeof result === 'function') disposables.push(result)
        else if (result && typeof result.dispose === 'function') disposables.push(() => result.dispose())
      }
      record.backendError = null
      pushLog(record.id, 'info', 'backend', `后端模块已启用（v${record.manifest.version}）`)
      return true
    } catch (error) {
      record.backendError = formatError(error)
      pushLog(record.id, 'error', 'backend', `启用失败: ${record.backendError.message}`, record.backendError.stack)
      await deactivateBackend(record.id)
      return false
    }
  }

  async function deactivateBackend(pluginId) {
    const runtime = activeBackends.get(pluginId)
    if (!runtime) return false
    activeBackends.delete(pluginId)

    try {
      const deactivateFn = typeof runtime.exports?.deactivate === 'function'
        ? runtime.exports.deactivate
        : typeof runtime.exports?.default?.deactivate === 'function'
          ? runtime.exports.default.deactivate
          : null
      if (deactivateFn) {
        await deactivateFn(runtime.ctx)
      }
    } catch (error) {
      const formatted = formatError(error)
      pushLog(pluginId, 'error', 'backend', `停用回调异常: ${formatted.message}`, formatted.stack)
    }

    for (let index = runtime.disposables.length - 1; index >= 0; index -= 1) {
      try {
        await runtime.disposables[index]()
      } catch (error) {
        const formatted = formatError(error)
        pushLog(pluginId, 'warn', 'backend', `资源清理异常: ${formatted.message}`)
      }
    }
    runtime.disposables.length = 0

    const record = records.get(pluginId)
    if (record?.dir) clearPluginRequireCache(record.dir)
    pushLog(pluginId, 'info', 'backend', '后端模块已停用')
    return true
  }

  function scanPlugins() {
    ensureDirectories()
    loadRegistry()

    const discovered = new Map()

    // 1. Scan installed plugins inside pluginsDir
    let dirEntries = []
    try {
      dirEntries = fs.readdirSync(pluginsDir, { withFileTypes: true })
    } catch {}
    for (const entry of dirEntries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('__')) continue
      const pluginDir = path.join(pluginsDir, entry.name)
      if (!findManifestFile(pluginDir)) continue
      try {
        const manifest = loadManifestFromDir(pluginDir, appVersion)
        discovered.set(manifest.id, {
          id: manifest.id,
          source: 'installed',
          dir: pluginDir,
          manifest,
          manifestError: null,
          missing: false,
        })
      } catch (error) {
        const fallbackId = entry.name
        discovered.set(fallbackId, {
          id: fallbackId,
          source: 'installed',
          dir: pluginDir,
          manifest: null,
          manifestError: formatError(error),
          missing: false,
        })
      }
    }

    // 2. Scan linked plugins recorded in registry
    for (const [id, entry] of Object.entries(registry.plugins)) {
      if (entry.source !== 'linked' || !entry.path) continue
      const linkedDir = path.resolve(entry.path)
      if (!fs.existsSync(linkedDir)) {
        discovered.set(id, {
          id,
          source: 'linked',
          dir: linkedDir,
          manifest: null,
          manifestError: { message: `找不到已链接的本地插件目录：${linkedDir}`, stack: '' },
          missing: true,
        })
        continue
      }
      try {
        const manifest = loadManifestFromDir(linkedDir, appVersion)
        discovered.set(manifest.id, {
          id: manifest.id,
          source: 'linked',
          dir: linkedDir,
          manifest,
          manifestError: null,
          missing: false,
        })
      } catch (error) {
        discovered.set(id, {
          id,
          source: 'linked',
          dir: linkedDir,
          manifest: null,
          manifestError: formatError(error),
          missing: false,
        })
      }
    }

    // 3. Reconcile with in-memory records
    for (const existingId of [...records.keys()]) {
      if (!discovered.has(existingId)) {
        records.delete(existingId)
      }
    }

    let registryDirty = false
    for (const [id, info] of discovered.entries()) {
      const prev = records.get(id)
      let regEntry = registry.plugins[id]
      if (!regEntry) {
        regEntry = {
          enabled: false,
          forceCompatible: false,
          source: info.source,
          path: info.dir,
          installedAt: Date.now(),
          updatedAt: Date.now(),
        }
        registry.plugins[id] = regEntry
        registryDirty = true
      } else if (regEntry.path !== info.dir || regEntry.source !== info.source) {
        regEntry.path = info.dir
        regEntry.source = info.source
        registryDirty = true
      }

      const canAutoEnable = info.manifest
        ? (info.manifest.compatibility.compatible || Boolean(regEntry.forceCompatible))
        : false
      const enabled = Boolean(regEntry.enabled) && !info.missing && !info.manifestError && canAutoEnable

      records.set(id, {
        ...info,
        enabled,
        revision: prev?.revision || 1,
        backendError: prev?.backendError || null,
      })
    }

    if (registryDirty) saveRegistry()
    return listPlugins()
  }

  async function initialize() {
    scanPlugins()
    for (const record of records.values()) {
      if (record.enabled) {
        await activateBackend(record)
      }
    }
    return listPlugins()
  }

  async function installFromDirectory(sourceDir, opts = {}) {
    ensureDirectories()
    const resolvedSource = path.resolve(sourceDir)
    if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isDirectory()) {
      throw new Error('所选路径不是有效的文件夹')
    }
    const manifest = loadManifestFromDir(resolvedSource, appVersion)
    const id = manifest.id
    const link = Boolean(opts.link)
    const force = Boolean(opts.force)
    const shouldEnable = opts.enable !== false && (manifest.compatibility.compatible || force)

    if (activeBackends.has(id)) {
      await deactivateBackend(id)
    }

    let finalDir = resolvedSource
    if (!link) {
      const targetDir = path.join(pluginsDir, safeFolderId(id))
      if (path.resolve(targetDir) !== resolvedSource) {
        const stagingDir = path.join(pluginsDir, `.tmp-${safeFolderId(id)}-${crypto.randomUUID().slice(0, 8)}`)
        try {
          copyDirectorySync(resolvedSource, stagingDir)
          fs.rmSync(targetDir, { recursive: true, force: true })
          fs.renameSync(stagingDir, targetDir)
        } catch (error) {
          fs.rmSync(stagingDir, { recursive: true, force: true })
          throw error
        }
      }
      finalDir = targetDir
    }

    const now = Date.now()
    const previous = registry.plugins[id]
    registry.plugins[id] = {
      enabled: shouldEnable,
      forceCompatible: force,
      source: link ? 'linked' : 'installed',
      path: finalDir,
      installedAt: previous?.installedAt || now,
      updatedAt: now,
    }
    saveRegistry()

    const prevRecord = records.get(id)
    const nextRecord = {
      id,
      source: link ? 'linked' : 'installed',
      dir: finalDir,
      manifest: loadManifestFromDir(finalDir, appVersion),
      manifestError: null,
      missing: false,
      enabled: shouldEnable,
      revision: (prevRecord?.revision || 0) + 1,
      backendError: null,
    }
    records.set(id, nextRecord)
    rendererStates.delete(id)
    pushLog(id, 'info', 'manager', link ? `已链接本地开发插件：${finalDir}` : `已安装插件 v${manifest.version}`)

    if (shouldEnable) {
      await activateBackend(nextRecord)
    }
    broadcastChanged('installed', id)
    return buildPluginDescriptor(nextRecord)
  }

  async function installFromArchive(archivePath, opts = {}) {
    ensureDirectories()
    const resolvedArchive = path.resolve(archivePath)
    if (!fs.existsSync(resolvedArchive) || !fs.statSync(resolvedArchive).isFile()) {
      throw new Error('插件压缩包文件不存在')
    }
    const tempDir = path.join(pluginsDir, `.extract-${crypto.randomUUID().slice(0, 8)}`)
    try {
      extractZipArchive(resolvedArchive, tempDir)
      const pluginRoot = locatePluginRoot(tempDir)
      if (!pluginRoot) {
        throw new Error('压缩包中未找到 plugin.json 或 manifest.json')
      }
      return await installFromDirectory(pluginRoot, { ...opts, link: false })
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }

  async function installFromPath(targetPath, opts = {}) {
    const resolved = path.resolve(String(targetPath || ''))
    if (!resolved || !fs.existsSync(resolved)) {
      throw new Error('找不到指定的插件路径')
    }
    const stat = fs.statSync(resolved)
    if (stat.isDirectory()) {
      return installFromDirectory(resolved, opts)
    }
    const base = path.basename(resolved).toLowerCase()
    if (base === 'plugin.json' || base === 'manifest.json') {
      return installFromDirectory(path.dirname(resolved), opts)
    }
    if (base.endsWith('.zip') || base.endsWith('.mrplugin')) {
      return installFromArchive(resolved, opts)
    }
    throw new Error('仅支持插件文件夹、plugin.json、.mrplugin 或 .zip 插件包')
  }

  async function enablePlugin(pluginId, opts = {}) {
    const record = records.get(pluginId)
    if (!record) throw new Error(`未找到插件：${pluginId}`)
    if (record.missing) throw new Error('插件目录已丢失，无法启用')
    if (record.manifestError || !record.manifest) {
      throw new Error(record.manifestError?.message || '插件清单无效，无法启用')
    }
    const force = Boolean(opts.force)
    if (!record.manifest.compatibility.compatible && !force) {
      const error = new Error(`插件支持的版本范围为 ${record.manifest.supportedVersions}，与当前 MenoRadio ${appVersion} 不兼容`)
      error.code = 'INCOMPATIBLE_VERSION'
      throw error
    }

    registry.plugins[pluginId] = {
      ...(registry.plugins[pluginId] || {}),
      enabled: true,
      forceCompatible: force || Boolean(registry.plugins[pluginId]?.forceCompatible),
      source: record.source,
      path: record.dir,
      updatedAt: Date.now(),
    }
    saveRegistry()

    record.enabled = true
    record.revision = (record.revision || 0) + 1
    record.backendError = null
    rendererStates.delete(pluginId)
    await activateBackend(record)
    broadcastChanged('enabled', pluginId)
    return buildPluginDescriptor(record)
  }

  async function disablePlugin(pluginId) {
    const record = records.get(pluginId)
    if (!record) throw new Error(`未找到插件：${pluginId}`)
    if (registry.plugins[pluginId]) {
      registry.plugins[pluginId].enabled = false
      registry.plugins[pluginId].updatedAt = Date.now()
      saveRegistry()
    }
    record.enabled = false
    record.backendError = null
    rendererStates.delete(pluginId)
    await deactivateBackend(pluginId)
    broadcastChanged('disabled', pluginId)
    return buildPluginDescriptor(record)
  }

  async function reloadPlugin(pluginId) {
    const record = records.get(pluginId)
    if (!record) throw new Error(`未找到插件：${pluginId}`)
    const wasEnabled = record.enabled
    await deactivateBackend(pluginId)

    if (!fs.existsSync(record.dir)) {
      record.missing = true
      record.enabled = false
      record.manifest = null
      record.manifestError = { message: `找不到插件目录：${record.dir}`, stack: '' }
      broadcastChanged('reloaded', pluginId)
      return buildPluginDescriptor(record)
    }

    try {
      record.manifest = loadManifestFromDir(record.dir, appVersion)
      record.manifestError = null
      record.missing = false
    } catch (error) {
      record.manifestError = formatError(error)
      record.enabled = false
      pushLog(pluginId, 'error', 'manager', `重载清单失败: ${record.manifestError.message}`)
      broadcastChanged('reloaded', pluginId)
      return buildPluginDescriptor(record)
    }

    record.revision = (record.revision || 0) + 1
    record.backendError = null
    rendererStates.delete(pluginId)
    const regEntry = registry.plugins[pluginId] || {}
    const canStayEnabled = wasEnabled && (record.manifest.compatibility.compatible || Boolean(regEntry.forceCompatible))
    record.enabled = canStayEnabled
    if (canStayEnabled) {
      await activateBackend(record)
    }
    pushLog(pluginId, 'info', 'manager', `插件已重新加载（rev ${record.revision}）`)
    broadcastChanged('reloaded', pluginId)
    return buildPluginDescriptor(record)
  }

  async function uninstallPlugin(pluginId, { removeData = false } = {}) {
    const record = records.get(pluginId)
    if (!record) throw new Error(`未找到插件：${pluginId}`)
    await deactivateBackend(pluginId)
    rendererStates.delete(pluginId)
    pluginLogs.delete(pluginId)
    records.delete(pluginId)
    delete registry.plugins[pluginId]
    saveRegistry()

    if (record.source === 'installed' && record.dir && isPathInside(pluginsDir, record.dir) && path.resolve(record.dir) !== pluginsDir) {
      fs.rmSync(record.dir, { recursive: true, force: true })
    }
    if (removeData) {
      const dataDir = pluginDataFolder(pluginId)
      if (isPathInside(pluginDataDir, dataDir) && path.resolve(dataDir) !== pluginDataDir) {
        fs.rmSync(dataDir, { recursive: true, force: true })
      }
    }
    broadcastChanged('uninstalled', pluginId)
    return { uninstalled: true, id: pluginId }
  }

  async function rescanPlugins() {
    const previousActive = new Set([...records.values()].filter((r) => r.enabled).map((r) => r.id))
    scanPlugins()
    for (const id of [...activeBackends.keys()]) {
      if (!records.has(id) || !records.get(id).enabled) {
        await deactivateBackend(id)
      }
    }
    for (const record of records.values()) {
      if (record.enabled && !activeBackends.has(record.id) && !previousActive.has(record.id)) {
        await activateBackend(record)
      }
    }
    broadcastChanged('rescanned')
    return listPlugins()
  }

  async function shutdown() {
    for (const pluginId of [...activeBackends.keys()]) {
      await deactivateBackend(pluginId)
    }
  }

  function reportRendererState(pluginId, statePatch = {}) {
    if (!records.has(pluginId)) return false
    const prev = rendererStates.get(pluginId) || { active: false, error: null }
    const next = {
      active: Boolean(statePatch.active),
      error: statePatch.error ? formatError(statePatch.error) : null,
    }
    rendererStates.set(pluginId, next)
    if (next.error) {
      pushLog(pluginId, 'error', 'renderer', next.error.message, next.error.stack)
    } else if (next.active && !prev.active) {
      pushLog(pluginId, 'info', 'renderer', '前端模块已激活')
    }
    return true
  }

  // --- Execution Pipelines (IPC middleware, Hooks, Events, Media, Protocol) ---

  function wrapIpcHandler(channel, baseHandler) {
    return async (event, payload) => {
      const specific = ipcInterceptors.get(channel) || []
      const wildcard = ipcInterceptors.get('*') || []
      const chain = [...specific, ...wildcard].sort((a, b) => b.priority - a.priority)
      if (!chain.length) return baseHandler(event, payload)

      const meta = { channel, event }
      let index = -1
      const dispatch = async (cursor, currentPayload) => {
        if (cursor <= index) throw new Error('IPC middleware next() called multiple times')
        index = cursor
        if (cursor >= chain.length) {
          return baseHandler(event, currentPayload)
        }
        const entry = chain[cursor]
        return entry.handler(currentPayload, (nextPayload = currentPayload) => dispatch(cursor + 1, nextPayload), meta)
      }
      return dispatch(0, payload)
    }
  }

  async function runHook(hookName, initialContext = {}) {
    const listeners = hookListeners.get(hookName)
    if (!listeners?.length) return initialContext
    let ctx = initialContext
    for (const entry of [...listeners]) {
      try {
        const result = await entry.handler(ctx)
        if (result && typeof result === 'object') {
          ctx = { ...ctx, ...result }
          if (ctx.handled === true || ctx.cancel === true) break
        }
      } catch (error) {
        const formatted = formatError(error)
        pushLog(entry.pluginId, 'error', 'backend', `Hook "${hookName}" 异常: ${formatted.message}`, formatted.stack)
      }
    }
    return ctx
  }

  function emitEvent(eventName, payload) {
    const listeners = eventListeners.get(eventName)
    if (!listeners?.size) return
    for (const entry of [...listeners]) {
      try {
        const maybePromise = entry.handler(payload)
        if (maybePromise && typeof maybePromise.catch === 'function') {
          maybePromise.catch((error) => {
            const formatted = formatError(error)
            pushLog(entry.pluginId, 'error', 'backend', `Event "${eventName}" 异步异常: ${formatted.message}`, formatted.stack)
          })
        }
      } catch (error) {
        const formatted = formatError(error)
        pushLog(entry.pluginId, 'error', 'backend', `Event "${eventName}" 异常: ${formatted.message}`, formatted.stack)
      }
    }
  }

  async function invokePluginBackend(pluginId, method, payload) {
    const key = `${String(pluginId)}:${String(method)}`
    const handler = pluginIpcHandlers.get(key)
    if (!handler) throw new Error(`插件 "${pluginId}" 未注册后端方法 "${method}"`)
    return handler(payload)
  }

  async function invokePluginService(serviceName, method, payload) {
    const entry = services.get(String(serviceName || ''))
    if (!entry) throw new Error(`未找到插件服务 "${serviceName}"`)
    const impl = entry.implementation
    if (typeof impl === 'function') return impl(method, payload)
    if (impl && typeof impl[method] === 'function') return impl[method](payload)
    throw new Error(`插件服务 "${serviceName}" 不支持方法 "${method}"`)
  }

  function isMediaHostAllowed(urlObj) {
    if (!allowedMediaHosts.size) return false
    const hostName = String(urlObj?.hostname || '').toLowerCase()
    const href = String(urlObj?.href || '')
    for (const entry of allowedMediaHosts) {
      const matcher = entry.matcher
      try {
        if (typeof matcher === 'string') {
          const clean = matcher.toLowerCase().trim()
          if (clean === '*' || hostName === clean || hostName.endsWith(`.${clean}`)) return true
        } else if (matcher instanceof RegExp) {
          if (matcher.test(hostName) || matcher.test(href)) return true
        } else if (typeof matcher === 'function') {
          if (matcher(urlObj)) return true
        }
      } catch {}
    }
    return false
  }

  function matchProvider(matcher, target) {
    if (!matcher) return false
    if (typeof matcher === 'string') return String(target || '').startsWith(matcher)
    if (matcher instanceof RegExp) return matcher.test(String(target || ''))
    if (typeof matcher === 'function') return Boolean(matcher(target))
    return false
  }

  async function resolveStreamProvider(payload) {
    for (const entry of [...streamProviders]) {
      try {
        if (!matchProvider(entry.matcher, payload?.url || payload)) continue
        const result = await entry.handler(payload)
        if (result) return { pluginId: entry.pluginId, ...result }
      } catch (error) {
        const formatted = formatError(error)
        pushLog(entry.pluginId, 'error', 'backend', `Stream provider 异常: ${formatted.message}`, formatted.stack)
      }
    }
    return null
  }

  async function resolveThumbnailProvider(url) {
    for (const entry of [...thumbnailProviders]) {
      try {
        if (!matchProvider(entry.matcher, url)) continue
        const result = await entry.handler(url)
        if (result?.bytes) return result
      } catch (error) {
        const formatted = formatError(error)
        pushLog(entry.pluginId, 'error', 'backend', `Thumbnail provider 异常: ${formatted.message}`, formatted.stack)
      }
    }
    return null
  }

  async function handleProtocolRequest(request) {
    let parsed
    try {
      parsed = new URL(request.url)
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
    const pluginId = decodeURIComponent(parsed.hostname || '')
    const record = records.get(pluginId)
    if (!record || record.missing) {
      return new Response('Plugin not found', { status: 404 })
    }
    const relPath = decodeURIComponent(parsed.pathname || '').replace(/^\/+/, '')

    // Custom backend protocol routes take precedence when plugin is active.
    const routes = protocolRoutes.get(pluginId)
    if (record.enabled && routes?.length) {
      for (const route of routes) {
        if (relPath === route.prefix || relPath.startsWith(`${route.prefix}/`)) {
          try {
            const response = await route.handler(request, {
              pluginId,
              path: relPath,
              searchParams: parsed.searchParams,
            })
            if (response instanceof Response) return response
            if (response && typeof response === 'object') {
              return new Response(JSON.stringify(response), {
                status: 200,
                headers: {
                  'Content-Type': 'application/json; charset=utf-8',
                  'Access-Control-Allow-Origin': '*',
                  'Cache-Control': 'no-store',
                },
              })
            }
          } catch (error) {
            const formatted = formatError(error)
            pushLog(pluginId, 'error', 'backend', `Protocol route 异常: ${formatted.message}`, formatted.stack)
            return new Response(formatted.message, { status: 500 })
          }
        }
      }
    }

    if (!relPath) return new Response('Not Found', { status: 404 })
    const filePath = path.resolve(record.dir, relPath)
    if (!isPathInside(record.dir, filePath)) {
      return new Response('Forbidden', { status: 403 })
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return new Response('Not Found', { status: 404 })
    }

    // Disabled plugins may still serve their icon for Settings display.
    const isIcon = Boolean(record.manifest?.icon) && path.resolve(record.dir, record.manifest.icon) === filePath
    if (!record.enabled && !isIcon) {
      return new Response('Plugin disabled', { status: 403 })
    }

    const ext = path.extname(filePath).toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'
    const stat = fs.statSync(filePath)
    const rangeHeader = request.headers?.get?.('range') || ''
    const rangeMatch = /^bytes=(\d+)-(\d*)$/i.exec(String(rangeHeader).trim())
    if (rangeMatch && stat.size > 0) {
      const start = Math.min(stat.size - 1, Number(rangeMatch[1]))
      const end = rangeMatch[2] ? Math.min(stat.size - 1, Number(rangeMatch[2])) : stat.size - 1
      if (start <= end) {
        const length = end - start + 1
        const slice = Buffer.alloc(length)
        const fd = fs.openSync(filePath, 'r')
        try {
          fs.readSync(fd, slice, 0, length, start)
        } finally {
          fs.closeSync(fd)
        }
        return new Response(slice, {
          status: 206,
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(length),
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
          },
        })
      }
    }
    const data = fs.readFileSync(filePath)
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(data.length),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    })
  }

  return {
    pluginsDir,
    pluginDataDir,
    registryPath,
    protocolScheme,
    initialize,
    rescanPlugins,
    listPlugins,
    getPlugin,
    installFromDirectory,
    installFromArchive,
    installFromPath,
    enablePlugin,
    disablePlugin,
    reloadPlugin,
    uninstallPlugin,
    shutdown,
    getPluginSettings,
    setPluginSettings,
    getPluginStorageValue,
    setPluginStorageValue,
    deletePluginStorageValue,
    readStorage,
    clearPluginStorage,
    reportRendererState,
    wrapIpcHandler,
    runHook,
    emitEvent,
    invokePluginBackend,
    invokePluginService,
    isMediaHostAllowed,
    resolveStreamProvider,
    resolveThumbnailProvider,
    handleProtocolRequest,
    pushLog,
  }
}

module.exports = {
  createPluginManager,
}
