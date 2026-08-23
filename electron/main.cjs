process.env.DOTENV_CONFIG_QUIET = 'true'

function ignoreClosedOutputPipe(stream) {
  stream?.on?.('error', (error) => {
    if (error?.code === 'EPIPE') return
    process.nextTick(() => { throw error })
  })
}

ignoreClosedOutputPipe(process.stdout)
ignoreClosedOutputPipe(process.stderr)

const { app, BrowserWindow, ipcMain, safeStorage, shell, nativeTheme, session, screen, net, protocol } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const QRCode = require('qrcode')
const {
  PLAYBACK_STARTUP_BYTES,
  PLAYBACK_BUFFER_LOW_SECONDS,
  PLAYBACK_BUFFER_HIGH_SECONDS,
  resetPlaybackBufferForSeek,
  effectivePlaybackBytesPerSecond,
  playbackBurstBytesPerSecond,
  playbackSegmentBytes,
  playbackRangeMinimumBytes,
  playbackRangeIsPrimed,
  playbackTransferBytesPerSecond,
  beginPlaybackRange,
  requestedByteRange,
  parseContentRange,
} = require('./playback-stream.cjs')
const {
  normalizeAudioQuality,
  requestedApiAudioQuality,
} = require('./audio-quality.cjs')
const { createLyricsLoader } = require('./lyrics-loader.cjs')

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

const mainWindowZoomFactors = [.5, .67, .75, .8, .9, 1, 1.1, 1.25, 1.5, 1.75, 2]

function normalizedMainWindowZoom(value) {
  const factor = Number(value)
  if (!Number.isFinite(factor)) return 1
  return Math.max(mainWindowZoomFactors[0], Math.min(mainWindowZoomFactors.at(-1), factor))
}

function setMainWindowZoom(value, notify = true) {
  const factor = normalizedMainWindowZoom(value)
  if (!mainWindow || mainWindow.isDestroyed()) return factor
  mainWindow.webContents.setZoomFactor(factor)
  if (notify && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('window:zoom-changed', factor)
  }
  return factor
}

function stepMainWindowZoom(direction) {
  if (!mainWindow || mainWindow.isDestroyed()) return 1
  const current = mainWindow.webContents.getZoomFactor()
  const nearestIndex = mainWindowZoomFactors.reduce((bestIndex, factor, index) => (
    Math.abs(factor - current) < Math.abs(mainWindowZoomFactors[bestIndex] - current) ? index : bestIndex
  ), 0)
  const nextIndex = Math.max(0, Math.min(mainWindowZoomFactors.length - 1, nearestIndex + Math.sign(Number(direction) || 0)))
  return setMainWindowZoom(mainWindowZoomFactors[nextIndex])
}

function handleMainWindowZoomShortcut(event, input) {
  if (!input || (!input.control && !input.meta) || input.alt) return
  const key = String(input.key || '').toLowerCase()
  const code = String(input.code || '')
  const zoomIn = key === '+' || key === '=' || code === 'NumpadAdd'
  const zoomOut = key === '-' || code === 'NumpadSubtract'
  const zoomReset = key === '0' || code === 'Numpad0'
  if (!zoomIn && !zoomOut && !zoomReset) return
  event.preventDefault()
  if (input.type !== 'keyDown') return
  if (zoomReset) setMainWindowZoom(1)
  else stepMainWindowZoom(zoomIn ? 1 : -1)
}

const githubLatestReleaseApi = 'https://api.github.com/repos/ichiris/MenoRadio/releases/latest'
const githubLatestReleasePage = 'https://github.com/ichiris/MenoRadio/releases/latest'
const githubReleasesAtom = 'https://github.com/ichiris/MenoRadio/releases.atom'

function normalizedReleaseVersion(value) {
  return String(value || '').trim().replace(/^v/i, '')
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function atomReleaseBody(value) {
  const html = decodeXmlEntities(value)
  if (!html.trim() || html.trim() === 'No content.') return ''
  return html
    .replace(/<pre\b[^>]*>\s*<code\b[^>]*>/gi, '\n```\n')
    .replace(/<\/code>\s*<\/pre>/gi, '\n```\n')
    .replace(/<h([1-6])\b[^>]*>/gi, (_match, level) => `\n${'#'.repeat(Number(level))} `)
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|ul|ol|blockquote)>/gi, '\n')
    .replace(/<(?:p|div|ul|ol|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function fetchGithubResource(url, accept, timeoutMs = 10000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await net.fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept: accept,
        'User-Agent': `MenoRadio/${app.getVersion()}`,
      },
    })
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`)
    return { text: await response.text(), url: response.url || url }
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchGithubText(url, accept, timeoutMs = 10000) {
  return (await fetchGithubResource(url, accept, timeoutMs)).text
}

function releaseResult(release) {
  const currentVersion = app.getVersion()
  return {
    currentVersion,
    tag: release.tag,
    updateAvailable: normalizedReleaseVersion(release.tag) !== normalizedReleaseVersion(currentVersion),
    name: release.name || '',
    body: release.body || '',
    url: release.url || 'https://github.com/ichiris/MenoRadio/releases',
    publishedAt: release.publishedAt || '',
  }
}

async function getLatestGithubReleaseFromApi() {
  // Follow the release explicitly marked as Latest on GitHub. Release-list and
  // Atom-feed order only describe publication time, so a newer test release can
  // remain first there even after another release is selected as Latest.
  const text = await fetchGithubText(githubLatestReleaseApi, 'application/vnd.github+json')
  const release = JSON.parse(text)
  const tag = String(release?.tag_name || '').trim()
  if (!release || release.draft || !tag) throw new Error('No latest GitHub release found')
  return releaseResult({
    tag,
    name: String(release.name || ''),
    body: String(release.body || ''),
    url: String(release.html_url || 'https://github.com/ichiris/MenoRadio/releases'),
    publishedAt: String(release.published_at || ''),
  })
}

function getReleaseFromAtom(xml, expectedTag) {
  const normalizedExpectedTag = normalizedReleaseVersion(expectedTag)
  const entries = [...String(xml || '').matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => match[1])
  for (const entry of entries) {
    const url = decodeXmlEntities(entry.match(/<link\b(?=[^>]*\brel="alternate")(?=[^>]*\bhref="([^"]+)")[^>]*\/?\s*>/i)?.[1] || '')
    const tagPart = url.match(/\/releases\/tag\/([^/?#]+)/i)?.[1] || ''
    const tag = decodeURIComponent(tagPart).trim()
    if (!tag || normalizedReleaseVersion(tag) !== normalizedExpectedTag) continue
    const title = decodeXmlEntities(entry.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i)?.[1] || '')
    const content = entry.match(/<content(?:\s[^>]*)?>([\s\S]*?)<\/content>/i)?.[1] || ''
    const publishedAt = decodeXmlEntities(entry.match(/<updated>([^<]+)<\/updated>/i)?.[1] || '')
    return { tag, name: title, body: atomReleaseBody(content), url, publishedAt }
  }
  return null
}

async function getLatestGithubReleaseFromPage() {
  // The public /releases/latest page redirects to the selected release and is
  // not subject to the unauthenticated API quota. Use that redirect as the
  // source of truth, then enrich it with notes from the matching Atom entry.
  const latestPage = await fetchGithubResource(githubLatestReleasePage, 'text/html')
  const tagPart = latestPage.url.match(/\/releases\/tag\/([^/?#]+)/i)?.[1] || ''
  const tag = decodeURIComponent(tagPart).trim()
  if (!tag) throw new Error('GitHub latest release did not redirect to a tag')

  let atomRelease = null
  try {
    const xml = await fetchGithubText(githubReleasesAtom, 'application/atom+xml')
    atomRelease = getReleaseFromAtom(xml, tag)
  } catch {
    // The redirect already identified the release. Missing release notes should
    // not turn a successful update check into a failure.
  }
  return releaseResult(atomRelease || {
    tag,
    name: tag,
    body: '',
    url: latestPage.url,
    publishedAt: '',
  })
}

async function getLatestGithubRelease() {
  try {
    return await getLatestGithubReleaseFromApi()
  } catch {
    // Shared IPs can exhaust GitHub's unauthenticated API allowance. The public
    // latest redirect still preserves GitHub's explicit Latest selection.
    return getLatestGithubReleaseFromPage()
  }
}

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
let playbackMediaSource = null

function cancelPlaybackMediaSource() {
  const source = playbackMediaSource
  if (!source) return false
  source.cancelled = true
  source.activeReader?.cancel()
  for (const request of source.requests) request.abort()
  source.requests.clear()
  for (const wake of source.bufferWaiters) wake()
  source.bufferWaiters.clear()
  playbackMediaSource = null
  return true
}

function playbackSourceUrl(payload = {}) {
  cancelMediaPreload()
  cancelPlaybackMediaSource()
  const url = validateMediaPreloadUrl(payload.url)
  const token = crypto.randomUUID()
  playbackMediaSource = {
    token,
    url,
    size: Math.max(0, Number(payload.size) || 0),
    cruiseBytesPerSecond: effectivePlaybackBytesPerSecond(payload),
    burstBytesPerSecond: playbackBurstBytesPerSecond(payload),
    rangeMinimumBytes: playbackRangeMinimumBytes(payload),
    rangeBytesPumped: 0,
    availableAt: Date.now(),
    bufferAheadSeconds: 0,
    bufferKnown: false,
    bufferGateClosed: false,
    seekPrimingUntil: 0,
    seekRangePending: false,
    starving: false,
    paused: false,
    bufferWaiters: new Set(),
    activeReader: null,
    cancelled: false,
    requests: new Set(),
  }
  return `${playbackProtocolScheme}://playback/${token}`
}

function responseHeader(headers, name) {
  const value = headers?.[String(name).toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function playbackResponseHeaders(source, start, end, total, partial) {
  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Type': source.contentType || 'audio/mpeg',
  }
  if (Number.isSafeInteger(end) && end >= start) headers['Content-Length'] = String(end - start + 1)
  if (partial && total > 0) headers['Content-Range'] = `bytes ${start}-${end}/${total}`
  return headers
}

function updatePlaybackBuffer(payload = {}) {
  const source = playbackMediaSource
  if (!source || source.cancelled) return false
  let token = ''
  try {
    const parsed = new URL(String(payload.src || ''))
    if (parsed.protocol !== `${playbackProtocolScheme}:` || parsed.hostname !== 'playback') return false
    token = parsed.pathname.replace(/^\//, '')
  } catch {
    return false
  }
  if (token !== source.token) return false
  const ahead = Math.max(0, Math.min(300, Number(payload.bufferedAhead) || 0))
  source.bufferAheadSeconds = ahead
  source.paused = Boolean(payload.paused)
  const readyState = Math.max(0, Number(payload.readyState) || 0)
  source.starving = Boolean(payload.starving)
    || (!source.paused && readyState <= 2)
  if (Boolean(payload.seeking) || source.starving || Date.now() < source.seekPrimingUntil) {
    source.bufferKnown = false
    source.bufferGateClosed = false
    for (const wake of source.bufferWaiters) wake()
    source.bufferWaiters.clear()
    return true
  }
  source.bufferKnown = true
  if (source.bufferGateClosed) {
    if (ahead <= PLAYBACK_BUFFER_LOW_SECONDS) source.bufferGateClosed = false
  } else if (playbackRangeIsPrimed(source)
    && ahead >= (source.paused ? PLAYBACK_BUFFER_LOW_SECONDS : PLAYBACK_BUFFER_HIGH_SECONDS)) {
    source.bufferGateClosed = true
  }
  if (!source.bufferGateClosed) {
    for (const wake of source.bufferWaiters) wake()
    source.bufferWaiters.clear()
  }
  return true
}

function preparePlaybackSeek(payload = {}) {
  const source = playbackMediaSource
  if (!source || source.cancelled) return false
  let token = ''
  try {
    const parsed = new URL(String(payload.src || ''))
    if (parsed.protocol !== `${playbackProtocolScheme}:` || parsed.hostname !== 'playback') return false
    token = parsed.pathname.replace(/^\//, '')
  } catch {
    return false
  }
  if (token !== source.token || !resetPlaybackBufferForSeek(source)) return false
  for (const wake of source.bufferWaiters) wake()
  source.bufferWaiters.clear()
  return true
}

function cancellableDelay(milliseconds, reader) {
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (reader.cancelled || reader.source.cancelled) return reject(new Error('Playback request cancelled'))
    const timer = setTimeout(() => {
      reader.delayTimers.delete(timer)
      if (reader.cancelled || reader.source.cancelled) reject(new Error('Playback request cancelled'))
      else resolve()
    }, milliseconds)
    timer.unref?.()
    reader.delayTimers.add(timer)
  })
}

async function reservePlaybackBandwidth(source, reader, byteLength) {
  const now = Date.now()
  const rate = playbackTransferBytesPerSecond(source, reader, now)
  const start = Math.max(now, source.availableAt)
  source.availableAt = start + Math.ceil((byteLength / Math.max(1, rate)) * 1000)
  await cancellableDelay(Math.max(0, start - now), reader)
}

async function waitForPlaybackWindow(source, reader) {
  if (source.starving || Date.now() < source.seekPrimingUntil) source.bufferGateClosed = false
  while (source.bufferGateClosed && !source.starving && !source.cancelled && !reader.cancelled) {
    await new Promise((resolve) => {
      let timer = null
      const wake = () => {
        clearTimeout(timer)
        source.bufferWaiters.delete(wake)
        resolve()
      }
      timer = setTimeout(wake, 1200)
      timer.unref?.()
      source.bufferWaiters.add(wake)
    })
  }
  if (source.cancelled || reader.cancelled) throw new Error('Playback request cancelled')
}

function fetchPlaybackSegment(source, reader, start, end) {
  return new Promise((resolve, reject) => {
    if (source.cancelled || reader.cancelled) return reject(new Error('Playback request cancelled'))
    const upstreamRequest = net.request({
      url: source.url,
      method: 'GET',
      session: session.defaultSession,
      redirect: 'follow',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    upstreamRequest.setHeader('Range', `bytes=${start}-${end}`)
    upstreamRequest.setHeader('Accept-Encoding', 'identity')
    source.requests.add(upstreamRequest)
    reader.requests.add(upstreamRequest)
    const expectedLength = end - start + 1
    const chunks = []
    let received = 0
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      source.requests.delete(upstreamRequest)
      reader.requests.delete(upstreamRequest)
      if (error) reject(error)
      else resolve(value)
    }
    upstreamRequest.on('response', (response) => {
      if (![200, 206].includes(response.statusCode)) {
        upstreamRequest.abort()
        finish(new Error(`Playback media request failed (${response.statusCode})`))
        return
      }
      const contentLength = Number(responseHeader(response.headers, 'content-length')) || 0
      if (response.statusCode !== 206 && (start > 0 || contentLength > expectedLength)) {
        upstreamRequest.abort()
        finish(new Error('Playback server ignored a bounded range'))
        return
      }
      const upstreamRange = parseContentRange(responseHeader(response.headers, 'content-range'))
      if (upstreamRange && upstreamRange.start !== start) {
        upstreamRequest.abort()
        finish(new Error('Playback server returned an unexpected range'))
        return
      }
      if (!source.size) {
        source.size = upstreamRange?.total || (response.statusCode === 200 ? contentLength : 0)
      }
      source.contentType ||= responseHeader(response.headers, 'content-type') || 'audio/mpeg'
      response.on('data', (chunk) => {
        if (!chunk?.length || settled) return
        received += chunk.length
        if (received > expectedLength) {
          upstreamRequest.abort()
          finish(new Error('Playback range exceeded its requested size'))
          return
        }
        chunks.push(Buffer.from(chunk))
      })
      response.on('end', () => {
        if (!received) finish(new Error('Playback range returned no data'))
        else finish(null, {
          bytes: Buffer.concat(chunks, received),
          range: upstreamRange,
        })
      })
      response.on('aborted', () => {
        if (!source.cancelled && !reader.cancelled) finish(new Error('Playback response aborted'))
        else finish(new Error('Playback request cancelled'))
      })
      response.on('error', (error) => finish(error))
    })
    upstreamRequest.on('error', (error) => {
      finish(source.cancelled || reader.cancelled ? new Error('Playback request cancelled') : error)
    })
    upstreamRequest.end()
  })
}

async function readSegmentedPlayback(source, protocolRequest) {
  if (source.cancelled) throw new Error('Playback source cancelled')
  const rangeHeader = protocolRequest.headers.get('range') || ''
  const requested = requestedByteRange(rangeHeader || 'bytes=0-', source.size)
  if (source.size > 0 && requested.start >= source.size) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${source.size}`, 'Accept-Ranges': 'bytes' },
    })
  }
  source.activeReader?.cancel()
  // Start the short seek burst when Chromium actually asks for the new byte
  // range. Starting it at pointer-up spent part of the window before any
  // bytes could arrive, which occasionally left high-bitrate tracks in a
  // play-for-two-seconds / wait-for-one-second cycle after a backward seek.
  beginPlaybackRange(source)
  // A fresh byte range must never inherit the previous range's buffered-ahead
  // decision. Chromium commonly opens this request while completing a seek.
  source.bufferAheadSeconds = 0
  source.bufferKnown = false
  source.bufferGateClosed = false
  source.starving = false
  source.rangeBytesPumped = 0
  source.availableAt = Math.min(source.availableAt, Date.now())
  for (const wake of source.bufferWaiters) wake()
  source.bufferWaiters.clear()
  const reader = {
    source,
    cancelled: false,
    requests: new Set(),
    delayTimers: new Set(),
    startupBytesRemaining: PLAYBACK_STARTUP_BYTES,
    cancel() {
      if (reader.cancelled) return
      reader.cancelled = true
      for (const timer of reader.delayTimers) clearTimeout(timer)
      reader.delayTimers.clear()
      for (const request of reader.requests) request.abort()
      reader.requests.clear()
      for (const wake of source.bufferWaiters) wake()
      source.bufferWaiters.clear()
    },
  }
  source.activeReader = reader
  const abortReader = () => reader.cancel()
  protocolRequest.signal?.addEventListener('abort', abortReader, { once: true })
  const cleanup = () => {
    protocolRequest.signal?.removeEventListener('abort', abortReader)
    if (source.activeReader === reader) source.activeReader = null
  }

  let cursor = requested.start
  let finalEnd = requested.end
  const fetchNext = async () => {
    if (source.cancelled || reader.cancelled) throw new Error('Playback request cancelled')
    if (source.size > 0) finalEnd = Math.min(finalEnd, source.size - 1)
    const remaining = finalEnd === Number.MAX_SAFE_INTEGER
      ? Number.MAX_SAFE_INTEGER
      : finalEnd - cursor + 1
    const length = playbackSegmentBytes(remaining)
    if (!length) return null
    await reservePlaybackBandwidth(source, reader, length)
    const result = await fetchPlaybackSegment(source, reader, cursor, cursor + length - 1)
    if (result.bytes.length < length && !source.size) {
      // A few CDN responses omit Content-Range/total. A short bounded response
      // still tells us that this is the final segment, so stop cleanly instead
      // of issuing empty ranges forever.
      finalEnd = cursor + result.bytes.length - 1
      source.size = finalEnd + 1
    }
    reader.startupBytesRemaining = Math.max(0, reader.startupBytesRemaining - result.bytes.length)
    if (source.activeReader === reader) source.rangeBytesPumped += result.bytes.length
    if (source.size > 0) finalEnd = Math.min(finalEnd, source.size - 1)
    cursor += result.bytes.length
    return result
  }

  let first
  try {
    first = await fetchNext()
  } catch (error) {
    cleanup()
    throw error
  }
  if (!first) {
    cleanup()
    return new Response(null, { status: 416 })
  }
  const total = source.size || first.range?.total || 0
  if (total > 0) finalEnd = Math.min(finalEnd, total - 1)
  const responseEnd = finalEnd === Number.MAX_SAFE_INTEGER
    ? null
    : finalEnd
  const partial = Boolean(rangeHeader) || requested.start > 0
  let firstBytes = first.bytes
  let pumping = false
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(firstBytes.buffer, firstBytes.byteOffset, firstBytes.byteLength))
      firstBytes = null
      if (cursor > finalEnd) {
        controller.close()
        cleanup()
      }
    },
    async pull(controller) {
      if (pumping || reader.cancelled) return
      if (cursor > finalEnd) {
        controller.close()
        cleanup()
        return
      }
      pumping = true
      try {
        await waitForPlaybackWindow(source, reader)
        const segment = await fetchNext()
        if (!segment) {
          controller.close()
          cleanup()
          return
        }
        controller.enqueue(new Uint8Array(segment.bytes.buffer, segment.bytes.byteOffset, segment.bytes.byteLength))
        if (cursor > finalEnd) {
          controller.close()
          cleanup()
        }
      } catch (error) {
        cleanup()
        if (!reader.cancelled && !source.cancelled) controller.error(error)
      } finally {
        pumping = false
      }
    },
    cancel() {
      reader.cancel()
      cleanup()
    },
  })
  return new Response(body, {
    status: partial ? 206 : 200,
    headers: playbackResponseHeaders(source, requested.start, responseEnd, total, partial),
  })
}

function registerPlaybackProtocol() {
  protocol.handle(playbackProtocolScheme, (request) => {
    const parsed = new URL(request.url)
    const token = parsed.pathname.replace(/^\//, '')
    const source = playbackMediaSource
    if (!source || source.cancelled || parsed.hostname !== 'playback' || token !== source.token) {
      return new Response(null, { status: 404 })
    }
    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: {
          'Accept-Ranges': 'bytes',
          ...(source.size > 0 ? { 'Content-Length': String(source.size) } : {}),
        },
      })
    }
    const task = Promise.resolve()
      .then(() => readSegmentedPlayback(source, request))
      .catch((error) => {
        if (!source.cancelled && !request.signal?.aborted) {
          console.warn('[playback-stream] Unable to read audio:', error?.message || error)
        }
        return new Response(null, { status: source.cancelled || request.signal?.aborted ? 499 : 502 })
      })
    return task
  })
}

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
    .slice(0, 1)
  if (!key || !urls.length) return { completed: false }
  if (activeMediaPreload?.key === key) return activeMediaPreload.promise
  cancelMediaPreload()
  mediaPreloadBandwidthAvailableAt = Date.now()
  const task = { key, request: null, resumeTimer: null, cancelled: false, promise: null }
  task.promise = (async () => {
    try {
      // Only the next cover uses this low-priority lane. Audio bodies are never
      // warmed here; resolving songUrl in the renderer is enough to remove API latency.
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

const lyricsLoader = createLyricsLoader({
  fetchNew: (id) => callApi('lyric_new', { id }),
  fetchLegacy: (id) => callApi('lyric', { id }),
})

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

  // Chromium remembers zoom per origin independently from MenoRadio's data.
  // Always establish a neutral baseline; the renderer restores the user's
  // explicit MenoRadio setting after it has loaded.
  mainWindow.webContents.setZoomFactor(1)
  mainWindow.webContents.on('before-input-event', handleMainWindowZoomShortcut)
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
  ipcMain.handle('window:get-zoom', () => mainWindow?.webContents.getZoomFactor() || 1)
  ipcMain.handle('window:set-zoom', (_event, payload) => {
    const value = payload && typeof payload === 'object' ? payload.value : payload
    const notify = payload && typeof payload === 'object' ? payload.notify !== false : true
    return setMainWindowZoom(value, notify)
  })
  ipcMain.handle('window:step-zoom', (_event, direction) => stepMainWindowZoom(direction))
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:check-update', () => getLatestGithubRelease())
  ipcMain.handle('app:third-party-notices', () => fs.readFileSync(path.join(__dirname, '..', 'THIRD_PARTY_NOTICES.md'), 'utf8'))
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
    setMainWindowZoom(1, false)

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
  ipcMain.handle('image:thumbnail', (_event, payload) => getThumbnail(payload?.url, payload?.forceRefresh === true))
  ipcMain.handle('media:preload-next', (_event, payload) => preloadNextMedia(payload))
  ipcMain.handle('media:cancel-preload', (_event, exceptKey) => cancelMediaPreload(String(exceptKey || '')))
  ipcMain.handle('media:playback-url', (_event, payload) => playbackSourceUrl(payload))
  ipcMain.handle('media:prepare-seek', (_event, payload) => preparePlaybackSeek(payload))
  ipcMain.handle('media:cancel-playback', () => cancelPlaybackMediaSource())
  ipcMain.on('media:playback-buffer', (event, payload) => {
    if (event.sender !== mainWindow?.webContents) return
    updatePlaybackBuffer(payload)
  })
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

  ipcMain.handle('data:artist', (_event, id) => guarded(async () => {
    const artistId = String(id)
    const loadSongs = async () => {
      const songs = []
      const limit = 100
      let offset = 0
      for (let page = 0; page < 20; page += 1) {
        const response = await callApi('artist_songs', { id: artistId, order: 'hot', limit, offset })
        const batch = Array.isArray(response?.songs) ? response.songs : []
        songs.push(...batch)
        offset += batch.length
        if (!batch.length || response?.more === false || (Number(response?.total) > 0 && songs.length >= Number(response.total))) break
      }
      return songs
    }
    const [detail, description, songs] = await Promise.all([
      callApi('artist_detail', { id: artistId }).catch(() => null),
      callApi('artist_desc', { id: artistId }).catch(() => null),
      loadSongs(),
    ])
    return { detail, description, songs }
  }))

  ipcMain.handle('data:album', (_event, id) => guarded(() =>
    callApi('album', { id: String(id) })
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

  ipcMain.handle('data:lyrics', (_event, id) => guarded(() => lyricsLoader.load(id)))

  ipcMain.handle('data:song-url', (_event, payload) => guarded(async () => {
    const id = String(payload?.id || '')
    const level = normalizeAudioQuality(payload?.level)
    const apiLevel = requestedApiAudioQuality(level)
    // song_url_v1 already negotiates the highest level the account and track
    // can use. Probing every quality serially made the Play button wait for up
    // to nine API round trips before the browser could request one audio byte.
    try {
      const body = await callApi('song_url_v1', { id, level: apiLevel })
      if (body.data?.[0]?.url) {
        return {
          ...body,
          requestedLevel: level,
          resolvedLevel: body.data[0].level || apiLevel,
        }
      }
    } catch {}
    const body = await callApi('song_url', { id, br: 320000 })
    return { ...body, requestedLevel: level, resolvedLevel: 'exhigh' }
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
    // Clear the obsolete whole-session limiter before any renderer/API work.
    // Bulk media now owns its own pacing and must never delay application data.
    session.defaultSession.disableNetworkEmulation()
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
