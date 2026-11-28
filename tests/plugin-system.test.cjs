const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

const semver = require('../electron/plugin-semver.cjs')
const archive = require('../electron/plugin-archive.cjs')
const manifestLoader = require('../electron/plugin-manifest.cjs')
const { createPluginManager } = require('../electron/plugin-manager.cjs')

function makeTempDir(prefix = 'menoradio-plugin-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('SemVer range evaluator handles comparators, caret, tilde, hyphens, OR and prereleases', () => {
  assert.equal(semver.satisfiesRange('0.17.0', '>=0.17.0 <1.0.0'), true)
  assert.equal(semver.satisfiesRange('0.16.9', '>=0.17.0 <1.0.0'), false)
  assert.equal(semver.satisfiesRange('0.17.5', '^0.17.0'), true)
  assert.equal(semver.satisfiesRange('0.18.0', '^0.17.0'), false)
  assert.equal(semver.satisfiesRange('1.4.2', '^1.2.0'), true)
  assert.equal(semver.satisfiesRange('2.0.0', '^1.2.0'), false)
  assert.equal(semver.satisfiesRange('0.17.3', '~0.17.0'), true)
  assert.equal(semver.satisfiesRange('0.18.0', '~0.17.0'), false)
  assert.equal(semver.satisfiesRange('0.19.0', '0.17.0 - 0.20.0'), true)
  assert.equal(semver.satisfiesRange('0.21.0', '0.17.0 - 0.20.0'), false)
  assert.equal(semver.satisfiesRange('0.17.0', '0.16.x || 0.17.x'), true)
  assert.equal(semver.satisfiesRange('0.17.0', '*'), true)
  assert.equal(semver.compareVersions('0.17.0-beta.1', '0.17.0'), -1)

  const compat = semver.evaluateCompatibility('0.17.0', '>=0.17.0 <1.0.0')
  assert.equal(compat.status, 'compatible')
  assert.equal(compat.compatible, true)

  const incompat = semver.evaluateCompatibility('0.17.0', '>=0.18.0')
  assert.equal(incompat.status, 'incompatible')
  assert.equal(incompat.compatible, false)

  const invalid = semver.evaluateCompatibility('0.17.0', 'not-a-range!!')
  assert.equal(invalid.status, 'invalid-range')
  assert.equal(invalid.compatible, false)
})

test('ZIP archive reader extracts store/deflate archives and blocks Zip-Slip traversal', () => {
  const tmp = makeTempDir()
  try {
    const zipBuf = archive.createZipBuffer([
      { name: 'my-plugin/plugin.json', content: JSON.stringify({ name: 'Demo', version: '1.0.0' }), compress: true },
      { name: 'my-plugin/main.cjs', content: 'module.exports = {}', compress: false },
    ])
    const zipPath = path.join(tmp, 'demo.mrplugin')
    fs.writeFileSync(zipPath, zipBuf)

    const outDir = path.join(tmp, 'extracted')
    archive.extractZipArchive(zipPath, outDir)
    const root = manifestLoader.locatePluginRoot(outDir)
    assert.equal(path.basename(root), 'my-plugin')
    assert.equal(fs.existsSync(path.join(root, 'plugin.json')), true)

    const evilBuf = archive.createZipBuffer([
      { name: '../escape.txt', content: 'pwned' },
    ])
    const evilPath = path.join(tmp, 'evil.zip')
    fs.writeFileSync(evilPath, evilBuf)
    assert.throws(() => archive.extractZipArchive(evilPath, path.join(tmp, 'evil-out')), /不安全的路径/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('manifest loader validates required display fields and loads built-in example plugins', () => {
  const auroraDir = path.join(__dirname, '..', 'examples', 'plugins', 'aurora-studio')
  const aurora = manifestLoader.loadManifestFromDir(auroraDir, '0.18.0')
  assert.equal(aurora.id, 'com.menoradio.aurora-studio')
  assert.equal(aurora.name, 'Aurora Studio')
  assert.equal(aurora.author, 'ichiris')
  assert.ok(aurora.description.length > 0)
  assert.equal(aurora.version, '1.0.0')
  assert.equal(aurora.supportedVersions, '>=0.18.0 <1.0.0')
  assert.equal(aurora.compatibility.compatible, true)
  assert.equal(aurora.contributes.themes.length, 1)
  assert.equal(aurora.contributes.settings.length, 3)

  const loginDemoDir = path.join(__dirname, '..', 'examples', 'plugins', 'custom-login-demo')
  const loginDemo = manifestLoader.loadManifestFromDir(loginDemoDir, '0.18.0')
  assert.equal(loginDemo.id, 'com.menoradio.custom-login-demo')
  assert.equal(loginDemo.author, 'ichiris')
  assert.equal(loginDemo.compatibility.compatible, true)

  const tmp = makeTempDir()
  try {
    fs.writeFileSync(path.join(tmp, 'plugin.json'), JSON.stringify({
      name: 'Broken',
      version: '1.0.0',
      main: '../outside.cjs',
    }))
    assert.throws(() => manifestLoader.loadManifestFromDir(tmp, '0.17.0'), /不能跳出插件目录/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('PluginManager supports full backend lifecycle: install, link, archive, IPC intercept, hooks, reload, version guard and cleanup', async () => {
  const tmp = makeTempDir()
  const userDataDir = path.join(tmp, 'userdata')
  const sourcePluginDir = path.join(tmp, 'dev-plugin')
  fs.mkdirSync(sourcePluginDir, { recursive: true })

  fs.writeFileSync(path.join(sourcePluginDir, 'plugin.json'), JSON.stringify({
    id: 'test.backend.power',
    name: 'Power Backend',
    author: 'Tester',
    description: 'Tests backend IPC, hooks, media, protocol, services and hot reload.',
    version: '1.0.0',
    supportedVersions: '>=0.17.0 <1.0.0',
    main: 'main.cjs',
    contributes: {
      settings: [{ key: 'prefix', type: 'string', label: 'Prefix', default: 'v1' }],
    },
  }))

  fs.writeFileSync(path.join(sourcePluginDir, 'main.cjs'), `
    module.exports = {
      activate(ctx) {
        ctx.storage.set('booted', (ctx.storage.get('booted', 0) || 0) + 1)
        ctx.ipc.handle('ping', (payload) => ({
          pong: true,
          prefix: ctx.settings.get('prefix'),
          echo: payload,
          booted: ctx.storage.get('booted'),
        }))
        ctx.ipc.intercept('data:song-url', async (payload, next) => {
          const res = await next(payload)
          return { ...res, interceptedBy: ctx.id, prefix: ctx.settings.get('prefix') }
        })
        ctx.hooks.afterApi(({ name, result }) => {
          if (name === 'song_url_v1') return { result: { ...result, hooked: true } }
        })
        ctx.media.allowHost('custom-cdn.local')
        ctx.protocol.registerRoute('api/hello', () => ({ hello: ctx.settings.get('prefix') }))
        ctx.services.provide('power.svc', { greet: (who) => 'hi ' + who })
      }
    }
  `)

  const broadcasts = []
  const manager = createPluginManager({
    appVersion: '0.18.0',
    userDataDir,
    host: {
      onBroadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    },
  })

  try {
    await manager.initialize()
    assert.deepEqual(manager.listPlugins(), [])

    // 1. Link dev plugin
    const linked = await manager.installFromDirectory(sourcePluginDir, { link: true })
    assert.equal(linked.id, 'test.backend.power')
    assert.equal(linked.source, 'linked')
    assert.equal(linked.enabled, true)
    assert.equal(linked.backendActive, true)

    // 2. Backend IPC method, service, IPC interceptor, API hook, media allowlist, protocol route
    const ping1 = await manager.invokePluginBackend('test.backend.power', 'ping', 'hello')
    assert.equal(ping1.pong, true)
    assert.equal(ping1.prefix, 'v1')
    assert.equal(ping1.echo, 'hello')
    assert.equal(ping1.booted, 1)

    assert.equal(await manager.invokePluginService('power.svc', 'greet', 'Meno'), 'hi Meno')

    const wrapped = manager.wrapIpcHandler('data:song-url', async (_e, payload) => ({ ok: true, id: payload.id }))
    const ipcRes = await wrapped({}, { id: '123' })
    assert.equal(ipcRes.interceptedBy, 'test.backend.power')
    assert.equal(ipcRes.prefix, 'v1')

    const apiAfter = await manager.runHook('api:after', { name: 'song_url_v1', result: { code: 200 } })
    assert.equal(apiAfter.result.hooked, true)

    assert.equal(manager.isMediaHostAllowed(new URL('https://custom-cdn.local/track.flac')), true)
    assert.equal(manager.isMediaHostAllowed(new URL('https://blocked.example/track.flac')), false)

    const protoResp = await manager.handleProtocolRequest({ url: 'menoradio-plugin://test.backend.power/api/hello' })
    assert.equal(protoResp.status, 200)
    assert.deepEqual(await protoResp.json(), { hello: 'v1' })

    // 3. Settings update persists and updates live backend reads
    manager.setPluginSettings('test.backend.power', { prefix: 'v2' })
    const ping2 = await manager.invokePluginBackend('test.backend.power', 'ping', 'again')
    assert.equal(ping2.prefix, 'v2')

    // 4. Hot reload picks up edited main.cjs after clearing require.cache
    fs.writeFileSync(path.join(sourcePluginDir, 'main.cjs'), `
      module.exports = {
        activate(ctx) {
          ctx.ipc.handle('ping', () => ({ reloaded: true, version: 2 }))
        }
      }
    `)
    await manager.reloadPlugin('test.backend.power')
    assert.deepEqual(await manager.invokePluginBackend('test.backend.power', 'ping'), { reloaded: true, version: 2 })

    // 5. Disable cleans up ALL disposables cleanly
    await manager.disablePlugin('test.backend.power')
    await assert.rejects(() => manager.invokePluginBackend('test.backend.power', 'ping'))
    assert.equal(manager.isMediaHostAllowed(new URL('https://custom-cdn.local/track.flac')), false)
    const unintercepted = await wrapped({}, { id: '456' })
    assert.equal(unintercepted.interceptedBy, undefined)

    // 6. Uninstall linked plugin never deletes source directory
    await manager.uninstallPlugin('test.backend.power', { removeData: true })
    assert.equal(fs.existsSync(sourcePluginDir), true)
    assert.equal(manager.getPlugin('test.backend.power'), null)

    // 7. Install incompatible plugin from .mrplugin archive -> stays disabled until force enabled
    const incompatZip = archive.createZipBuffer([
      {
        name: 'future-plugin/plugin.json',
        content: JSON.stringify({
          id: 'test.future.plugin',
          name: 'Future Only',
          author: 'Time Traveler',
          description: 'Requires v9.0.0+',
          version: '2.0.0',
          supportedVersions: '>=9.0.0',
          main: 'main.cjs',
        }),
      },
      {
        name: 'future-plugin/main.cjs',
        content: 'module.exports = { activate(ctx) { ctx.ipc.handle("ok", () => true) } }',
      },
    ])
    const archivePath = path.join(tmp, 'future.mrplugin')
    fs.writeFileSync(archivePath, incompatZip)

    const installed = await manager.installFromPath(archivePath)
    assert.equal(installed.source, 'installed')
    assert.equal(installed.compatibility.status, 'incompatible')
    assert.equal(installed.enabled, false)

    await assert.rejects(
      () => manager.enablePlugin('test.future.plugin', { force: false }),
      (err) => err?.code === 'INCOMPATIBLE_VERSION'
    )

    const forced = await manager.enablePlugin('test.future.plugin', { force: true })
    assert.equal(forced.enabled, true)
    assert.equal(await manager.invokePluginBackend('test.future.plugin', 'ok'), true)

    // 8. Install & activate real example plugins end-to-end
    const aurora = await manager.installFromDirectory(path.join(__dirname, '..', 'examples', 'plugins', 'aurora-studio'), { link: true })
    assert.equal(aurora.enabled, true)
    assert.equal(aurora.backendActive, true)
    manager.emitEvent('player:track-changed', { track: { id: '777', name: 'Test Song', artist: 'Artist' } })
    const stats = await manager.invokePluginBackend('com.menoradio.aurora-studio', 'getStats')
    assert.equal(stats.totalPlays, 1)
    assert.equal(stats.tracks['777'].count, 1)

    const loginDemo = await manager.installFromDirectory(path.join(__dirname, '..', 'examples', 'plugins', 'custom-login-demo'), { link: true })
    assert.equal(loginDemo.enabled, true)
    const customAuth = await manager.invokePluginBackend('com.menoradio.custom-login-demo', 'signInCustom', { nickname: 'Alice' })
    assert.equal(customAuth.profile.nickname, 'Alice')
    const authStateWrapped = manager.wrapIpcHandler('auth:state', async () => ({ ok: true, data: { loggedIn: false, profile: null } }))
    const authState = await authStateWrapped({}, null)
    assert.equal(authState.data.loggedIn, true)
    assert.equal(authState.data.profile.nickname, 'Alice')

    assert.ok(broadcasts.some((b) => b.channel === 'plugins:changed'))
    await manager.shutdown()
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('Renderer plugin host activates/deactivates themes, login tabs, routes, slots, shortcuts, hooks and reversible patches cleanly', async () => {
  const createdElements = []
  const makeEl = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      nodeType: 1,
      dataset: {},
      className: '',
      children: [],
      textContent: '',
      innerHTML: '',
      style: {
        map: new Map(),
        getPropertyValue(k) { return this.map.get(k) || '' },
        setProperty(k, v) { this.map.set(k, v) },
        removeProperty(k) { this.map.delete(k) },
      },
      attributes: new Map(),
      setAttribute(k, v) { this.attributes.set(k, v) },
      appendChild(child) { this.children.push(child); child.parent = this; return child },
      remove() {
        if (this.parent) {
          const i = this.parent.children.indexOf(this)
          if (i >= 0) this.parent.children.splice(i, 1)
          this.parent = null
        }
      },
      querySelector(sel) {
        const keyMatch = /\[data-plugin-slot-key="([^"]+)"\]/.exec(sel)
        if (keyMatch) return this.children.find((c) => c.dataset.pluginSlotKey === keyMatch[1]) || null
        return null
      },
    }
    createdElements.push(el)
    return el
  }

  const head = makeEl('head')
  const slotToolbar = makeEl('div')
  slotToolbar.dataset.pluginSlot = 'toolbar-actions'
  const sprite = makeEl('svg')

  const mockDocument = {
    head,
    documentElement: makeEl('html'),
    activeElement: null,
    createElement: makeEl,
    createElementNS: (_ns, tag) => makeEl(tag),
    getElementById: (id) => sprite.children.find((c) => c.id === id) || null,
    querySelector: (sel) => sel === '.svg-sprite' ? sprite : null,
    querySelectorAll: (sel) => sel === '[data-plugin-slot]' ? [slotToolbar] : [],
  }

  const storage = new Map()
  const mockWindow = {
    document: mockDocument,
    Node: class {},
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
  }

  const context = vm.createContext({
    window: mockWindow,
    document: mockDocument,
    console,
  })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'i18n.js'), 'utf8'), context)
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'plugin-host.js'), 'utf8'), context)

  const i18n = context.window.MenoRadioI18n
  i18n.register('en', { '设置': 'Settings' })
  i18n.setLanguage('en')

  let baseToastCalls = []
  let shortcutHits = 0
  const hostActions = {
    toast: (msg) => { baseToastCalls.push(msg); return msg },
    navigate: () => {},
  }
  const reportedStates = []

  const host = context.window.MenoRadioPluginsFactory({
    window: mockWindow,
    document: mockDocument,
    i18n,
    core: {},
    bridge: {
      app: { version: async () => '0.17.0' },
      plugins: {
        list: async () => ({ ok: true, data: [] }),
        reportRendererState: (id, s) => reportedStates.push({ id, ...s }),
      },
    },
    importModule: async (url) => {
      if (url.includes('good-plugin')) {
        return {
          activate(api) {
            api.ui.registerNavItem({ id: 'hub', label: 'Hub', route: 'plugin:good:hub' })
            api.ui.registerRoute('plugin:good:hub', { render: () => {} })
            api.ui.mountSlot('toolbar-actions', () => '<span>Hi</span>')
            api.auth.registerLoginTab({ id: 'sso', label: 'SSO', render: () => {} })
            api.player.registerStyle({ id: 'vinyl', label: 'Vinyl' })
            api.player.registerImmersiveView({ id: 'viz', label: 'Viz', render: () => {} })
            api.ui.registerTrackMenuItem({ id: 't1', label: 'Inspect', onClick: () => {} })
            api.shortcuts.register('Ctrl+Shift+Y', () => { shortcutHits += 1 })
            api.hooks.tap('lyrics:renderLine', ({ html }) => ({ html: `${html}<!--ok-->` }))
            api.app.patch('toast', (next, msg) => next(`[patched] ${msg}`))
          },
        }
      }
      if (url.includes('broken-plugin')) {
        return {
          activate() {
            throw new Error('Intentional plugin crash')
          },
        }
      }
      return {}
    },
  })

  await host.initialize({
    state: { theme: 'dark', route: 'home' },
    dom: {},
    actions: hostActions,
  })

  await host.sync([
    {
      id: 'good-plugin',
      enabled: true,
      revision: 1,
      rendererUrl: 'menoradio-plugin://good-plugin/renderer.js?rev=1',
      styleUrls: ['menoradio-plugin://good-plugin/styles.css?rev=1'],
      contributes: {
        themes: [{ id: 'neon', label: 'Neon', colorScheme: 'dark', variables: { '--accent': '#00ffcc' } }],
        locales: { en: { 'custom.hello': 'Hello from plugin' } },
      },
      settings: {},
    },
    {
      id: 'broken-plugin',
      enabled: true,
      revision: 1,
      rendererUrl: 'menoradio-plugin://broken-plugin/renderer.js?rev=1',
      styleUrls: [],
      contributes: { themes: [], locales: {} },
      settings: {},
    },
  ])

  // Good plugin activated cleanly despite broken-plugin throwing
  assert.deepEqual([...host.getActivePluginIds()], ['good-plugin'])
  assert.equal(i18n.t('custom.hello'), 'Hello from plugin')
  assert.equal(host.getThemes().length, 1)
  assert.equal(host.getPlayerStyles().length, 1)
  assert.equal(host.getImmersiveViews().length, 1)
  assert.equal(host.getNavItems().length, 1)
  assert.ok(host.getRoute('plugin:good:hub'))
  assert.equal(host.getLoginTabs().length, 1)
  assert.equal(host.getTrackMenuItems({}, {}).length, 1)
  assert.equal(slotToolbar.children.length, 1)

  // Hook & action patch & shortcut work
  assert.equal(host.runSyncHook('lyrics:renderLine', { html: '<div>A</div>' }).html, '<div>A</div><!--ok-->')
  hostActions.toast('hello')
  assert.equal(baseToastCalls.at(-1), '[patched] hello')
  assert.equal(host.handleKeydown({ key: 'y', code: 'KeyY', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, preventDefault() {} }), true)
  assert.equal(shortcutHits, 1)

  // Broken plugin reported its error cleanly
  const brokenReport = reportedStates.find((r) => r.id === 'broken-plugin' && r.error)
  assert.ok(brokenReport)
  assert.match(brokenReport.error.message, /Intentional plugin crash/)

  // Disabling good-plugin disposes EVERYTHING cleanly
  await host.sync([])
  assert.deepEqual([...host.getActivePluginIds()], [])
  assert.equal(i18n.t('custom.hello'), 'custom.hello')
  assert.equal(host.getThemes().length, 0)
  assert.equal(host.getPlayerStyles().length, 0)
  assert.equal(host.getImmersiveViews().length, 0)
  assert.equal(host.getNavItems().length, 0)
  assert.equal(host.getRoute('plugin:good:hub'), null)
  assert.equal(host.getLoginTabs().length, 0)
  assert.equal(host.getTrackMenuItems({}, {}).length, 0)
  assert.equal(slotToolbar.children.length, 0)
  assert.equal(head.children.length, 0)
  hostActions.toast('clean')
  assert.equal(baseToastCalls.at(-1), 'clean')
})

test('CSP headers allow both menoradio-media: and menoradio-plugin: schemes', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
  const indexPolicy = /Content-Security-Policy" content="([^"]+)"/.exec(indexHtml)?.[1] || ''
  assert.match(indexPolicy, /script-src[^;]*menoradio-plugin:/)
  assert.match(indexPolicy, /style-src[^;]*menoradio-plugin:/)
  assert.match(indexPolicy, /media-src[^;]*menoradio-media:/)
  assert.match(indexPolicy, /media-src[^;]*menoradio-plugin:/)

  const floatingHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'floating-lyrics.html'), 'utf8')
  const floatingPolicy = /Content-Security-Policy" content="([^"]+)"/.exec(floatingHtml)?.[1] || ''
  assert.match(floatingPolicy, /script-src[^;]*menoradio-plugin:/)
})

test('App ID and Windows NSIS installer desktop shortcut option are configured', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  assert.equal(pkg.build.appId, 'io.github.ichiris.menoradio')
  assert.equal(pkg.build.nsis.createDesktopShortcut, false)
  assert.equal(pkg.build.nsis.include, 'build/installer.nsh')

  const nsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8')
  assert.match(nsh, /!macro customPageAfterChangeDir/)
  assert.match(nsh, /\$\{NSD_CreateCheckbox\}/)
  assert.match(nsh, /创建桌面快捷方式/)
  assert.match(nsh, /CreateShortCut "\$DESKTOP\\\$\{SHORTCUT_NAME\}\.lnk"/)
  assert.match(nsh, /!ifndef BUILD_UNINSTALLER/)
})
