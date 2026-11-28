// Plugin runtime for the MenoRadio Floating Lyrics transparent window.
;((root) => {
  const bridge = root.floatingLyrics
  const active = new Map()
  const hooks = new Map()
  let hostContext = {}

  function injectLink(pluginId, href) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.dataset.pluginId = pluginId
    document.head.appendChild(link)
    return () => link.remove()
  }

  function injectStyle(pluginId, cssText) {
    const style = document.createElement('style')
    style.dataset.pluginId = pluginId
    style.textContent = String(cssText || '')
    document.head.appendChild(style)
    return () => style.remove()
  }

  function tapHook(pluginId, name, handler, priority = 0) {
    if (typeof handler !== 'function') return () => {}
    let list = hooks.get(name)
    if (!list) {
      list = []
      hooks.set(name, list)
    }
    const entry = { pluginId, priority: Number(priority) || 0, handler }
    list.push(entry)
    list.sort((a, b) => b.priority - a.priority)
    return () => {
      const current = hooks.get(name)
      if (!current) return
      const index = current.indexOf(entry)
      if (index >= 0) current.splice(index, 1)
      if (!current.length) hooks.delete(name)
    }
  }

  function runSyncHook(name, initialContext = {}) {
    const list = hooks.get(name)
    if (!list?.length) return initialContext
    let ctx = initialContext
    for (const entry of [...list]) {
      try {
        const next = entry.handler(ctx)
        if (next && typeof next === 'object') {
          ctx = { ...ctx, ...next }
          if (ctx.handled === true || ctx.cancel === true) break
        }
      } catch (error) {
        console.error(`[floating-plugin:${entry.pluginId}] Hook "${name}" error:`, error)
      }
    }
    return ctx
  }

  async function deactivate(pluginId) {
    const runtime = active.get(pluginId)
    if (!runtime) return
    active.delete(pluginId)
    try {
      const deactivateFn = runtime.exports?.deactivate || runtime.exports?.default?.deactivate
      if (typeof deactivateFn === 'function') await deactivateFn(runtime.api)
    } catch {}
    for (let i = runtime.disposables.length - 1; i >= 0; i -= 1) {
      try { await runtime.disposables[i]() } catch {}
    }
    runtime.disposables.length = 0
  }

  async function activate(descriptor) {
    if (!descriptor?.enabled || descriptor.missing) return
    if (!descriptor.floatingLyricsUrl && !(descriptor.floatingStyleUrls?.length)) return
    const existing = active.get(descriptor.id)
    if (existing && existing.revision === descriptor.revision) return
    if (existing) await deactivate(descriptor.id)

    const runtime = {
      id: descriptor.id,
      revision: descriptor.revision || 1,
      descriptor,
      settings: { ...(descriptor.settings || {}) },
      disposables: [],
      settingsWatchers: new Set(),
      backendListeners: new Map(),
      exports: null,
      api: null,
    }
    active.set(descriptor.id, runtime)

    const track = (fn) => {
      if (typeof fn === 'function') runtime.disposables.push(fn)
      return fn
    }

    const baseUrl = `menoradio-plugin://${encodeURIComponent(descriptor.id)}/`
    const api = {
      id: descriptor.id,
      manifest: descriptor,
      baseUrl,
      assetUrl: (rel) => `${baseUrl}${String(rel || '').replace(/^\/+/, '')}?rev=${runtime.revision}`,
      onDispose: track,
      get dom() { return hostContext.dom || {} },
      get config() { return hostContext.getConfig?.() || {} },
      get payload() { return hostContext.getPayload?.() || {} },
      styles: {
        inject: (cssText) => track(injectStyle(descriptor.id, cssText)),
        injectFile: (rel) => track(injectLink(descriptor.id, api.assetUrl(rel))),
      },
      hooks: {
        tap: (name, handler, priority = 0) => track(tapHook(descriptor.id, name, handler, priority)),
      },
      settings: {
        get: (key) => runtime.settings[key],
        getAll: () => ({ ...runtime.settings }),
        onChange: (fn) => {
          runtime.settingsWatchers.add(fn)
          return track(() => runtime.settingsWatchers.delete(fn))
        },
      },
      backend: {
        invoke: async (method, payload) => {
          const res = await bridge?.plugins?.invokeBackend?.(descriptor.id, method, payload)
          if (!res?.ok) throw new Error(res?.error || `Backend call failed: ${method}`)
          return res.data
        },
        on: (event, fn) => {
          let set = runtime.backendListeners.get(event)
          if (!set) {
            set = new Set()
            runtime.backendListeners.set(event, set)
          }
          set.add(fn)
          return track(() => set.delete(fn))
        },
      },
    }
    runtime.api = api

    try {
      for (const href of descriptor.floatingStyleUrls || []) {
        track(injectLink(descriptor.id, href))
      }
      if (descriptor.floatingLyricsUrl) {
        const mod = await import(descriptor.floatingLyricsUrl)
        runtime.exports = mod
        const activateFn = typeof mod?.activate === 'function'
          ? mod.activate
          : typeof mod?.default?.activate === 'function'
            ? mod.default.activate
            : typeof mod?.default === 'function'
              ? mod.default
              : null
        if (activateFn) {
          const ret = await activateFn(api)
          if (typeof ret === 'function') track(ret)
          else if (ret && typeof ret.dispose === 'function') track(() => ret.dispose())
        }
      }
    } catch (error) {
      console.error(`[floating-plugin:${descriptor.id}] Activation failed:`, error)
      await deactivate(descriptor.id)
    }
  }

  async function sync(descriptors = []) {
    const enabledMap = new Map()
    for (const item of Array.isArray(descriptors) ? descriptors : []) {
      if (item?.enabled && !item.missing && (item.floatingLyricsUrl || item.floatingStyleUrls?.length)) {
        enabledMap.set(item.id, item)
      }
    }
    for (const [id, runtime] of [...active.entries()]) {
      const next = enabledMap.get(id)
      if (!next || next.revision !== runtime.revision) await deactivate(id)
    }
    for (const item of enabledMap.values()) {
      await activate(item)
    }
  }

  async function initialize(context = {}) {
    hostContext = context
    if (!bridge?.plugins) return
    bridge.plugins.onChanged?.((payload) => {
      if (Array.isArray(payload?.plugins)) void sync(payload.plugins)
    })
    bridge.plugins.onSettingsChanged?.((payload) => {
      const runtime = active.get(payload?.pluginId)
      if (!runtime) return
      runtime.settings = { ...(payload.settings || {}) }
      for (const watcher of runtime.settingsWatchers) {
        try { watcher(runtime.settings, payload.patch || {}) } catch {}
      }
    })
    bridge.plugins.onBackendEvent?.((payload) => {
      const runtime = active.get(payload?.pluginId)
      const set = runtime?.backendListeners.get(payload?.event)
      if (!set?.size) return
      for (const listener of [...set]) {
        try { listener(payload.payload) } catch {}
      }
    })
    try {
      const res = await bridge.plugins.list()
      if (res?.ok && Array.isArray(res.data)) await sync(res.data)
    } catch {}
  }

  root.MenoRadioFloatingPlugins = {
    initialize,
    sync,
    runSyncHook,
  }
})(window)
