// Renderer-side Plugin Host and Deep Extensibility Runtime for MenoRadio.
;((root) => {
  const DEFAULT_LIGHT_THEME_OVERRIDES = (selector) => `
${selector} .playlist-nav-more:hover,
${selector} .creator-link:hover,
${selector} .expandable-description [data-toggle-description]:hover,
${selector} .settings-link:hover { color: var(--text); }
${selector} .playlist-nav-section + .playlist-nav-section,
${selector} .content-toolbar,
${selector} .floating-setting-row { border-color: var(--line); }
${selector} .profile-button.interactive:hover,
${selector} .nav-item.drop-target,
${selector} [data-playlist-drop-liked].drop-target,
${selector} .search-history-items button,
${selector} .search-entity,
${selector} .empty-state .empty-icon,
${selector} .skeleton { background: var(--bg-card); }
${selector} .search-entity:hover,
${selector} .font-option:hover,
${selector} .choice-option:hover { background: var(--control-hover); color: var(--text); }
${selector} .track-section { background: var(--bg-card); border-color: var(--line); }
${selector} .track-row { border-color: var(--line); }
${selector} .track-row:hover { background: var(--control-bg); }
${selector} .track-row.selected { background: var(--control-hover); outline-color: var(--line); }
${selector} .track-index,
${selector} .track-duration { color: var(--text-muted); }
${selector} .track-cover { background: var(--cover-placeholder); }
${selector} .playlist-hero { background: linear-gradient(120deg, var(--bg-elevated), var(--bg-card)); }
${selector} .player-icon { color: var(--text-soft); }
${selector} .now-cover { background: linear-gradient(135deg, var(--bg-card-hover), var(--line-strong)); }
${selector} .release-markdown,
${selector} .markdown-document code,
${selector} .markdown-document pre,
${selector} kbd { background: var(--input-bg); }
${selector} .floating-color-swatch { border-color: var(--line-strong); }
`

  function cssEscapeAttr(value) {
    return String(value || '').replace(/["\\]/g, '\\$&')
  }

  function normalizeShortcutCombo(combo) {
    const parts = String(combo || '')
      .toLowerCase()
      .split('+')
      .map((part) => part.trim())
      .filter(Boolean)
    const mods = { ctrl: false, alt: false, shift: false, meta: false }
    let key = ''
    for (const part of parts) {
      if (part === 'ctrl' || part === 'control' || part === 'cmdorctrl') mods.ctrl = true
      else if (part === 'alt' || part === 'option') mods.alt = true
      else if (part === 'shift') mods.shift = true
      else if (part === 'meta' || part === 'cmd' || part === 'command' || part === 'super') mods.meta = true
      else key = part
    }
    return { ...mods, key }
  }

  function matchesShortcut(event, parsed) {
    if (!parsed.key) return false
    const eventKey = String(event.key || '').toLowerCase()
    const eventCode = String(event.code || '').toLowerCase()
    const keyMatches = eventKey === parsed.key
      || eventCode === parsed.key
      || eventCode === `key${parsed.key}`
      || (parsed.key === 'space' && (eventKey === ' ' || eventCode === 'space'))
      || (parsed.key === 'esc' && eventKey === 'escape')
    if (!keyMatches) return false
    return Boolean(event.ctrlKey) === parsed.ctrl
      && Boolean(event.altKey) === parsed.alt
      && Boolean(event.shiftKey) === parsed.shift
      && Boolean(event.metaKey) === parsed.meta
  }

  function formatError(error) {
    if (!error) return { message: 'Unknown error', stack: '' }
    if (typeof error === 'string') return { message: error, stack: '' }
    return {
      message: String(error.message || error),
      stack: String(error.stack || ''),
    }
  }

  function createPluginHost(options = {}) {
    const doc = options.document || root.document
    const win = options.window || root
    const i18n = options.i18n || root.MenoRadioI18n
    const core = options.core || root.MenoRadioCore
    const bridge = options.bridge || root.menoradio
    const importModule = options.importModule || ((url) => import(url))

    let hostApp = null
    let appVersion = options.appVersion || '0.0.0'
    let pluginDescriptors = []
    let initialized = false

    const activePlugins = new Map() // id -> { descriptor, revision, exports, api, disposables, settingsWatchers, backendListeners }
    const hooks = new Map() // hookName -> Array<{ pluginId, priority, handler }>
    const events = new Map() // eventName -> Set<{ pluginId, handler }>
    const customThemes = new Map() // id -> { pluginId, id, label, colorScheme }
    const customPlayerStyles = new Map() // id -> { pluginId, id, label, className, onActivate, onDeactivate }
    const customFonts = new Map() // family -> { pluginId, family, label }
    const customImmersiveViews = new Map() // id -> { pluginId, id, label, icon, order, render, onShow, onHide, unmount }
    const customNavItems = new Map() // key -> { pluginId, id, label, icon, route, group, order, badge, onClick }
    const customRoutes = new Map() // route -> { pluginId, route, title, render, unmount }
    const customSettingsCards = new Map() // key -> { pluginId, id, section, order, render }
    const customSettingsRenderers = new Map() // pluginId -> renderFn
    const customLoginTabs = new Map() // key -> { pluginId, id, label, order, render, unmount }
    const loginModalOverrides = [] // Array<{ pluginId, priority, handler }>
    const trackMenuItems = [] // Array<{ pluginId, id, label, icon, danger, order, when, onClick }>
    const playlistMenuItems = [] // Array<{ pluginId, id, label, icon, danger, order, when, onClick }>
    const slotMounts = new Map() // slotName -> Array<{ pluginId, key, order, factory, elements: Set }>
    const shortcuts = [] // Array<{ pluginId, combo, parsed, handler, allowInInput, description }>
    const rendererServices = new Map() // name -> { pluginId, implementation }
    const actionPatches = new Map() // actionName -> Array<{ pluginId, original, wrapper }>
    const hostChangeListeners = new Set()

    // Shared lazy Web Audio API graph for audio effect / visualizer plugins.
    const audioGraph = {
      context: null,
      source: null,
      analyser: null,
      nodes: [], // Array<{ pluginId, input, output, dispose }>
    }

    function ensureAudioGraph() {
      const audioElement = hostApp?.dom?.audio
      if (!audioElement) throw new Error('Audio element unavailable')
      const AudioCtx = win.AudioContext || win.webkitAudioContext
      if (!AudioCtx) throw new Error('Web Audio API unavailable')
      if (!audioGraph.context) {
        audioGraph.context = new AudioCtx()
        audioGraph.source = audioGraph.context.createMediaElementSource(audioElement)
        audioGraph.analyser = audioGraph.context.createAnalyser()
        audioGraph.analyser.fftSize = 256
        reconnectAudioGraph()
      }
      if (audioGraph.context.state === 'suspended') {
        void audioGraph.context.resume().catch(() => {})
      }
      return audioGraph
    }

    function reconnectAudioGraph() {
      if (!audioGraph.source || !audioGraph.context || !audioGraph.analyser) return
      try { audioGraph.source.disconnect() } catch {}
      try { audioGraph.analyser.disconnect() } catch {}
      for (const entry of audioGraph.nodes) {
        try { entry.output?.disconnect?.() } catch {}
      }
      let current = audioGraph.source
      for (const entry of audioGraph.nodes) {
        if (entry.input && entry.output) {
          current.connect(entry.input)
          current = entry.output
        }
      }
      current.connect(audioGraph.analyser)
      audioGraph.analyser.connect(audioGraph.context.destination)
    }

    function notifyHostChanged(reason = 'updated') {
      for (const listener of hostChangeListeners) {
        try { listener({ reason, plugins: pluginDescriptors }) } catch {}
      }
    }

    function onHostChange(listener) {
      if (typeof listener !== 'function') return () => {}
      hostChangeListeners.add(listener)
      return () => hostChangeListeners.delete(listener)
    }

    function registerHook(pluginId, hookName, handler, priority = 0) {
      if (typeof handler !== 'function') throw new TypeError('Hook handler must be a function')
      let list = hooks.get(hookName)
      if (!list) {
        list = []
        hooks.set(hookName, list)
      }
      const entry = { pluginId, priority: Number(priority) || 0, handler }
      list.push(entry)
      list.sort((a, b) => b.priority - a.priority)
      return () => {
        const current = hooks.get(hookName)
        if (!current) return
        const index = current.indexOf(entry)
        if (index >= 0) current.splice(index, 1)
        if (!current.length) hooks.delete(hookName)
      }
    }

    function runSyncHook(hookName, initialContext = {}) {
      const list = hooks.get(hookName)
      if (!list?.length) return initialContext
      let ctx = initialContext
      for (const entry of [...list]) {
        try {
          const result = entry.handler(ctx)
          if (result && typeof result === 'object' && typeof result.then !== 'function') {
            ctx = { ...ctx, ...result }
            if (ctx.handled === true || ctx.cancel === true) break
          }
        } catch (error) {
          console.error(`[plugin:${entry.pluginId}] Sync hook "${hookName}" failed:`, error)
        }
      }
      return ctx
    }

    async function runHook(hookName, initialContext = {}) {
      const list = hooks.get(hookName)
      if (!list?.length) return initialContext
      let ctx = initialContext
      for (const entry of [...list]) {
        try {
          const result = await entry.handler(ctx)
          if (result && typeof result === 'object') {
            ctx = { ...ctx, ...result }
            if (ctx.handled === true || ctx.cancel === true) break
          }
        } catch (error) {
          console.error(`[plugin:${entry.pluginId}] Hook "${hookName}" failed:`, error)
        }
      }
      return ctx
    }

    function registerEvent(pluginId, eventName, handler) {
      if (typeof handler !== 'function') throw new TypeError('Event handler must be a function')
      let set = events.get(eventName)
      if (!set) {
        set = new Set()
        events.set(eventName, set)
      }
      const entry = { pluginId, handler }
      set.add(entry)
      return () => {
        set.delete(entry)
        if (!set.size) events.delete(eventName)
      }
    }

    function emit(eventName, payload, { mirrorToBackend = false } = {}) {
      const set = events.get(eventName)
      if (set?.size) {
        for (const entry of [...set]) {
          try {
            const res = entry.handler(payload)
            if (res && typeof res.catch === 'function') {
              res.catch((error) => console.error(`[plugin:${entry.pluginId}] Async event "${eventName}" error:`, error))
            }
          } catch (error) {
            console.error(`[plugin:${entry.pluginId}] Event "${eventName}" error:`, error)
          }
        }
      }
      if (mirrorToBackend && bridge?.plugins?.notifyEvent) {
        try { bridge.plugins.notifyEvent(eventName, payload) } catch {}
      }
    }

    function injectStyleElement(pluginId, cssText, tagId = '') {
      if (!doc?.head) return () => {}
      const style = doc.createElement('style')
      style.dataset.pluginId = pluginId
      if (tagId) style.dataset.pluginStyleId = tagId
      style.textContent = String(cssText || '')
      doc.head.appendChild(style)
      return () => style.remove()
    }

    function injectLinkElement(pluginId, href, tagId = '') {
      if (!doc?.head || !href) return () => {}
      const link = doc.createElement('link')
      link.rel = 'stylesheet'
      link.href = href
      link.dataset.pluginId = pluginId
      if (tagId) link.dataset.pluginStyleId = tagId
      doc.head.appendChild(link)
      return () => link.remove()
    }

    function registerThemeInternal(pluginId, def, baseUrl, revision) {
      if (!def || !def.id) throw new Error('Theme requires an id')
      const id = String(def.id).includes(':') ? String(def.id) : `plugin:${pluginId}:${def.id}`
      const label = String(def.label || def.name || def.id)
      const colorScheme = def.colorScheme === 'light' ? 'light' : 'dark'
      const cleanups = []

      const selector = `:root[data-theme="${cssEscapeAttr(id)}"]`
      const varLines = []
      if (colorScheme === 'light') varLines.push('  color-scheme: light;')
      else varLines.push('  color-scheme: dark;')
      if (def.variables && typeof def.variables === 'object') {
        for (const [key, value] of Object.entries(def.variables)) {
          if (key.startsWith('--') && value != null) {
            varLines.push(`  ${key}: ${String(value)};`)
          }
        }
      }
      let generatedCss = `${selector} {\n${varLines.join('\n')}\n}\n`
      if (colorScheme === 'light') {
        generatedCss += DEFAULT_LIGHT_THEME_OVERRIDES(selector)
      }
      if (def.css && typeof def.css === 'string' && !def.cssUrl && !/\.(css)(\?.*)?$/i.test(def.css.trim())) {
        generatedCss += `\n${def.css}`
      }
      cleanups.push(injectStyleElement(pluginId, generatedCss, `theme:${id}`))

      const cssHref = def.cssUrl || (def.cssFile ? `${baseUrl}${String(def.cssFile).replace(/^\/+/, '')}?rev=${revision}` : '')
      if (cssHref) {
        cleanups.push(injectLinkElement(pluginId, cssHref, `theme-file:${id}`))
      }

      const record = { pluginId, id, label, colorScheme }
      customThemes.set(id, record)
      hostApp?.onThemesChanged?.()

      return () => {
        if (customThemes.get(id) === record) customThemes.delete(id)
        for (const dispose of cleanups) dispose()
        hostApp?.onThemesChanged?.()
      }
    }

    function mountEntryIntoContainer(slotName, entry, container) {
      if (!container || !doc) return
      const wrapper = doc.createElement('div')
      wrapper.className = 'plugin-slot-item'
      wrapper.dataset.pluginId = entry.pluginId
      wrapper.dataset.pluginSlot = slotName
      wrapper.dataset.pluginSlotKey = entry.key
      try {
        const result = typeof entry.factory === 'function' ? entry.factory(wrapper, container) : entry.factory
        if (result instanceof win.Node || (result && typeof result === 'object' && 'nodeType' in result)) {
          wrapper.appendChild(result)
        } else if (typeof result === 'string') {
          wrapper.innerHTML = result
        }
        container.appendChild(wrapper)
        entry.elements.add(wrapper)
        if (typeof result === 'function') {
          entry.elementCleanups.set(wrapper, result)
        }
      } catch (error) {
        wrapper.remove()
        console.error(`[plugin:${entry.pluginId}] Slot "${slotName}" mount failed:`, error)
      }
    }

    function refreshSlots(rootNode = doc) {
      if (!rootNode?.querySelectorAll) return
      const containers = [...rootNode.querySelectorAll('[data-plugin-slot]')]
      if (rootNode.matches?.('[data-plugin-slot]')) containers.unshift(rootNode)
      for (const container of containers) {
        const slotName = container.dataset.pluginSlot
        const entries = slotMounts.get(slotName)
        if (!entries?.length) continue
        const sorted = [...entries].sort((a, b) => a.order - b.order)
        for (const entry of sorted) {
          const existing = container.querySelector(`[data-plugin-slot-key="${cssEscapeAttr(entry.key)}"]`)
          if (existing) continue
          mountEntryIntoContainer(slotName, entry, container)
        }
      }
    }

    function rebuildActionPatch(actionName) {
      const stack = actionPatches.get(actionName)
      if (!hostApp?.actions) return
      if (!stack || !stack.length) {
        actionPatches.delete(actionName)
        return
      }
      let fn = stack[0].base
      for (const entry of stack) {
        const next = fn
        fn = function patchedAction(...args) {
          return entry.wrapper(next, ...args)
        }
      }
      hostApp.actions[actionName] = fn
    }

    // Ensure original function is restored when the last patch for actionName is removed.
    function createPatchAction(pluginId) {
      return (actionName, wrapper) => {
        if (!hostApp?.actions || typeof hostApp.actions[actionName] !== 'function') {
          throw new Error(`Host action "${actionName}" is not patchable`)
        }
        let stack = actionPatches.get(actionName)
        const baseFn = stack?.length ? stack[0].base : hostApp.actions[actionName]
        if (!stack) {
          stack = []
          actionPatches.set(actionName, stack)
        }
        const entry = { pluginId, base: baseFn, wrapper }
        stack.push(entry)
        rebuildActionPatch(actionName)
        return () => {
          const current = actionPatches.get(actionName)
          if (!current) return
          const index = current.indexOf(entry)
          if (index >= 0) current.splice(index, 1)
          if (!current.length) {
            actionPatches.delete(actionName)
            hostApp.actions[actionName] = baseFn
          } else {
            rebuildActionPatch(actionName)
          }
        }
      }
    }

    function createPluginApi(descriptor, runtime) {
      const pluginId = descriptor.id
      const revision = descriptor.revision || 1
      const baseUrl = `menoradio-plugin://${encodeURIComponent(pluginId)}/`
      const track = (dispose) => {
        if (typeof dispose === 'function') runtime.disposables.push(dispose)
        return dispose
      }

      const api = {
        id: pluginId,
        manifest: descriptor,
        baseUrl,
        appVersion,
        assetUrl: (relPath) => `${baseUrl}${String(relPath || '').replace(/^\/+/, '')}?rev=${revision}`,
        onDispose: (fn) => track(fn),

        logger: {
          info: (...args) => console.log(`[plugin:${pluginId}]`, ...args),
          warn: (...args) => console.warn(`[plugin:${pluginId}]`, ...args),
          error: (...args) => console.error(`[plugin:${pluginId}]`, ...args),
        },

        settings: {
          get: (key) => runtime.settings[key],
          getAll: () => ({ ...runtime.settings }),
          set: async (key, value) => {
            const patch = typeof key === 'object' && key !== null ? key : { [key]: value }
            if (bridge?.plugins?.setSettings) {
              const res = await bridge.plugins.setSettings(pluginId, patch)
              if (res?.ok && res.data) {
                runtime.settings = { ...res.data }
                return runtime.settings
              }
            }
            runtime.settings = { ...runtime.settings, ...patch }
            return runtime.settings
          },
          onChange: (listener) => {
            if (typeof listener !== 'function') throw new TypeError('Settings listener must be a function')
            runtime.settingsWatchers.add(listener)
            return track(() => runtime.settingsWatchers.delete(listener))
          },
        },

        storage: {
          get: async (key, defaultValue = undefined) => {
            if (bridge?.plugins?.storage?.get) {
              const res = await bridge.plugins.storage.get(pluginId, key)
              if (res?.ok && res.data !== undefined) return res.data
              return defaultValue
            }
            try {
              const raw = win.localStorage?.getItem(`menoradio.plugin.${pluginId}.${key}`)
              return raw == null ? defaultValue : JSON.parse(raw)
            } catch {
              return defaultValue
            }
          },
          set: async (key, value) => {
            if (bridge?.plugins?.storage?.set) {
              await bridge.plugins.storage.set(pluginId, key, value)
              return true
            }
            try {
              win.localStorage?.setItem(`menoradio.plugin.${pluginId}.${key}`, JSON.stringify(value))
            } catch {}
            return true
          },
          delete: async (key) => {
            if (bridge?.plugins?.storage?.delete) {
              await bridge.plugins.storage.delete(pluginId, key)
              return true
            }
            try {
              win.localStorage?.removeItem(`menoradio.plugin.${pluginId}.${key}`)
            } catch {}
            return true
          },
          all: async () => {
            if (bridge?.plugins?.storage?.all) {
              const res = await bridge.plugins.storage.all(pluginId)
              return res?.ok ? (res.data || {}) : {}
            }
            return {}
          },
          local: {
            get: (key, fallback = null) => {
              try { return win.localStorage?.getItem(`menoradio.plugin.${pluginId}.${key}`) ?? fallback }
              catch { return fallback }
            },
            set: (key, value) => {
              try { win.localStorage?.setItem(`menoradio.plugin.${pluginId}.${key}`, String(value)) } catch {}
            },
            remove: (key) => {
              try { win.localStorage?.removeItem(`menoradio.plugin.${pluginId}.${key}`) } catch {}
            },
          },
        },

        backend: {
          invoke: async (method, payload) => {
            if (!bridge?.plugins?.invokeBackend) throw new Error('Backend plugin bridge unavailable')
            const result = await bridge.plugins.invokeBackend(pluginId, method, payload)
            if (!result?.ok) throw new Error(result?.error || `Backend call failed: ${method}`)
            return result.data
          },
          invokeService: async (serviceName, method, payload) => {
            if (!bridge?.plugins?.invokeService) throw new Error('Backend service bridge unavailable')
            const result = await bridge.plugins.invokeService(serviceName, method, payload)
            if (!result?.ok) throw new Error(result?.error || `Service call failed: ${serviceName}.${method}`)
            return result.data
          },
          on: (event, handler) => {
            if (typeof handler !== 'function') throw new TypeError('Backend event handler must be a function')
            let set = runtime.backendListeners.get(event)
            if (!set) {
              set = new Set()
              runtime.backendListeners.set(event, set)
            }
            set.add(handler)
            return track(() => {
              set.delete(handler)
              if (!set.size) runtime.backendListeners.delete(event)
            })
          },
        },

        hooks: {
          tap: (hookName, handler, priority = 0) => track(registerHook(pluginId, hookName, handler, priority)),
        },

        events: {
          on: (eventName, handler) => track(registerEvent(pluginId, eventName, handler)),
          emit: (eventName, payload, opts) => emit(eventName, payload, opts),
        },

        styles: {
          inject: (cssText, tagId = '') => track(injectStyleElement(pluginId, cssText, tagId)),
          injectFile: (relPath, tagId = '') => track(injectLinkElement(pluginId, api.assetUrl(relPath), tagId)),
          registerFont: async ({ family, label, src, descriptors = {} }) => {
            if (!family) throw new Error('Font family is required')
            const fontUrl = /^(https?:|data:|menoradio-plugin:)/i.test(String(src || ''))
              ? String(src)
              : api.assetUrl(src)
            let loadedFace = null
            if (typeof win.FontFace === 'function' && doc?.fonts && fontUrl) {
              loadedFace = new win.FontFace(family, `url("${fontUrl}")`, descriptors)
              await loadedFace.load()
              doc.fonts.add(loadedFace)
            }
            const entry = { pluginId, family: String(family), label: String(label || family) }
            customFonts.set(entry.family, entry)
            hostApp?.onFontsChanged?.()
            return track(() => {
              if (customFonts.get(entry.family) === entry) customFonts.delete(entry.family)
              if (loadedFace && doc?.fonts) {
                try { doc.fonts.delete(loadedFace) } catch {}
              }
              hostApp?.onFontsChanged?.()
            })
          },
        },

        theme: {
          register: (themeDef) => track(registerThemeInternal(pluginId, themeDef, baseUrl, revision)),
          list: () => hostApp?.getThemes?.() || [],
          getCurrent: () => hostApp?.state?.theme || 'dark',
          apply: (themeId) => hostApp?.actions?.setTheme?.(themeId),
          setVariables: (vars = {}) => {
            if (!doc?.documentElement) return () => {}
            const previous = new Map()
            for (const [k, v] of Object.entries(vars)) {
              if (!k.startsWith('--')) continue
              previous.set(k, doc.documentElement.style.getPropertyValue(k))
              if (v == null) doc.documentElement.style.removeProperty(k)
              else doc.documentElement.style.setProperty(k, String(v))
            }
            return track(() => {
              for (const [k, old] of previous.entries()) {
                if (old) doc.documentElement.style.setProperty(k, old)
                else doc.documentElement.style.removeProperty(k)
              }
            })
          },
          onChange: (handler) => track(registerEvent(pluginId, 'theme:changed', handler)),
        },

        ui: {
          toast: (message, title = '', type = '') => hostApp?.actions?.toast?.(message, title, type),
          navigate: (route, payload = null, record = true) => hostApp?.actions?.navigate?.(route, payload, record),
          showModal: (modalOptions) => hostApp?.actions?.showPluginModal?.(modalOptions),
          closeModal: () => hostApp?.actions?.closeModal?.(),
          getDom: () => hostApp?.dom || {},
          registerIcon: (name, svgContent, viewBox = '0 0 24 24') => {
            const sprite = doc?.querySelector?.('.svg-sprite')
            if (!sprite || !name) return () => {}
            const symbolId = `i-${String(name).replace(/^i-/, '')}`
            const existing = doc.getElementById(symbolId)
            if (existing) existing.remove()
            const symbol = doc.createElementNS('http://www.w3.org/2000/svg', 'symbol')
            symbol.id = symbolId
            symbol.setAttribute('viewBox', viewBox)
            symbol.dataset.pluginId = pluginId
            symbol.innerHTML = String(svgContent || '')
            sprite.appendChild(symbol)
            return track(() => symbol.remove())
          },
          registerNavItem: (item) => {
            if (!item?.id || !item?.label) throw new Error('Nav item requires id and label')
            const key = `${pluginId}:${item.id}`
            const entry = {
              pluginId,
              key,
              id: String(item.id),
              label: String(item.label),
              icon: String(item.icon || 'plugin'),
              route: item.route ? String(item.route) : '',
              group: String(item.group || 'plugins'),
              order: Number(item.order) || 100,
              badge: item.badge != null ? String(item.badge) : '',
              onClick: typeof item.onClick === 'function' ? item.onClick : null,
            }
            customNavItems.set(key, entry)
            hostApp?.onNavItemsChanged?.()
            return track(() => {
              if (customNavItems.get(key) === entry) customNavItems.delete(key)
              hostApp?.onNavItemsChanged?.()
            })
          },
          registerRoute: (routeName, routeDef) => {
            const route = String(routeName || '').trim()
            if (!route || typeof routeDef?.render !== 'function') {
              throw new Error('Route requires a name and render function')
            }
            const entry = {
              pluginId,
              route,
              title: String(routeDef.title || route),
              render: routeDef.render,
              unmount: typeof routeDef.unmount === 'function' ? routeDef.unmount : null,
            }
            customRoutes.set(route, entry)
            return track(() => {
              if (customRoutes.get(route) === entry) {
                customRoutes.delete(route)
                if (hostApp?.state?.route === route) {
                  hostApp.actions?.navigate?.('home', null, false)
                }
              }
            })
          },
          mountSlot: (slotName, factory, { id = '', order = 100 } = {}) => {
            const name = String(slotName || '').trim()
            if (!name) throw new Error('Slot name is required')
            const key = `${pluginId}:${id || Math.random().toString(36).slice(2, 10)}`
            let list = slotMounts.get(name)
            if (!list) {
              list = []
              slotMounts.set(name, list)
            }
            const entry = {
              pluginId,
              key,
              order: Number(order) || 100,
              factory,
              elements: new Set(),
              elementCleanups: new WeakMap(),
            }
            list.push(entry)
            refreshSlots(doc)
            return track(() => {
              for (const el of entry.elements) {
                try { entry.elementCleanups.get(el)?.() } catch {}
                el.remove()
              }
              entry.elements.clear()
              const current = slotMounts.get(name)
              if (!current) return
              const index = current.indexOf(entry)
              if (index >= 0) current.splice(index, 1)
              if (!current.length) slotMounts.delete(name)
            })
          },
          registerTrackMenuItem: (item) => {
            if (!item?.label || typeof item.onClick !== 'function') {
              throw new Error('Track menu item requires label and onClick')
            }
            const entry = {
              pluginId,
              id: String(item.id || `${pluginId}:${trackMenuItems.length}`),
              label: String(item.label),
              icon: String(item.icon || 'plugin'),
              danger: Boolean(item.danger),
              order: Number(item.order) || 100,
              when: typeof item.when === 'function' ? item.when : null,
              onClick: item.onClick,
            }
            trackMenuItems.push(entry)
            trackMenuItems.sort((a, b) => a.order - b.order)
            return track(() => {
              const index = trackMenuItems.indexOf(entry)
              if (index >= 0) trackMenuItems.splice(index, 1)
            })
          },
          registerPlaylistMenuItem: (item) => {
            if (!item?.label || typeof item.onClick !== 'function') {
              throw new Error('Playlist menu item requires label and onClick')
            }
            const entry = {
              pluginId,
              id: String(item.id || `${pluginId}:${playlistMenuItems.length}`),
              label: String(item.label),
              icon: String(item.icon || 'plugin'),
              danger: Boolean(item.danger),
              order: Number(item.order) || 100,
              when: typeof item.when === 'function' ? item.when : null,
              onClick: item.onClick,
            }
            playlistMenuItems.push(entry)
            playlistMenuItems.sort((a, b) => a.order - b.order)
            return track(() => {
              const index = playlistMenuItems.indexOf(entry)
              if (index >= 0) playlistMenuItems.splice(index, 1)
            })
          },
          registerSettingsCard: (card) => {
            if (!card?.id || typeof card.render !== 'function') {
              throw new Error('Settings card requires id and render function')
            }
            const key = `${pluginId}:${card.id}`
            const entry = {
              pluginId,
              key,
              id: String(card.id),
              section: String(card.section || 'extensions'),
              order: Number(card.order) || 100,
              render: card.render,
            }
            customSettingsCards.set(key, entry)
            if (hostApp?.state?.route === 'settings') hostApp.actions?.renderSettings?.()
            return track(() => {
              if (customSettingsCards.get(key) === entry) customSettingsCards.delete(key)
              if (hostApp?.state?.route === 'settings') hostApp.actions?.renderSettings?.()
            })
          },
          registerSettingsRenderer: (renderFn) => {
            if (typeof renderFn !== 'function') throw new TypeError('Settings renderer must be a function')
            customSettingsRenderers.set(pluginId, renderFn)
            return track(() => {
              if (customSettingsRenderers.get(pluginId) === renderFn) customSettingsRenderers.delete(pluginId)
            })
          },
        },

        auth: {
          getState: () => ({
            loggedIn: Boolean(hostApp?.state?.loggedIn),
            profile: hostApp?.state?.profile ? { ...hostApp.state.profile } : null,
          }),
          showLogin: () => hostApp?.actions?.showLogin?.(),
          logout: () => hostApp?.actions?.logout?.(),
          reloadAccount: () => hostApp?.actions?.loadAccount?.(),
          completeLogin: async (profile) => {
            if (!hostApp?.state) return
            hostApp.state.loggedIn = true
            if (profile) hostApp.state.profile = profile
            hostApp.actions?.closeModal?.()
            await hostApp.actions?.afterLogin?.()
          },
          registerLoginTab: (tab) => {
            if (!tab?.id || !tab?.label || typeof tab.render !== 'function') {
              throw new Error('Login tab requires id, label, and render function')
            }
            const key = `${pluginId}:${tab.id}`
            const entry = {
              pluginId,
              key,
              id: String(tab.id),
              label: String(tab.label),
              order: Number(tab.order) || 100,
              render: tab.render,
              unmount: typeof tab.unmount === 'function' ? tab.unmount : null,
            }
            customLoginTabs.set(key, entry)
            return track(() => {
              if (customLoginTabs.get(key) === entry) customLoginTabs.delete(key)
            })
          },
          replaceLoginModal: (handler, priority = 0) => {
            if (typeof handler !== 'function') throw new TypeError('Login modal replacement must be a function')
            const entry = { pluginId, priority: Number(priority) || 0, handler }
            loginModalOverrides.push(entry)
            loginModalOverrides.sort((a, b) => b.priority - a.priority)
            return track(() => {
              const index = loginModalOverrides.indexOf(entry)
              if (index >= 0) loginModalOverrides.splice(index, 1)
            })
          },
        },

        player: {
          getState: () => ({
            current: hostApp?.state?.current || null,
            queue: [...(hostApp?.state?.queue || [])],
            queueIndex: hostApp?.state?.queueIndex ?? -1,
            paused: Boolean(hostApp?.dom?.audio?.paused ?? true),
            currentTime: Number(hostApp?.dom?.audio?.currentTime || 0),
            duration: Number(hostApp?.actions?.playbackDuration?.() || 0),
            volume: Number(hostApp?.state?.userVolume ?? 0.75),
            muted: Boolean(hostApp?.dom?.audio?.muted),
            playMode: hostApp?.state?.playMode || 'repeat-all',
            radioMode: Boolean(hostApp?.state?.radioMode),
            audioQuality: hostApp?.state?.audioQuality || 'best',
            immersiveOpen: Boolean(hostApp?.dom?.immersive?.classList?.contains('open')),
            immersiveView: hostApp?.state?.immersiveView || 'lyrics',
            lyrics: [...(hostApp?.state?.lyrics || [])],
            activeLyric: hostApp?.state?.activeLyric ?? -1,
          }),
          play: () => hostApp?.actions?.play?.(),
          pause: () => hostApp?.actions?.pause?.(),
          togglePlay: () => hostApp?.actions?.togglePlayback?.(),
          next: () => hostApp?.actions?.nextTrack?.(1),
          previous: () => hostApp?.actions?.nextTrack?.(-1),
          seek: (seconds) => hostApp?.actions?.seekCurrentTrack?.(seconds),
          setVolume: (value) => hostApp?.actions?.setVolume?.(value),
          toggleMute: () => hostApp?.actions?.toggleMute?.(),
          playTracks: (tracks, index = 0, opts = {}) => hostApp?.actions?.playTracks?.(tracks, index, opts),
          queueNext: (trackItem) => hostApp?.actions?.queueTrackNext?.(trackItem),
          insertQueue: (trackItem, index) => hostApp?.actions?.insertTrackIntoQueue?.(trackItem, index),
          removeQueue: (index) => hostApp?.actions?.removeQueueTrack?.(index),
          clearQueue: () => hostApp?.actions?.clearPlaybackQueue?.(),
          openImmersive: (open = true) => hostApp?.actions?.openImmersive?.(open),
          setImmersiveView: (viewId) => hostApp?.actions?.setImmersiveView?.(viewId),
          registerStyle: (styleDef) => {
            if (!styleDef?.id || !styleDef?.label) throw new Error('Player style requires id and label')
            const id = String(styleDef.id).includes(':') ? String(styleDef.id) : `plugin:${pluginId}:${styleDef.id}`
            const cleanups = []
            if (styleDef.css) cleanups.push(injectStyleElement(pluginId, styleDef.css, `player-style:${id}`))
            if (styleDef.cssFile) cleanups.push(injectLinkElement(pluginId, api.assetUrl(styleDef.cssFile), `player-style-file:${id}`))
            const entry = {
              pluginId,
              id,
              label: String(styleDef.label),
              className: styleDef.className ? String(styleDef.className) : '',
              onActivate: typeof styleDef.onActivate === 'function' ? styleDef.onActivate : null,
              onDeactivate: typeof styleDef.onDeactivate === 'function' ? styleDef.onDeactivate : null,
            }
            customPlayerStyles.set(id, entry)
            hostApp?.onPlayerStylesChanged?.()
            return track(() => {
              if (customPlayerStyles.get(id) === entry) customPlayerStyles.delete(id)
              for (const dispose of cleanups) dispose()
              hostApp?.onPlayerStylesChanged?.()
            })
          },
          registerImmersiveView: (viewDef) => {
            if (!viewDef?.id || !viewDef?.label || typeof viewDef.render !== 'function') {
              throw new Error('Immersive view requires id, label, and render function')
            }
            const id = `plugin:${pluginId}:${viewDef.id}`
            const entry = {
              pluginId,
              id,
              label: String(viewDef.label),
              icon: String(viewDef.icon || 'plugin'),
              order: Number(viewDef.order) || 100,
              render: viewDef.render,
              onShow: typeof viewDef.onShow === 'function' ? viewDef.onShow : null,
              onHide: typeof viewDef.onHide === 'function' ? viewDef.onHide : null,
              unmount: typeof viewDef.unmount === 'function' ? viewDef.unmount : null,
            }
            customImmersiveViews.set(id, entry)
            hostApp?.onImmersiveViewsChanged?.()
            return track(() => {
              if (customImmersiveViews.get(id) === entry) {
                try { entry.unmount?.() } catch {}
                customImmersiveViews.delete(id)
              }
              hostApp?.onImmersiveViewsChanged?.()
            })
          },
          audio: {
            getElement: () => hostApp?.dom?.audio || null,
            getGraph: () => {
              const graph = ensureAudioGraph()
              return { context: graph.context, analyser: graph.analyser }
            },
            connectNode: (factory) => {
              const graph = ensureAudioGraph()
              const created = typeof factory === 'function' ? factory(graph.context) : factory
              const input = created?.input || created
              const output = created?.output || created
              if (!input || !output) throw new Error('Audio node factory must return an AudioNode or { input, output }')
              const entry = {
                pluginId,
                input,
                output,
                dispose: typeof created?.dispose === 'function' ? created.dispose : null,
              }
              graph.nodes.push(entry)
              reconnectAudioGraph()
              return track(() => {
                const index = graph.nodes.indexOf(entry)
                if (index >= 0) graph.nodes.splice(index, 1)
                try { entry.output?.disconnect?.() } catch {}
                try { entry.dispose?.() } catch {}
                reconnectAudioGraph()
              })
            },
          },
        },

        lyrics: {
          getCurrent: () => ({
            lines: [...(hostApp?.state?.lyrics || [])],
            breaks: [...(hostApp?.state?.lyricBreaks || [])],
            activeIndex: hostApp?.state?.activeLyric ?? -1,
            rawBody: hostApp?.state?.lyricsBody || null,
          }),
          refresh: () => hostApp?.actions?.refreshPlayerStyle?.({ lyrics: true }),
          setLyrics: (lines, breaks = []) => hostApp?.actions?.setCustomLyrics?.(lines, breaks),
        },

        shortcuts: {
          register: (combo, handler, opts = {}) => {
            if (typeof handler !== 'function') throw new TypeError('Shortcut handler must be a function')
            const entry = {
              pluginId,
              combo: String(combo),
              parsed: normalizeShortcutCombo(combo),
              handler,
              allowInInput: Boolean(opts.allowInInput),
              description: String(opts.description || ''),
            }
            shortcuts.push(entry)
            return track(() => {
              const index = shortcuts.indexOf(entry)
              if (index >= 0) shortcuts.splice(index, 1)
            })
          },
        },

        i18n: {
          t: (key, params) => i18n?.t ? i18n.t(key, params) : key,
          getLocale: () => i18n?.locale || 'zh-CN',
          register: (localeCode, entries) => track(i18n?.extend ? i18n.extend(localeCode, entries) : () => {}),
          onChange: (handler) => track(i18n?.onChange ? i18n.onChange(handler) : () => {}),
        },

        services: {
          provide: (name, implementation) => {
            const serviceName = String(name || '').trim()
            if (!serviceName) throw new Error('Service name is required')
            const entry = { pluginId, implementation }
            rendererServices.set(serviceName, entry)
            return track(() => {
              if (rendererServices.get(serviceName) === entry) rendererServices.delete(serviceName)
            })
          },
          get: (name) => rendererServices.get(String(name || ''))?.implementation ?? null,
          list: () => [...rendererServices.keys()],
        },

        core,
        bridge,

        app: {
          get state() { return hostApp?.state || null },
          get dom() { return hostApp?.dom || null },
          get actions() { return hostApp?.actions || {} },
          patch: (actionName, wrapper) => track(createPatchAction(pluginId)(actionName, wrapper)),
        },
      }

      return api
    }

    async function activatePlugin(descriptor) {
      if (!descriptor || !descriptor.enabled || descriptor.missing) return
      const existing = activePlugins.get(descriptor.id)
      if (existing && existing.revision === descriptor.revision) {
        existing.descriptor = descriptor
        existing.settings = { ...(descriptor.settings || {}) }
        return
      }
      if (existing) {
        await deactivatePlugin(descriptor.id)
      }

      const runtime = {
        id: descriptor.id,
        revision: descriptor.revision || 1,
        descriptor,
        settings: { ...(descriptor.settings || {}) },
        exports: null,
        api: null,
        disposables: [],
        settingsWatchers: new Set(),
        backendListeners: new Map(),
      }
      activePlugins.set(descriptor.id, runtime)

      try {
        const api = createPluginApi(descriptor, runtime)
        runtime.api = api

        // 1. Declarative locales
        const locales = descriptor.contributes?.locales || {}
        for (const [localeCode, dict] of Object.entries(locales)) {
          api.i18n.register(localeCode, dict)
        }

        // 2. Declarative themes
        const themes = descriptor.contributes?.themes || []
        for (const theme of themes) {
          api.theme.register(theme)
        }

        // 3. Declarative stylesheets
        for (const styleUrl of descriptor.styleUrls || []) {
          runtime.disposables.push(injectLinkElement(descriptor.id, styleUrl, 'manifest-style'))
        }

        // 4. Renderer JS module
        if (descriptor.rendererUrl) {
          const mod = await importModule(descriptor.rendererUrl)
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
            if (typeof ret === 'function') runtime.disposables.push(ret)
            else if (ret && typeof ret.dispose === 'function') runtime.disposables.push(() => ret.dispose())
          }
        }

        bridge?.plugins?.reportRendererState?.(descriptor.id, { active: true, error: null })
      } catch (error) {
        const formatted = formatError(error)
        console.error(`[plugin:${descriptor.id}] Renderer activation failed:`, error)
        bridge?.plugins?.reportRendererState?.(descriptor.id, { active: false, error: formatted })
        await deactivatePlugin(descriptor.id, { reportState: false })
      }
    }

    async function deactivatePlugin(pluginId, { reportState = true } = {}) {
      const runtime = activePlugins.get(pluginId)
      if (!runtime) return false
      activePlugins.delete(pluginId)

      try {
        const deactivateFn = typeof runtime.exports?.deactivate === 'function'
          ? runtime.exports.deactivate
          : typeof runtime.exports?.default?.deactivate === 'function'
            ? runtime.exports.default.deactivate
            : null
        if (deactivateFn) {
          await deactivateFn(runtime.api)
        }
      } catch (error) {
        console.error(`[plugin:${pluginId}] Renderer deactivate failed:`, error)
      }

      for (let index = runtime.disposables.length - 1; index >= 0; index -= 1) {
        try {
          await runtime.disposables[index]()
        } catch (error) {
          console.warn(`[plugin:${pluginId}] Renderer dispose error:`, error)
        }
      }
      runtime.disposables.length = 0
      runtime.settingsWatchers.clear()
      runtime.backendListeners.clear()

      if (reportState) {
        bridge?.plugins?.reportRendererState?.(pluginId, { active: false, error: null })
      }
      return true
    }

    async function sync(descriptors = []) {
      pluginDescriptors = Array.isArray(descriptors) ? descriptors : []
      const enabledById = new Map()
      for (const item of pluginDescriptors) {
        if (item && item.enabled && !item.missing) {
          enabledById.set(item.id, item)
        }
      }

      // Deactivate removed, disabled, or revision-changed plugins first.
      for (const [id, runtime] of [...activePlugins.entries()]) {
        const next = enabledById.get(id)
        if (!next || next.revision !== runtime.revision) {
          await deactivatePlugin(id)
        }
      }

      // Activate newly enabled or updated plugins.
      for (const item of enabledById.values()) {
        await activatePlugin(item)
      }

      refreshSlots(doc)
      notifyHostChanged('synced')
      return pluginDescriptors
    }

    function handleKeydown(event) {
      if (!shortcuts.length) return false
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(doc?.activeElement?.tagName)
        || Boolean(doc?.activeElement?.isContentEditable)
      for (const entry of [...shortcuts]) {
        if (typing && !entry.allowInInput) continue
        if (!matchesShortcut(event, entry.parsed)) continue
        try {
          const result = entry.handler(event)
          if (result !== false) {
            event.preventDefault()
            return true
          }
        } catch (error) {
          console.error(`[plugin:${entry.pluginId}] Shortcut "${entry.combo}" failed:`, error)
        }
      }
      return false
    }

    async function initialize(appBinding) {
      hostApp = appBinding || hostApp
      if (initialized) return pluginDescriptors
      initialized = true

      try {
        const version = await bridge?.app?.version?.()
        if (version) appVersion = String(version)
      } catch {}

      bridge?.plugins?.onChanged?.((payload) => {
        if (Array.isArray(payload?.plugins)) {
          void sync(payload.plugins)
        }
      })

      bridge?.plugins?.onSettingsChanged?.((payload) => {
        const runtime = activePlugins.get(payload?.pluginId)
        if (!runtime) return
        runtime.settings = { ...(payload.settings || {}) }
        for (const watcher of runtime.settingsWatchers) {
          try { watcher(runtime.settings, payload.patch || {}) } catch (error) {
            console.error(`[plugin:${payload.pluginId}] settings onChange error:`, error)
          }
        }
        const desc = pluginDescriptors.find((item) => item.id === payload?.pluginId)
        if (desc) desc.settings = { ...runtime.settings }
      })

      bridge?.plugins?.onBackendEvent?.((payload) => {
        const runtime = activePlugins.get(payload?.pluginId)
        if (!runtime) return
        const set = runtime.backendListeners.get(payload?.event)
        if (!set?.size) return
        for (const listener of [...set]) {
          try { listener(payload.payload) } catch (error) {
            console.error(`[plugin:${payload.pluginId}] backend event "${payload.event}" error:`, error)
          }
        }
      })

      if (bridge?.plugins?.list) {
        try {
          const response = await bridge.plugins.list()
          if (response?.ok && Array.isArray(response.data)) {
            await sync(response.data)
          }
        } catch (error) {
          console.warn('[plugins] Unable to initialize plugins:', error)
        }
      }
      return pluginDescriptors
    }

    return {
      initialize,
      sync,
      activatePlugin,
      deactivatePlugin,
      onHostChange,
      runHook,
      runSyncHook,
      emit,
      refreshSlots,
      handleKeydown,
      getPlugins: () => pluginDescriptors,
      getActivePluginIds: () => [...activePlugins.keys()],
      getThemes: () => [...customThemes.values()],
      getPlayerStyles: () => [...customPlayerStyles.values()],
      getFonts: () => [...customFonts.values()],
      getImmersiveViews: () => [...customImmersiveViews.values()].sort((a, b) => a.order - b.order),
      getNavItems: () => [...customNavItems.values()].sort((a, b) => a.order - b.order),
      getRoute: (name) => customRoutes.get(String(name || '')) || null,
      getSettingsCards: () => [...customSettingsCards.values()].sort((a, b) => a.order - b.order),
      getSettingsRenderer: (pluginId) => customSettingsRenderers.get(pluginId) || null,
      getLoginTabs: () => [...customLoginTabs.values()].sort((a, b) => a.order - b.order),
      getLoginModalOverride: () => loginModalOverrides[0]?.handler || null,
      getTrackMenuItems: (track, context) => trackMenuItems.filter((item) => {
        if (!item.when) return true
        try { return Boolean(item.when(track, context)) } catch { return false }
      }),
      getPlaylistMenuItems: (playlist, context) => playlistMenuItems.filter((item) => {
        if (!item.when) return true
        try { return Boolean(item.when(playlist, context)) } catch { return false }
      }),
    }
  }

  root.MenoRadioPluginsFactory = createPluginHost
  root.MenoRadioPlugins = createPluginHost()
})(window)
