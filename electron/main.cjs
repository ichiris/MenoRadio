const { app, BrowserWindow, ipcMain, safeStorage, shell, nativeTheme, session, screen, net, protocol } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const QRCode = require('qrcode')

const playbackProtocolScheme = 'menoradio-media'
protocol.registerSchemesAsPrivileged([{
  scheme: playbackProtocolScheme,
  privileges: {
    standard: true,
    secure: true,
    stream: true,
    supportFetchAPI: true,
    corsEnabled: true,
  },
}])

const execFileAsync = promisify(execFile)

let musicApi
let mainWindow
let floatingLyricsWindow
let floatingLyricsSaveTimer
let floatingLyricsShowTimer
let floatingLyricsShowNotBefore = 0
let floatingLyricsPayload = {}
let floatingLyricsState = null
let floatingLyricsResizeSession = null
let floatingLyricsMoveSession = null
let sessionCookie = ''
let sessionProfile = null
let authStatusMisses = 0
let installedFontsCache = null
let resettingApplication = false

const thumbnailConcurrency = 12
const thumbnailBytesPerSecond = 1024 * 1024
const thumbnailMaximumBytes = 2 * 1024 * 1024
const thumbnailInitialCredit = 64 * 1024
const thumbnailCacheLimit = 420
let thumbnailActiveRequests = 0
let thumbnailBandwidthAvailableAt = 0
const thumbnailWaiters = []
const thumbnailCache = new Map()
const thumbnailInflight = new Map()

const mediaPreloadBytesPerSecond = 1024 * 1024
let mediaPreloadBandwidthAvailableAt = 0
let activeMediaPreload = null
let userNetworkRateLimitBytesPerSecond = 0
let playbackRateLimitBytesPerSecond = 0
let playbackMediaSource = null

const playbackInitialCredit = 64 * 1024
const playbackChunkSize = 64 * 1024

function validateMediaPreloadUrl(value) {
  const url = new URL(String(value || ''))
  if (url.protocol !== 'https:') throw new Error('Unsupported media preload URL')
  const host = url.hostname.toLowerCase()
  if (!host.endsWith('music.126.net') && !host.endsWith('music.163.com')) throw new Error('Unsupported media preload host')
  return url.toString()
}

function mediaPreloadDelay(byteLength) {
  const now = Date.now()
  const start = Math.max(now, mediaPreloadBandwidthAvailableAt)
  mediaPreloadBandwidthAvailableAt = start + Math.ceil((byteLength / mediaPreloadBytesPerSecond) * 1000)
  return Math.max(0, mediaPreloadBandwidthAvailableAt - now)
}

function cancelMediaPreload(exceptKey = '') {
  const task = activeMediaPreload
  if (!task || (exceptKey && task.key === exceptKey)) return false
  task.cancelled = true
  clearTimeout(task.resumeTimer)
  task.request?.abort()
  activeMediaPreload = null
  return true
}

function preloadMediaResource(url, task) {
  return new Promise((resolve, reject) => {
    if (task.cancelled) return resolve(false)
    const request = net.request({
      url,
      session: session.defaultSession,
      cache: 'force-cache',
      priority: 'throttled',
      priorityIncremental: true,
      referrerPolicy: 'no-referrer',
    })
    task.request = request
    const finish = (error, result = false) => {
      clearTimeout(task.resumeTimer)
      if (task.request === request) task.request = null
      if (error && !task.cancelled) reject(error)
      else resolve(result)
    }
    request.on('response', (response) => {
      if (response.statusCode < 200 || response.statusCode >= 400) {
        request.abort()
        finish(new Error(`Media preload failed (${response.statusCode})`))
        return
      }
      response.on('data', (chunk) => {
        if (task.cancelled || !chunk?.length) return
        response.pause()
        task.resumeTimer = setTimeout(() => {
          task.resumeTimer = null
          if (!task.cancelled) response.resume()
        }, mediaPreloadDelay(chunk.length))
      })
      response.on('end', () => finish(null, true))
      response.on('aborted', () => finish(null, false))
      response.on('error', (error) => finish(error))
    })
    request.on('error', (error) => finish(error))
    request.end()
  })
}

async function preloadNextMedia(payload = {}) {
  const key = String(payload.key || '').slice(0, 160)
  const urls = [...new Set((Array.isArray(payload.urls) ? payload.urls : [])
    .map((url) => validateMediaPreloadUrl(url)))]
    .slice(0, 2)
  if (!key || !urls.length) return { completed: false }
  if (activeMediaPreload?.key === key) return activeMediaPreload.promise
  cancelMediaPreload()
  mediaPreloadBandwidthAvailableAt = Date.now()
  const task = { key, request: null, resumeTimer: null, cancelled: false, promise: null }
  task.promise = (async () => {
    try {
      // Cover and audio share one serial 1 MB/s lane. This request starts only
      // after the renderer confirms the current track, cover, and lyrics are ready.
      for (const url of urls) {
        if (task.cancelled) return { completed: false, cancelled: true }
        await preloadMediaResource(url, task)
      }
      return { completed: !task.cancelled }
    } catch (error) {
      if (!task.cancelled) console.warn('[media-preload] Unable to warm next track:', error?.message || error)
      return { completed: false, cancelled: task.cancelled }
    } finally {
      if (activeMediaPreload === task) activeMediaPreload = null
    }
  })()
  activeMediaPreload = task
  return task.promise
}

function applyEffectiveNetworkRateLimit() {
  if (!(userNetworkRateLimitBytesPerSecond > 0)) {
    session.defaultSession.disableNetworkEmulation()
    return 0
  }
  const bytesPerSecond = Math.round(userNetworkRateLimitBytesPerSecond)
  session.defaultSession.enableNetworkEmulation({
    offline: false,
    latency: 0,
    downloadThroughput: bytesPerSecond,
    uploadThroughput: 0,
  })
  return bytesPerSecond
}

function setNetworkRateLimit(megabytesPerSecond) {
  const value = Number(megabytesPerSecond)
  userNetworkRateLimitBytesPerSecond = Number.isFinite(value) && value > 0
    ? Math.round(Math.max(.1, Math.min(1024, value)) * 1024 * 1024)
    : 0
  applyEffectiveNetworkRateLimit()
  return userNetworkRateLimitBytesPerSecond > 0
    ? userNetworkRateLimitBytesPerSecond / (1024 * 1024)
    : 0
}

function setPlaybackRateLimit(bytesPerSecond) {
  const value = Number(bytesPerSecond)
  playbackRateLimitBytesPerSecond = Number.isFinite(value) && value > 0
    ? Math.round(Math.max(128 * 1024, Math.min(64 * 1024 * 1024, value)))
    : 0
  return playbackRateLimitBytesPerSecond
}

function effectivePlaybackRateLimit() {
  const limits = [userNetworkRateLimitBytesPerSecond, playbackRateLimitBytesPerSecond]
    .filter((value) => Number.isFinite(value) && value > 0)
  return limits.length ? Math.round(Math.min(...limits)) : 0
}

function cancelPlaybackMediaSource() {
  const source = playbackMediaSource
  playbackMediaSource = null
  if (!source) return false
  for (const controller of source.controllers) controller.abort()
  source.controllers.clear()
  return true
}

function createPlaybackMediaUrl(value) {
  const url = validateMediaPreloadUrl(value)
  cancelPlaybackMediaSource()
  if (!(effectivePlaybackRateLimit() > 0)) return url
  const token = crypto.randomUUID()
  playbackMediaSource = { token, url, controllers: new Set() }
  return `${playbackProtocolScheme}://stream/${token}`
}

function playbackRequestHeaders(request) {
  const headers = new Headers()
  for (const name of ['accept', 'accept-encoding', 'if-match', 'if-modified-since', 'if-none-match', 'if-range', 'range']) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}

function playbackResponseHeaders(upstream) {
  const headers = new Headers()
  for (const name of [
    'accept-ranges',
    'cache-control',
    'content-length',
    'content-range',
    'content-type',
    'etag',
    'expires',
    'last-modified',
  ]) {
    const entry = Object.entries(upstream.headers || {})
      .find(([key]) => key.toLowerCase() === name)
    const value = entry?.[1]
    if (Array.isArray(value) && value.length) headers.set(name, value.join(', '))
    else if (value) headers.set(name, String(value))
  }
  return headers
}

function openPlaybackResponse(source, request, controller) {
  return new Promise((resolve, reject) => {
    const client = net.request({
      url: source.url,
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      session: session.defaultSession,
      cache: 'force-cache',
      referrerPolicy: 'no-referrer',
    })
    for (const [name, value] of playbackRequestHeaders(request)) client.setHeader(name, value)
    const abort = () => client.abort()
    controller.signal.addEventListener('abort', abort, { once: true })
    client.once('response', (response) => {
      response.pause()
      resolve({
        client,
        response,
        detachAbort: () => controller.signal.removeEventListener('abort', abort),
      })
    })
    client.once('error', (error) => {
      controller.signal.removeEventListener('abort', abort)
      reject(error)
    })
    client.end()
  })
}

function delayWithAbort(delay, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(signal.reason || new Error('Playback request aborted'))
    }
    const timer = setTimeout(finish, delay)
    signal.addEventListener('abort', abort, { once: true })
  })
}

function waitForPlaybackBudget(bucket, byteLength, signal) {
  return new Promise((resolve, reject) => {
    const run = () => {
      if (signal.aborted) {
        reject(signal.reason || new Error('Playback request aborted'))
        return
      }
      const rate = effectivePlaybackRateLimit()
      if (!(rate > 0)) {
        bucket.tokens = playbackInitialCredit
        bucket.updatedAt = Date.now()
        resolve()
        return
      }
      const now = Date.now()
      bucket.tokens = Math.min(playbackInitialCredit, bucket.tokens + ((now - bucket.updatedAt) * rate / 1000))
      bucket.updatedAt = now
      if (bucket.tokens >= byteLength) {
        bucket.tokens -= byteLength
        resolve()
        return
      }
      const delay = Math.max(1, Math.ceil(((byteLength - bucket.tokens) / rate) * 1000))
      void delayWithAbort(delay, signal).then(run, reject)
    }
    run()
  })
}

function throttledPlaybackBody(body, controller, onFinish) {
  const bucket = { tokens: playbackInitialCredit, updatedAt: Date.now() }
  const chunks = []
  let output = null
  let pumping = false
  let upstreamEnded = false
  let upstreamError = null
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    body.removeListener('data', onData)
    body.removeListener('end', onEnd)
    body.removeListener('aborted', onAborted)
    body.removeListener('error', onError)
    onFinish()
  }
  const stop = (error = null) => {
    if (finished) return
    finish()
    if (!output) return
    if (error && !controller.signal.aborted) output.error(error)
    else output.close()
  }
  const pump = async () => {
    if (pumping || finished || !output) return
    pumping = true
    try {
      while (chunks.length && (output.desiredSize ?? 1) > 0) {
        const chunk = chunks.shift()
        await waitForPlaybackBudget(bucket, chunk.byteLength, controller.signal)
        if (finished || controller.signal.aborted) break
        output.enqueue(chunk)
      }
      if (upstreamError) stop(upstreamError)
      else if (upstreamEnded && !chunks.length) stop()
      else if (!chunks.length && !controller.signal.aborted) body.resume()
    } catch (error) {
      stop(error)
    } finally {
      pumping = false
      if (!finished && (upstreamEnded || upstreamError || (chunks.length && (output.desiredSize ?? 1) > 0))) void pump()
    }
  }
  const onData = (value) => {
    body.pause()
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
    for (let offset = 0; offset < buffer.byteLength; offset += playbackChunkSize) {
      chunks.push(buffer.subarray(offset, Math.min(buffer.byteLength, offset + playbackChunkSize)))
    }
    void pump()
  }
  const onEnd = () => {
    upstreamEnded = true
    void pump()
  }
  const onAborted = () => {
    upstreamError = new Error('Playback response aborted')
    void pump()
  }
  const onError = (error) => {
    upstreamError = error
    void pump()
  }

  return new ReadableStream({
    start(controllerOutput) {
      output = controllerOutput
      body.on('data', onData)
      body.once('end', onEnd)
      body.once('aborted', onAborted)
      body.once('error', onError)
      body.resume()
    },
    pull() {
      void pump()
    },
    cancel(reason) {
      controller.abort(reason)
      finish()
    },
  })
}

function registerPlaybackProtocol() {
  protocol.handle(playbackProtocolScheme, async (request) => {
    const source = playbackMediaSource
    let token = ''
    try {
      token = new URL(request.url).pathname.replace(/^\//, '')
    } catch {}
    if (!source || token !== source.token) return new Response('', { status: 404 })

    const controller = new AbortController()
    source.controllers.add(controller)
    const abortUpstream = () => controller.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', abortUpstream, { once: true })
    const finish = () => {
      source.controllers.delete(controller)
      request.signal?.removeEventListener('abort', abortUpstream)
      detachClientAbort()
    }
    let detachClientAbort = () => {}
    try {
      const opened = await openPlaybackResponse(source, request, controller)
      const { client, response: upstream } = opened
      detachClientAbort = opened.detachAbort
      const headers = playbackResponseHeaders(upstream)
      if (request.method === 'HEAD') {
        client.abort()
        finish()
        return new Response(null, { status: upstream.statusCode, statusText: upstream.statusMessage, headers })
      }
      return new Response(throttledPlaybackBody(upstream, controller, finish), {
        status: upstream.statusCode,
        statusText: upstream.statusMessage,
        headers,
      })
    } catch (error) {
      finish()
      if (controller.signal.aborted) return new Response('', { status: 499 })
      console.warn('[playback-stream] Unable to proxy audio:', error?.message || error)
      return new Response('', { status: 502 })
    }
  })
}

function acquireThumbnailSlot() {
  if (thumbnailActiveRequests < thumbnailConcurrency) {
    thumbnailActiveRequests += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => thumbnailWaiters.push(resolve))
}

function releaseThumbnailSlot() {
  const next = thumbnailWaiters.shift()
  if (next) next()
  else thumbnailActiveRequests = Math.max(0, thumbnailActiveRequests - 1)
}

async function reserveThumbnailBandwidth(byteLength) {
  const now = Date.now()
  const start = Math.max(now, thumbnailBandwidthAvailableAt)
  thumbnailBandwidthAvailableAt = start + Math.ceil((byteLength / thumbnailBytesPerSecond) * 1000)
  const delay = thumbnailBandwidthAvailableAt - now
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
}

function validateThumbnailUrl(value) {
  const url = new URL(String(value || ''))
  if (url.protocol !== 'https:') throw new Error('Unsupported thumbnail URL')
  const host = url.hostname.toLowerCase()
  if (!host.endsWith('music.126.net') && !host.endsWith('music.163.com')) throw new Error('Unsupported thumbnail host')
  return url.toString()
}

function rememberThumbnail(url, entry) {
  if (thumbnailCache.has(url)) thumbnailCache.delete(url)
  thumbnailCache.set(url, entry)
  while (thumbnailCache.size > thumbnailCacheLimit) thumbnailCache.delete(thumbnailCache.keys().next().value)
}

async function downloadThumbnail(url, forceRefresh = false) {
  await acquireThumbnailSlot()
  try {
    // Stagger the first network read as well as subsequent body chunks. Without
    // this credit, twelve responses can all deliver their first buffered chunk
    // before backpressure is applied, producing a large one-sample spike in
    // Task Manager even though the sustained rate is limited correctly.
    await reserveThumbnailBandwidth(thumbnailInitialCredit)
    const response = await net.fetch(url, { cache: forceRefresh ? 'reload' : 'force-cache', referrerPolicy: 'no-referrer' })
    if (!response.ok || !response.body) throw new Error(`Thumbnail request failed (${response.status})`)
    const mimeType = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase()
    if (!mimeType.startsWith('image/')) throw new Error('Thumbnail response is not an image')
    const contentLength = Number(response.headers.get('content-length') || 0)
    if (contentLength > thumbnailMaximumBytes) throw new Error('Thumbnail response is too large')
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    let bandwidthCredit = thumbnailInitialCredit
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      total += value.byteLength
      if (total > thumbnailMaximumBytes) {
        await reader.cancel()
        throw new Error('Thumbnail response is too large')
      }
      const charge = Math.max(0, value.byteLength - bandwidthCredit)
      bandwidthCredit = Math.max(0, bandwidthCredit - value.byteLength)
      if (charge) await reserveThumbnailBandwidth(charge)
      chunks.push(Buffer.from(value))
    }
    const data = Buffer.concat(chunks, total)
    const entry = {
      mimeType,
      bytes: Uint8Array.from(data),
    }
    rememberThumbnail(url, entry)
    return entry
  } finally {
    releaseThumbnailSlot()
  }
}

function getThumbnail(value, forceRefresh = false) {
  const url = validateThumbnailUrl(value)
  if (forceRefresh) thumbnailCache.delete(url)
  const cached = thumbnailCache.get(url)
  if (cached) {
    rememberThumbnail(url, cached)
    return Promise.resolve(cached)
  }
  if (thumbnailInflight.has(url)) return thumbnailInflight.get(url)
  const request = downloadThumbnail(url, forceRefresh).finally(() => thumbnailInflight.delete(url))
  thumbnailInflight.set(url, request)
  return request
}

const isDev = process.argv.includes('--dev')
const hasSingleInstanceLock = app.requestSingleInstanceLock()

const floatingLyricsDefaults = {
  mode: 'off',
  locked: true,
  hideWhenPaused: true,
  fontFamily: 'system',
  fontSize: 30,
  italic: false,
  bold: false,
  align: 'right',
  shadow: true,
  stroke: false,
  color: '#f2f2f2',
  opacity: 1,
  noTranslationPosition: 'bottom',
}

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
    mainWindow.moveTop()
  })
}

function api() {
  if (!musicApi) musicApi = require('@neteasecloudmusicapienhanced/api')
  return musicApi
}

function sessionPath() {
  return path.join(app.getPath('userData'), 'session.json')
}

function floatingLyricsPath() {
  return path.join(app.getPath('userData'), 'floating-lyrics.json')
}

function sanitizeFloatingLyricsConfig(input = {}) {
  const config = { ...floatingLyricsDefaults, ...(input || {}) }
  if (!['off', 'minimized', 'outside-player', 'always'].includes(config.mode)) config.mode = 'off'
  if (!['left', 'center', 'right'].includes(config.align)) config.align = 'right'
  if (!['top', 'center', 'bottom'].includes(config.noTranslationPosition)) config.noTranslationPosition = 'bottom'
  config.locked = Boolean(config.locked)
  config.hideWhenPaused = Boolean(config.hideWhenPaused)
  config.italic = Boolean(config.italic)
  config.bold = Boolean(config.bold)
  config.shadow = Boolean(config.shadow)
  config.stroke = Boolean(config.stroke)
  config.fontFamily = String(config.fontFamily || 'system').slice(0, 96)
  config.fontSize = Math.max(12, Math.min(120, Number(config.fontSize) || 30))
  config.opacity = Math.max(.15, Math.min(1, Number(config.opacity) || 1))
  config.color = /^#[\da-f]{6}$/i.test(String(config.color || '')) ? String(config.color) : '#f2f2f2'
  return config
}

function loadFloatingLyricsState() {
  try {
    const saved = JSON.parse(fs.readFileSync(floatingLyricsPath(), 'utf8'))
    floatingLyricsState = {
      config: sanitizeFloatingLyricsConfig(saved.config),
      bounds: saved.bounds && Number.isFinite(saved.bounds.x) ? saved.bounds : null,
    }
  } catch {
    floatingLyricsState = { config: { ...floatingLyricsDefaults }, bounds: null }
  }
  return floatingLyricsState
}

function writeFloatingLyricsState() {
  if (!floatingLyricsState) return
  try {
    fs.mkdirSync(path.dirname(floatingLyricsPath()), { recursive: true })
    fs.writeFileSync(floatingLyricsPath(), JSON.stringify(floatingLyricsState, null, 2), 'utf8')
  } catch (error) {
    console.warn('[floating-lyrics] Unable to save settings:', error?.message || error)
  }
}

function saveFloatingLyricsState() {
  if (!floatingLyricsState) return
  clearTimeout(floatingLyricsSaveTimer)
  floatingLyricsSaveTimer = setTimeout(writeFloatingLyricsState, 140)
}

function floatingLyricsHeightForFontSize(fontSize) {
  return Math.max(54, Math.round((Number(fontSize) || 30) * 2.18 + 20))
}

function floatingLyricsFontSizeForHeight(height) {
  return Math.max(12, Math.min(120, Math.round(((Number(height) || 85) - 20) / 2.18)))
}

function defaultFloatingLyricsBounds() {
  const display = mainWindow && !mainWindow.isDestroyed()
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getPrimaryDisplay()
  const area = display.workArea
  const width = Math.max(500, Math.min(area.width, Math.round(area.width * .78125)))
  const fontSize = floatingLyricsState?.config?.fontSize || 30
  const height = floatingLyricsHeightForFontSize(fontSize)
  return {
    x: area.x + area.width - width,
    // The surface has its own lower padding. A 12px window offset places the
    // translated baseline roughly 20px above the taskbar at the default size.
    y: area.y + area.height - height - 12,
    width,
    height,
  }
}

function normalizeFloatingLyricsBounds(bounds) {
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return defaultFloatingLyricsBounds()
  const display = screen.getDisplayMatching(bounds)
  const area = display.workArea
  const width = Math.max(500, Math.min(area.width, Math.round(Number(bounds.width) || 500)))
  const height = Math.max(30, Math.min(area.height, Math.round(Number(bounds.height) || 80)))
  // Keep an intentionally overhanging desktop lyric where the user left it.
  // Only rescue a window that would otherwise be effectively unreachable.
  const recoverableEdge = 24
  return {
    x: Math.max(area.x - width + recoverableEdge, Math.min(area.x + area.width - recoverableEdge, Math.round(bounds.x))),
    y: Math.max(area.y - height + recoverableEdge, Math.min(area.y + area.height - recoverableEdge, Math.round(bounds.y))),
    width,
    height,
  }
}

function floatingLyricsShouldShow() {
  const mode = floatingLyricsState?.config?.mode || 'off'
  if (mode === 'off') return false
  if (floatingLyricsState?.config?.hideWhenPaused && floatingLyricsPayload?.paused) return false
  // Keep the transparent window alive while a locked lyric is temporarily
  // empty (for example during an instrumental break). Hiding and showing the
  // native window makes Windows animate its contents from the text-alignment
  // edge when the next line arrives.
  if (mode === 'always') return true
  if (mode === 'minimized') return Boolean(mainWindow?.isMinimized() || !mainWindow?.isVisible())
  if (mode === 'outside-player') {
    return Boolean(mainWindow?.isMinimized() || !mainWindow?.isVisible() || !floatingLyricsPayload?.inPlayer)
  }
  return false
}

function clearFloatingLyricsShowTimer() {
  clearTimeout(floatingLyricsShowTimer)
  floatingLyricsShowTimer = null
}

function broadcastFloatingLyricsState() {
  const snapshot = { config: floatingLyricsState.config, bounds: floatingLyricsState.bounds }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('floating-lyrics:state-changed', snapshot)
  if (floatingLyricsWindow && !floatingLyricsWindow.isDestroyed()) {
    floatingLyricsWindow.webContents.send('floating-lyrics:config', snapshot.config)
  }
}

function applyFloatingLyricsLock() {
  if (!floatingLyricsWindow || floatingLyricsWindow.isDestroyed()) return
  const locked = Boolean(floatingLyricsState.config.locked)
  floatingLyricsWindow.setMovable(!locked)
  floatingLyricsWindow.setResizable(!locked)
  if (locked) floatingLyricsWindow.setIgnoreMouseEvents(true, { forward: true })
  else floatingLyricsWindow.setIgnoreMouseEvents(false)
  floatingLyricsWindow.webContents.send('floating-lyrics:config', floatingLyricsState.config)
}

function updateFloatingLyricsVisibility() {
  clearFloatingLyricsShowTimer()
  const shouldShow = floatingLyricsShouldShow()
  if (!shouldShow) {
    floatingLyricsWindow?.hide()
    return
  }
  const mode = floatingLyricsState?.config?.mode || 'off'
  const waitingForPlayerExit = mode === 'outside-player'
    && !mainWindow?.isMinimized()
    && mainWindow?.isVisible()
    && !floatingLyricsPayload?.inPlayer
  const remainingDelay = waitingForPlayerExit ? floatingLyricsShowNotBefore - Date.now() : 0
  if (remainingDelay > 0) {
    floatingLyricsShowTimer = setTimeout(() => {
      floatingLyricsShowTimer = null
      updateFloatingLyricsVisibility()
    }, remainingDelay)
    return
  }
  floatingLyricsShowNotBefore = 0
  createFloatingLyricsWindow()
  if (!floatingLyricsWindow.isVisible()) floatingLyricsWindow.showInactive()
  floatingLyricsWindow.webContents.send('floating-lyrics:update', floatingLyricsPayload)
}

function createFloatingLyricsWindow() {
  if (floatingLyricsWindow && !floatingLyricsWindow.isDestroyed()) return floatingLyricsWindow
  const bounds = normalizeFloatingLyricsBounds(floatingLyricsState?.bounds)
  floatingLyricsWindow = new BrowserWindow({
    ...bounds,
    minWidth: 500,
    minHeight: 30,
    show: false,
    frame: false,
    type: 'toolbar',
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: !floatingLyricsState.config.locked,
    resizable: !floatingLyricsState.config.locked,
    movable: !floatingLyricsState.config.locked,
    webPreferences: {
      preload: path.join(__dirname, 'floating-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  floatingLyricsWindow.setAlwaysOnTop(true, 'screen-saver')
  floatingLyricsWindow.setSkipTaskbar(true)
  floatingLyricsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  floatingLyricsWindow.loadFile(path.join(__dirname, '..', 'src', 'floating-lyrics.html'))
  floatingLyricsWindow.webContents.once('did-finish-load', () => {
    floatingLyricsWindow.setSkipTaskbar(true)
    applyFloatingLyricsLock()
    floatingLyricsWindow.webContents.send('floating-lyrics:update', floatingLyricsPayload)
    updateFloatingLyricsVisibility()
  })
  const rememberBounds = () => {
    if (!floatingLyricsWindow || floatingLyricsWindow.isDestroyed()) return
    floatingLyricsState.bounds = floatingLyricsWindow.getBounds()
    saveFloatingLyricsState()
  }
  floatingLyricsWindow.on('move', rememberBounds)
  floatingLyricsWindow.on('resize', rememberBounds)
  floatingLyricsWindow.on('show', () => {
    // Windows may try to restore tool windows alongside the main window.
    // Re-apply our own visibility policy so a paused, auto-hidden lyric never
    // reappears merely because the main window was restored.
    if (!floatingLyricsShouldShow()) floatingLyricsWindow?.hide()
  })
  floatingLyricsWindow.on('closed', () => { floatingLyricsWindow = null })
  return floatingLyricsWindow
}

function configureFloatingLyrics(patch = {}) {
  floatingLyricsState.config = sanitizeFloatingLyricsConfig({ ...floatingLyricsState.config, ...(patch || {}) })
  if (floatingLyricsWindow && !floatingLyricsWindow.isDestroyed()) {
    floatingLyricsWindow.setFocusable(!floatingLyricsState.config.locked)
    applyFloatingLyricsLock()
    const bounds = floatingLyricsWindow.getBounds()
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'fontSize')) {
      const height = floatingLyricsHeightForFontSize(floatingLyricsState.config.fontSize)
      floatingLyricsWindow.setBounds({ ...bounds, y: bounds.y + bounds.height - height, height }, true)
    }
  }
  saveFloatingLyricsState()
  broadcastFloatingLyricsState()
  updateFloatingLyricsVisibility()
  return { config: floatingLyricsState.config, bounds: floatingLyricsState.bounds }
}

function resizeFloatingLyrics(point = {}) {
  if (!floatingLyricsResizeSession || !floatingLyricsWindow || floatingLyricsWindow.isDestroyed()) return
  const x = Number(point.x)
  const y = Number(point.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  const { direction, startX, startY, bounds } = floatingLyricsResizeSession
  const dx = x - startX
  const dy = y - startY
  let left = bounds.x
  let top = bounds.y
  let right = bounds.x + bounds.width
  let bottom = bounds.y + bounds.height
  if (direction.includes('w')) left = Math.min(right - 500, left + dx)
  if (direction.includes('e')) right = Math.max(left + 500, right + dx)
  if (direction.includes('n')) top = Math.min(bottom - 30, top + dy)
  if (direction.includes('s')) bottom = Math.max(top + 30, bottom + dy)
  const nextBounds = {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  }
  floatingLyricsWindow.setBounds(nextBounds)
  if (direction.includes('n') || direction.includes('s')) {
    const fontSize = floatingLyricsFontSizeForHeight(nextBounds.height)
    if (fontSize !== floatingLyricsState.config.fontSize) {
      floatingLyricsState.config = sanitizeFloatingLyricsConfig({ ...floatingLyricsState.config, fontSize })
      broadcastFloatingLyricsState()
    }
  }
}

function moveFloatingLyrics(point = {}) {
  if (!floatingLyricsMoveSession || !floatingLyricsWindow || floatingLyricsWindow.isDestroyed()) return
  const x = Number(point.x)
  const y = Number(point.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  const { startX, startY, bounds } = floatingLyricsMoveSession
  floatingLyricsWindow.setPosition(
    Math.round(bounds.x + x - startX),
    Math.round(bounds.y + y - startY),
  )
}

function loadSession() {
  try {
    const saved = JSON.parse(fs.readFileSync(sessionPath(), 'utf8'))
    if (!saved.value) return
    if (saved.protected && safeStorage.isEncryptionAvailable()) {
      sessionCookie = safeStorage.decryptString(Buffer.from(saved.value, 'base64'))
    } else {
      sessionCookie = Buffer.from(saved.value, 'base64').toString('utf8')
    }
    sessionProfile = saved.profile && saved.profile.userId ? saved.profile : null
  } catch {
    sessionCookie = ''
    sessionProfile = null
  }
}

function saveSession(cookie, profile = sessionProfile) {
  sessionCookie = cookie || ''
  if (!sessionCookie) {
    sessionProfile = null
    try { fs.unlinkSync(sessionPath()) } catch {}
    return
  }
  sessionProfile = profile && profile.userId ? {
    userId: profile.userId,
    nickname: String(profile.nickname || ''),
    avatarUrl: String(profile.avatarUrl || ''),
    signature: String(profile.signature || ''),
  } : null
  const canProtect = safeStorage.isEncryptionAvailable()
  const value = canProtect
    ? safeStorage.encryptString(sessionCookie).toString('base64')
    : Buffer.from(sessionCookie, 'utf8').toString('base64')
  fs.mkdirSync(path.dirname(sessionPath()), { recursive: true })
  fs.writeFileSync(sessionPath(), JSON.stringify({ version: 2, protected: canProtect, value, profile: sessionProfile }), 'utf8')
}

function normalizeResult(result) {
  if (!result) return {}
  return result.body ?? result
}

async function callApi(name, params = {}, includeCookie = true) {
  const fn = api()[name]
  if (typeof fn !== 'function') throw new Error(`API method unavailable: ${name}`)
  const query = { ...params, timestamp: Date.now() }
  if (includeCookie && sessionCookie) query.cookie = sessionCookie
  const result = await fn(query)
  return normalizeResult(result)
}

function safeMessage(error) {
  const message = error?.body?.message || error?.message || '网络请求失败'
  const clean = sessionCookie ? String(message).replace(sessionCookie, '[hidden]') : String(message)
  return clean.slice(0, 240)
}

async function listInstalledFonts() {
  if (installedFontsCache) return installedFontsCache
  if (process.platform !== 'win32') return []
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  const script = [
    '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();',
    'Add-Type -AssemblyName System.Drawing;',
    '$c=[System.Drawing.Text.InstalledFontCollection]::new();',
    '$names=@($c.Families | ForEach-Object Name);',
    '$fontDirs=@("$env:WINDIR\\Fonts","$env:LOCALAPPDATA\\Microsoft\\Windows\\Fonts");',
    '$hasSarasa=@($fontDirs | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter "Sarasa*.ttc" -File -ErrorAction SilentlyContinue }).Count -gt 0;',
    'if($hasSarasa){ $names += @("Sarasa Gothic CL","Sarasa Gothic SC","Sarasa Gothic TC","Sarasa Gothic HC","Sarasa Gothic J","Sarasa Gothic K","Sarasa UI CL","Sarasa UI SC","Sarasa UI TC","Sarasa UI HC","Sarasa UI J","Sarasa UI K","Sarasa Mono CL","Sarasa Mono SC","Sarasa Mono TC","Sarasa Mono HC","Sarasa Mono J","Sarasa Mono K","Sarasa Fixed CL","Sarasa Fixed SC","Sarasa Fixed TC","Sarasa Term CL","Sarasa Term SC","Sarasa Term TC","Sarasa Term Slab CL","Sarasa Term Slab SC","Sarasa Term Slab TC") };',
    '@($names | Where-Object { $_ -and -not $_.StartsWith("@") } | Sort-Object -Unique) | ConvertTo-Json -Compress',
  ].join(' ')
  const { stdout } = await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 12000,
  })
  const parsed = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim() || '[]')
  installedFontsCache = (Array.isArray(parsed) ? parsed : [parsed])
    .map((name) => typeof name === 'string' ? name.trim() : '')
    .filter((name) => name && name.length <= 72 && !name.includes('&') && !name.startsWith('@') && !name.startsWith('.') && !/[\r\n;{}<>]/.test(name))
    .slice(0, 2000)
  return installedFontsCache
}

async function guarded(work, fallback = null) {
  try {
    return { ok: true, data: await work() }
  } catch (error) {
    return { ok: false, error: safeMessage(error), data: fallback }
  }
}

function sanitizeCookie(input) {
  const raw = String(input || '').trim().replace(/^cookie:\s*/i, '')
  const pairs = raw.split(';').map((part) => part.trim()).filter(Boolean)
  const allowed = new Map()
  for (const pair of pairs) {
    const index = pair.indexOf('=')
    if (index < 1) continue
    const key = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (value && /^[\w-]+$/.test(key)) allowed.set(key, value)
  }
  if (!allowed.has('MUSIC_U') && !allowed.has('MUSIC_A')) {
    throw new Error('Cookie 中没有找到 MUSIC_U 或 MUSIC_A')
  }
  return [...allowed.entries()].map(([key, value]) => `${key}=${value}`).join('; ')
}

function authProfileFromBody(body) {
  const profile = body?.data?.profile || body?.profile || null
  if (!profile?.userId) return null
  return profile
}

async function resolveAuthenticatedProfile(fallback = null) {
  for (const method of ['login_status', 'user_account']) {
    try {
      const body = await callApi(method)
      const profile = authProfileFromBody(body)
      if (profile) return profile
      const userId = body?.account?.id || body?.data?.account?.id
      if (userId) {
        try {
          const detail = await callApi('user_detail', { uid: userId })
          const detailedProfile = authProfileFromBody(detail)
          if (detailedProfile) return detailedProfile
        } catch {}
      }
    } catch {}
  }
  return fallback?.userId ? fallback : null
}

async function cookieHasAuthenticatedAccess() {
  try {
    const body = await callApi('recommend_songs')
    return Number(body?.code) === 200 && Array.isArray(body?.data?.dailySongs)
  } catch {
    return false
  }
}

function createWindow() {
  nativeTheme.themeSource = 'dark'
  const sizeArg = process.argv.find((argument) => argument.startsWith('--size='))
  const sizeMatch = sizeArg?.slice('--size='.length).match(/^(\d{3,4})x(\d{3,4})$/i)
  const width = sizeMatch ? Math.max(980, Math.min(3840, Number(sizeMatch[1]))) : 1440
  const height = sizeMatch ? Math.max(680, Math.min(2160, Number(sizeMatch[2]))) : 900
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 980,
    minHeight: 680,
    icon: path.join(__dirname, '..', 'src', 'assets', 'icon', 'app-icon.png'),
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#17151d',
    backgroundMaterial: 'mica',
    title: 'MenoRadio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Audio and the floating-lyric clock must keep advancing while the main
      // window is minimized. Chromium's default background throttling can
      // otherwise leave the lyric line frozen after a system/media-key pause.
      backgroundThrottling: false,
    },
  })

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximized', true))
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximized', false))
  mainWindow.on('enter-full-screen', () => mainWindow.webContents.send('window:fullscreen', true))
  mainWindow.on('leave-full-screen', () => mainWindow.webContents.send('window:fullscreen', false))
  mainWindow.on('minimize', updateFloatingLyricsVisibility)
  mainWindow.on('restore', updateFloatingLyricsVisibility)
  mainWindow.on('show', updateFloatingLyricsVisibility)
  mainWindow.on('hide', updateFloatingLyricsVisibility)
  mainWindow.on('closed', () => {
    mainWindow = null
    if (floatingLyricsWindow && !floatingLyricsWindow.isDestroyed()) floatingLyricsWindow.destroy()
    if (process.platform !== 'darwin') app.quit()
  })

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' })

  const screenshotArg = process.argv.find((argument) => argument.startsWith('--screenshot='))
  const previewArg = process.argv.find((argument) => argument.startsWith('--preview='))
  const preview = previewArg?.slice('--preview='.length) || 'home'
  const screenshotTarget = process.env.MENORADIO_SCREENSHOT || screenshotArg?.slice('--screenshot='.length)
  if (screenshotTarget) {
    mainWindow.webContents.once('did-finish-load', async () => {
      const playerPreview = ['player', 'player-jump', 'player-long', 'player-end', 'player-volume', 'player-font', 'player-dismiss', 'player-queue', 'player-radio', 'bar'].includes(preview)
      const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
      const run = (source) => mainWindow.webContents.executeJavaScript(source)
      const waitForHome = () => run(`new Promise((resolve) => {
        const deadline = Date.now() + 18000
        const probe = () => {
          if (document.querySelector('[data-track-index], .empty-state')) { resolve(true); return }
          if (Date.now() >= deadline) { resolve(false); return }
          setTimeout(probe, 200)
        }
        probe()
      })`)
      if (preview === 'login') {
        await wait(1800)
        await run("document.querySelector('#profileButton')?.click()")
      }
      if (['settings', 'settings-font', 'settings-quality', 'settings-floating'].includes(preview)) {
        await waitForHome()
        await wait(2200)
        await run("document.querySelector('[data-route=\"settings\"]')?.click()")
        await run(`new Promise((resolve) => {
          const deadline = Date.now() + 15000
          const probe = () => {
            if (document.querySelector('.settings-grid')) { resolve(true); return }
            if (Date.now() >= deadline) { resolve(false); return }
            setTimeout(probe, 200)
          }
          probe()
        })`)
        await wait(800)
        if (preview === 'settings-font') {
          await run("document.querySelector('[data-font-picker]')?.click()")
          await wait(1600)
        } else if (preview === 'settings-quality') {
          await run("document.querySelector('[data-choice-picker=\"audio-quality\"]')?.click()")
          await wait(500)
        } else if (preview === 'settings-floating') {
          await run("document.querySelector('[data-route-link=\"settings-floating\"]')?.click()")
          await wait(1100)
        }
      }
      if (preview === 'search') {
        await waitForHome()
        await run("navigate('search', { keywords: '周杰伦', type: 1018 })")
        await run(`new Promise((resolve) => {
          const deadline = Date.now() + 30000
          const probe = () => {
            if (document.querySelector('#page .search-entity, #page .track-row, #page .search-empty, #page .empty-state')) { resolve(true); return }
            if (Date.now() >= deadline) { resolve(false); return }
            setTimeout(probe, 200)
          }
          probe()
        })`)
        await wait(1000)
      }
      if (preview === 'radio') {
        await waitForHome()
        await run("document.querySelector('[data-route=\"radio\"]')?.click()")
        await wait(3600)
      }
      if (['playlist', 'playlist-search', 'playlist-menu'].includes(preview)) {
        await waitForHome()
        await run("document.querySelector('[data-playlist-id]')?.click()")
        await wait(1200)
        if (preview === 'playlist-search') {
          await run("document.querySelector('[data-toggle-playlist-search]')?.click()")
          await wait(280)
        }
        if (preview === 'playlist-menu') {
          await run("document.querySelector('.track-more')?.click()")
          await wait(280)
        }
      }
      if (preview === 'user') {
        await waitForHome()
        await run("document.querySelector('[data-playlist-id]')?.click()")
        await run(`new Promise((resolve) => {
          const deadline = Date.now() + 12000
          const probe = () => {
            const creator = document.querySelector('.creator-link')
            if (creator) { creator.click(); resolve(true); return }
            if (Date.now() >= deadline) { resolve(false); return }
            setTimeout(probe, 200)
          }
          probe()
        })`)
        await wait(1800)
      }
      if (playerPreview) {
        await run(`new Promise((resolve) => {
          const deadline = Date.now() + 15000
          const probe = () => {
            const row = document.querySelector('[data-track-index]')
            if (row) { row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window })); resolve(true); return }
            if (Date.now() >= deadline) { resolve(false); return }
            setTimeout(probe, 200)
          }
          probe()
        })`)
        await wait(2400)
      }
      if (playerPreview && preview !== 'bar') {
        await run("document.querySelector('#nowPlayingInfo')?.click()")
        await wait(1000)
      }
      if (preview === 'player-radio') {
        await run("document.querySelector('#immersivePlayer')?.classList.add('radio-mode', 'fullscreen')")
        await wait(320)
      }
      if (['player-long', 'player-end'].includes(preview)) {
        await run(`(() => {
          const demo = [
            { time: 0, text: '嫌なこと全部吐き出そう', translation: '讨厌的事情全部倾诉出来吧' },
            { time: 10, text: 'とびきりの長いアドバイスはちゃんと聞いて', translation: '格外冗长的建议要好好地听着呀' },
            { time: 20, text: '嬉しいことは報告しよう', translation: '高兴的事情汇报一下吧' },
            { time: 30, text: '新しい出会い大事にしよう', translation: '新的邂逅很重要的对吧' },
            { time: 40, text: 'つまりはいつでもいつまでも', translation: '也就是说永远永远' },
            { time: 50, text: '僕らは立った今', translation: '我们正站在此刻' },
          ]
          state.lyrics = demo
          state.lyricBreaks = []
          renderLyrics(demo)
          const time = '${preview}' === 'player-end' ? 50.05 : 10.05
          const audio = document.querySelector('#audio')
          try { audio.currentTime = time } catch {}
          updateActiveLyric(time, true, true)
          return true
        })()`)
        await wait(500)
      }
      if (preview === 'player-jump') {
        await run(`(() => {
          const lines = [...document.querySelectorAll('[data-time]')]
          const target = lines[Math.max(0, Math.floor(lines.length * .62))]
          if (target) {
            const time = Number(target.dataset.time || 0) + .05
            const audio = document.querySelector('#audio')
            if (audio) {
              try { audio.currentTime = time } catch {}
              audio.dispatchEvent(new Event('timeupdate'))
            }
            if (typeof updateActiveLyric === 'function') updateActiveLyric(time, false, true)
          }
          return Boolean(target)
        })()`)
        await wait(640)
      }
      if (preview === 'player-volume') {
        await run("document.querySelector('#immersiveVolume')?.click()")
        await run("(() => { const range = document.querySelector('#immersiveVolumeRange'); if (!range) return; range.value = '.56'; range.dispatchEvent(new Event('input', { bubbles: true })); range.focus() })()")
        await wait(320)
      }
      if (preview === 'player-font') {
        await run("document.querySelector('#fontSizeToggle')?.click()")
        await wait(320)
      }
      if (preview === 'player-queue') {
        await run("document.querySelector('#immersiveQueueView')?.click()")
        await wait(420)
      }
      if (preview === 'player-dismiss') {
        mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: 800, y: 31, button: 'left', clickCount: 1 })
        mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: 800, y: 31, button: 'left', clickCount: 1 })
        await wait(760)
      }
      if (!playerPreview && !['login', 'settings', 'settings-font', 'settings-quality', 'settings-floating', 'search', 'playlist', 'playlist-search', 'playlist-menu', 'user'].includes(preview)) await wait(4300)
      if (preview === 'login') await wait(7000)
      const image = await mainWindow.webContents.capturePage()
      fs.writeFileSync(path.resolve(screenshotTarget), image.toPNG())
      app.quit()
    })
  }
}

function registerWindowIpc() {
  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return false
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
    return mainWindow.isMaximized()
  })
  ipcMain.handle('window:close', () => mainWindow?.close())
  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() || false)
  ipcMain.handle('window:set-fullscreen', (_event, value) => {
    if (!mainWindow) return false
    mainWindow.setFullScreen(Boolean(value))
    return mainWindow.isFullScreen()
  })
  ipcMain.handle('window:is-fullscreen', () => mainWindow?.isFullScreen() || false)
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:cache-size', () => session.defaultSession.getCacheSize())
  ipcMain.handle('app:clear-cache', async () => {
    const clearedBytes = await session.defaultSession.getCacheSize()
    await Promise.all([
      session.defaultSession.clearCache(),
      session.defaultSession.clearCodeCaches({}),
    ])
    await session.defaultSession.clearHostResolverCache().catch(() => {})
    return { clearedBytes }
  })
  ipcMain.handle('app:reset', async () => {
    if (resettingApplication) return { resetting: true }
    resettingApplication = true
    clearTimeout(floatingLyricsSaveTimer)
    clearFloatingLyricsShowTimer()
    sessionCookie = ''
    sessionProfile = null
    authStatusMisses = 0
    installedFontsCache = null
    floatingLyricsState = { config: { ...floatingLyricsDefaults }, bounds: null }

    await Promise.allSettled([
      session.defaultSession.clearStorageData(),
      session.defaultSession.clearCache(),
      session.defaultSession.clearCodeCaches({}),
      session.defaultSession.clearAuthCache?.() || Promise.resolve(),
      session.defaultSession.clearHostResolverCache(),
    ])
    for (const file of [sessionPath(), floatingLyricsPath()]) {
      try {
        fs.rmSync(file, { force: true })
      } catch (error) {
        console.warn('[reset] Unable to remove app data file:', error?.message || error)
      }
    }

    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 120)
    return { resetting: true }
  })
  ipcMain.handle('app:list-fonts', () => listInstalledFonts().catch((error) => {
    console.warn('[fonts] Unable to enumerate installed fonts:', error?.message || error)
    return []
  }))
  ipcMain.handle('app:open-external', (_event, url) => {
    const parsed = new URL(String(url))
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Unsupported URL')
    return shell.openExternal(parsed.toString())
  })
  ipcMain.handle('app:set-network-rate-limit', (_event, value) => setNetworkRateLimit(value))
  ipcMain.handle('image:thumbnail', (_event, payload) => getThumbnail(payload?.url, payload?.forceRefresh === true))
  ipcMain.handle('media:preload-next', (_event, payload) => preloadNextMedia(payload))
  ipcMain.handle('media:cancel-preload', (_event, exceptKey) => cancelMediaPreload(String(exceptKey || '')))
  ipcMain.handle('media:set-playback-rate-limit', (_event, value) => setPlaybackRateLimit(value))
  ipcMain.handle('media:playback-url', (_event, url) => createPlaybackMediaUrl(url))
  ipcMain.handle('media:cancel-playback', () => cancelPlaybackMediaSource())
  ipcMain.handle('floating-lyrics:state', () => ({
    config: floatingLyricsState.config,
    bounds: floatingLyricsState.bounds,
  }))
  ipcMain.handle('floating-lyrics:configure', (_event, patch) => configureFloatingLyrics(patch))
  ipcMain.handle('floating-lyrics:update', (_event, payload) => {
    const wasInPlayer = Boolean(floatingLyricsPayload?.inPlayer)
    floatingLyricsPayload = {
      text: String(payload?.text || '').slice(0, 1000),
      translation: String(payload?.translation || '').slice(0, 1000),
      inPlayer: Boolean(payload?.inPlayer),
      active: Boolean(payload?.active),
      paused: Boolean(payload?.paused),
    }
    if (floatingLyricsPayload.inPlayer) {
      floatingLyricsShowNotBefore = 0
    } else if (
      wasInPlayer
      && floatingLyricsState?.config?.mode === 'outside-player'
      && !mainWindow?.isMinimized()
      && mainWindow?.isVisible()
    ) {
      floatingLyricsShowNotBefore = Date.now() + 320
    }
    if (floatingLyricsWindow && !floatingLyricsWindow.isDestroyed()) {
      floatingLyricsWindow.webContents.send('floating-lyrics:update', floatingLyricsPayload)
    }
    updateFloatingLyricsVisibility()
    return true
  })
  ipcMain.handle('floating-lyrics:lock', () => configureFloatingLyrics({ locked: true }))
  ipcMain.handle('floating-lyrics:resize-start', (event, payload) => {
    if (!floatingLyricsWindow || floatingLyricsWindow.isDestroyed() || event.sender !== floatingLyricsWindow.webContents || floatingLyricsState.config.locked) return false
    const direction = String(payload?.direction || '')
    const x = Number(payload?.x)
    const y = Number(payload?.y)
    if (!/^(n|s|e|w|ne|nw|se|sw)$/.test(direction) || !Number.isFinite(x) || !Number.isFinite(y)) return false
    floatingLyricsResizeSession = { direction, startX: x, startY: y, bounds: floatingLyricsWindow.getBounds() }
    return true
  })
  ipcMain.on('floating-lyrics:resize-move', (event, payload) => {
    if (!floatingLyricsWindow || floatingLyricsWindow.isDestroyed() || event.sender !== floatingLyricsWindow.webContents) return
    resizeFloatingLyrics(payload)
  })
  ipcMain.on('floating-lyrics:resize-end', (event) => {
    if (!floatingLyricsWindow || floatingLyricsWindow.isDestroyed() || event.sender !== floatingLyricsWindow.webContents) return
    floatingLyricsResizeSession = null
    saveFloatingLyricsState()
  })
  ipcMain.handle('floating-lyrics:move-start', (event, payload) => {
    if (!floatingLyricsWindow || floatingLyricsWindow.isDestroyed() || event.sender !== floatingLyricsWindow.webContents || floatingLyricsState.config.locked) return false
    const x = Number(payload?.x)
    const y = Number(payload?.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    floatingLyricsMoveSession = { startX: x, startY: y, bounds: floatingLyricsWindow.getBounds() }
    return true
  })
  ipcMain.on('floating-lyrics:move-move', (event, payload) => {
    if (!floatingLyricsWindow || floatingLyricsWindow.isDestroyed() || event.sender !== floatingLyricsWindow.webContents) return
    moveFloatingLyrics(payload)
  })
  ipcMain.on('floating-lyrics:move-end', (event) => {
    if (!floatingLyricsWindow || floatingLyricsWindow.isDestroyed() || event.sender !== floatingLyricsWindow.webContents) return
    floatingLyricsMoveSession = null
    saveFloatingLyricsState()
  })
  ipcMain.handle('floating-lyrics:reset', () => {
    const mode = floatingLyricsState.config.mode
    floatingLyricsState.config = { ...floatingLyricsDefaults, mode }
    floatingLyricsState.bounds = defaultFloatingLyricsBounds()
    if (floatingLyricsWindow && !floatingLyricsWindow.isDestroyed()) {
      floatingLyricsWindow.setBounds(floatingLyricsState.bounds, true)
      floatingLyricsWindow.setFocusable(false)
      applyFloatingLyricsLock()
    }
    saveFloatingLyricsState()
    broadcastFloatingLyricsState()
    return { config: floatingLyricsState.config, bounds: floatingLyricsState.bounds }
  })
}

function registerAuthIpc() {
  ipcMain.handle('auth:state', () => guarded(async () => {
    if (!sessionCookie) return { loggedIn: false, profile: null }
    try {
      const profile = await resolveAuthenticatedProfile(sessionProfile)
      if (!profile) {
        authStatusMisses += 1
        return { loggedIn: false, profile: null }
      }
      authStatusMisses = 0
      const cached = profile === sessionProfile
      saveSession(sessionCookie, profile)
      return { loggedIn: true, profile, cached }
    } catch (error) {
      if (sessionProfile) return { loggedIn: true, profile: sessionProfile, cached: true }
      throw error
    }
  }, { loggedIn: false, profile: null }))

  ipcMain.handle('auth:create-qr', () => guarded(async () => {
    const body = await callApi('login_qr_key', {}, false)
    const key = body.data?.unikey || body.unikey
    if (!key) throw new Error(body.message || '无法获取二维码登录密钥')
    const url = `https://music.163.com/login?codekey=${encodeURIComponent(key)}`
    const dataUrl = await QRCode.toDataURL(url, {
      width: 256,
      margin: 1,
      color: { dark: '#17151D', light: '#FFFFFFFF' },
      errorCorrectionLevel: 'M',
    })
    return { key, dataUrl }
  }))

  ipcMain.handle('auth:check-qr', (_event, key) => guarded(async () => {
    if (!key || typeof key !== 'string') throw new Error('无效的二维码密钥')
    const body = await callApi('login_qr_check', { key }, false)
    if (Number(body.code) === 803 && body.cookie) saveSession(body.cookie, null)
    return { code: Number(body.code || 0), message: body.message || '', loggedIn: Number(body.code) === 803 }
  }))

  ipcMain.handle('auth:login-password', (_event, payload) => guarded(async () => {
    const account = String(payload?.account || '').trim()
    const password = String(payload?.password || '')
    if (account.length < 5 || account.length > 120 || password.length < 1 || password.length > 200) {
      throw new Error('请输入有效的手机号或邮箱与密码')
    }

    const previous = sessionCookie
    const previousProfile = sessionProfile
    try {
      const isEmail = account.includes('@')
      let method = 'login_cellphone'
      let params = { phone: account.replace(/\s+/g, ''), password }
      if (isEmail) {
        method = 'login'
        params = { email: account, password }
      } else {
        const international = account.match(/^\+(\d{1,4})[-\s]+(\d{5,20})$/)
        if (international) params = { countrycode: international[1], phone: international[2], password }
      }

      const body = await callApi(method, params, false)
      if (Number(body.code) !== 200 || !body.cookie) {
        throw new Error(body.message || body.msg || `登录失败（${body.code || '未知错误'}）`)
      }
      sessionCookie = body.cookie
      const profile = authProfileFromBody(body) || await resolveAuthenticatedProfile()
      if (!profile) throw new Error('账号已验证，但未能读取用户资料')
      saveSession(body.cookie, profile)
      return { loggedIn: true, profile }
    } catch (error) {
      saveSession(previous, previousProfile)
      const message = error?.body?.message || error?.message || '登录失败'
      throw new Error(String(message).replaceAll(password, '[hidden]'))
    }
  }))

  ipcMain.handle('auth:import-cookie', (_event, value) => guarded(async () => {
    const cookie = sanitizeCookie(value)
    const previous = sessionCookie
    const previousProfile = sessionProfile
    sessionCookie = cookie
    try {
      const profile = await resolveAuthenticatedProfile()
      if (!profile) {
        if (await cookieHasAuthenticatedAccess()) {
          throw new Error('Cookie 已被网易云识别，但账户资料接口要求额外验证；请稍后重试或使用扫码登录。')
        }
        throw new Error('Cookie 未能通过网易云验证')
      }
      saveSession(cookie, profile)
      return { loggedIn: true, profile }
    } catch (error) {
      saveSession(previous, previousProfile)
      throw error
    }
  }))

  ipcMain.handle('auth:logout', () => {
    saveSession('')
    return { ok: true }
  })
}

function registerDataIpc() {
  ipcMain.handle('data:home', () => guarded(async () => {
    if (sessionCookie) {
      const [recommended, daily] = await Promise.all([
        callApi('recommend_resource').catch(() => null),
        callApi('recommend_songs').catch(() => null),
      ])
      const hasRecommended = Array.isArray(recommended?.recommend) && recommended.recommend.length > 0
      const hasDaily = Array.isArray(daily?.data?.dailySongs) && daily.data.dailySongs.length > 0
      if (hasRecommended && hasDaily) {
        return { personalized: null, newSongs: null, topPlaylists: null, recommended, daily }
      }
      // Public discovery is a fallback, not a second startup payload. Avoiding
      // five simultaneous API calls substantially reduces the initialization
      // burst for signed-in users while preserving the same visible content.
      const [personalized, newSongs, topPlaylists] = await Promise.all([
        hasRecommended ? Promise.resolve(null) : callApi('personalized', { limit: 10 }),
        hasDaily ? Promise.resolve(null) : callApi('personalized_newsong', { limit: 12 }),
        hasRecommended ? Promise.resolve(null) : callApi('top_playlist', { limit: 10, order: 'hot' }),
      ])
      return { personalized, newSongs, topPlaylists, recommended, daily }
    }
    const [personalized, newSongs, topPlaylists] = await Promise.all([
      callApi('personalized', { limit: 10 }),
      callApi('personalized_newsong', { limit: 12 }),
      callApi('top_playlist', { limit: 10, order: 'hot' }),
    ])
    return { personalized, newSongs, topPlaylists, recommended: null, daily: null }
  }))

  ipcMain.handle('data:user-playlists', (_event, uid) => guarded(() =>
    callApi('user_playlist', { uid: String(uid), limit: 100, offset: 0 })
  ))

  ipcMain.handle('data:user-detail', (_event, uid) => guarded(async () => {
    try { return await callApi('user_detail_new', { uid: String(uid) }) }
    catch { return callApi('user_detail', { uid: String(uid) }) }
  }))

  ipcMain.handle('data:playlist', (_event, id) => guarded(() =>
    callApi('playlist_detail', { id: String(id), s: 8 })
  ))

  ipcMain.handle('data:search', (_event, payload) => guarded(async () => {
    const allowedTypes = new Set([1, 10, 100, 1000, 1002, 1018])
    const requestedType = Number(payload?.type || 1)
    const type = allowedTypes.has(requestedType) ? requestedType : 1
    const keywords = String(payload?.keywords || '')
    const offset = Number(payload?.offset || 0)
    if (type !== 1018) return callApi('cloudsearch', { keywords, type, limit: 50, offset })

    // The current PC endpoint advertises type 1018 but returns an empty object.
    // Build the comprehensive result from the five authoritative search types so
    // the UI remains useful even when NetEase changes that undocumented payload.
    const types = [1, 100, 10, 1000, 1002]
    const responses = await Promise.allSettled(types.map((searchType) =>
      Promise.race([
        callApi('cloudsearch', { keywords, type: searchType, limit: searchType === 1 ? 30 : 18, offset }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('搜索请求超时')), 18000)),
      ])
    ))
    if (!responses.some((response) => response.status === 'fulfilled')) {
      throw new Error('搜索服务暂时不可用，请检查网络后重试')
    }
    const resultOf = (index) => responses[index].status === 'fulfilled'
      ? (responses[index].value?.result || {})
      : {}
    return {
      code: 200,
      result: {
        songs: resultOf(0).songs || [],
        artists: resultOf(1).artists || [],
        albums: resultOf(2).albums || [],
        playlists: resultOf(3).playlists || [],
        userprofiles: resultOf(4).userprofiles || [],
      },
    }
  }))

  ipcMain.handle('data:lyrics', (_event, id) => guarded(async () => {
    try { return await callApi('lyric_new', { id: String(id) }) }
    catch { return callApi('lyric', { id: String(id) }) }
  }))

  ipcMain.handle('data:song-url', (_event, payload) => guarded(async () => {
    const id = String(payload?.id || '')
    const requested = String(payload?.level || 'best')
    const supported = new Set(['best', 'standard', 'higher', 'exhigh', 'lossless', 'hires', 'jyeffect', 'sky', 'dolby', 'jymaster'])
    const level = supported.has(requested) ? requested : 'best'
    const candidates = level === 'best'
      ? ['jymaster', 'dolby', 'sky', 'jyeffect', 'hires', 'lossless', 'exhigh', 'higher', 'standard']
      : [level]
    for (const candidate of candidates) {
      try {
        const body = await callApi('song_url_v1', { id, level: candidate })
        if (body.data?.[0]?.url) return { ...body, requestedLevel: level }
      } catch {}
    }
    return callApi('song_url', { id, br: 320000 })
  }))

  ipcMain.handle('data:personal-fm', () => guarded(() => callApi('personal_fm')))
  ipcMain.handle('data:daily', () => guarded(() => callApi('recommend_songs')))
  ipcMain.handle('data:like', (_event, payload) => guarded(() =>
    callApi('like', { id: String(payload?.id || ''), like: payload?.like !== false })
  ))
  ipcMain.handle('data:like-list', (_event, uid) => guarded(() =>
    callApi('likelist', { uid: String(uid || ''), timestamp: Date.now() })
  ))
  ipcMain.handle('data:playlist-subscribe', (_event, payload) => guarded(() =>
    callApi('playlist_subscribe', { id: String(payload?.id || ''), t: payload?.subscribe === false ? 2 : 1 })
  ))
  ipcMain.handle('data:playlist-create', (_event, payload) => guarded(() => {
    const name = String(payload?.name || '').trim()
    if (!name || name.length > 40) throw new Error('歌单名称需为 1 至 40 个字符')
    return callApi('playlist_create', { name, privacy: 0 })
  }))
  ipcMain.handle('data:playlist-update', (_event, payload) => guarded(() => {
    const id = String(payload?.id || '')
    const name = String(payload?.name || '').trim()
    const description = String(payload?.description || '').trim()
    const tags = Array.isArray(payload?.tags) ? payload.tags.map((tag) => String(tag).trim()).filter(Boolean).join(';') : ''
    if (!/^\d+$/.test(id)) throw new Error('无效的歌单')
    if (!name || name.length > 40) throw new Error('歌单名称需为 1 至 40 个字符')
    if (description.length > 1000) throw new Error('歌单简介不能超过 1000 个字符')
    return callApi('playlist_update', { id, name, desc: description, tags })
  }))
  ipcMain.handle('data:playlist-delete', (_event, payload) => guarded(() => {
    const id = String(payload?.id || '')
    if (!/^\d+$/.test(id)) throw new Error('无效的歌单')
    return callApi('playlist_delete', { id })
  }))
  ipcMain.handle('data:playlist-track', (_event, payload) => guarded(() => {
    const op = payload?.op === 'del' ? 'del' : 'add'
    const pid = String(payload?.pid || '')
    const trackId = String(payload?.trackId || '')
    if (!/^\d+$/.test(pid) || !/^\d+$/.test(trackId)) throw new Error('无效的歌单或歌曲')
    return callApi('playlist_tracks', { op, pid, tracks: trackId })
  }))
  ipcMain.handle('data:playlist-reorder', (_event, payload) => guarded(() => {
    const pid = String(payload?.pid || '')
    const trackIds = Array.isArray(payload?.trackIds) ? payload.trackIds.map(String) : []
    if (!/^\d+$/.test(pid) || !trackIds.length || trackIds.some((id) => !/^\d+$/.test(id))) throw new Error('无效的歌单或歌曲顺序')
    return callApi('song_order_update', { pid, ids: JSON.stringify(trackIds) })
  }))
}

if (hasSingleInstanceLock) {
  app.whenReady().then(() => {
    loadSession()
    loadFloatingLyricsState()
    registerPlaybackProtocol()
    registerWindowIpc()
    registerAuthIpc()
    registerDataIpc()
    createWindow()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  cancelMediaPreload()
  cancelPlaybackMediaSource()
  clearTimeout(floatingLyricsSaveTimer)
  clearFloatingLyricsShowTimer()
  if (!resettingApplication) writeFloatingLyricsState()
  floatingLyricsResizeSession = null
  if (floatingLyricsWindow && !floatingLyricsWindow.isDestroyed()) floatingLyricsWindow.destroy()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
