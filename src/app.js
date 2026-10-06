const bridge = window.menoradio
const {
  clamp,
  adaptiveLyricFontSize,
  hexToHsv,
  hsvToHex,
  hexToRgbText,
  parseRgbColor,
  escapeHtml,
  attr,
  truncate,
  formatTime,
  formatDuration,
  formatCount,
  formatBytes,
  hashColor,
  legacyFontNames,
  fontCss,
  fontLabel,
  sizedImageUrl,
  upcomingTracks,
  uniqueTracks,
  shuffleTracks,
  rotateTracks,
  buildPlaybackQueue,
  parseLrcDocument,
  parseLrc,
  parseYrc,
  applyTimedDurations,
  alignLyricBreaks,
  mergeLyrics,
} = window.MenoRadioCore
const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`
const playbackSessionStorageKey = 'menoradio.playbackSession.v1'
const searchHistoryStorageKey = 'menoradio.searchHistory.v1'
const updateNotificationStorageKey = 'menoradio.lastNotifiedReleaseTag.v1'
const zoomStorageKey = 'menoradio.zoomFactor.v1'
const searchHistoryLimit = 12
const lyricsClockIntervalMs = 180
const lyricsClockMinimumDelayMs = 8
const lyricActivationToleranceSeconds = .06
let pendingAutomaticRelease = null
let updateCheckPromise = null
let zoomControlsHideTimer = 0
let restoringPageZoom = false

function markdownInline(value) {
  const tokens = []
  const token = (html) => {
    const key = `\u0000${tokens.length}\u0000`
    tokens.push(html)
    return key
  }
  let source = String(value || '')
  source = source.replace(/`([^`]+)`/g, (_match, code) => token(`<code>${escapeHtml(code)}</code>`))
  source = source.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => token(`<button type="button" class="markdown-link" data-external="${attr(url)}">${escapeHtml(label)}</button>`))
  source = source.replace(/<(https?:\/\/[^>]+)>/g, (_match, url) => token(`<button type="button" class="markdown-link" data-external="${attr(url)}">${escapeHtml(url)}</button>`))
  source = escapeHtml(source)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  return source.replace(/\u0000(\d+)\u0000/g, (_match, index) => tokens[Number(index)] || '')
}

function markdownTableCells(line) {
  return String(line || '')
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

function renderSafeMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n')
  const output = []
  let paragraph = []
  let listType = ''
  let inCode = false
  let codeLines = []
  const flushParagraph = () => {
    if (!paragraph.length) return
    output.push(`<p>${markdownInline(paragraph.join(' '))}</p>`)
    paragraph = []
  }
  const closeList = () => {
    if (!listType) return
    output.push(`</${listType}>`)
    listType = ''
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*```/.test(line)) {
      flushParagraph()
      closeList()
      if (inCode) {
        output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
        codeLines = []
        inCode = false
      } else inCode = true
      continue
    }
    if (inCode) {
      codeLines.push(line)
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      closeList()
      continue
    }
    const tableDivider = lines[index + 1]
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(tableDivider || '')) {
      flushParagraph()
      closeList()
      const headings = markdownTableCells(line)
      const alignments = markdownTableCells(tableDivider).map((cell) => {
        const left = cell.startsWith(':')
        const right = cell.endsWith(':')
        return left && right ? 'center' : right ? 'right' : 'left'
      })
      const rows = []
      index += 2
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(markdownTableCells(lines[index]))
        index += 1
      }
      index -= 1
      const cellStyle = (column) => ` style="text-align:${alignments[column] || 'left'}"`
      output.push(`<div class="markdown-table-wrap"><table><thead><tr>${headings.map((cell, column) => `<th${cellStyle(column)}>${markdownInline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${headings.map((_heading, column) => `<td${cellStyle(column)}>${markdownInline(row[column] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`)
      continue
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      closeList()
      // Release-note headings stay subordinate to the dialog title.
      const level = Math.min(6, Math.max(4, heading[1].length + 3))
      output.push(`<h${level}>${markdownInline(heading[2])}</h${level}>`)
      continue
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph()
      closeList()
      output.push('<hr>')
      continue
    }
    const quote = line.match(/^\s*>\s?(.*)$/)
    if (quote) {
      flushParagraph()
      closeList()
      output.push(`<blockquote>${markdownInline(quote[1])}</blockquote>`)
      continue
    }
    const list = line.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/)
    if (list) {
      flushParagraph()
      const nextType = list[2] ? 'ol' : 'ul'
      if (listType !== nextType) {
        closeList()
        listType = nextType
        output.push(`<${listType}>`)
      }
      const task = list[3].match(/^\[([ xX])\]\s*(.*)$/)
      output.push(task
        ? `<li class="markdown-task"><input type="checkbox" disabled ${task[1].toLowerCase() === 'x' ? 'checked' : ''}>${markdownInline(task[2])}</li>`
        : `<li>${markdownInline(list[3])}</li>`)
      continue
    }
    closeList()
    paragraph.push(line.trim())
  }
  if (inCode) output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
  flushParagraph()
  closeList()
  return output.join('')
}

const dom = {
  page: $('#page'),
  audio: $('#audio'),
  playlistNav: $('#playlistNav'),
  playerBar: $('#playerBar'),
  playerProgress: $('#playerProgress'),
  immersiveProgress: $('#immersiveProgress'),
  playButton: $('#playButton'),
  immersivePlay: $('#immersivePlay'),
  nowCover: $('#nowCover'),
  nowTitle: $('#nowTitle'),
  nowArtist: $('#nowArtist'),
  timeLabel: $('#timeLabel'),
  modalLayer: $('#modalLayer'),
  toastLayer: $('#toastLayer'),
  zoomControls: $('#zoomControls'),
  zoomValue: $('#zoomValue'),
  queueDrawer: $('#queueDrawer'),
  queueList: $('#queueList'),
  immersiveQueuePanel: $('#immersiveQueuePanel'),
  immersiveQueueList: $('#immersiveQueueList'),
  trackMenu: $('#trackMenu'),
  immersive: $('#immersivePlayer'),
  lyricsScroller: $('#lyricsScroller'),
  initializingScreen: $('#initializingScreen'),
}

function readSearchHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(searchHistoryStorageKey) || '[]')
    if (!Array.isArray(value)) return []
    return value
      .map((item) => String(item || '').trim())
      .filter((item, index, items) => item && items.findIndex((entry) => entry.toLocaleLowerCase() === item.toLocaleLowerCase()) === index)
      .slice(0, searchHistoryLimit)
  } catch {
    return []
  }
}

const state = {
  route: 'home',
  routePayload: null,
  history: [{ route: 'home', payload: null }],
  historyIndex: 0,
  profile: null,
  loggedIn: false,
  userPlaylists: [],
  home: null,
  current: null,
  queue: [],
  queueSource: [],
  queueIndex: -1,
  pageTracks: [],
  playlistTracks: [],
  lyrics: [],
  lyricBreaks: [],
  lyricsLoading: false,
  lyricsReadyGeneration: 0,
  coverReadyGeneration: 0,
  currentCoverLoadTimer: 0,
  playingGeneration: 0,
  upcomingPreloadSignature: '',
  activeLyric: -1,
  showTranslation: true,
  playMode: localStorage.getItem('menoradio.playMode') || 'repeat-all',
  lyricScale: localStorage.getItem('menoradio.lyricScale') || 'auto',
  theme: localStorage.getItem('menoradio.theme') || 'dark',
  fontFamily: localStorage.getItem('menoradio.fontFamily') || 'system',
  systemFonts: [],
  fontsLoaded: false,
  fontsLoading: false,
  fontSearchTimer: 0,
  audioQuality: localStorage.getItem('menoradio.audioQuality') || 'best',
  audioNormalization: localStorage.getItem('menoradio.audioNormalization') !== 'false',
  mediaLoadingOptimization: localStorage.getItem('menoradio.mediaLoadingOptimization') !== 'false',
  quickQueueReveal: localStorage.getItem('menoradio.quickQueueReveal') !== 'false',
  legacyPlayer: localStorage.getItem('menoradio.legacyPlayer') === 'true',
  wordHighlight: localStorage.getItem('menoradio.wordHighlight') !== 'false',
  depthBlur: localStorage.getItem('menoradio.depthBlur') !== 'false',
  userVolume: .75,
  trackReplayGainDb: 0,
  floatingLyrics: {
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
  },
  lyricsClockTimer: 0,
  liked: new Set(),
  recent: [],
  loginGeneration: 0,
  audioLoadGeneration: 0,
  audioSourceTrackId: '',
  audioSourcePromise: null,
  audioSourcePromiseGeneration: 0,
  currentAudioSource: null,
  currentAudioDirectUrl: '',
  optimizedPlaybackInPlaceRetryGeneration: 0,
  playbackProxyFallbackGeneration: 0,
  optimizedPlaybackRecoveryStartedAt: 0,
  playbackBufferReportTimer: 0,
  playbackBufferLastAt: 0,
  passiveAudioGeneration: 0,
  pendingSeekTime: null,
  pendingSeekDisplayTime: null,
  pendingSeekApplied: false,
  pendingSeekRecoveryTimer: 0,
  pendingSeekRecoveryAttempts: 0,
  seekPrimingUntil: 0,
  timelineScrubbing: false,
  timelinePreviewTime: null,
  timelineAtEnd: false,
  playbackIntentPlaying: false,
  lastStablePlaybackTime: null,
  playbackStarving: false,
  ignoreAudioErrorsUntil: 0,
  manualLyricFrame: 0,
  manualLyricTarget: 0,
  manualLyricReadable: false,
  manualLyricReadableTimer: 0,
  focusLyric: 0,
  lyricFocusRatio: .21,
  lyricWordFrame: 0,
  lyricWordLine: null,
  lyricWords: [],
  lyricWordOutgoing: [],
  coverRevealListener: null,
  backdropGeneration: 0,
  backdropUrl: '',
  backdropLayer: 0,
  backdropTransitionTimer: 0,
  likePending: new Set(),
  accountRetryTimer: 0,
  menuTrack: null,
  menuPlaylist: null,
  radioMode: false,
  radioLoading: false,
  immersiveChromeTimer: 0,
  immersiveVolumeCloseTimer: 0,
  immersiveVolumeTemporary: false,
  immersiveLayoutTimer: 0,
  immersiveLayoutSettleTimer: 0,
  immersiveLayoutGeneration: 0,
  immersiveAppSuspendTimer: 0,
  immersiveViewTimer: 0,
  immersiveViewPhaseTimer: 0,
  immersiveViewGeneration: 0,
  queueDomReleaseTimer: 0,
  queueDragIndex: -1,
  queueDropIndex: -1,
  queueJustDragged: false,
  selectedTrackIndex: -1,
  draggedTrack: null,
  dragCancelled: false,
  dragSource: '',
  draggedPageIndex: -1,
  dragOriginPlaylistId: '',
  dragDropHandled: false,
  queueWasOpenAtDragStart: false,
  queueAutoOpenedForDrag: false,
  queueAutoCloseTimer: 0,
  queueAutoOpenedByPointer: false,
  queuePointerCloseTimer: 0,
  playlistDropIndex: -1,
  dragFeedbackType: '',
  dragFeedbackLabel: '',
  dragMarkerRow: null,
  dragMarkerClass: '',
  dragPointerX: 0,
  dragPointerY: 0,
  dragLastNearQueueAt: 0,
  dragHoverPlaylistId: '',
  dragHoverTimer: 0,
  dragHoverNavigatedPlaylistId: '',
  dragPlaylistTargetElement: null,
  searchType: 1018,
  searchHistory: readSearchHistory(),
  immersiveView: 'lyrics',
  fullScreen: false,
  maximized: false,
  playbackFailureGeneration: 0,
  consecutivePlaybackFailures: 0,
  playbackRetryCounts: new Map(),
  playbackFailedTrackIds: new Set(),
  playbackFailureTimer: 0,
  audioOutputSnapshot: '',
  currentPlaylist: null,
  playlistSubscriptionPending: new Set(),
  playlistSubscriptionCooldown: new Map(),
}

const floatingLyricModes = [
  ['off', '保持关闭'],
  ['minimized', '最小化时开启'],
  ['outside-player', '不在播放页时开启'],
  ['always', '保持开启'],
]

const floatingLyricVerticalPositions = [
  ['top', '偏上'],
  ['center', '上下居中'],
  ['bottom', '偏下'],
]

let floatingColorDraft = null
let floatingLyricsResetHold = null
let applicationResetHold = null

function updateFloatingColorPicker({ preserveRgb = false } = {}) {
  const popover = $('[data-floating-color-popover]', dom.page)
  if (!popover || !floatingColorDraft) return
  const color = hsvToHex(floatingColorDraft)
  popover.style.setProperty('--picker-hue', floatingColorDraft.h)
  popover.style.setProperty('--picker-x', `${floatingColorDraft.s * 100}%`)
  popover.style.setProperty('--picker-y', `${(1 - floatingColorDraft.v) * 100}%`)
  $('[data-floating-color-value]', popover)?.replaceChildren(document.createTextNode(color.toUpperCase()))
  const hue = $('[data-floating-color-hue]', popover)
  if (hue && document.activeElement !== hue) hue.value = floatingColorDraft.h
  const rgb = $('[data-floating-color-rgb]', popover)
  if (rgb && !preserveRgb) rgb.value = hexToRgbText(color)
}

function updateFloatingColorFromPointer(event, field) {
  const rect = field.getBoundingClientRect()
  floatingColorDraft = floatingColorDraft || hexToHsv(state.floatingLyrics.color)
  floatingColorDraft.s = clamp((event.clientX - rect.left) / rect.width, 0, 1)
  floatingColorDraft.v = clamp(1 - ((event.clientY - rect.top) / rect.height), 0, 1)
  updateFloatingColorPicker()
}

const audioQualities = [
  ['best', '最佳可用音质'],
  ['standard', '标准（最高 128 kbps）'],
  ['exhigh', '极高（最高 320 kbps）'],
  ['lossless', '无损（最高 48 kHz / 16 bit）'],
  ['hires', '高解析度无损'],
  ['jyeffect', '高清臻音'],
  ['sky', '沉浸环绕声'],
  ['jymaster', '超清母带'],
]

const themes = [
  ['dark', '深色（默认）'],
  ['light', '浅色'],
  ['catppuccin-latte', 'Catppuccin Latte'],
  ['catppuccin-frappe', 'Catppuccin Frappé'],
  ['catppuccin-macchiato', 'Catppuccin Macchiato'],
  ['catppuccin-mocha', 'Catppuccin Mocha'],
]

function applyTheme() {
  if (!themes.some(([value]) => value === state.theme)) state.theme = 'dark'
  document.documentElement.dataset.theme = state.theme
}

applyTheme()

function applyDisplaySettings() {
  const legacyName = legacyFontNames[String(state.fontFamily || '').toLowerCase()]
  if (legacyName) {
    state.fontFamily = legacyName
    localStorage.setItem('menoradio.fontFamily', state.fontFamily)
  }
  if (!['auto', '60', '80', '100', '120', '150'].includes(state.lyricScale)) state.lyricScale = 'auto'
  const migratedQuality = { higher: 'exhigh', dolby: 'sky' }[state.audioQuality]
  if (migratedQuality) {
    state.audioQuality = migratedQuality
    localStorage.setItem('menoradio.audioQuality', state.audioQuality)
  }
  if (!audioQualities.some(([value]) => value === state.audioQuality)) state.audioQuality = 'best'
  applyTheme()
  applyPlayerStyleSettings()
  document.documentElement.style.setProperty('--font', fontCss(state.fontFamily))
  dom.immersive.dataset.lyricScale = state.lyricScale
  $$('[data-lyric-scale-value]').forEach((button) => {
    const active = button.dataset.lyricScaleValue === state.lyricScale
    button.classList.toggle('active', active)
    button.setAttribute('aria-selected', String(active))
  })
}

function applyPlayerStyleSettings() {
  if (state.legacyPlayer) document.documentElement.dataset.playerStyle = 'legacy'
  else delete document.documentElement.dataset.playerStyle
  dom.immersive.classList.toggle('depth-blur-off', !state.depthBlur)
}

function wordHighlightEnabled() {
  return state.wordHighlight && !state.legacyPlayer
}

// Player style changes take effect immediately: lyrics are rebuilt with or
// without word spans, and the backdrop is regenerated for the active style.
function refreshPlayerStyle({ lyrics = false, backdrop = false } = {}) {
  applyPlayerStyleSettings()
  if (lyrics && state.lyrics.length) renderLyrics(state.lyrics)
  const cover = $('#immersiveCover')
  if (backdrop && cover?.src) {
    state.backdropUrl = ''
    updateImmersiveBackdrop(cover.src, cover.complete ? cover : null)
  }
}

function placeholderCover(label = 'M', seed = label) {
  const letter = escapeHtml(String(label).trim().slice(0, 1).toUpperCase() || 'M')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${hashColor(seed)}"/><stop offset="1" stop-color="${hashColor(seed, 47)}"/></linearGradient></defs><rect width="600" height="600" rx="42" fill="url(#g)"/><circle cx="460" cy="125" r="170" fill="white" opacity=".055"/><circle cx="80" cy="520" r="220" fill="black" opacity=".09"/><text x="50%" y="54%" text-anchor="middle" font-family="Segoe UI,Arial" font-weight="700" font-size="210" fill="white" opacity=".9">${letter}</text></svg>`
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
}

function installImageRetry() {
  document.addEventListener('error', (event) => {
    const image = event.target
    if (!(image instanceof HTMLImageElement)) return
    const original = image.dataset.originalSrc || image.currentSrc || image.src
    if (!/^https?:/i.test(original)) return
    const retries = Number(image.dataset.retryCount || 0)
    if (retries >= 2) return
    image.dataset.originalSrc = original
    image.dataset.retryCount = String(retries + 1)
    window.setTimeout(() => {
      if (!image.isConnected) return
      try {
        const retryUrl = new URL(original)
        retryUrl.searchParams.set('_menoradio_retry', `${Date.now()}-${retries + 1}`)
        image.src = retryUrl.toString()
      } catch {
        image.src = original
      }
    }, retries === 0 ? 420 : 1200)
  }, true)
}

const thumbnailBlobCache = new Map()
const thumbnailLoads = new WeakMap()
const upcomingCoverPreloads = new Map()
const upcomingAudioPreloads = new Map()
let thumbnailObserver = null
const transparentThumbnail = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='

function isManagedThumbnailUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'https:' && (url.hostname.endsWith('music.126.net') || url.hostname.endsWith('music.163.com'))
  } catch {
    return false
  }
}

function thumbnailAttributes(source, size = 96) {
  const url = String(source || '')
  return state.mediaLoadingOptimization && isManagedThumbnailUrl(url)
    ? `src="${transparentThumbnail}" data-thumbnail-src="${attr(url)}" data-thumbnail-size="${size}" data-thumbnail-state="loading" decoding="async"`
    : `src="${attr(url)}" decoding="async"`
}

function thumbnailPixelSize(cssPixels = 40, maximum = 160) {
  const required = cssPixels * Math.max(1, window.devicePixelRatio || 1)
  return Math.max(64, Math.min(maximum, Math.ceil(required / 32) * 32))
}

function rememberThumbnail(url, blobUrl) {
  if (thumbnailBlobCache.has(url)) URL.revokeObjectURL(thumbnailBlobCache.get(url))
  thumbnailBlobCache.set(url, blobUrl)
  while (thumbnailBlobCache.size > 420) {
    const [oldestUrl, oldestBlob] = thumbnailBlobCache.entries().next().value
    thumbnailBlobCache.delete(oldestUrl)
    URL.revokeObjectURL(oldestBlob)
  }
}

function forgetThumbnail(url) {
  const blobUrl = thumbnailBlobCache.get(url)
  if (blobUrl) URL.revokeObjectURL(blobUrl)
  thumbnailBlobCache.delete(url)
}

function applyThumbnailBlob(image, blobUrl) {
  return new Promise((resolve, reject) => {
    if (!image.isConnected) return resolve(false)
    const cleanup = () => {
      image.removeEventListener('load', loaded)
      image.removeEventListener('error', failed)
    }
    const loaded = () => {
      cleanup()
      image.dataset.thumbnailLoaded = 'true'
      image.dataset.thumbnailState = 'ready'
      delete image.dataset.thumbnailRetryCycle
      resolve(true)
    }
    const failed = () => {
      cleanup()
      reject(new Error('Thumbnail decode failed'))
    }
    image.addEventListener('load', loaded, { once: true })
    image.addEventListener('error', failed, { once: true })
    image.src = blobUrl
    if (image.complete && image.naturalWidth > 0) loaded()
  })
}

async function loadThumbnail(image, attempt = 0) {
  if (!image?.isConnected || image.dataset.thumbnailLoaded === 'true') return
  const source = image.dataset.thumbnailSrc
  if (!source) return
  const requestUrl = sizedImageUrl(source, Number(image.dataset.thumbnailSize || 96))
  const cached = thumbnailBlobCache.get(requestUrl)
  if (cached) {
    try {
      await applyThumbnailBlob(image, cached)
      return
    } catch {
      forgetThumbnail(requestUrl)
    }
  }
  if (thumbnailLoads.has(image)) return thumbnailLoads.get(image)
  image.dataset.thumbnailState = 'loading'
  image.src = transparentThumbnail
  const request = bridge.images.thumbnail(requestUrl, attempt > 0).then(async (response) => {
    if (!response?.bytes?.length) throw new Error('缩略图未返回内容')
    const blobUrl = URL.createObjectURL(new Blob([response.bytes], { type: response.mimeType || 'image/jpeg' }))
    rememberThumbnail(requestUrl, blobUrl)
    await applyThumbnailBlob(image, blobUrl)
  }).catch(() => {
    forgetThumbnail(requestUrl)
    image.dataset.thumbnailLoaded = 'false'
    image.dataset.thumbnailState = 'loading'
    image.src = transparentThumbnail
    if (!image.isConnected) return
    if (attempt >= 3) {
      const retryCycle = Number(image.dataset.thumbnailRetryCycle || 0)
      if (retryCycle >= 2) return
      image.dataset.thumbnailRetryCycle = String(retryCycle + 1)
      window.setTimeout(() => {
        thumbnailLoads.delete(image)
        loadThumbnail(image, 0)
      }, 12000)
      return
    }
    window.setTimeout(() => {
      thumbnailLoads.delete(image)
      loadThumbnail(image, attempt + 1)
    }, [520, 1400, 3200][attempt] || 3200)
  }).finally(() => thumbnailLoads.delete(image))
  thumbnailLoads.set(image, request)
  return request
}

function installThumbnailLoading() {
  thumbnailObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return
      thumbnailObserver.unobserve(entry.target)
      loadThumbnail(entry.target)
    })
  // Keep roughly ten 58px track rows beyond either viewport edge warm. This
  // avoids a blank strip during quick scrolling without eagerly fetching an
  // entire playlist as soon as it opens.
  }, {
    root: null,
    rootMargin: '600px 0px',
    // The page and both queue surfaces are nested scroll containers. Expanding
    // their scroll clip as well as the viewport keeps about ten nearby rows
    // warm without turning the whole playlist into an eager image request.
    scrollMargin: '600px 0px',
    threshold: 0,
  })
  const observe = (root) => {
    if (root instanceof HTMLImageElement && root.matches('[data-thumbnail-src]')) thumbnailObserver.observe(root)
    root.querySelectorAll?.('img[data-thumbnail-src]').forEach((image) => thumbnailObserver.observe(image))
  }
  observe(document)
  new MutationObserver((records) => {
    records.forEach((record) => record.addedNodes.forEach((node) => {
      if (node instanceof Element) observe(node)
    }))
  }).observe(document.body, { childList: true, subtree: true })
}

function playbackCoverUrl(source) {
  if (!state.mediaLoadingOptimization) return String(source || '').replace(/^http:/, 'https:')
  const pixels = Math.max(960, Math.min(1600, Math.round(720 * Math.max(1, window.devicePixelRatio || 1))))
  return sizedImageUrl(source, pixels)
}

function loadPlaybackCover(url, priority = 'low') {
  if (!/^https:/i.test(url)) return Promise.resolve(null)
  const existing = upcomingCoverPreloads.get(url)
  if (existing) {
    if (priority === 'high') existing.image.fetchPriority = 'high'
    return existing.promise
  }
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.decoding = 'async'
  image.fetchPriority = priority
  image.referrerPolicy = 'no-referrer'
  const entry = { image, promise: null, settled: false, cancel: null }
  const promise = new Promise((resolve) => {
    const finish = (loaded) => {
      if (entry.settled) return
      entry.settled = true
      resolve(loaded)
    }
    image.onload = () => finish(image)
    image.onerror = () => finish(null)
    entry.cancel = () => {
      finish(null)
      image.onload = null
      image.onerror = null
      image.src = transparentThumbnail
    }
  })
  entry.promise = promise
  upcomingCoverPreloads.set(url, entry)
  image.src = url
  while (upcomingCoverPreloads.size > 36) {
    const oldest = upcomingCoverPreloads.keys().next().value
    if (oldest === url) break
    upcomingCoverPreloads.delete(oldest)
  }
  return promise
}

function scheduleCurrentPlaybackCover(generation = state.audioLoadGeneration) {
  clearTimeout(state.currentCoverLoadTimer)
  if (!state.mediaLoadingOptimization || !state.current || dom.audio.paused) return
  const trackId = String(state.current.id)
  const highResolutionCover = playbackCoverUrl(state.current.cover)
  state.currentCoverLoadTimer = window.setTimeout(() => {
    state.currentCoverLoadTimer = 0
    void loadPlaybackCover(highResolutionCover, 'high').then((image) => {
      if (!image || generation !== state.audioLoadGeneration || String(state.current?.id) !== trackId) return
      dom.nowCover.style.backgroundImage = `url("${highResolutionCover.replace(/["\\]/g, '')}")`
      const immersiveCover = $('#immersiveCover')
      immersiveCover.crossOrigin = 'anonymous'
      immersiveCover.src = highResolutionCover
      updateImmersiveBackdrop(highResolutionCover, image)
      state.coverReadyGeneration = generation
      maybePreloadUpcomingCovers()
    })
  }, 280)
}

function cancelPendingCoverPreloadsExcept(currentUrl) {
  for (const [url, entry] of upcomingCoverPreloads) {
    if (url === currentUrl || entry.settled) continue
    entry.cancel?.()
    upcomingCoverPreloads.delete(url)
  }
}

function clearCoverPreloads() {
  for (const entry of upcomingCoverPreloads.values()) {
    if (!entry.settled) entry.cancel?.()
  }
  upcomingCoverPreloads.clear()
}

function audioPreloadKey(track) {
  return `${String(track?.id || '')}:${state.audioQuality}`
}

function getAudioPreload(track, warmMedia = false) {
  if (!state.mediaLoadingOptimization || !track?.id) return null
  const key = audioPreloadKey(track)
  let entry = upcomingAudioPreloads.get(key)
  if (!entry) {
    entry = {
      key,
      trackId: String(track.id),
      sourcePromise: null,
      source: null,
      warming: false,
    }
    entry.sourcePromise = bridge.data.songUrl(track.id, state.audioQuality).then((response) => {
      const body = unwrap(response)
      const source = body.data?.[0] || {}
      if (!source.url) throw playbackError('这首歌暂时无法播放，可能需要会员或所在地区没有版权。', 'unavailable')
      entry.source = { ...source, url: String(source.url).replace(/^http:/, 'https:') }
      return entry.source
    }).catch((error) => {
      if (upcomingAudioPreloads.get(key) === entry) upcomingAudioPreloads.delete(key)
      throw error
    })
    upcomingAudioPreloads.set(key, entry)
  }
  if (warmMedia && !entry.warming) {
    entry.warming = true
    // Resolve songUrl now, but never preload the audio body. Eager media
    // preloading makes Chromium download complete lossless/Hi-Res files and
    // produces the exact bandwidth spike this optimization should avoid.
    const coverUrl = playbackCoverUrl(track.cover)
    void bridge.media.preloadNext(key, /^https:/i.test(coverUrl) ? [coverUrl] : [])
      .catch(() => {})
      .finally(() => { entry.warming = false })
  }
  return entry
}

function trimAudioPreloads(keepKeys) {
  for (const [key, entry] of upcomingAudioPreloads) {
    if (keepKeys.has(key)) continue
    upcomingAudioPreloads.delete(key)
  }
}

function clearAudioPreloads() {
  trimAudioPreloads(new Set())
  void bridge.media.cancelPreload().catch(() => {})
}

function cancelPendingAudioPreloadsExcept(track) {
  const keep = track?.id ? new Set([audioPreloadKey(track)]) : new Set()
  trimAudioPreloads(keep)
  // A user-initiated/current-track load always wins. The resolved URL remains
  // reusable, while the low-priority cover warm-up yields immediately.
  void bridge.media.cancelPreload().catch(() => {})
}

function maybePreloadUpcomingCovers() {
  const generation = state.audioLoadGeneration
  if (!state.mediaLoadingOptimization) return
  if (dom.audio.paused || !state.current || state.queue.length < 2) return
  if (dom.audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return
  if (state.playingGeneration !== generation || state.coverReadyGeneration !== generation || state.lyricsReadyGeneration !== generation) return
  const index = currentQueueIndex()
  const tracks = upcomingTracks(state.queue, index, 1)
  const signature = `${generation}:${tracks.map((track) => track.id).join(',')}`
  if (state.upcomingPreloadSignature === signature) return
  state.upcomingPreloadSignature = signature
  const keepAudioKeys = new Set([audioPreloadKey(state.current), ...tracks.map(audioPreloadKey)])
  trimAudioPreloads(keepAudioKeys)
  tracks.forEach((track) => getAudioPreload(track, true))
}

function imageOf(source, label = 'M') {
  const url = source?.picUrl || source?.avatarUrl || source?.coverImgUrl || source?.cover || source?.album?.picUrl || source?.al?.picUrl || source?.song?.album?.picUrl
  return url ? String(url).replace(/^http:/, 'https:') : placeholderCover(label, source?.id || label)
}

function artistOf(song) {
  const artists = song?.ar || song?.artists || song?.song?.artists || []
  return artists.map((artist) => artist.name).filter(Boolean).join(' / ') || song?.artist || '未知音乐人'
}

function albumOf(song) {
  return song?.al?.name || song?.album?.name || song?.song?.album?.name || '未知专辑'
}

function sourceSongOf(track) {
  const raw = track?.raw || track || {}
  return raw?.song || raw
}

function artistsOfTrack(track) {
  const source = sourceSongOf(track)
  const artists = source?.ar || source?.artists || source?.song?.artists || []
  return artists
    .filter((artist) => artist?.id != null && artist?.name)
    .map((artist) => ({ id: String(artist.id), name: String(artist.name), cover: imageOf(artist, artist.name) }))
}

function albumOfTrack(track) {
  const source = sourceSongOf(track)
  const album = source?.al || source?.album || source?.song?.album
  if (!album?.id) return null
  return { id: String(album.id), name: String(album.name || track?.album || '未知专辑'), cover: imageOf(album, album.name) }
}

function normalizeTrack(input) {
  const song = input?.song || input || {}
  return {
    id: String(song.id ?? input?.id ?? ''),
    name: song.name || input?.name || '未命名歌曲',
    artist: artistOf(song),
    album: albumOf(song),
    cover: imageOf(song, song.name || input?.name),
    duration: Number(song.dt ?? song.duration ?? input?.duration ?? 0),
    alias: (song.alia || song.alias || []).join(' / '),
    raw: input,
  }
}

function normalizePlaylist(input) {
  return {
    id: String(input?.id ?? ''),
    name: input?.name || '未命名歌单',
    cover: imageOf(input, input?.name),
    description: input?.description || input?.copywriter || '',
    creator: input?.creator?.nickname || '',
    trackCount: Number(input?.trackCount || 0),
    playCount: Number(input?.playCount || 0),
    creatorId: String(input?.creator?.userId ?? input?.userId ?? ''),
    subscribed: Boolean(input?.subscribed),
    tags: Array.isArray(input?.tags) ? input.tags.map(String) : [],
    raw: input,
  }
}

function likedPlaylistOf(playlists = state.userPlaylists) {
  const uid = String(state.profile?.userId || '')
  const created = playlists.filter((playlist) => playlist.creatorId === uid)
  return created.find((playlist) => Number(playlist.raw?.specialType || 0) === 5)
    || created.find((playlist) => /喜欢的音乐$/.test(playlist.name))
    || null
}

function isLikedPlaylist(playlist) {
  if (!playlist) return false
  const uid = String(state.profile?.userId || '')
  if (!uid || String(playlist.creatorId || '') !== uid) return false
  const likedPlaylist = likedPlaylistOf()
  return Number(playlist.raw?.specialType || 0) === 5
    || (likedPlaylist && String(likedPlaylist.id) === String(playlist.id))
}

function unwrap(result) {
  if (!result?.ok) throw new Error(result?.error || '请求失败')
  return result.data
}

function toast(message, title = '', type = '') {
  const element = document.createElement('div')
  element.className = `toast ${type}`
  element.innerHTML = `${title ? `<strong>${escapeHtml(title)}</strong>` : ''}${escapeHtml(message)}`
  dom.toastLayer.append(element)
  setTimeout(() => element.remove(), 3800)
}

function skeletonPage() {
  dom.page.innerHTML = `<div class="page-inner"><div class="skeleton skeleton-hero"></div><div class="skeleton skeleton-title"></div><div class="skeleton-cards">${Array(6).fill('<div class="skeleton skeleton-card"></div>').join('')}</div></div>`
}

function pageTitle(title, subtitle = '', action = '') {
  return `<div class="page-title-row"><div><h1>${escapeHtml(title)}</h1>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}</div>${action}</div>`
}

function expandableDescriptionMarkup(value, lines = 1) {
  const text = String(value || '').trim()
  if (!text) return ''
  return `<div class="entity-description-text expandable-description is-collapsed" data-expandable-description style="--description-lines:${Math.max(1, Number(lines) || 1)}">
    <span data-description-content>${escapeHtml(text)}</span>
    <button type="button" data-toggle-description aria-expanded="false" hidden>展开</button>
  </div>`
}

function refreshExpandableDescription(root) {
  const content = $('[data-description-content]', root)
  const toggle = $('[data-toggle-description]', root)
  if (!content || !toggle || !root.classList.contains('is-collapsed')) return
  toggle.hidden = !(content.scrollHeight > content.clientHeight + 1)
}

function hydrateExpandableDescriptions(container = dom.page) {
  const roots = $$('[data-expandable-description]', container)
  if (!roots.length) return
  requestAnimationFrame(() => roots.forEach(refreshExpandableDescription))
}

function renderCards(playlists) {
  return `<div class="card-grid">${playlists.map((playlistInput) => {
    const playlist = playlistInput.cover ? playlistInput : normalizePlaylist(playlistInput)
    return `<div class="music-card">
      <span class="card-cover-wrap">
        <button type="button" class="card-cover-button" data-playlist-id="${attr(playlist.id)}" aria-label="打开 ${attr(playlist.name)}"><img class="card-cover" ${thumbnailAttributes(playlist.cover, thumbnailPixelSize(220, 384))} alt=""></button>
        <button type="button" class="card-play" data-playlist-play="${attr(playlist.id)}" aria-label="播放 ${attr(playlist.name)}">${icon('play')}</button>
      </span>
      <button type="button" class="card-copy" data-playlist-id="${attr(playlist.id)}">
        <span class="card-title">${escapeHtml(playlist.name)}</span>
        <span class="card-subtitle">${playlist.creator ? escapeHtml(playlist.creator) : `${formatCount(playlist.playCount)} 次播放`}</span>
      </button>
    </div>`
  }).join('')}</div>`
}

function renderTrackTable(tracks, options = {}) {
  state.pageTracks = tracks
  state.selectedTrackIndex = -1
  if (!tracks.length) {
    const title = options.emptyTitle || '这里还是空的'
    const description = Object.prototype.hasOwnProperty.call(options, 'emptyDescription')
      ? options.emptyDescription
      : '换个关键词，或者稍后再回来看看。'
    return `<div class="empty-state"><div class="empty-state-inner"><div class="empty-icon">${icon('list')}</div><h2>${escapeHtml(title)}</h2>${description ? `<p>${escapeHtml(description)}</p>` : ''}</div></div>`
  }
  return `<div class="track-section">${tracks.map((track, index) => `<div class="track-row ${state.current?.id === track.id ? 'playing' : ''}" data-track-index="${index}" role="button" tabindex="0" draggable="true">
    <span class="track-index">${String(index + 1).padStart(2, '0')}</span>
    <div class="track-main"><img class="track-cover" ${thumbnailAttributes(track.cover, thumbnailPixelSize(40))} alt=""><span class="track-copy"><span class="track-name">${escapeHtml(track.name)}${track.alias ? ` <small>(${escapeHtml(track.alias)})</small>` : ''}</span><span class="track-artist">${escapeHtml(track.artist)}</span></span></div>
    <span class="track-album">${escapeHtml(track.album)}</span>
    <span class="track-duration">${formatDuration(track.duration)}</span>
    <button class="player-icon track-more" aria-label="更多">${icon('more')}</button>
  </div>`).join('')}</div>`
}

async function loadHome(force = false) {
  if (state.home && !force) return state.home
  const data = unwrap(await bridge.data.home())
  const personalized = (data.personalized?.result || []).map(normalizePlaylist)
  const top = (data.topPlaylists?.playlists || []).map(normalizePlaylist)
  const recommended = (data.recommended?.recommend || []).map(normalizePlaylist)
  const newSongs = (data.newSongs?.result || []).map(normalizeTrack)
  const daily = (data.daily?.data?.dailySongs || []).map(normalizeTrack)
  state.home = {
    playlists: [...recommended, ...personalized, ...top].filter((item, index, list) => list.findIndex((other) => other.id === item.id) === index).slice(0, 12),
    newSongs: (daily.length ? daily : newSongs).slice(0, 12),
  }
  if (!state.home.playlists.length && !state.home.newSongs.length) throw new Error('未返回推荐内容')
  return state.home
}

async function renderHome() {
  skeletonPage()
  try {
    const home = await loadHome()
    if (state.route !== 'home') return
    dom.page.innerHTML = `<div class="page-inner">
      <section class="hero">
        <div class="hero-copy"><span class="eyebrow">今日推荐</span><h1>${state.loggedIn ? '今天听什么？' : '发现音乐'}</h1>
        <p>为你整理的歌曲与歌单。</p>
        <button class="primary-button" data-play-home>${icon('play')} 播放今日推荐</button></div>
        <div class="hero-turntable" aria-hidden="true">
          <span class="hero-vinyl"><i></i></span>
          <svg class="hero-tonearm" viewBox="0 0 128 188">
            <circle class="hero-tonearm-base-shadow" cx="105" cy="20" r="17"/>
            <circle class="hero-tonearm-base" cx="105" cy="20" r="13"/>
            <circle class="hero-tonearm-bearing" cx="105" cy="20" r="5"/>
            <path class="hero-tonearm-shadow" d="M105 31 C101 65 97 105 78 135 C68 151 55 160 41 166"/>
            <path class="hero-tonearm-rail" d="M105 31 C101 65 97 105 78 135 C68 151 55 160 41 166"/>
            <g class="hero-tonearm-head" transform="translate(27 159) rotate(-23)">
              <rect width="31" height="15" rx="3"/>
              <rect class="hero-tonearm-stylus" x="2" y="12" width="10" height="4" rx="2"/>
            </g>
          </svg>
        </div>
      </section>
      <div class="section-title"><h2>${state.loggedIn ? '为你推荐' : '热门歌单'}</h2><button data-route-link="search">发现更多 ›</button></div>
      ${renderCards(home.playlists.slice(0, 6))}
      <div class="section-title"><h2>${state.loggedIn ? '你的今日歌曲' : '新歌速递'}</h2><button data-play-home>播放全部 ›</button></div>
      ${renderTrackTable(home.newSongs.slice(0, 10))}
    </div>`
  } catch (error) {
    if (state.route === 'home') renderError('主页加载失败', error.message, () => { state.home = null; renderHome() })
  }
}

async function fetchPlaylist(id) {
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const body = unwrap(await bridge.data.playlist(id))
      if (body?.code && Number(body.code) !== 200) throw new Error(body.message || '歌单加载失败')
      const source = body.playlist || body
      if (!source?.id) throw new Error('歌单信息未完整返回')
      const playlist = normalizePlaylist(source)
      const tracks = (source.tracks || body.songs || []).map(normalizeTrack)
      const expectedTrackCount = Math.max(playlist.trackCount, Array.isArray(source.trackIds) ? source.trackIds.length : 0)
      if (expectedTrackCount > 0 && tracks.length === 0) {
        throw new Error('网络不稳定，歌单歌曲未完整加载')
      }
      return { playlist, tracks }
    } catch (error) {
      lastError = error
      if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 520))
    }
  }
  throw lastError || new Error('歌单加载失败')
}

async function renderPlaylist(payload) {
  const id = payload?.id || payload
  skeletonPage()
  try {
    const { playlist, tracks } = await fetchPlaylist(id)
    if (state.route !== 'playlist' || String(state.routePayload?.id || state.routePayload) !== String(id)) return
    state.currentPlaylist = playlist
    state.playlistTracks = tracks
    if (isLikedPlaylist(playlist)) {
      tracks.forEach((track) => state.liked.add(String(track.id)))
      updateNowPlaying()
    }
    const ownPlaylist = state.loggedIn && playlist.creatorId === String(state.profile?.userId || '')
    const subscribed = playlist.subscribed || state.userPlaylists.some((item) => String(item.id) === String(playlist.id) && item.creatorId !== String(state.profile?.userId || ''))
    const collectAction = ownPlaylist ? '' : `<button class="secondary-button ${subscribed ? 'active' : ''}" data-playlist-subscribe data-playlist-subscribed="${subscribed}">${icon('heart')} ${subscribed ? '已收藏' : '收藏歌单'}</button>`
    dom.page.innerHTML = `<div class="page-inner">
      <section class="playlist-hero" style="--hero-image:url('${attr(playlist.cover)}')">
        <img class="playlist-cover" src="${attr(playlist.cover)}" alt="${attr(playlist.name)}">
        <div class="playlist-meta"><span class="eyebrow">歌单 · ${tracks.length || playlist.trackCount} 首</span><h1>${escapeHtml(playlist.name)}</h1>
        ${playlist.creator ? `<p class="creator">${playlist.creatorId ? `<button type="button" class="creator-link" data-user-id="${attr(playlist.creatorId)}" data-user-name="${attr(playlist.creator)}">${escapeHtml(playlist.creator)}</button>` : escapeHtml(playlist.creator)}</p>` : ''}${expandableDescriptionMarkup(playlist.description)}
        <div class="playlist-actions"><button class="primary-button" data-playlist-play-all>${icon('play')} 播放全部</button>${collectAction}<button class="secondary-button" data-toggle-playlist-search aria-expanded="false">${icon('search')} 搜索</button></div></div>
        <div id="playlistSearchPanel" class="playlist-search-panel" hidden>
          <label><svg><use href="#i-search"/></svg><input type="search" data-playlist-search placeholder="在歌单中搜索" autocomplete="off"></label>
          <span data-playlist-result-count>${tracks.length} 首</span>
        </div>
      </section>
      <div id="playlistTrackList">${tracks.length ? renderTrackTable(tracks) : '<div class="empty-state playlist-empty-state"><div class="empty-state-inner"><div class="empty-icon">' + icon('list') + '</div><h2>这个歌单还没有歌曲</h2><p>以后再次打开时，MenoRadio 会重新同步歌单内容。</p></div></div>'}</div>
    </div>`
    if (!tracks.length) state.pageTracks = []
    hydrateExpandableDescriptions()
  } catch (error) {
    renderError('歌单加载失败', error.message, () => renderPlaylist(payload))
  }
}

async function renderArtist(payload) {
  const id = String(payload?.id || payload || '')
  const fallbackName = payload?.name || '歌手'
  const pageSize = 100
  skeletonPage()
  try {
    const body = unwrap(await bridge.data.artist(id, pageSize))
    if (state.route !== 'artist' || String(state.routePayload?.id || state.routePayload || '') !== id) return
    const detail = body?.detail || {}
    const artist = detail?.data?.artist || detail?.artist || body?.artist || { id, name: fallbackName }
    const tracks = (body?.songs || []).map(normalizeTrack)
    const biography = body?.description?.briefDesc || artist?.briefDesc || ''
    const name = artist.name || fallbackName
    const cover = imageOf(artist, name)
    const total = Math.max(Number(body?.total || 0), Number(artist.musicSize || 0), tracks.length)
    const hasMore = body?.more === true || (body?.more !== false && tracks.length < total)
    state.pageTracks = tracks
    dom.page.innerHTML = `<div class="page-inner entity-page">
      <section class="playlist-hero entity-hero" style="--hero-image:url('${attr(cover)}')">
        <img class="playlist-cover entity-cover artist-cover" src="${attr(cover)}" alt="${attr(name)}">
        <div class="playlist-meta"><span class="eyebrow">歌手 · ${total} 首歌曲</span><h1>${escapeHtml(name)}</h1>
          ${expandableDescriptionMarkup(biography)}
          <div class="playlist-actions"><button class="primary-button" data-play-all>${icon('play')} 播放全部</button></div>
        </div>
      </section>
      <section><div class="section-title"><h2 data-artist-song-count>歌曲 · ${tracks.length}${hasMore ? ` / ${total}` : ''}</h2></div>
        <div data-artist-track-list>${renderTrackTable(tracks, { emptyTitle: '暂无歌曲', emptyDescription: '' })}</div>
        ${hasMore ? `<p class="entity-load-status" data-artist-load-status>正在加载其余歌曲…</p>` : ''}
      </section>
    </div>`
    hydrateExpandableDescriptions()
    if (hasMore) void loadRemainingArtistSongs(id, tracks, total, pageSize)
  } catch (error) {
    if (state.route === 'artist') renderError('歌手页面加载失败', error.message, () => renderArtist(payload))
  }
}

async function loadRemainingArtistSongs(id, initialTracks, expectedTotal, pageSize) {
  const tracks = [...initialTracks]
  const knownIds = new Set(tracks.map((track) => String(track.id)))
  let offset = initialTracks.length
  let more = true
  let total = expectedTotal
  try {
    while (more && offset < 5000) {
      if (state.route !== 'artist' || String(state.routePayload?.id || state.routePayload || '') !== id) return
      const body = unwrap(await bridge.data.artistSongs(id, offset, pageSize))
      const batch = Array.isArray(body?.songs) ? body.songs : []
      if (!batch.length) break
      for (const item of batch) {
        const track = normalizeTrack(item)
        if (!knownIds.has(String(track.id))) {
          knownIds.add(String(track.id))
          tracks.push(track)
        }
      }
      offset += batch.length
      total = Math.max(total, Number(body?.total || 0), tracks.length)
      more = body?.more !== false && (Number(body?.total || 0) > 0 ? offset < total : batch.length >= pageSize)
      const status = $('[data-artist-load-status]', dom.page)
      if (status) status.textContent = `正在加载其余歌曲… ${tracks.length} / ${total}`
    }
    if (state.route !== 'artist' || String(state.routePayload?.id || state.routePayload || '') !== id) return
    const list = $('[data-artist-track-list]', dom.page)
    const heading = $('[data-artist-song-count]', dom.page)
    const status = $('[data-artist-load-status]', dom.page)
    state.pageTracks = tracks
    if (list) list.innerHTML = renderTrackTable(tracks, { emptyTitle: '暂无歌曲', emptyDescription: '' })
    if (heading) heading.textContent = `歌曲 · ${tracks.length}`
    status?.remove()
  } catch {
    if (state.route !== 'artist' || String(state.routePayload?.id || state.routePayload || '') !== id) return
    const status = $('[data-artist-load-status]', dom.page)
    if (status) status.textContent = `已加载 ${tracks.length} 首，其余歌曲暂时无法载入`
  }
}

async function renderAlbum(payload) {
  const id = String(payload?.id || payload || '')
  const fallbackName = payload?.name || '专辑'
  skeletonPage()
  try {
    const body = unwrap(await bridge.data.album(id))
    if (state.route !== 'album' || String(state.routePayload?.id || state.routePayload || '') !== id) return
    const album = body?.album || body || { id, name: fallbackName }
    const tracks = (body?.songs || album?.songs || []).map(normalizeTrack)
    const name = album.name || fallbackName
    const cover = imageOf(album, name)
    const artists = (album.artists || (album.artist ? [album.artist] : []))
      .filter((artist) => artist?.name)
      .map((artist) => ({ id: String(artist.id || ''), name: String(artist.name) }))
    const artistLinks = artists.map((artist) => artist.id
      ? `<button type="button" class="creator-link" data-artist-id="${attr(artist.id)}" data-artist-name="${attr(artist.name)}">${escapeHtml(artist.name)}</button>`
      : escapeHtml(artist.name)).join(' / ')
    const published = Number(album.publishTime) > 0
      ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(Number(album.publishTime)))
      : ''
    state.pageTracks = tracks
    dom.page.innerHTML = `<div class="page-inner entity-page">
      <section class="playlist-hero entity-hero" style="--hero-image:url('${attr(cover)}')">
        <img class="playlist-cover entity-cover" src="${attr(cover)}" alt="${attr(name)}">
        <div class="playlist-meta"><span class="eyebrow">专辑 · ${tracks.length || Number(album.size || 0)} 首</span><h1>${escapeHtml(name)}</h1>
          ${artistLinks ? `<p class="creator">${artistLinks}</p>` : ''}
          ${published ? `<p class="entity-published">${escapeHtml(published)}</p>` : ''}
          ${expandableDescriptionMarkup(album.description || album.briefDesc)}
          <div class="playlist-actions"><button class="primary-button" data-play-all>${icon('play')} 播放全部</button></div>
        </div>
      </section>
      <section><div class="section-title"><h2>歌曲 · ${tracks.length}</h2></div>${renderTrackTable(tracks, { emptyTitle: '暂无歌曲', emptyDescription: '' })}</section>
    </div>`
    hydrateExpandableDescriptions()
  } catch (error) {
    if (state.route === 'album') renderError('专辑页面加载失败', error.message, () => renderAlbum(payload))
  }
}

async function renderDaily() {
  skeletonPage()
  try {
    let tracks = []
    if (state.loggedIn) {
      const body = unwrap(await bridge.data.daily())
      tracks = (body.data?.dailySongs || body.recommend || []).map(normalizeTrack)
    }
    if (!tracks.length) tracks = (await loadHome()).newSongs
    if (!tracks.length) throw new Error('未返回推荐歌曲')
    if (state.route !== 'daily') return
    const date = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())
    dom.page.innerHTML = `<div class="page-inner">${pageTitle('每日推荐', `${date} · 根据你的音乐口味更新`, `<button class="primary-button" data-play-all>${icon('play')} 播放全部</button>`)}${renderTrackTable(tracks)}</div>`
  } catch (error) {
    if (state.route === 'daily') renderError('每日推荐加载失败', error.message, renderDaily)
  }
}

async function renderLiked() {
  if (!state.loggedIn) {
    renderLoginRequired('登录后查看喜欢的音乐', '扫码登录网易云音乐，即可同步收藏和歌单。')
    return
  }
  const likedPlaylist = likedPlaylistOf()
  if (likedPlaylist) {
    state.route = 'playlist'
    state.routePayload = { id: likedPlaylist.id }
    setActiveNav('liked')
    await renderPlaylist(state.routePayload)
  } else {
    renderEmpty('喜欢的音乐', '暂时没有找到你的收藏歌单。', 'heart')
  }
}

async function renderUser(payload) {
  const uid = String(payload?.uid || '')
  const name = payload?.name || '网易云用户'
  skeletonPage()
  try {
    const [detailResult, playlistsResult] = await Promise.all([
      bridge.data.userDetail(uid),
      bridge.data.userPlaylists(uid),
    ])
    const detail = detailResult?.ok ? detailResult.data : {}
    const body = unwrap(playlistsResult)
    if (state.route !== 'user' || String(state.routePayload?.uid || '') !== uid) return
    const profile = detail.profile || detail.data?.profile || {}
    const playlists = (body.playlist || []).map(normalizePlaylist)
    const createdPlaylists = playlists.filter((playlist) => String(playlist.creatorId) === uid)
    const collectedPlaylists = playlists.filter((playlist) => String(playlist.creatorId) !== uid)
    const nickname = profile.nickname || name
    const avatar = imageOf(profile, nickname)
    const signature = truncate(profile.signature || '这个人还没有留下个性签名。', 180)
    const follows = Number(profile.follows ?? profile.followCount ?? 0)
    const followers = Number(profile.followeds ?? profile.followerCount ?? 0)
    dom.page.innerHTML = `<div class="page-inner user-page">
      <section class="user-hero">
        <img class="user-avatar" src="${attr(avatar)}" alt="${attr(nickname)}">
        <div class="user-profile-copy"><span class="eyebrow">网易云音乐用户</span><h1>${escapeHtml(nickname)}</h1><p>${escapeHtml(signature)}</p>
          <div class="user-stats"><span><strong>${formatCount(follows)}</strong> 关注</span><span><strong>${formatCount(followers)}</strong> 粉丝</span><span><strong>${playlists.length}</strong> 可见歌单</span></div>
        </div>
      </section>
      <div class="section-title"><h2>创建的歌单 · ${createdPlaylists.length}</h2></div>
      ${createdPlaylists.length ? renderCards(createdPlaylists) : '<div class="user-playlist-empty">没有可见的创建歌单</div>'}
      <div class="section-title user-playlist-section"><h2>收藏的歌单 · ${collectedPlaylists.length}</h2></div>
      ${collectedPlaylists.length ? renderCards(collectedPlaylists) : '<div class="user-playlist-empty">没有可见的收藏歌单</div>'}
    </div>`
  } catch (error) {
    if (state.route === 'user') renderError('用户主页加载失败', error.message, () => renderUser(payload))
  }
}

function searchField(keywords = '', autofocus = false) {
  return `<form class="search-page-form" data-search-form>
    <label><svg><use href="#i-search"/></svg><input type="search" data-page-search value="${attr(keywords)}" placeholder="搜索音乐、歌手、专辑" autocomplete="off" ${autofocus ? 'autofocus' : ''}><kbd>Ctrl K</kbd></label>
    <button class="primary-button" type="submit">搜索</button>
  </form>`
}

const searchTypes = [
  [1018, '综合'], [1, '歌曲'], [100, '歌手'], [10, '专辑'], [1000, '歌单'], [1002, '用户'],
]

function searchTabs(query, activeType) {
  return `<div class="search-tabs" role="tablist">${searchTypes.map(([type, label]) => `<button type="button" role="tab" class="${type === activeType ? 'active' : ''}" data-search-type="${type}" data-search-query="${attr(query)}">${escapeHtml(label)}</button>`).join('')}</div>`
}

function rememberSearchQuery(query) {
  const value = String(query || '').trim()
  if (!value) return
  state.searchHistory = [value, ...state.searchHistory.filter((item) => item.toLocaleLowerCase() !== value.toLocaleLowerCase())]
    .slice(0, searchHistoryLimit)
  try {
    localStorage.setItem(searchHistoryStorageKey, JSON.stringify(state.searchHistory))
  } catch {}
}

function searchHistoryMarkup() {
  if (!state.searchHistory.length) return ''
  return `<section class="search-history" aria-label="搜索历史">
    <div class="search-history-heading"><h2>搜索历史</h2><button type="button" data-clear-search-history>清空</button></div>
    <div class="search-history-items">${state.searchHistory.map((query) => `<button type="button" data-search-history="${attr(query)}" title="再次搜索 ${attr(query)}"><span>${escapeHtml(query)}</span></button>`).join('')}</div>
  </section>`
}

function searchEntities(items, kind) {
  if (!items.length) return ''
  const labels = { artists: '歌手', albums: '专辑', playlists: '歌单', users: '用户' }
  return `<section class="search-entity-section"><div class="section-title"><h2>${labels[kind]} · ${items.length}</h2></div><div class="search-entity-grid">${items.slice(0, 30).map((item) => {
    const name = item.name || item.nickname || '未命名'
    const cover = imageOf(item, name)
    const subtitle = kind === 'playlists' ? (item.creator?.nickname || `${Number(item.trackCount || 0)} 首`) : kind === 'albums' ? artistOf(item) : kind === 'artists' ? `${Number(item.musicSize || 0)} 首歌曲` : (item.signature || '网易云音乐用户')
    const action = kind === 'playlists'
      ? `data-playlist-id="${attr(item.id)}"`
      : kind === 'users'
        ? `data-user-id="${attr(item.userId || item.id)}" data-user-name="${attr(name)}"`
        : kind === 'artists'
          ? `data-artist-id="${attr(item.id)}" data-artist-name="${attr(name)}"`
          : `data-album-id="${attr(item.id)}" data-album-name="${attr(name)}"`
    return `<button class="search-entity" ${action}><img ${thumbnailAttributes(cover, thumbnailPixelSize(48))} alt=""><span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(subtitle)}</small></span></button>`
  }).join('')}</div></section>`
}

function unpackSearchResults(body) {
  const result = body.result || body || {}
  return {
    songs: result.songs || result.song?.songs || [],
    artists: result.artists || result.artist?.artists || [],
    albums: result.albums || result.album?.albums || [],
    playlists: result.playlists || result.playLists || result.playList?.playLists || [],
    users: result.userprofiles || result.users || result.user?.users || [],
  }
}

function renderSearch(keywords = '', requestedType = state.routePayload?.type || 1018) {
  const query = String(keywords || '').trim()
  const type = searchTypes.some(([value]) => value === Number(requestedType)) ? Number(requestedType) : 1018
  state.searchType = type
  if (!query) {
    state.pageTracks = []
    dom.page.innerHTML = `<div class="page-inner search-page">${pageTitle('搜索')}${searchField('', true)}${searchTabs('', type)}${searchHistoryMarkup()}<div class="search-empty ${state.searchHistory.length ? 'with-history' : ''}"><div class="empty-state-inner"><div class="empty-icon">${icon('search')}</div><h2>听见你想找的</h2><p>输入关键词，然后按下 Enter。</p></div></div></div>`
    return
  }
  searchNow(query, type)
}

async function searchNow(query, requestedType = state.searchType || 1018) {
  query = String(query || '').trim()
  const type = Number(requestedType)
  if (!query) {
    state.route = 'search'
    state.routePayload = { keywords: '', type }
    setActiveNav('search')
    renderSearch('', type)
    return
  }
  rememberSearchQuery(query)
  state.searchType = type
  state.route = 'search'
  state.routePayload = { keywords: query, type }
  setActiveNav('search')
  dom.page.innerHTML = `<div class="page-inner search-page">${searchField(query)}${searchTabs(query, type)}<div class="search-heading"><p>正在搜索</p><h1>“<strong>${escapeHtml(query)}</strong>”</h1></div><div class="skeleton skeleton-title"></div>${Array(7).fill('<div class="skeleton" style="height:58px;margin:1px 0"></div>').join('')}</div>`
  try {
    const body = unwrap(await bridge.data.search(query, type))
    const results = unpackSearchResults(body)
    const tracks = results.songs.map(normalizeTrack)
    if (state.route !== 'search' || state.routePayload?.keywords !== query || state.routePayload?.type !== type) return
    state.pageTracks = tracks
    const songSection = tracks.length ? `<section><div class="section-title"><h2>歌曲 · ${tracks.length}</h2></div>${renderTrackTable(tracks)}</section>` : ''
    const entitySections = [
      searchEntities(results.artists, 'artists'),
      searchEntities(results.albums, 'albums'),
      searchEntities(results.playlists, 'playlists'),
      searchEntities(results.users, 'users'),
    ].join('')
    const empty = !songSection && !entitySections ? `<div class="search-empty"><div class="empty-state-inner"><h2>没有找到相关结果</h2></div></div>` : ''
    dom.page.innerHTML = `<div class="page-inner search-page">${searchField(query)}${searchTabs(query, type)}<div class="search-heading"><p>搜索结果</p><h1>“<strong>${escapeHtml(query)}</strong>”</h1></div>${songSection}${entitySections}${empty}</div>`
  } catch (error) {
    if (state.route === 'search' && state.routePayload?.keywords === query && state.routePayload?.type === type) renderError('搜索失败', error.message, () => searchNow(query, type))
  }
}

function renderEmpty(title, description, iconName = 'radio') {
  state.pageTracks = []
  dom.page.innerHTML = `<div class="page-inner">${pageTitle(title)}<div class="empty-state"><div class="empty-state-inner"><div class="empty-icon">${icon(iconName)}</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p><button class="secondary-button" data-route-link="home">返回主页</button></div></div></div>`
}

function renderLoginRequired(title, description) {
  state.pageTracks = []
  dom.page.innerHTML = `<div class="page-inner">${pageTitle(title)}<div class="empty-state"><div class="empty-state-inner"><div class="empty-icon">${icon('user')}</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p><button class="primary-button" data-login>${icon('user')} 立即登录</button></div></div></div>`
}

function renderError(title, description, retry) {
  state.pageTracks = []
  dom.page.innerHTML = `<div class="page-inner"><div class="empty-state"><div class="empty-state-inner"><div class="empty-icon">${icon('radio')}</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p><button class="secondary-button" id="retryButton">重试</button></div></div></div>`
  $('#retryButton')?.addEventListener('click', retry, { once: true })
}

const FONT_BATCH_SIZE = 32

function filteredFontNames(filter = '') {
  const query = String(filter || '').trim().toLocaleLowerCase()
  return [state.fontFamily, 'system', ...state.systemFonts]
    .filter((name, index, list) => list.indexOf(name) === index)
    .filter((name) => !query || fontLabel(name).toLocaleLowerCase().includes(query))
}

function fontOptionMarkup(name) {
  return `<button type="button" class="font-option ${state.fontFamily === name ? 'active' : ''}" data-font-name="${attr(name)}"><span class="font-option-preview" style="font-family:${attr(fontCss(name))}">${escapeHtml(fontLabel(name))}</span>${state.fontFamily === name ? '<small>当前</small>' : ''}</button>`
}

function fontOptionsMarkup(filter = '') {
  const names = filteredFontNames(filter)
  if (!names.length) return '<div class="font-picker-empty">没有匹配的字体</div>'
  const visible = names.slice(0, FONT_BATCH_SIZE)
  const hint = names.length > visible.length ? `<div class="font-picker-hint" data-font-more>向下滚动加载其余 ${names.length - visible.length} 个字体</div>` : ''
  return visible.map(fontOptionMarkup).join('') + hint
}

function renderFontOptions(filter = '', reset = true) {
  const list = $('[data-font-list]', dom.page)
  if (!list) return
  const names = filteredFontNames(filter)
  const renderedCount = reset ? 0 : $$('[data-font-name]', list).length
  const nextCount = Math.min(names.length, renderedCount + FONT_BATCH_SIZE)
  if (reset) list.innerHTML = ''
  $('[data-font-more]', list)?.remove()
  if (!names.length) {
    list.innerHTML = '<div class="font-picker-empty">没有匹配的字体</div>'
    return
  }
  const batch = names.slice(renderedCount, nextCount).map(fontOptionMarkup).join('')
  if (batch) list.insertAdjacentHTML('beforeend', batch)
  if (nextCount < names.length) {
    list.insertAdjacentHTML('beforeend', `<div class="font-picker-hint" data-font-more>向下滚动加载其余 ${names.length - nextCount} 个字体</div>`)
  }
}

function floatingFontNames(filter = '') {
  const query = String(filter || '').trim().toLocaleLowerCase()
  return [state.floatingLyrics.fontFamily, 'system', ...state.systemFonts]
    .filter((name, index, list) => list.indexOf(name) === index)
    .filter((name) => !query || fontLabel(name).toLocaleLowerCase().includes(query))
}

function floatingFontOptionMarkup(name) {
  return `<button type="button" class="font-option ${state.floatingLyrics.fontFamily === name ? 'active' : ''}" data-floating-font-name="${attr(name)}"><span class="font-option-preview" style="font-family:${attr(fontCss(name))}">${escapeHtml(fontLabel(name))}</span>${state.floatingLyrics.fontFamily === name ? '<small>当前</small>' : ''}</button>`
}

function floatingFontOptionsMarkup(filter = '') {
  const names = floatingFontNames(filter)
  const visible = names.slice(0, FONT_BATCH_SIZE)
  const hint = names.length > visible.length ? `<div class="font-picker-hint" data-floating-font-more>向下滚动加载其余 ${names.length - visible.length} 个字体</div>` : ''
  return visible.map(floatingFontOptionMarkup).join('') + hint
}

function renderFloatingFontOptions(filter = '', reset = true) {
  const list = $('[data-floating-font-list]', dom.page)
  if (!list) return
  const names = floatingFontNames(filter)
  const renderedCount = reset ? 0 : $$('[data-floating-font-name]', list).length
  const nextCount = Math.min(names.length, renderedCount + FONT_BATCH_SIZE)
  if (reset) list.innerHTML = ''
  $('[data-floating-font-more]', list)?.remove()
  if (!names.length) {
    list.innerHTML = '<div class="font-picker-empty">没有匹配的字体</div>'
    return
  }
  const batch = names.slice(renderedCount, nextCount).map(floatingFontOptionMarkup).join('')
  if (batch) list.insertAdjacentHTML('beforeend', batch)
  if (nextCount < names.length) {
    list.insertAdjacentHTML('beforeend', `<div class="font-picker-hint" data-floating-font-more>向下滚动加载其余 ${names.length - nextCount} 个字体</div>`)
  }
}

function choicePickerMarkup(name, value, options, label) {
  const selected = options.find(([optionValue]) => optionValue === value) || options[0]
  return `<div class="choice-picker-control" data-choice-control="${attr(name)}">
    <button type="button" class="setting-picker" data-choice-picker="${attr(name)}" aria-expanded="false" aria-label="${attr(label)}"><span>${escapeHtml(selected?.[1] || '')}</span><svg><use href="#i-chevron"/></svg></button>
    <div class="choice-picker-popover" data-choice-popover="${attr(name)}" aria-hidden="true">
      <div class="choice-picker-list" role="listbox" aria-label="${attr(label)}">${options.map(([optionValue, optionLabel]) => `<button type="button" class="choice-option ${optionValue === value ? 'active' : ''}" data-choice-value="${attr(optionValue)}" role="option" aria-selected="${optionValue === value}"><span>${escapeHtml(optionLabel)}</span>${optionValue === value ? '<small>当前</small>' : ''}</button>`).join('')}</div>
    </div>
  </div>`
}

function closeChoicePickers(except = null) {
  $$('[data-choice-control]', dom.page).forEach((control) => {
    if (control === except) return
    const picker = $('[data-choice-picker]', control)
    const popover = $('[data-choice-popover]', control)
    picker?.setAttribute('aria-expanded', 'false')
    popover?.classList.remove('open')
    popover?.setAttribute('aria-hidden', 'true')
  })
}

function updateChoicePicker(control, value) {
  const option = $(`[data-choice-value="${CSS.escape(value)}"]`, control)
  const picker = $('[data-choice-picker]', control)
  if (picker && option) $('span', picker).textContent = $('span', option)?.textContent || ''
  $$('[data-choice-value]', control).forEach((button) => {
    const active = button.dataset.choiceValue === value
    button.classList.toggle('active', active)
    button.setAttribute('aria-selected', String(active))
    $('small', button)?.remove()
    if (active) button.insertAdjacentHTML('beforeend', '<small>当前</small>')
  })
  picker?.setAttribute('aria-expanded', 'false')
  const popover = $('[data-choice-popover]', control)
  popover?.classList.remove('open')
  popover?.setAttribute('aria-hidden', 'true')
}

async function configureFloatingLyrics(patch, { refresh = false } = {}) {
  try {
    const snapshot = await bridge.floatingLyrics.configure(patch)
    state.floatingLyrics = { ...state.floatingLyrics, ...(snapshot?.config || patch) }
    if (refresh && state.route === 'settings-floating') renderFloatingLyricsSettings()
    return snapshot
  } catch (error) {
    toast(error.message || '悬浮歌词设置未能保存', '操作失败', 'error')
    return null
  }
}

function cancelFloatingLyricsResetHold() {
  const hold = floatingLyricsResetHold
  if (!hold) return
  floatingLyricsResetHold = null
  clearTimeout(hold.timer)
  hold.button.classList.remove('holding')
  try {
    if (hold.button.hasPointerCapture?.(hold.pointerId)) hold.button.releasePointerCapture(hold.pointerId)
  } catch {}
}

async function performFloatingLyricsReset() {
  try {
    const snapshot = await bridge.floatingLyrics.reset()
    state.floatingLyrics = { ...state.floatingLyrics, ...(snapshot?.config || {}) }
    floatingColorDraft = null
    if (state.route === 'settings-floating') renderFloatingLyricsSettings()
    toast('已重置')
  } catch (error) {
    toast(error.message || '重置失败', '操作失败', 'error')
  }
}

function beginFloatingLyricsResetHold(button, event) {
  cancelFloatingLyricsResetHold()
  const pointerId = event.pointerId
  button.setPointerCapture?.(pointerId)
  void button.offsetWidth
  button.classList.add('holding')
  const timer = window.setTimeout(() => {
    if (floatingLyricsResetHold?.button !== button) return
    floatingLyricsResetHold = null
    button.classList.remove('holding')
    performFloatingLyricsReset()
  }, 3000)
  floatingLyricsResetHold = { button, pointerId, timer }
}

function cancelApplicationResetHold() {
  const hold = applicationResetHold
  if (!hold) return
  applicationResetHold = null
  clearTimeout(hold.timer)
  hold.button.classList.remove('holding')
  try {
    if (hold.button.hasPointerCapture?.(hold.pointerId)) hold.button.releasePointerCapture(hold.pointerId)
  } catch {}
}

async function performApplicationReset(button) {
  if (!button || button.disabled) return
  button.disabled = true
  button.textContent = '正在重置…'
  try {
    await bridge.app.reset()
  } catch (error) {
    button.disabled = false
    button.textContent = '彻底重置'
    toast(error.message || '应用重置失败', '操作失败', 'error')
  }
}

function showApplicationResetConfirmation() {
  dom.modalLayer.innerHTML = `<div class="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="resetApplicationTitle">
    <div class="modal-header"><div><h2 id="resetApplicationTitle">彻底重置 MenoRadio？</h2><p>登录账号、设置、播放状态和本地缓存都会被清除。此操作无法撤销。</p></div><button class="icon-button" data-close-modal>${icon('close')}</button></div>
    <div class="modal-actions"><button class="secondary-button" type="button" data-close-modal>取消</button><button class="danger-button floating-reset-button application-reset-confirm-button" type="button" data-confirm-reset-application title="长按 3 秒彻底重置" aria-label="长按 3 秒彻底重置 MenoRadio"><span>彻底重置</span></button></div>
  </div>`
  dom.modalLayer.classList.add('open')
  dom.modalLayer.setAttribute('aria-hidden', 'false')
  $$('[data-close-modal]', dom.modalLayer).forEach((button) => button.addEventListener('click', closeModal))
  const confirmButton = $('[data-confirm-reset-application]', dom.modalLayer)
  confirmButton?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    beginApplicationResetHold(confirmButton, event)
  })
  confirmButton?.addEventListener('click', (event) => event.preventDefault())
}

function beginApplicationResetHold(button, event) {
  cancelApplicationResetHold()
  const pointerId = event.pointerId
  button.setPointerCapture?.(pointerId)
  void button.offsetWidth
  button.classList.add('holding')
  const timer = window.setTimeout(() => {
    if (applicationResetHold?.button !== button) return
    applicationResetHold = null
    button.classList.remove('holding')
    performApplicationReset(button)
  }, 3000)
  applicationResetHold = { button, pointerId, timer }
}

async function loadSystemFonts() {
  if (state.fontsLoaded || state.fontsLoading) return
  state.fontsLoading = true
  const list = $('[data-font-list]', dom.page)
  if (list) list.innerHTML = '<div class="font-picker-loading"><span></span>正在读取已安装字体</div>'
  try {
    const fonts = await bridge.app.fonts()
    state.systemFonts = Array.isArray(fonts) ? fonts : []
    state.fontsLoaded = true
  } catch {
    state.systemFonts = []
  } finally {
    state.fontsLoading = false
    if (state.route === 'settings' || state.route === 'settings-floating') {
      const currentList = $('[data-font-list]', dom.page)
      if (currentList) renderFontOptions($('[data-font-search]', dom.page)?.value || '', true)
      renderFloatingFontOptions($('[data-floating-font-search]', dom.page)?.value || '', true)
    }
  }
}

function renderSettings() {
  const version = '0.16.0-preview'
  dom.page.innerHTML = `<div class="page-inner">${pageTitle('设置')}
    <div class="settings-grid">
      <h2 class="settings-section-label">账户</h2>
      <section class="settings-card"><div><h3>网易云音乐账户</h3><p>${state.loggedIn ? escapeHtml(state.profile?.nickname || '网易云用户') : '同步收藏、歌单与每日推荐'}</p></div><div class="setting-actions">${state.loggedIn ? '<button class="secondary-button" data-logout>退出登录</button>' : '<button class="primary-button" data-login>登录</button>'}</div></section>
      <h2 class="settings-section-label">外观</h2>
      <section class="settings-card theme-setting-card"><div><h3>配色方案</h3></div>${choicePickerMarkup('theme', state.theme, themes, '配色方案')}</section>
      <section class="settings-card font-setting-card"><div><h3>字体</h3></div><div class="font-picker-control">
        <button type="button" class="setting-picker" data-font-picker aria-expanded="false"><span style="font-family:${attr(fontCss(state.fontFamily))}">${escapeHtml(fontLabel(state.fontFamily))}</span><svg><use href="#i-chevron"/></svg></button>
        <div class="font-picker-popover" data-font-popover aria-hidden="true">
          <label class="font-picker-search"><svg><use href="#i-search"/></svg><input type="search" data-font-search placeholder="搜索已安装字体" autocomplete="off"></label>
          <div class="font-picker-list" data-font-list>${fontOptionsMarkup()}</div>
        </div>
      </div></section>
      <section class="settings-card"><div><h3>旧版播放页样式</h3></div><label class="setting-switch" title="使用 0.15 版本的播放页外观"><input type="checkbox" data-legacy-player ${state.legacyPlayer ? 'checked' : ''}><i></i></label></section>
      <section class="settings-card" data-modern-player-setting ${state.legacyPlayer ? 'hidden' : ''}><div><h3>逐字高亮</h3></div><label class="setting-switch" title="支持逐字歌词的歌曲按演唱进度逐字点亮"><input type="checkbox" data-word-highlight ${state.wordHighlight ? 'checked' : ''}><i></i></label></section>
      <section class="settings-card" data-modern-player-setting ${state.legacyPlayer ? 'hidden' : ''}><div><h3>景深模糊</h3></div><label class="setting-switch" title="远离当前句的歌词逐渐模糊"><input type="checkbox" data-depth-blur ${state.depthBlur ? 'checked' : ''}><i></i></label></section>
      <h2 class="settings-section-label">播放</h2>
      <section class="settings-card quality-setting-card"><div><h3>音质</h3></div>${choicePickerMarkup('audio-quality', state.audioQuality, audioQualities, '音质')}</section>
      <section class="settings-card"><div><h3>音量均衡</h3></div><label class="setting-switch" title="按歌曲的 ReplayGain 固定调整播放增益"><input type="checkbox" data-audio-normalization ${state.audioNormalization ? 'checked' : ''}><i></i></label></section>
      <section class="settings-card"><div><h3>媒体加载优化</h3></div><label class="setting-switch"><input type="checkbox" data-media-loading-optimization ${state.mediaLoadingOptimization ? 'checked' : ''}><i></i></label></section>
      <section class="settings-card"><div><h3>快捷呼出播放队列</h3></div><label class="setting-switch" title="鼠标贴近窗口右侧时呼出播放队列"><input type="checkbox" data-quick-queue-reveal ${state.quickQueueReveal ? 'checked' : ''}><i></i></label></section>
      <button type="button" class="settings-card settings-navigation-card" data-route-link="settings-floating"><h3>悬浮歌词</h3><svg><use href="#i-chevron"/></svg></button>
      <h2 class="settings-section-label">数据</h2>
      <section class="settings-card data-management-card"><div><h3>数据管理</h3></div><div class="setting-actions"><button class="secondary-button" data-clear-cache>清理缓存</button><button type="button" class="secondary-button application-reset-button" data-reset-application>重置</button></div></section>
      <h2 class="settings-section-label">关于</h2>
      <section class="settings-card"><div><h3>关于</h3><p>MenoRadio <span data-app-version>${escapeHtml(version)}</span> · 开发者 <button type="button" class="settings-link" data-external="https://github.com/ichiris">@ichiris</button></p></div><div class="setting-actions"><button class="secondary-button" data-external="https://github.com/ichiris/MenoRadio">项目主页 ${icon('external')}</button><button class="secondary-button" data-route-link="settings-licenses">开源许可</button><button class="secondary-button" data-check-update>检查更新</button></div></section>
    </div>
  </div>`
  bridge.app.version().then((value) => {
    if (state.route === 'settings') $('[data-app-version]', dom.page)?.replaceChildren(document.createTextNode(value))
  }).catch(() => {})
}

async function renderOpenSourceLicenses() {
  dom.page.innerHTML = `<div class="page-inner licenses-page">${pageTitle('开源许可')}
    <section class="license-document license-loading"><span class="lyric-loading-spinner" aria-hidden="true"></span><p>正在读取开源许可</p></section>
  </div>`
  try {
    const source = await bridge.app.thirdPartyNotices()
    if (state.route !== 'settings-licenses') return
    const licenses = String(source || '')
      .replace(/^#\s+Third-party notices\s*/i, '')
      .replace(/\n##\s+Service and product names[\s\S]*$/i, '')
      .trim()
    const document = $('.license-document', dom.page)
    if (document) {
      document.className = 'license-document markdown-document'
      document.innerHTML = renderSafeMarkdown(licenses)
    }
  } catch {
    if (state.route !== 'settings-licenses') return
    const document = $('.license-document', dom.page)
    if (document) {
      document.className = 'license-document license-error'
      document.innerHTML = '<h2>无法读取开源许可</h2><p>请稍后重试。</p>'
    }
  }
}

function renderFloatingLyricsSettings() {
  const floating = state.floatingLyrics
  const hsv = floatingColorDraft || hexToHsv(floating.color)
  floatingColorDraft = { ...hsv }
  const color = hsvToHex(hsv)
  const boldIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h6.2c3.4 0 5.5 1.7 5.5 4.5 0 1.8-.9 3.1-2.4 3.8 2 .6 3.2 2 3.2 4.1 0 3.1-2.4 4.8-6.2 4.8H7V4Zm4 3v4h2c1.2 0 1.9-.7 1.9-2s-.8-2-2.1-2H11Zm0 7v4.2h2.3c1.5 0 2.3-.7 2.3-2.1S14.8 14 13.3 14H11Z"/></svg>'
  const italicIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4h9v3h-3.1l-3.8 10H15v3H6v-3h3l3.8-10H10V4Z"/></svg>'
  dom.page.innerHTML = `<div class="page-inner floating-settings-page">${pageTitle('悬浮歌词')}
    <div class="settings-grid">
      <section class="settings-card floating-lyrics-setting-card">
        <div class="floating-lyrics-settings">
          <div class="floating-setting-row"><span>悬浮歌词行为</span>${choicePickerMarkup('floating-lyrics-mode', floating.mode, floatingLyricModes, '悬浮歌词行为')}</div>
          <div class="floating-setting-row"><span>锁定歌词</span><label class="setting-switch"><input type="checkbox" data-floating-setting="locked" ${floating.locked ? 'checked' : ''}><i></i></label></div>
          <div class="floating-setting-row"><span>暂停时自动隐藏</span><label class="setting-switch"><input type="checkbox" data-floating-setting="hideWhenPaused" ${floating.hideWhenPaused ? 'checked' : ''}><i></i></label></div>
          <div class="floating-setting-row"><span>字体</span><div class="font-picker-control floating-font-picker-control">
            <button type="button" class="setting-picker" data-floating-font-picker aria-expanded="false"><span style="font-family:${attr(fontCss(floating.fontFamily))}">${escapeHtml(fontLabel(floating.fontFamily))}</span><svg><use href="#i-chevron"/></svg></button>
            <div class="font-picker-popover floating-font-popover" data-floating-font-popover aria-hidden="true">
              <label class="font-picker-search"><svg><use href="#i-search"/></svg><input type="search" data-floating-font-search placeholder="搜索已安装字体" autocomplete="off"></label>
              <div class="font-picker-list" data-floating-font-list>${floatingFontOptionsMarkup()}</div>
            </div>
          </div></div>
          <div class="floating-setting-row"><label for="floatingFontSize">字体大小</label><div class="setting-number"><input id="floatingFontSize" type="number" min="12" max="120" step="1" value="${attr(floating.fontSize)}" data-floating-setting="fontSize"><span>px</span></div></div>
          <div class="floating-setting-row"><span>字形</span><div class="floating-glyph-buttons"><button type="button" data-floating-toggle="bold" class="${floating.bold ? 'active' : ''}" title="加粗" aria-label="加粗">${boldIcon}</button><button type="button" data-floating-toggle="italic" class="${floating.italic ? 'active' : ''}" title="斜体" aria-label="斜体">${italicIcon}</button></div></div>
          <div class="floating-setting-row"><span>对齐</span><div class="segmented-settings">${[['left','左'],['center','中'],['right','右']].map(([value, label]) => `<button type="button" data-floating-align="${value}" class="${floating.align === value ? 'active' : ''}">${label}</button>`).join('')}</div></div>
          <div class="floating-setting-row"><span>文字效果</span><div class="setting-checks"><label><input type="checkbox" data-floating-setting="shadow" ${floating.shadow ? 'checked' : ''}>阴影</label><label><input type="checkbox" data-floating-setting="stroke" ${floating.stroke ? 'checked' : ''}>描边</label></div></div>
          <div class="floating-setting-row floating-color-row"><span>文字颜色</span><div class="floating-color-control">
            <button type="button" class="floating-color-swatch" data-floating-color-picker style="--swatch:${attr(floating.color)}" aria-expanded="false" aria-label="选择文字颜色"></button>
            <div class="floating-color-popover" data-floating-color-popover hidden style="--picker-hue:${hsv.h};--picker-x:${hsv.s * 100}%;--picker-y:${(1 - hsv.v) * 100}%">
              <div class="floating-color-field" data-floating-color-field><i></i></div>
              <input type="range" min="0" max="360" step="1" value="${hsv.h}" data-floating-color-hue aria-label="色相">
              <output data-floating-color-value>${color.toUpperCase()}</output>
              <label class="floating-color-rgb"><span>RGB</span><input type="text" inputmode="numeric" value="${attr(hexToRgbText(color))}" data-floating-color-rgb aria-label="RGB 颜色值"></label>
              <div class="floating-color-actions"><button type="button" class="secondary-button" data-floating-color-cancel>取消</button><button type="button" class="primary-button" data-floating-color-apply>应用</button></div>
            </div>
          </div></div>
          <div class="floating-setting-row"><label for="floatingOpacity">不透明度</label><div class="setting-range"><input id="floatingOpacity" type="range" min=".15" max="1" step=".01" value="${attr(floating.opacity)}" data-floating-setting="opacity"><output>${Math.round(floating.opacity * 100)}%</output></div></div>
          <div class="floating-setting-row"><span>无翻译时</span>${choicePickerMarkup('floating-no-translation-position', floating.noTranslationPosition, floatingLyricVerticalPositions, '无翻译时的位置')}</div>
          <div class="floating-setting-footer"><p>解除锁定后可拖动和缩放；若不慎将悬浮歌词拖动到了莫名其妙的位置，可使用重置来恢复。</p><button type="button" class="secondary-button floating-reset-button" data-reset-floating-lyrics title="长按 3 秒重置" aria-label="长按 3 秒重置悬浮歌词"><span>重置悬浮歌词</span></button></div>
        </div>
      </section>
    </div>
  </div>`
  if (!state.fontsLoaded) loadSystemFonts()
}

function syncFloatingLyricsSettingsControls() {
  if (state.route !== 'settings-floating') return
  const floating = state.floatingLyrics
  $$('[data-floating-setting]', dom.page).forEach((control) => {
    const key = control.dataset.floatingSetting
    if (!(key in floating)) return
    if (control.type === 'checkbox') control.checked = Boolean(floating[key])
    else if (document.activeElement !== control) control.value = floating[key]
    if (key === 'opacity') {
      control.closest('.setting-range')?.querySelector('output')?.replaceChildren(document.createTextNode(`${Math.round(floating.opacity * 100)}%`))
    }
  })
  $$('[data-floating-toggle]', dom.page).forEach((button) => button.classList.toggle('active', Boolean(floating[button.dataset.floatingToggle])))
  $$('[data-floating-align]', dom.page).forEach((button) => button.classList.toggle('active', floating.align === button.dataset.floatingAlign))
  const fontLabelElement = $('[data-floating-font-picker] span', dom.page)
  if (fontLabelElement) {
    fontLabelElement.textContent = fontLabel(floating.fontFamily)
    fontLabelElement.style.fontFamily = fontCss(floating.fontFamily)
  }
  const swatch = $('[data-floating-color-picker]', dom.page)
  if (swatch) swatch.style.setProperty('--swatch', floating.color)
  const modeControl = $('[data-choice-control="floating-lyrics-mode"]', dom.page)
  if (modeControl) {
    const option = floatingLyricModes.find(([value]) => value === floating.mode)
    const pickerLabel = $('[data-choice-picker] span', modeControl)
    if (pickerLabel && option) pickerLabel.textContent = option[1]
    $$('[data-choice-value]', modeControl).forEach((button) => button.classList.toggle('active', button.dataset.choiceValue === floating.mode))
  }
  const positionControl = $('[data-choice-control="floating-no-translation-position"]', dom.page)
  if (positionControl) {
    const option = floatingLyricVerticalPositions.find(([value]) => value === floating.noTranslationPosition)
    const pickerLabel = $('[data-choice-picker] span', positionControl)
    if (pickerLabel && option) pickerLabel.textContent = option[1]
    $$('[data-choice-value]', positionControl).forEach((button) => button.classList.toggle('active', button.dataset.choiceValue === floating.noTranslationPosition))
  }
}

async function clearApplicationCache(button) {
  if (!button || button.disabled) return
  const original = button.innerHTML
  button.disabled = true
  button.textContent = '正在清理…'
  try {
    const result = await bridge.app.clearCache()
    const size = formatBytes(result?.clearedBytes || 0)
    if (state.route === 'settings') {
      button.textContent = '清理缓存'
      button.disabled = false
    }
    toast(`已清理 ${size} 缓存`)
  } catch (error) {
    button.disabled = false
    button.innerHTML = original
    toast(error.message || '缓存清理失败', '操作失败', 'error')
  }
}

async function renderRoute() {
  setActiveNav(state.route)
  updateHistoryButtons()
  if (state.route !== 'playlist') state.currentPlaylist = null
  switch (state.route) {
    case 'home': return renderHome()
    case 'search': return renderSearch(state.routePayload?.keywords || '', state.routePayload?.type || 1018)
    case 'daily': return renderDaily()
    case 'liked': return renderLiked()
    case 'playlist': return renderPlaylist(state.routePayload)
    case 'artist': return renderArtist(state.routePayload)
    case 'album': return renderAlbum(state.routePayload)
    case 'user': return renderUser(state.routePayload)
    case 'recent':
      dom.page.innerHTML = `<div class="page-inner">${pageTitle('最近播放', state.recent.length ? `最近听过的 ${state.recent.length} 首歌` : '还没有播放记录', state.recent.length ? '<button type="button" class="secondary-button" data-clear-recent>清空</button>' : '')}${renderTrackTable(state.recent, { emptyDescription: '播放过的歌曲会出现在这里。' })}</div>`
      return
    case 'settings': return renderSettings()
    case 'settings-floating': return renderFloatingLyricsSettings()
    case 'settings-licenses': return renderOpenSourceLicenses()
    default: return renderHome()
  }
}

function navigate(route, payload = null, record = true) {
  if (state.route === route && JSON.stringify(state.routePayload) === JSON.stringify(payload)) return
  state.route = route
  state.routePayload = payload
  if (record) {
    state.history = state.history.slice(0, state.historyIndex + 1)
    state.history.push({ route, payload })
    state.historyIndex = state.history.length - 1
  }
  renderRoute()
}

function moveHistory(delta) {
  const next = state.historyIndex + delta
  if (next < 0 || next >= state.history.length) return
  state.historyIndex = next
  const item = state.history[next]
  state.route = item.route
  state.routePayload = item.payload
  renderRoute()
}

function installPageTransitions() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const observer = new MutationObserver((mutations) => {
    if (!mutations.some((mutation) => mutation.type === 'childList' && mutation.target === dom.page)) return
    const content = dom.page.firstElementChild
    if (!content?.animate) return
    requestAnimationFrame(() => {
      const animation = content.animate([
        { opacity: 0, transform: 'translateX(30px)' },
        { opacity: 1, transform: 'translateX(0)' },
      ], {
        duration: 460,
        easing: 'cubic-bezier(.16,1,.3,1)',
        fill: 'both',
      })
      animation.id = 'page-route-enter'
      animation.addEventListener('finish', () => animation.cancel(), { once: true })
    })
  })
  observer.observe(dom.page, { childList: true })
}

function updateHistoryButtons() {
  $('#backButton').disabled = state.historyIndex <= 0
  $('#forwardButton').disabled = state.historyIndex >= state.history.length - 1
}

function setActiveNav(route) {
  const activeRoute = String(route || '').startsWith('settings') ? 'settings' : route
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.route === activeRoute))
}

function updateRange(element, value, max = 1) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  element.value = ratio * Number(element.max || 1000)
  element.style.setProperty('--value', `${ratio * 100}%`)
}

function setPlayIcons(playing) {
  const symbol = playing ? 'pause' : 'play'
  dom.playButton.innerHTML = icon(symbol)
  dom.immersivePlay.innerHTML = icon(symbol)
  dom.immersive.classList.toggle('paused', !playing)
}

function replayGainDb(value) {
  const gain = Number(value)
  return Number.isFinite(gain) ? Math.max(-18, Math.min(12, gain)) : 0
}

function effectiveAudioVolume() {
  const gain = state.audioNormalization ? Math.pow(10, state.trackReplayGainDb / 20) : 1
  return Math.max(0, Math.min(1, state.userVolume * gain))
}

function applyEffectiveAudioVolume() {
  const nextVolume = effectiveAudioVolume()
  if (Math.abs(dom.audio.volume - nextVolume) > .0001) dom.audio.volume = nextVolume
}

function updateVolumeUi() {
  const silent = dom.audio.muted || state.userVolume <= .001
  const symbol = silent ? 'volume-muted' : 'volume'
  const label = silent ? '取消静音' : '静音'
  for (const button of [$('#volumeButton'), $('#immersiveVolume'), $('#immersiveMuteToggle')]) {
    if (!button) continue
    button.innerHTML = icon(symbol)
    button.classList.toggle('active', silent)
    button.setAttribute('aria-label', button.id === 'immersiveVolume' ? '调节音量' : label)
  }
  for (const range of [$('#volumeRange'), $('#immersiveVolumeRange')]) {
    if (range) updateRange(range, state.userVolume, 1)
  }
  const value = $('#immersiveVolumeValue')
  if (value) value.textContent = `${Math.round((silent ? 0 : state.userVolume) * 100)}%`
}

function toggleMute() {
  if (dom.audio.muted || state.userVolume <= .001) {
    dom.audio.muted = false
    if (state.userVolume <= .001) {
      state.userVolume = .75
      localStorage.setItem('menoradio.volume', String(state.userVolume))
      applyEffectiveAudioVolume()
    }
  } else {
    dom.audio.muted = true
  }
  updateVolumeUi()
}

function setVolume(value) {
  state.userVolume = Math.max(0, Math.min(1, Number(value)))
  applyEffectiveAudioVolume()
  if (state.userVolume > .001) dom.audio.muted = false
  localStorage.setItem('menoradio.volume', String(state.userVolume))
  updateVolumeUi()
}

function adjustVolumeFromWheel(event) {
  const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
  if (!delta) return
  event.preventDefault()
  event.stopPropagation()
  const step = event.shiftKey ? .01 : .05
  const direction = delta < 0 ? 1 : -1
  const nextVolume = Math.round((state.userVolume + direction * step) * 100) / 100
  setVolume(nextVolume)
}

function setImmersiveVolumePopover(open, { temporary = false } = {}) {
  clearTimeout(state.immersiveVolumeCloseTimer)
  state.immersiveVolumeCloseTimer = 0
  state.immersiveVolumeTemporary = Boolean(open && temporary)
  const popover = $('#immersiveVolumePopover')
  popover.classList.toggle('open', open)
  popover.setAttribute('aria-hidden', String(!open))
  $('#immersiveVolume').setAttribute('aria-expanded', String(open))
  if (state.immersiveVolumeTemporary) {
    state.immersiveVolumeCloseTimer = window.setTimeout(() => {
      setImmersiveVolumePopover(false)
    }, 1000)
  }
}

function pauseImmersiveVolumeAutoClose() {
  if (!state.immersiveVolumeTemporary) return
  clearTimeout(state.immersiveVolumeCloseTimer)
  state.immersiveVolumeCloseTimer = 0
}

function adjustImmersiveVolumeFromWheel(event) {
  if (event.currentTarget.id === 'immersiveVolume') {
    setImmersiveVolumePopover(true, { temporary: true })
    showImmersiveChrome()
  } else if (state.immersiveVolumeTemporary) {
    setImmersiveVolumePopover(true, { temporary: true })
  }
  adjustVolumeFromWheel(event)
}

async function audioOutputFingerprint() {
  if (!navigator.mediaDevices?.enumerateDevices) return ''
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices
      .filter((device) => device.kind === 'audiooutput')
      .map((device) => `${device.deviceId}|${device.groupId}|${device.label}`)
      .sort()
      .join('\n')
  } catch {
    return ''
  }
}

async function installAudioDeviceGuard() {
  if (!navigator.mediaDevices?.addEventListener) return
  state.audioOutputSnapshot = await audioOutputFingerprint()
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    const previous = state.audioOutputSnapshot
    const next = await audioOutputFingerprint()
    state.audioOutputSnapshot = next
    if (dom.audio.paused || !state.current) return
    if (!previous || !next || previous !== next) {
      state.playbackIntentPlaying = false
      dom.audio.pause()
      toast('音频设备发生变动，播放已暂停。', '已暂停')
    }
  })
}

function currentQueueIndex() {
  return state.queue.findIndex((track) => String(track.id) === String(state.current?.id))
}

function playbackSessionTrack(track) {
  if (!track?.id) return null
  return {
    id: String(track.id),
    name: String(track.name || ''),
    artist: String(track.artist || ''),
    album: String(track.album || ''),
    cover: String(track.cover || ''),
    duration: Math.max(0, Number(track.duration) || 0),
    alias: String(track.alias || ''),
    artists: artistsOfTrack(track),
    albumInfo: albumOfTrack(track),
  }
}

function restorePlaybackSessionTrack(track) {
  if (!track?.id) return null
  // Playback snapshots use a deliberately flat schema. Do not pass them
  // through normalizeTrack(): API tracks contain array-valued aliases while
  // snapshots contain a display string, which made restore call `.join()` on
  // a string and abort application initialization.
  return {
    id: String(track.id),
    name: String(track.name || '未命名歌曲'),
    artist: String(track.artist || ''),
    album: String(track.album || ''),
    cover: String(track.cover || ''),
    duration: Math.max(0, Number(track.duration) || 0),
    alias: String(track.alias || ''),
    raw: {
      ar: Array.isArray(track.artists) ? track.artists : [],
      al: track.albumInfo || null,
    },
  }
}

function persistPlaybackSession() {
  try {
    // An empty renderer state can be transient while account data and the
    // previous playback session are still hydrating. Only an explicit queue
    // clear is allowed to delete the saved session.
    if (!state.queue.length || !state.current) return
    const queue = state.queue.map(playbackSessionTrack).filter(Boolean)
    if (!queue.length) return
    const queueSource = state.queueSource.map(playbackSessionTrack).filter(Boolean)
    localStorage.setItem(playbackSessionStorageKey, JSON.stringify({
      version: 1,
      queue,
      queueSource,
      currentId: String(state.current.id),
      queueIndex: currentQueueIndex(),
      radioMode: Boolean(state.radioMode),
    }))
  } catch {
    // A full localStorage quota must not interrupt playback or window closing.
  }
}

function clearPersistedPlaybackSession() {
  try {
    localStorage.removeItem(playbackSessionStorageKey)
  } catch {}
}

function restorePlaybackSession() {
  let snapshot
  try {
    snapshot = JSON.parse(localStorage.getItem(playbackSessionStorageKey) || 'null')
  } catch {
    clearPersistedPlaybackSession()
    return false
  }
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.queue)) return false
  let queue
  let source
  try {
    queue = uniqueTracks(snapshot.queue.map(restorePlaybackSessionTrack).filter(Boolean))
    source = Array.isArray(snapshot.queueSource)
      ? uniqueTracks(snapshot.queueSource.map(restorePlaybackSessionTrack).filter(Boolean))
      : []
  } catch (error) {
    console.warn('[playback-session] Unable to decode saved queue:', error)
    return false
  }
  if (!queue.length) {
    clearPersistedPlaybackSession()
    return false
  }
  // Versions before 0.13.15 represented repeat-one as a one-item queue. Heal
  // those persisted sessions once so upgrading does not strand the user with
  // an invisible single-song queue.
  if (state.playMode === 'repeat-one' && queue.length === 1 && source.length > 1) queue = [...source]
  let queueIndex = queue.findIndex((track) => String(track.id) === String(snapshot.currentId || ''))
  if (queueIndex < 0 && Number.isInteger(snapshot.queueIndex)) {
    queueIndex = Math.max(0, Math.min(queue.length - 1, snapshot.queueIndex))
  }
  if (queueIndex < 0) queueIndex = 0
  state.queue = queue
  state.queueSource = source.length ? source : [...queue]
  state.queueIndex = queueIndex
  state.current = queue[queueIndex]
  state.radioMode = Boolean(snapshot.radioMode)
  state.activeLyric = -1
  state.focusLyric = 0
  state.lyrics = []
  state.lyricBreaks = []
  const generation = ++state.audioLoadGeneration
  state.lyricsLoading = false
  state.lyricsReadyGeneration = 0
  state.coverReadyGeneration = 0
  clearTimeout(state.currentCoverLoadTimer)
  state.currentCoverLoadTimer = 0
  state.playingGeneration = 0
  state.upcomingPreloadSignature = ''
  state.audioSourceTrackId = ''
  state.audioSourcePromise = null
  state.audioSourcePromiseGeneration = 0
  state.passiveAudioGeneration = generation
  state.pendingSeekTime = null
  state.pendingSeekDisplayTime = null
  state.pendingSeekApplied = false
  state.playbackIntentPlaying = false
  state.timelineAtEnd = false
  dom.audio.pause()
  dom.audio.removeAttribute('src')
  try { dom.audio.load() } catch {}
  try { dom.audio.currentTime = 0 } catch {}
  try {
    updateRange(dom.playerProgress, 0, Math.max(1, state.current.duration / 1000))
    updateRange(dom.immersiveProgress, 0, Math.max(1, state.current.duration / 1000))
    dom.timeLabel.textContent = `0:00 / ${formatTime(state.current.duration / 1000)}`
    $('#immersiveCurrent').textContent = '0:00'
    $('#immersiveDuration').textContent = formatTime(state.current.duration / 1000)
    setPlayIcons(false)
    updateRadioModeUi()
    updateNowPlaying({ passive: true })
  } catch (error) {
    // The saved queue is valid even if an optional renderer integration
    // (Media Session, backdrop decoding, etc.) is unavailable at startup.
    console.warn('[playback-session] Queue restored with reduced UI:', error)
    dom.playerBar.classList.remove('empty')
    dom.nowTitle.textContent = state.current.name
    dom.nowArtist.textContent = state.current.artist
    renderQueue()
  }
  // Restoring a paused queue must stay entirely local. Resolving media and
  // lyrics here used to overlap the initial home requests and caused a large
  // network burst immediately after initialization.
  renderLyrics([], 'loading')
  return true
}

function rebuildQueueForMode() {
  if (state.radioMode || !state.current) return
  if (state.playMode === 'repeat-one') {
    state.queueIndex = Math.max(0, currentQueueIndex())
    renderQueue()
    return
  }
  const source = uniqueTracks(state.queueSource.length ? state.queueSource : state.queue)
  if (!source.some((track) => String(track.id) === String(state.current.id))) source.unshift(state.current)
  state.queueSource = source
  state.queue = buildPlaybackQueue(source, state.playMode, state.current, true)
  state.queueIndex = currentQueueIndex()
  if (state.queueIndex < 0) state.queueIndex = 0
  renderQueue()
}

function updateRadioModeUi() {
  dom.playerBar.classList.toggle('radio-mode', state.radioMode)
  dom.immersive.classList.toggle('radio-mode', state.radioMode)
  $$('[data-route="radio"]').forEach((item) => item.classList.toggle('radio-playing', state.radioMode))
}

async function fetchPrivateRadioTracks() {
  const body = unwrap(await bridge.data.personalFm())
  const source = body.data || body.songs || body.result || []
  return source.map(normalizeTrack).filter((track) => track.id)
}

async function startPrivateRadio() {
  if (!state.loggedIn) {
    showLogin()
    return
  }
  if (state.radioLoading) return
  state.radioLoading = true
  try {
    const tracks = await fetchPrivateRadioTracks()
    if (!tracks.length) throw new Error('暂时没有取得私人漫游歌曲')
    await playTracks(tracks, 0, { radio: true })
  } catch (error) {
    toast(error.message || '无法开始私人漫游', '私人漫游', 'error')
  } finally {
    state.radioLoading = false
  }
}

async function playTracks(tracks, index = 0, options = {}) {
  if (!tracks?.length) return
  resetPlaybackFailureCycle()
  state.radioMode = options.radio === true
  updateRadioModeUi()
  const source = uniqueTracks(tracks)
  if (!source.length) return
  const selectedIndex = Math.max(0, Math.min(index, source.length - 1))
  const selected = source[selectedIndex]
  state.queueSource = [...source]
  state.queue = state.radioMode
    ? [...source]
    : buildPlaybackQueue(source, state.playMode, selected, state.playMode === 'shuffle' || options.keepSelectedFirst === true)
  state.queueIndex = state.queue.findIndex((track) => String(track.id) === String(selected.id))
  if (state.queueIndex < 0) state.queueIndex = 0
  renderQueue()
  await loadTrack(state.queue[state.queueIndex], true)
}

function playAllTracks(tracks) {
  const source = uniqueTracks(tracks)
  if (!source.length) return
  const index = state.playMode === 'shuffle' ? Math.floor(Math.random() * source.length) : 0
  return playTracks(source, index, { keepSelectedFirst: state.playMode === 'shuffle' })
}

async function playPlaylistFromCard(button) {
  const id = String(button?.dataset.playlistPlay || '')
  if (!id || button.dataset.loading === 'true') return
  button.dataset.loading = 'true'
  button.setAttribute('aria-busy', 'true')
  try {
    const { tracks } = await fetchPlaylist(id)
    if (!tracks.length) return toast('暂无歌曲')
    await playAllTracks(tracks)
  } catch (error) {
    toast(error.message || '歌单播放失败', '播放失败', 'error')
  } finally {
    if (button.isConnected) {
      delete button.dataset.loading
      button.removeAttribute('aria-busy')
    }
  }
}

function isSupersededPlaybackError(error) {
  return error?.name === 'AbortError' || /interrupted by a new load|interrupted by a call to pause/i.test(String(error?.message || ''))
}

function playbackError(message, kind = 'network', details = {}) {
  const error = new Error(message)
  error.playbackKind = kind
  Object.assign(error, details)
  return error
}

function playbackFailureKind(error) {
  if (error?.playbackKind === 'unavailable' || error?.playbackKind === 'network') return error.playbackKind
  if (!navigator.onLine) return 'network'
  if (Number(error?.mediaErrorCode) === 2) return 'network'
  if (Number(error?.mediaErrorCode) === 4) return 'unavailable'
  const message = String(error?.message || '')
  if (/无版权|版权|会员|不可用|无法播放|地区|下架|not available|forbidden|fee/i.test(message)) return 'unavailable'
  return 'network'
}

function resetPlaybackFailureCycle() {
  clearTimeout(state.playbackFailureTimer)
  state.playbackFailureTimer = 0
  state.playbackFailureGeneration = 0
  state.consecutivePlaybackFailures = 0
  state.playbackRetryCounts.clear()
  state.playbackFailedTrackIds.clear()
}

async function handlePlaybackFailure(track, generation, error) {
  if (!track || state.current?.id !== track.id || generation !== state.audioLoadGeneration) return
  // Media errors raised while the user is paused must not consume the one
  // failure slot for this generation. Otherwise pressing Play later cannot
  // retry the same source and may leave the track permanently inert.
  if (!state.playbackIntentPlaying) {
    dom.audio.pause()
    return
  }
  if (state.playbackFailureGeneration === generation) return
  state.playbackFailureGeneration = generation
  setPlayIcons(false)
  const trackId = String(track.id)
  const retries = state.playbackRetryCounts.get(trackId) || 0
  const failureKind = playbackFailureKind(error)
  clearTimeout(state.playbackFailureTimer)
  const optimizedCurrentStream = state.mediaLoadingOptimization
    && String(dom.audio.currentSrc || dom.audio.src || '').startsWith('menoradio-media:')
  // A bounded current stream has its own in-place recovery path. Re-running
  // loadTrack here resolves the song again, replaces the token and can restart
  // it from zero after a transient proxy/network interruption.
  if (failureKind === 'network' && optimizedCurrentStream) {
    state.playbackIntentPlaying = false
    dom.audio.pause()
    return
  }
  if (retries < 1) {
    state.playbackRetryCounts.set(trackId, retries + 1)
    state.playbackFailureTimer = window.setTimeout(() => {
      if (generation === state.audioLoadGeneration && String(state.current?.id) === trackId) loadTrack(track, true)
    }, 2200)
    return
  }
  if (failureKind === 'network') {
    state.playbackIntentPlaying = false
    dom.audio.pause()
    dom.audio.removeAttribute('src')
    try { dom.audio.load() } catch {}
    return
  }
  state.playbackFailedTrackIds.add(trackId)
  state.consecutivePlaybackFailures = state.playbackFailedTrackIds.size
  toast(error?.message || '这首歌暂时无法播放，已自动跳过。', '播放失败，正在跳过', 'error')
  const availableIds = new Set(state.queue.map((item) => String(item.id)))
  const allUnavailable = availableIds.size > 0 && [...availableIds].every((id) => state.playbackFailedTrackIds.has(id))
  if (allUnavailable) {
    state.playbackIntentPlaying = false
    dom.audio.pause()
    toast('播放队列中的歌曲目前都无法播放。', '已停止自动跳过', 'error')
    return
  }
  state.playbackFailureTimer = window.setTimeout(() => {
    if (generation === state.audioLoadGeneration) nextTrack(1, { failed: true })
  }, 700)
}

function playbackBufferedAhead() {
  const current = Math.max(0, Number(dom.audio.currentTime) || 0)
  let end = current
  try {
    for (let index = 0; index < dom.audio.buffered.length; index += 1) {
      const start = dom.audio.buffered.start(index)
      const rangeEnd = dom.audio.buffered.end(index)
      if (start <= current + .25 && rangeEnd >= current) end = Math.max(end, rangeEnd)
    }
  } catch {}
  return Math.max(0, end - current)
}

function sendPlaybackBufferReport() {
  if (state.playbackBufferReportTimer) {
    window.clearTimeout(state.playbackBufferReportTimer)
    state.playbackBufferReportTimer = 0
  }
  state.playbackBufferLastAt = performance.now()
  const src = String(dom.audio.currentSrc || dom.audio.src || '')
  if (!state.mediaLoadingOptimization || !src.startsWith('menoradio-media:')) return
  bridge.media.updatePlaybackBuffer({
    src,
    bufferedAhead: playbackBufferedAhead(),
    paused: dom.audio.paused,
    seeking: dom.audio.seeking,
    readyState: dom.audio.readyState,
    starving: state.playbackStarving
      || (state.playbackIntentPlaying && !dom.audio.paused && dom.audio.readyState <= 2),
  })
}

function reportPlaybackBuffer(force = false) {
  if (!state.mediaLoadingOptimization) return
  if (force) {
    sendPlaybackBufferReport()
    return
  }
  if (state.playbackBufferReportTimer) return
  const elapsed = performance.now() - state.playbackBufferLastAt
  state.playbackBufferReportTimer = window.setTimeout(
    sendPlaybackBufferReport,
    Math.max(0, 160 - elapsed),
  )
}

function resetAudioSource(generation = state.audioLoadGeneration, passive = false) {
  state.audioSourceTrackId = ''
  state.audioSourcePromise = null
  state.audioSourcePromiseGeneration = 0
  state.currentAudioSource = null
  state.currentAudioDirectUrl = ''
  state.optimizedPlaybackInPlaceRetryGeneration = 0
  state.playbackProxyFallbackGeneration = 0
  state.optimizedPlaybackRecoveryStartedAt = 0
  state.passiveAudioGeneration = passive ? generation : 0
  state.pendingSeekTime = null
  state.pendingSeekDisplayTime = null
  state.pendingSeekApplied = false
  state.pendingSeekRecoveryAttempts = 0
  state.seekPrimingUntil = 0
  state.timelineScrubbing = false
  state.timelinePreviewTime = null
  state.timelineAtEnd = false
  state.lastStablePlaybackTime = null
  state.playbackStarving = false
  if (state.pendingSeekRecoveryTimer) window.clearTimeout(state.pendingSeekRecoveryTimer)
  state.pendingSeekRecoveryTimer = 0
  state.ignoreAudioErrorsUntil = performance.now() + 900
  if (state.playbackBufferReportTimer) window.clearTimeout(state.playbackBufferReportTimer)
  state.playbackBufferReportTimer = 0
  state.playbackBufferLastAt = 0
  dom.audio.pause()
  dom.audio.removeAttribute('src')
  try { dom.audio.load() } catch {}
  void bridge.media.cancelPlayback().catch(() => {})
  try { dom.audio.currentTime = 0 } catch {}
}

function playbackDuration() {
  return Number.isFinite(dom.audio.duration) && dom.audio.duration > 0
    ? dom.audio.duration
    : Math.max(0, Number(state.current?.duration || 0) / 1000)
}

function clearPendingAudioSeek() {
  state.pendingSeekTime = null
  state.pendingSeekDisplayTime = null
  state.pendingSeekApplied = false
  state.pendingSeekRecoveryAttempts = 0
  state.seekPrimingUntil = 0
  if (state.pendingSeekRecoveryTimer) window.clearTimeout(state.pendingSeekRecoveryTimer)
  state.pendingSeekRecoveryTimer = 0
}

function updatePlaybackPositionUi(current, duration = playbackDuration(), updateLyrics = false) {
  const value = Math.max(0, Number(current) || 0)
  const maximum = Math.max(1, Number(duration) || 0)
  updateRange(dom.playerProgress, value, maximum)
  updateRange(dom.immersiveProgress, value, maximum)
  dom.timeLabel.textContent = `${formatTime(value)} / ${formatTime(duration)}`
  $('#immersiveCurrent').textContent = formatTime(value)
  $('#immersiveDuration').textContent = formatTime(duration)
  if (updateLyrics) updateActiveLyric(value, false, true)
}

async function prepareOptimizedPlaybackSeek() {
  const src = String(dom.audio.currentSrc || dom.audio.src || '')
  if (!state.mediaLoadingOptimization || !src.startsWith('menoradio-media:')) return false
  state.seekPrimingUntil = performance.now() + 2800
  try {
    return await bridge.media.preparePlaybackSeek(src)
  } catch {
    return false
  }
}

function schedulePendingSeekRecovery(generation, attempt = 0) {
  if (state.pendingSeekRecoveryTimer) window.clearTimeout(state.pendingSeekRecoveryTimer)
  state.pendingSeekRecoveryTimer = window.setTimeout(async () => {
    state.pendingSeekRecoveryTimer = 0
    if (generation !== state.audioLoadGeneration || !Number.isFinite(state.pendingSeekTime)) return
    const difference = Math.abs((dom.audio.currentTime || 0) - state.pendingSeekTime)
    if (difference <= .5) {
      finishPendingAudioSeek()
      return
    }
    if (attempt >= 1) {
      // Do not leave the visual clock pinned forever if Chromium rejected the
      // seek. A later user action can still submit a fresh seek normally.
      clearPendingAudioSeek()
      state.timelineAtEnd = false
      updatePlaybackPositionUi(dom.audio.currentTime || 0, playbackDuration(), true)
      return
    }
    state.pendingSeekRecoveryAttempts = attempt + 1
    const restarted = await restartOptimizedPlaybackAfterStalledSeek(generation)
    if (!restarted) {
      await prepareOptimizedPlaybackSeek()
      if (generation !== state.audioLoadGeneration || !Number.isFinite(state.pendingSeekTime)) return
      state.pendingSeekApplied = false
      applyPendingAudioSeek()
    }
    schedulePendingSeekRecovery(generation, attempt + 1)
  }, 2400)
}

async function restartOptimizedPlaybackAfterStalledSeek(generation) {
  if (!Number.isFinite(state.pendingSeekTime)) return false
  return recoverOptimizedPlayback(generation, {
    freshToken: true,
    target: state.pendingSeekTime,
    shouldResume: state.playbackIntentPlaying,
  })
}

function optimizedPlaybackRecoveryTarget() {
  const duration = playbackDuration()
  const candidates = [state.pendingSeekTime, state.lastStablePlaybackTime, dom.audio.currentTime]
  const candidate = candidates.find((value) => Number.isFinite(value)) ?? 0
  return Math.min(Math.max(0, Number(candidate)), Math.max(0, duration - .05))
}

function waitForAudioMetadata(generation, timeout = 3200) {
  if (generation !== state.audioLoadGeneration || dom.audio.readyState >= 1) return Promise.resolve()
  return new Promise((resolve) => {
    let timer = 0
    const finish = () => {
      window.clearTimeout(timer)
      dom.audio.removeEventListener('loadedmetadata', finish)
      dom.audio.removeEventListener('error', finish)
      resolve()
    }
    timer = window.setTimeout(finish, timeout)
    dom.audio.addEventListener('loadedmetadata', finish, { once: true })
    dom.audio.addEventListener('error', finish, { once: true })
  })
}

async function recoverOptimizedPlayback(generation, options = {}) {
  const directUrl = state.currentAudioDirectUrl
  const currentSrc = String(dom.audio.currentSrc || dom.audio.src || '')
  if (!state.mediaLoadingOptimization
    || !directUrl
    || generation !== state.audioLoadGeneration
    || (!options.freshToken && !currentSrc.startsWith('menoradio-media:'))) return false
  const target = Number.isFinite(options.target) ? Math.max(0, Number(options.target)) : optimizedPlaybackRecoveryTarget()
  const shouldResume = Boolean(options.shouldResume)
  let retryUrl = currentSrc
  if (options.freshToken) {
    const source = state.currentAudioSource || {}
    try {
      retryUrl = await bridge.media.playbackUrl(directUrl, {
        size: source.size,
        br: source.br,
        time: source.time,
        duration: state.current?.duration,
      })
    } catch {
      return false
    }
  } else {
    await prepareOptimizedPlaybackSeek()
  }
  if (!retryUrl || generation !== state.audioLoadGeneration) return false

  const duration = playbackDuration()
  state.pendingSeekTime = Math.min(target, Math.max(0, duration - .05))
  state.pendingSeekDisplayTime = state.pendingSeekTime
  state.pendingSeekApplied = false
  state.pendingSeekRecoveryAttempts = 0
  state.timelineAtEnd = false
  state.playbackStarving = true
  state.optimizedPlaybackRecoveryStartedAt = performance.now()
  state.ignoreAudioErrorsUntil = performance.now() + 1000
  dom.audio.pause()
  if (options.freshToken) dom.audio.src = retryUrl
  dom.audio.load()
  reportPlaybackBuffer(true)
  await waitForAudioMetadata(generation)
  if (generation !== state.audioLoadGeneration) return false
  await prepareOptimizedPlaybackSeek()
  if (generation !== state.audioLoadGeneration) return false
  state.pendingSeekApplied = false
  if (!applyPendingAudioSeek()) return false
  schedulePendingSeekRecovery(generation)
  if (shouldResume && state.playbackIntentPlaying) {
    try {
      await dom.audio.play()
    } catch (error) {
      if (!isSupersededPlaybackError(error)) return false
    }
  }
  return true
}

function applyPendingAudioSeek() {
  if (!Number.isFinite(state.pendingSeekTime) || !dom.audio.src || dom.audio.readyState < 1) return false
  if (state.pendingSeekApplied) return true
  const duration = playbackDuration()
  const target = Math.max(0, duration > 0 ? Math.min(duration, state.pendingSeekTime) : state.pendingSeekTime)
  try {
    // Keep the requested time authoritative until the media element confirms
    // the seek. A restored, paused source can emit a transient 0-second update
    // between load() and seeked; clearing here made lyrics visibly jump back.
    state.pendingSeekApplied = true
    dom.audio.currentTime = target
    return true
  } catch {
    state.pendingSeekApplied = false
    return false
  }
}

function playbackClockTime() {
  if (state.timelineScrubbing && Number.isFinite(state.timelinePreviewTime)) return state.timelinePreviewTime
  if (Number.isFinite(state.pendingSeekDisplayTime)) return state.pendingSeekDisplayTime
  if (state.timelineAtEnd && dom.audio.paused) return playbackDuration()
  return dom.audio.currentTime || 0
}

function finishPendingAudioSeek() {
  if (!Number.isFinite(state.pendingSeekTime) || !state.pendingSeekApplied) return false
  if (Math.abs((dom.audio.currentTime || 0) - state.pendingSeekTime) > .35) return false
  clearPendingAudioSeek()
  return true
}

async function ensureAudioSource(track, generation = state.audioLoadGeneration, options = {}) {
  if (!track || String(state.current?.id) !== String(track.id) || generation !== state.audioLoadGeneration) return false
  const trackId = String(track.id)
  if (!options.passive) state.passiveAudioGeneration = 0
  if (dom.audio.src && state.audioSourceTrackId === trackId) {
    if (!options.deferSeek) applyPendingAudioSeek()
    return true
  }
  if (state.audioSourcePromise && state.audioSourcePromiseGeneration === generation) {
    return state.audioSourcePromise
  }

  state.audioSourcePromiseGeneration = generation
  if (options.passive) state.passiveAudioGeneration = generation
  const request = (async () => {
    try {
      // Reuse the already-resolved URL without preloading its audio body.
      const preload = getAudioPreload(track, false)
      const audioSource = preload
        ? await preload.sourcePromise
        : unwrap(await bridge.data.songUrl(track.id, state.audioQuality)).data?.[0]
      if (preload && upcomingAudioPreloads.get(preload.key) === preload) upcomingAudioPreloads.delete(preload.key)
      if (String(state.current?.id) !== trackId || generation !== state.audioLoadGeneration) return false
      let url = audioSource?.url
      if (!url) throw playbackError('这首歌暂时无法播放，可能需要会员或所在地区没有版权。', 'unavailable')
      state.currentAudioSource = audioSource
      state.trackReplayGainDb = replayGainDb(audioSource.gain)
      applyEffectiveAudioVolume()
      url = String(url).replace(/^http:/, 'https:')
      state.currentAudioDirectUrl = url
      if (state.mediaLoadingOptimization) {
        // The main process cancels obsolete low-priority work before returning
        // this paced media source, so current playback never waits behind it.
        url = await bridge.media.playbackUrl(url, {
          size: audioSource.size,
          br: audioSource.br,
          time: audioSource.time,
          duration: track.duration,
        })
      } else {
        void bridge.media.cancelPreload().catch(() => {})
        void bridge.media.cancelPlayback().catch(() => {})
      }
      if (String(state.current?.id) !== trackId || generation !== state.audioLoadGeneration) return false
      state.ignoreAudioErrorsUntil = performance.now() + 900
      state.audioSourceTrackId = trackId
      dom.audio.src = url
      dom.audio.load()
      reportPlaybackBuffer(true)
      if (!options.deferSeek) applyPendingAudioSeek()
      return true
    } catch (error) {
      if (String(state.current?.id) !== trackId || generation !== state.audioLoadGeneration) return false
      state.audioSourceTrackId = ''
      if (state.passiveAudioGeneration !== generation && !isSupersededPlaybackError(error)) {
        handlePlaybackFailure(track, generation, error?.playbackKind ? error : playbackError(error?.message || '音频连接失败', 'network'))
      }
      return false
    }
  })()
  state.audioSourcePromise = request
  try {
    return await request
  } finally {
    if (state.audioSourcePromise === request) {
      state.audioSourcePromise = null
      state.audioSourcePromiseGeneration = 0
    }
  }
}

async function seekCurrentTrack(seconds) {
  if (!state.current || !Number.isFinite(seconds)) return false
  const duration = playbackDuration()
  const requestedTarget = Math.max(0, duration > 0 ? Math.min(duration, seconds) : seconds)
  const atEnd = duration > 0 && requestedTarget >= duration - .25
  const target = atEnd ? Math.max(0, duration - .05) : requestedTarget
  state.timelineAtEnd = atEnd
  state.pendingSeekTime = target
  state.pendingSeekDisplayTime = requestedTarget
  state.pendingSeekApplied = false
  state.pendingSeekRecoveryAttempts = 0
  state.timelineScrubbing = false
  state.timelinePreviewTime = null
  updatePlaybackPositionUi(requestedTarget, duration, true)
  const generation = state.audioLoadGeneration
  const ready = await ensureAudioSource(state.current, generation, {
    passive: !state.playbackIntentPlaying,
    deferSeek: true,
  })
  if (generation !== state.audioLoadGeneration || !ready) return false
  await prepareOptimizedPlaybackSeek()
  if (generation !== state.audioLoadGeneration) return false
  applyPendingAudioSeek()
  schedulePendingSeekRecovery(generation)
  if (state.playbackIntentPlaying && !dom.audio.paused) startLyricsClock()
  return true
}

async function loadTrack(track, autoplay = true) {
  if (!track) return
  const generation = ++state.audioLoadGeneration
  state.playbackIntentPlaying = Boolean(autoplay)
  stopLyricsClock()
  const loadId = track.id
  cancelPendingCoverPreloadsExcept(playbackCoverUrl(track.cover))
  // Preserve a pre-resolved URL for the selected track, but immediately stop
  // low-priority cover work so the current song gets the network first.
  cancelPendingAudioPreloadsExcept(track)
  state.current = track
  state.queueIndex = currentQueueIndex()
  state.activeLyric = -1
  state.focusLyric = 0
  state.lyrics = []
  state.lyricBreaks = []
  state.lyricsLoading = false
  state.lyricsReadyGeneration = 0
  state.coverReadyGeneration = 0
  state.playingGeneration = 0
  state.upcomingPreloadSignature = ''
  state.trackReplayGainDb = 0
  applyEffectiveAudioVolume()
  resetAudioSource(generation, !autoplay)
  updateRange(dom.playerProgress, 0, Math.max(1, track.duration / 1000))
  updateRange(dom.immersiveProgress, 0, Math.max(1, track.duration / 1000))
  dom.timeLabel.textContent = `0:00 / ${formatTime(track.duration / 1000)}`
  $('#immersiveCurrent').textContent = '0:00'
  $('#immersiveDuration').textContent = formatTime(track.duration / 1000)
  updateNowPlaying()
  renderLyrics([], 'loading')
  void fetchLyrics(track, generation)
  if (!state.recent.some((item) => item.id === track.id)) state.recent.unshift(track)
  state.recent = state.recent.slice(0, 80)

  const ready = await ensureAudioSource(track, generation, { passive: !autoplay })
  if (!ready || state.current?.id !== loadId || generation !== state.audioLoadGeneration || !autoplay) return
  try {
    state.passiveAudioGeneration = 0
    await dom.audio.play()
  } catch (error) {
    if (state.current?.id !== loadId || generation !== state.audioLoadGeneration) return
    if (isSupersededPlaybackError(error)) return
    handlePlaybackFailure(track, generation, error?.playbackKind ? error : playbackError(error?.message || '音频连接失败', 'network'))
  }
}

function updateNowPlaying(options = {}) {
  const track = state.current
  dom.playerBar.classList.toggle('empty', !track)
  if (!track) {
    dom.nowCover.style.backgroundImage = ''
    dom.nowTitle.textContent = ''
    dom.nowArtist.textContent = ''
    renderQueue()
    return
  }
  const passive = Boolean(options.passive)
  const cover = state.mediaLoadingOptimization
    ? sizedImageUrl(track.cover, passive ? thumbnailPixelSize(64) : 512)
    : playbackCoverUrl(track.cover)
  const generation = state.audioLoadGeneration
  if (!passive && !state.mediaLoadingOptimization) state.coverReadyGeneration = generation
  dom.nowCover.textContent = ''
  dom.nowCover.style.backgroundImage = `url("${cover.replace(/["\\]/g, '')}")`
  dom.nowCover.style.backgroundSize = 'cover'
  dom.nowTitle.textContent = track.name
  dom.nowArtist.textContent = track.artist
  const immersiveCover = $('#immersiveCover')
  const trackKey = String(track.id)
  const trackChanged = dom.immersive.dataset.trackKey !== trackKey
  const firstTrack = !dom.immersive.dataset.trackKey
  dom.immersive.dataset.trackKey = trackKey
  immersiveCover.crossOrigin = 'anonymous'
  immersiveCover.src = cover
  $('#immersiveTitle').textContent = track.name
  $('#immersiveTitle').title = track.name
  $('#immersiveArtist').textContent = track.artist
  if (trackChanged && !firstTrack) animateImmersiveTrackChange(immersiveCover)
  if (!passive) updateImmersiveBackdrop(cover)
  const liked = state.liked.has(track.id)
  $('#likeButton').classList.toggle('active', liked)
  $('#immersiveLike').classList.toggle('active', liked)
  $('#likeButton').setAttribute('aria-label', liked ? '从我喜欢的音乐移除' : '添加到我喜欢的音乐')
  $('#immersiveLike').setAttribute('aria-label', liked ? '从我喜欢的音乐移除' : '添加到我喜欢的音乐')
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.name,
        artist: track.artist,
        album: track.album,
        artwork: cover ? [{ src: cover }] : [],
      })
    } catch (error) {
      console.warn('[media-session] Unable to publish restored metadata:', error)
    }
  }
  refreshPlayingRows()
  renderQueue()
}

function updateLikeButtonsOnly() {
  const liked = Boolean(state.current && state.liked.has(String(state.current.id)))
  for (const button of [$('#likeButton'), $('#immersiveLike')]) {
    if (!button) continue
    button.classList.toggle('active', liked)
    button.setAttribute('aria-label', liked ? '从我喜欢的音乐移除' : '添加到我喜欢的音乐')
  }
}

function animateImmersiveTrackChange(coverImage) {
  if (state.legacyPlayer || !dom.immersive.classList.contains('open') || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const easing = 'cubic-bezier(.16,1,.3,1)'
  const meta = $('.immersive-meta > div', dom.immersive)
  meta?.animate([
    { opacity: 0, transform: 'translateY(10px)', filter: 'blur(6px)' },
    { opacity: 1, transform: 'none', filter: 'blur(0)' },
  ], { duration: 560, delay: 60, easing, fill: 'backwards' })
  // Reveal the new artwork once it has decoded, so the old cover is never
  // the one being animated in.
  const stage = $('.cover-stage', dom.immersive)
  if (!stage) return
  if (state.coverRevealListener) coverImage.removeEventListener('load', state.coverRevealListener)
  state.coverRevealListener = null
  const animateStage = () => {
    state.coverRevealListener = null
    stage.animate([
      { opacity: .2, transform: 'scale(.9)', filter: 'blur(12px) saturate(1.3)' },
      { opacity: 1, transform: 'none', filter: 'blur(0) saturate(1)' },
    ], { duration: 760, easing })
  }
  if (coverImage.complete && coverImage.naturalWidth > 0 && coverImage.currentSrc === coverImage.src) {
    animateStage()
    return
  }
  state.coverRevealListener = animateStage
  coverImage.addEventListener('load', animateStage, { once: true })
}

function updateImmersiveBackdrop(url, decodedImage = null) {
  if (!url || state.backdropUrl === url) return
  state.backdropUrl = url
  const generation = ++state.backdropGeneration
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.referrerPolicy = 'no-referrer'
  const reveal = (source, luminance = Number.NaN) => {
    if (generation !== state.backdropGeneration) return
    const layers = [$('#immersiveBackdrop'), $('#immersiveBackdropNext')]
    const nextIndex = state.backdropLayer === 0 ? 1 : 0
    const current = layers[state.backdropLayer]
    const next = layers[nextIndex]
    if (!next) return
    const processed = Number.isFinite(luminance)
    const coverValue = `url("${String(source).replace(/["\\]/g, '')}")`
    next.style.setProperty('--cover', coverValue)
    // An unprocessed (cross-origin) cover still needs the CSS blur fallback.
    next.classList.toggle('raw', !processed)
    // Bright artwork receives a deeper veil so white lyrics keep contrast.
    const veil = processed ? Math.max(.14, Math.min(.42, .2 + (luminance - .42) * .62)) : .26
    dom.immersive.style.setProperty('--backdrop-veil', veil.toFixed(3))
    dom.immersive.style.setProperty('--cover-ambient', coverValue)
    next.classList.add('active')
    current?.classList.remove('active')
    state.backdropLayer = nextIndex
    clearTimeout(state.backdropTransitionTimer)
    state.backdropTransitionTimer = window.setTimeout(() => {
      if (current && !current.classList.contains('active')) current.style.removeProperty('--cover')
    }, 1100)
  }
  const processImage = (sourceImage) => {
    if (generation !== state.backdropGeneration) return
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 28
      canvas.height = 28
      const context = canvas.getContext('2d', { willReadFrequently: true })
      context.drawImage(sourceImage, 0, 0, canvas.width, canvas.height)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
      const values = pixels.data
      const smoothstep = (start, end, value) => {
        const amount = Math.max(0, Math.min(1, (value - start) / (end - start)))
        return amount * amount * (3 - 2 * amount)
      }
      let luminanceTotal = 0
      let whiteMass = 0
      for (let index = 0; index < values.length; index += 4) {
        const red = values[index] / 255
        const green = values[index + 1] / 255
        const blue = values[index + 2] / 255
        const luminance = red * .2126 + green * .7152 + blue * .0722
        const chroma = Math.max(red, green, blue) - Math.min(red, green, blue)
        luminanceTotal += luminance
        whiteMass += smoothstep(.70, .96, luminance) * (1 - smoothstep(.055, .24, chroma))
      }
      const pixelCount = Math.max(1, values.length / 4)
      const averageLuminance = luminanceTotal / pixelCount
      const whiteRatio = whiteMass / pixelCount
      const overbrightRisk = smoothstep(.12, .46, whiteRatio) * smoothstep(.56, .80, averageLuminance)
      if (overbrightRisk > .04) {
        const coverDimming = 1 - overbrightRisk * .07
        for (let index = 0; index < values.length; index += 4) {
          const red = values[index] / 255
          const green = values[index + 1] / 255
          const blue = values[index + 2] / 255
          const luminance = red * .2126 + green * .7152 + blue * .0722
          const chroma = Math.max(red, green, blue) - Math.min(red, green, blue)
          const whiteWeight = smoothstep(.70, .96, luminance) * (1 - smoothstep(.055, .24, chroma))
          const mix = overbrightRisk * whiteWeight * .34
          const targetRed = luminance * .72
          const targetGreen = luminance * .82
          const targetBlue = luminance * .68
          values[index] = Math.round((red * (1 - mix) + targetRed * mix) * coverDimming * 255)
          values[index + 1] = Math.round((green * (1 - mix) + targetGreen * mix) * coverDimming * 255)
          values[index + 2] = Math.round((blue * (1 - mix) + targetBlue * mix) * coverDimming * 255)
        }
        context.putImageData(pixels, 0, 0)
      }
      if (state.legacyPlayer) {
        reveal(canvas.toDataURL('image/jpeg', .9), averageLuminance)
        return
      }
      // Pre-blur the tiny sample once. The animated backdrop layers then only
      // move an already-soft texture instead of running a huge CSS blur.
      const soft = document.createElement('canvas')
      soft.width = 96
      soft.height = 96
      const softContext = soft.getContext('2d')
      softContext.imageSmoothingQuality = 'high'
      softContext.filter = 'blur(6px) saturate(1.16)'
      softContext.drawImage(canvas, -14, -14, 124, 124)
      reveal(soft.toDataURL('image/jpeg', .9), averageLuminance)
    } catch {
      reveal(url)
    }
  }
  image.onload = () => processImage(image)
  image.onerror = () => {
    if (generation === state.backdropGeneration) state.backdropUrl = ''
  }
  if (decodedImage?.naturalWidth > 0) {
    processImage(decodedImage)
  } else {
    image.src = url
  }
}

function refreshPlayingRows() {
  $$('.track-row').forEach((row, index) => {
    row.classList.toggle('playing', state.pageTracks[index]?.id === state.current?.id)
  })
}

async function togglePlayback() {
  if (!state.current) {
    const tracks = state.pageTracks.length ? state.pageTracks : state.home?.newSongs
    if (tracks?.length) playTracks(tracks, 0)
    return
  }
  const duration = playbackDuration()
  const reachedEnd = state.timelineAtEnd
    || dom.audio.ended
    || (duration > 0 && (dom.audio.currentTime || 0) >= duration - .25)
  if (dom.audio.paused && reachedEnd) {
    state.playbackIntentPlaying = true
    state.timelineAtEnd = false
    clearPendingAudioSeek()
    if (state.playMode !== 'repeat-one') {
      await nextTrack(1)
      return
    }
    const generation = state.audioLoadGeneration
    const sought = await seekCurrentTrack(0)
    if (!sought || generation !== state.audioLoadGeneration || !state.playbackIntentPlaying) return
    try {
      await dom.audio.play()
    } catch (error) {
      if (generation !== state.audioLoadGeneration || isSupersededPlaybackError(error)) return
      handlePlaybackFailure(state.current, generation, error)
    }
    return
  }
  if (!dom.audio.src) {
    const generation = state.audioLoadGeneration
    state.playbackIntentPlaying = true
    updateNowPlaying()
    if (!state.lyricsLoading && state.lyricsReadyGeneration !== generation) void fetchLyrics(state.current, generation)
    state.passiveAudioGeneration = 0
    const ready = await ensureAudioSource(state.current, generation)
    if (!ready || generation !== state.audioLoadGeneration) return
    try {
      await dom.audio.play()
    } catch (error) {
      if (generation !== state.audioLoadGeneration) return
      if (error?.name === 'AbortError' || /interrupted by a new load|interrupted by a call to pause/i.test(String(error?.message || ''))) return
      if (error?.name === 'NotAllowedError') {
        state.playbackIntentPlaying = false
        return toast(error.message, '无法开始播放', 'error')
      }
      handlePlaybackFailure(state.current, generation, error)
    }
  } else if (dom.audio.paused) {
    const generation = state.audioLoadGeneration
    state.playbackIntentPlaying = true
    if (!state.lyricsLoading && state.lyricsReadyGeneration !== generation) void fetchLyrics(state.current, generation)
    state.passiveAudioGeneration = 0
    dom.audio.play().catch((error) => {
      if (generation !== state.audioLoadGeneration) return
      if (error?.name === 'AbortError' || /interrupted by a new load|interrupted by a call to pause/i.test(String(error?.message || ''))) return
      if (error?.name === 'NotAllowedError') {
        state.playbackIntentPlaying = false
        return toast(error.message, '无法开始播放', 'error')
      }
      handlePlaybackFailure(state.current, generation, error)
    })
  } else {
    state.playbackIntentPlaying = false
    dom.audio.pause()
  }
}

async function nextTrack(direction = 1, options = {}) {
  if (!state.queue.length) return
  if (!options.failed) resetPlaybackFailureCycle()
  if (state.radioMode) {
    if (direction < 0) return
    if (state.queueIndex >= state.queue.length - 1) {
      try {
        const tracks = await fetchPrivateRadioTracks()
        const existing = new Set(state.queue.map((track) => String(track.id)))
        state.queue.push(...tracks.filter((track) => !existing.has(String(track.id))))
        renderQueue()
      } catch (error) {
        toast(error.message || '无法取得下一首私人漫游歌曲', '私人漫游', 'error')
        return
      }
    }
    state.queueIndex = Math.min(state.queueIndex + 1, state.queue.length - 1)
    await loadTrack(state.queue[state.queueIndex], true)
    return
  }
  const currentIndex = currentQueueIndex()
  if (currentIndex >= 0) state.queueIndex = currentIndex
  const step = direction < 0 ? -1 : 1
  state.queueIndex = ((state.queueIndex + step) % state.queue.length + state.queue.length) % state.queue.length
  renderQueue()
  return loadTrack(state.queue[state.queueIndex], true)
}

async function onTrackEnded() {
  if (!state.playbackIntentPlaying) {
    state.timelineAtEnd = true
    clearPendingAudioSeek()
    dom.audio.pause()
    updatePlaybackPositionUi(playbackDuration(), playbackDuration(), true)
    return
  }
  if (state.radioMode) {
    await nextTrack(1)
  } else if (state.playMode === 'repeat-one') {
    state.timelineAtEnd = false
    const generation = state.audioLoadGeneration
    const sought = await seekCurrentTrack(0)
    if (sought && generation === state.audioLoadGeneration && state.playbackIntentPlaying) {
      await dom.audio.play().catch((error) => {
        if (generation === state.audioLoadGeneration && !isSupersededPlaybackError(error)) {
          handlePlaybackFailure(state.current, generation, error)
        }
      })
    }
  } else {
    await nextTrack(1)
  }
}

async function toggleLike() {
  if (!state.current) return
  if (!state.loggedIn) {
    showLogin()
    return
  }
  const track = state.current
  if (state.likePending.has(track.id)) return
  const liked = state.liked.has(track.id)
  const likedPlaylist = likedPlaylistOf()
  state.likePending.add(track.id)
  for (const button of [$('#likeButton'), $('#immersiveLike')]) button?.setAttribute('disabled', '')
  try {
    let succeeded = false
    if (likedPlaylist) {
      succeeded = await modifyPlaylist(liked ? 'del' : 'add', likedPlaylist.id, track, { quiet: true })
    } else {
      const body = unwrap(await bridge.data.like(track.id, !liked))
      if (body?.code && Number(body.code) !== 200) throw new Error(body.message || '网易云音乐未接受本次操作')
      setTrackLiked(track.id, !liked)
      succeeded = true
    }
    if (succeeded) toast(liked ? '已从我喜欢的音乐移除' : '已添加到我喜欢的音乐')
  } catch (error) {
    toast(error.message || '网易云音乐未接受本次操作', '同步收藏失败', 'error')
  } finally {
    state.likePending.delete(track.id)
    for (const button of [$('#likeButton'), $('#immersiveLike')]) button?.removeAttribute('disabled')
  }
}

function cyclePlayMode() {
  const modes = ['repeat-one', 'repeat-all', 'shuffle']
  state.playMode = modes[(modes.indexOf(state.playMode) + 1) % modes.length]
  localStorage.setItem('menoradio.playMode', state.playMode)
  rebuildQueueForMode()
  updatePlayModeButtons()
}

function updatePlayModeButtons() {
  const config = {
    'repeat-one': { icon: 'repeat-one', label: '单曲循环' },
    'repeat-all': { icon: 'repeat', label: '列表循环' },
    shuffle: { icon: 'shuffle', label: '随机播放' },
  }[state.playMode]
  for (const button of [$('#playModeButton'), $('#immersiveModeButton')]) {
    if (!button) continue
    button.innerHTML = icon(config.icon)
    button.title = config.label
    button.setAttribute('aria-label', config.label)
  }
}

function rangeSeekTime(element) {
  if (!state.current) return
  const duration = playbackDuration()
  const maximum = Number(element.max)
  if (!(duration > 0) || !(maximum > 0)) return null
  return Math.max(0, Math.min(duration, (Number(element.value) / maximum) * duration))
}

function previewSeekFromRange(element) {
  const target = rangeSeekTime(element)
  if (!Number.isFinite(target)) return
  state.timelineScrubbing = true
  state.timelinePreviewTime = target
  updatePlaybackPositionUi(target, playbackDuration(), true)
}

function commitSeekFromRange(element) {
  const target = rangeSeekTime(element)
  state.timelineScrubbing = false
  state.timelinePreviewTime = null
  if (Number.isFinite(target)) void seekCurrentTrack(target)
}

function cancelTimelineScrub() {
  if (!state.timelineScrubbing) return
  state.timelineScrubbing = false
  state.timelinePreviewTime = null
  updatePlaybackPositionUi(playbackClockTime(), playbackDuration(), true)
}

async function fetchLyrics(track, generation = state.audioLoadGeneration) {
  state.lyricsLoading = true
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const body = unwrap(await bridge.data.lyrics(track.id))
      if (state.current?.id !== track.id || generation !== state.audioLoadGeneration) return
      const timed = parseYrc(body.yrc?.lyric)
      const originalDocument = parseLrcDocument(body.lrc?.lyric)
      const original = applyTimedDurations(originalDocument.lines, timed)
      const translated = parseLrc(body.tlyric?.lyric)
      const romanized = parseLrc(body.romalrc?.lyric)
      const merged = mergeLyrics(original, translated, romanized)
      const explicitlyEmpty = body.nolyric === true || body.uncollected === true
      if (!merged.length && !explicitlyEmpty && attempt < 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 240))
        continue
      }
      state.lyricBreaks = alignLyricBreaks(merged, originalDocument.breaks)
      state.lyrics = merged
      state.lyricsLoading = false
      state.lyricsReadyGeneration = generation
      renderLyrics(state.lyrics, state.lyrics.length ? 'ready' : 'empty')
      maybePreloadUpcomingCovers()
      return
    } catch (error) {
      lastError = error
      if (attempt < 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 240))
        continue
      }
    }
  }
  if (state.current?.id === track.id && generation === state.audioLoadGeneration) {
    state.lyricsLoading = false
    state.lyricsReadyGeneration = generation
    renderLyrics([], 'empty')
    maybePreloadUpcomingCovers()
    if (lastError) console.warn('[lyrics] Unable to load lyrics after retries:', lastError)
  }
}

function renderLyrics(lines, status = 'ready') {
  state.activeLyric = -1
  state.focusLyric = 0
  state.manualLyricReadable = false
  clearTimeout(state.manualLyricReadableTimer)
  $$('.lyric-line', dom.lyricsScroller).forEach((line) => line.getAnimations().forEach((animation) => animation.cancel()))
  resetLyricWords()
  if (!lines.length) {
    dom.lyricsScroller.innerHTML = status === 'loading'
      ? `<div class="lyric-loading" role="status" aria-label="正在加载歌词"><span class="lyric-loading-spinner" aria-hidden="true"></span></div>`
      : `<div class="lyric-empty"><strong>暂无歌词</strong><span>让旋律自己说话</span></div>`
    syncFloatingLyrics(true)
    return
  }
  dom.lyricsScroller.innerHTML = lines.map((line, index) => {
    const words = wordHighlightEnabled() && Array.isArray(line.words) && line.words.length ? line.words : null
    const original = words
      ? words.map((word) => `<span class="lyric-word" data-start="${Number(word.time)}" data-end="${Number(word.time) + Number(word.duration || 0)}">${escapeHtml(word.text)}</span>`).join('')
      : escapeHtml(line.text)
    return `<div class="lyric-line${words ? ' has-words' : ''}" data-lyric-index="${index}" data-time="${line.time}"><div class="lyric-content"><div class="lyric-original">${original}</div>${line.translation ? `<div class="lyric-translation translation">${escapeHtml(line.translation)}</div>` : ''}</div></div>`
  }).join('')
  updateLyricVisibility()
  requestAnimationFrame(() => {
    updateActiveLyric(playbackClockTime(), true, true)
    startLyricsClock()
  })
}

function updateLyricVisibility() {
  $$('.translation', dom.lyricsScroller).forEach((line) => line.hidden = !state.showTranslation)
  $('#translationToggle').classList.toggle('active', state.showTranslation)
  syncFloatingLyrics(true)
}

function syncFloatingLyrics(force = false) {
  if (!bridge.floatingLyrics) return
  const line = state.activeLyric >= 0 ? state.lyrics[state.activeLyric] : null
  const payload = {
    text: line?.text || '',
    translation: state.showTranslation ? line?.translation || '' : '',
    active: state.activeLyric >= 0,
    inPlayer: dom.immersive.classList.contains('open'),
    paused: dom.audio.paused,
  }
  const key = JSON.stringify(payload)
  if (!force && key === state.floatingLyricsPayloadKey) return
  state.floatingLyricsPayloadKey = key
  bridge.floatingLyrics.update(payload).catch(() => {})
}

function syncLyricsToPlaybackClock(force = false) {
  const current = playbackClockTime()
  if (state.lyrics.length) updateActiveLyric(current)
  syncFloatingLyrics(force)
  return current
}

function nextLyricsClockBoundary(time) {
  let boundary = Number.POSITIVE_INFINITY
  for (const line of state.lyrics) {
    const lineTime = Number(line.time)
    const activation = lyricActivationTime(line)
    if (activation > time) {
      boundary = activation
      break
    }
    // A very short explicit break can begin after the early activation point
    // of its following line. Keep the real line timestamp as a boundary too,
    // otherwise the break state would not be revisited until the polling cap.
    if (lineTime > time) {
      boundary = lineTime
      break
    }
  }
  for (const marker of state.lyricBreaks) {
    const candidate = Number(marker)
    if (candidate > time) {
      boundary = Math.min(boundary, candidate)
      break
    }
  }
  return boundary
}

function stopLyricsClock() {
  if (!state.lyricsClockTimer) return
  window.clearTimeout(state.lyricsClockTimer)
  state.lyricsClockTimer = 0
}

function scheduleLyricsClock(time, generation = state.audioLoadGeneration) {
  if (dom.audio.paused || generation !== state.audioLoadGeneration) return
  const boundary = nextLyricsClockBoundary(time)
  const playbackRate = Math.max(.05, Number(dom.audio.playbackRate) || 1)
  const boundaryDelay = Number.isFinite(boundary)
    ? Math.max(lyricsClockMinimumDelayMs, Math.ceil(((boundary - time) * 1000) / playbackRate))
    : lyricsClockIntervalMs
  const delay = Math.min(lyricsClockIntervalMs, boundaryDelay)
  state.lyricsClockTimer = window.setTimeout(() => {
    state.lyricsClockTimer = 0
    if (generation !== state.audioLoadGeneration) return
    if (dom.audio.paused) {
      syncFloatingLyrics(true)
      return
    }
    const current = syncLyricsToPlaybackClock()
    scheduleLyricsClock(current, generation)
  }, delay)
}

function startLyricsClock() {
  stopLyricsClock()
  const current = syncLyricsToPlaybackClock(true)
  scheduleLyricsClock(current)
  syncLyricWords()
}

function lyricOpacity(lineIndex, activeIndex, focusIndex = state.focusLyric) {
  if (lineIndex === activeIndex) return 1
  if (state.manualLyricReadable) return .34
  if (activeIndex < 0 && lineIndex === focusIndex) return .34
  const distance = Math.abs(lineIndex - focusIndex)
  return Math.max(.075, .34 * Math.pow(.67, Math.max(0, distance - 1)))
}

// Depth of field: lines further from the focus soften slightly so the sung
// line stays the clear subject. Manual reading removes the effect entirely.
function lyricBlur(lineIndex, activeIndex, focusIndex = state.focusLyric) {
  if (lineIndex === activeIndex || state.manualLyricReadable) return 0
  const distance = Math.abs(lineIndex - focusIndex)
  return distance === 0 ? 0 : Math.min(2.6, .4 + distance * .45)
}

function animateLyricOpacity(line, lineIndex, previousActive, previousFocus, nextActive, nextFocus, immediate, durationOverride = 0) {
  const current = Number.parseFloat(getComputedStyle(line).opacity) || lyricOpacity(lineIndex, previousActive, previousFocus)
  line.getAnimations().filter((animation) => animation.id?.startsWith('lyric-opacity-')).forEach((animation) => animation.cancel())
  const target = lyricOpacity(lineIndex, nextActive, nextFocus)
  line.style.setProperty('--lyric-opacity', target.toFixed(3))
  line.style.setProperty('--lyric-blur', `${lyricBlur(lineIndex, nextActive, nextFocus).toFixed(2)}px`)
  if (immediate || Math.abs(current - target) < .006 || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const incoming = lineIndex === nextActive
  const outgoing = lineIndex === previousActive
  const animation = line.animate([{ opacity: current }, { opacity: target }], {
    duration: durationOverride || (incoming ? 720 : outgoing ? 650 : 780),
    delay: durationOverride ? 0 : incoming ? 80 : 0,
    easing: durationOverride ? 'cubic-bezier(.22,.61,.36,1)' : incoming ? 'cubic-bezier(.22,.61,.36,1)' : outgoing ? 'cubic-bezier(.28,0,.35,1)' : 'linear',
    fill: 'both',
  })
  animation.id = `lyric-opacity-${lineIndex}`
  animation.addEventListener('finish', () => animation.cancel(), { once: true })
}

function lyricContentScale(content) {
  if (!content) return 1
  const transform = getComputedStyle(content).transform
  if (!transform || transform === 'none') return 1
  try {
    const matrix = new DOMMatrixReadOnly(transform)
    return Math.hypot(matrix.a, matrix.b) || 1
  } catch {
    return 1
  }
}

function animateLyricScale(line, target, immediate) {
  if (!line) return
  const content = $('.lyric-content', line)
  if (!content) return
  const currentScale = lyricContentScale(content)
  const animations = content.getAnimations().filter((animation) => animation.id?.startsWith('lyric-scale-'))
  animations.forEach((animation) => animation.cancel())
  content.style.setProperty('--lyric-scale', target.toFixed(4))
  if (immediate || Math.abs(currentScale - target) < .001 || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const incoming = target > 1
  const animation = content.animate([
    { transform: `scale(${currentScale.toFixed(4)})` },
    { transform: `scale(${target})` },
  ], {
    duration: incoming ? 720 : 650,
    delay: incoming ? 80 : 0,
    easing: incoming ? 'cubic-bezier(.22,.61,.36,1)' : 'cubic-bezier(.28,0,.35,1)',
    fill: 'both',
  })
  animation.id = `lyric-scale-${line.dataset.lyricIndex || 'line'}`
  animation.addEventListener('finish', () => animation.cancel(), { once: true })
}

// Word-timed lines activate on the YRC timestamp; even the usual 60ms lead
// can cut off a short final syllable of the preceding line.
function lyricActivationTime(line) {
  return Math.max(0, line.time - (line.words?.length ? 0 : lyricActivationToleranceSeconds))
}

function lyricIndexAt(time, earlyActivation = false) {
  let indexAtTime = -1
  for (let index = 0; index < state.lyrics.length; index += 1) {
    const line = state.lyrics[index]
    if ((earlyActivation ? lyricActivationTime(line) : line.time) <= time) indexAtTime = index
    else break
  }
  return indexAtTime
}

function explicitBreakAfter(lineIndex) {
  const current = state.lyrics[lineIndex]
  const next = state.lyrics[lineIndex + 1]
  if (!current || !next) return Number.NaN
  return state.lyricBreaks.find((marker) => marker > current.time && marker < next.time) ?? Number.NaN
}

function resolveLyricEmphasis(time) {
  const chronological = lyricIndexAt(time)
  if (chronological >= 0) {
    const next = state.lyrics[chronological + 1]
    const explicitBreak = explicitBreakAfter(chronological)
    if (next && Number.isFinite(explicitBreak)) {
      // An explicit blank timestamp owns the whole gap, however short it is.
      // Do not let the usual early-activation tolerance highlight the next
      // line before that gap begins or before its real timestamp is reached.
      return time >= explicitBreak && time < next.time ? -1 : chronological
    }
  }
  return lyricIndexAt(time, true)
}

function resolveLyricScrollFocus(time) {
  const chronological = lyricIndexAt(time)
  if (chronological >= 0) {
    const next = state.lyrics[chronological + 1]
    const explicitBreak = explicitBreakAfter(chronological)
    if (next && Number.isFinite(explicitBreak) && time >= explicitBreak && time < next.time) {
      return chronological + 1
    }
  }
  return Math.max(0, lyricIndexAt(time, true))
}

function updateLyricEmphasis(nextActive, nextFocus, immediate = false, force = false) {
  const previousActive = state.activeLyric
  const previousFocus = state.focusLyric
  const activeChanged = nextActive !== previousActive
  const focusChanged = nextFocus !== previousFocus
  if (!activeChanged && !focusChanged && !force) return
  state.activeLyric = nextActive
  syncFloatingLyrics()
  const lines = $$('.lyric-line', dom.lyricsScroller)
  lines.forEach((line, lineIndex) => {
    line.classList.toggle('active', lineIndex === nextActive)
    animateLyricOpacity(line, lineIndex, previousActive, previousFocus, nextActive, nextFocus, immediate)
  })

  // Scaling has its own lifecycle. Only the outgoing and incoming lines are
  // handed to this controller, so a short explicit break can never make the
  // following line cancel the outgoing line's still-running shrink animation.
  if (activeChanged) {
    if (previousActive >= 0 && previousActive !== nextActive) animateLyricScale(lines[previousActive], 1, immediate)
    if (nextActive >= 0) animateLyricScale(lines[nextActive], 1.038, immediate)
  }
  syncLyricWords()
}

// Visual alpha of a not-yet-sung word. It equals the opacity of the lines
// next to the focus, so an unsung word looks the same before, during and
// after its line becomes active.
const lyricUnsungAlpha = .34

// Reversing a lift starts at its visible position, including an unfinished
// rise. A monotonic easing and a longer descent avoid a tiny snap/rebound.
function animateLyricWordLift(element, lifted) {
  if (element.classList.contains('sung') === lifted) return
  const current = getComputedStyle(element).transform
  element.getAnimations().filter((animation) => animation.id === 'lyric-word-lift').forEach((animation) => animation.cancel())
  element.classList.toggle('sung', lifted)
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const target = getComputedStyle(element).transform
  const animation = element.animate([
    { transform: current },
    { transform: target },
  ], { duration: lifted ? 600 : 950, easing: 'cubic-bezier(.25,.1,.25,1)', fill: 'both' })
  animation.id = 'lyric-word-lift'
  animation.addEventListener('finish', () => animation.cancel(), { once: true })
}

function updateLyricWordProgress(words, time, lift = true) {
  for (const word of words) {
    const span = Math.max(.001, word.end - word.start)
    const progress = Math.round(Math.max(0, Math.min(1, (time - word.start) / span)) * 1000) / 1000
    if (progress === word.progress) continue
    word.progress = progress
    word.element.style.setProperty('--word-progress', String(progress))
    if (lift) animateLyricWordLift(word.element, progress > 0)
  }
}

function resetLyricWords() {
  cancelAnimationFrame(state.lyricWordFrame)
  state.lyricWordFrame = 0
  state.lyricWordLine = null
  state.lyricWords = []
  state.lyricWordOutgoing = []
}

function lyricOpacityAnimating(line) {
  return line.getAnimations().some((animation) => (
    animation.id?.startsWith('lyric-opacity-')
    && (animation.playState === 'running' || animation.playState === 'pending')
  ))
}

// The line's opacity is animated as a whole, so a fixed unsung alpha would be
// multiplied by it: the unsung words dip to ~12% right when a line activates
// (and flash up as it leaves). Instead the unsung alpha is derived from the
// line's live opacity every frame, keeping the unsung brightness constant.
function applyLyricWordRest(line) {
  const opacity = Number.parseFloat(getComputedStyle(line).opacity) || 1
  const rest = Math.min(1, lyricUnsungAlpha / Math.max(.01, opacity))
  line.style.setProperty('--word-rest', rest.toFixed(3))
}

// Word-timed (YRC) lyrics fill word by word. The loop reads the playback
// clock every frame while the player is visible and playing, so seeking,
// pausing and rate changes never need their own bookkeeping. It keeps running
// while an outgoing or incoming line is still fading, even when paused.
function syncLyricWords() {
  const index = state.activeLyric
  const found = index >= 0 ? $(`.lyric-line[data-lyric-index="${index}"]`, dom.lyricsScroller) : null
  const line = found?.classList.contains('has-words') ? found : null
  if (line !== state.lyricWordLine) {
    const previous = state.lyricWordLine
    if (previous) {
      // Catch the final word up to this exact boundary before freezing its fill;
      // the last animation frame may have occurred just before the word ended.
      updateLyricWordProgress(state.lyricWords, playbackClockTime(), false)
      // The outgoing line keeps its fill; only the lift settles back down.
      state.lyricWords.forEach((word) => animateLyricWordLift(word.element, false))
      state.lyricWordOutgoing = [...state.lyricWordOutgoing.filter((item) => item !== previous && item !== line), previous]
    }
    state.lyricWordOutgoing = state.lyricWordOutgoing.filter((item) => item !== line)
    state.lyricWordLine = line
    state.lyricWords = line ? $$('.lyric-word', line).map((element) => ({
      element,
      start: Number(element.dataset.start) || 0,
      end: Number(element.dataset.end) || 0,
      progress: -1,
    })) : []
  }
  if (!state.lyricWordLine && !state.lyricWordOutgoing.length) return
  cancelAnimationFrame(state.lyricWordFrame)
  state.lyricWordFrame = 0
  const tick = () => {
    state.lyricWordFrame = 0
    const active = state.lyricWordLine
    if (active) {
      updateLyricWordProgress(state.lyricWords, playbackClockTime())
      applyLyricWordRest(active)
    }
    state.lyricWordOutgoing = state.lyricWordOutgoing.filter((outgoing) => {
      if (!outgoing.isConnected) return false
      if (lyricOpacityAnimating(outgoing)) {
        applyLyricWordRest(outgoing)
        return true
      }
      // Settled: at rest the unsung part is plain text again.
      outgoing.style.removeProperty('--word-rest')
      return false
    })
    const playing = !dom.audio.paused && dom.immersive.classList.contains('open')
    const fading = state.lyricWordOutgoing.length || (active && lyricOpacityAnimating(active))
    if ((active && playing) || fading) state.lyricWordFrame = requestAnimationFrame(tick)
  }
  tick()
}

function updateLyricScrollFocus(nextFocus, previousActive, nextActive, immediate = false, force = false) {
  const previousFocus = state.focusLyric
  const focusChanged = nextFocus !== previousFocus
  state.focusLyric = nextFocus
  if ((!focusChanged && !force) || (state.manualLyricReadable && !immediate)) return
  const lines = $$('.lyric-line', dom.lyricsScroller)
  const focused = lines[nextFocus]
  if (focused) {
    const desired = Math.max(0, focused.offsetTop - dom.lyricsScroller.clientHeight * state.lyricFocusRatio)
    const last = lines[lines.length - 1]
    const optionClearance = Math.max(60, dom.lyricsScroller.clientHeight * .065)
    const endAligned = Math.max(0, last.offsetTop + last.offsetHeight - (dom.lyricsScroller.clientHeight - optionClearance))
    const target = Math.min(desired, endAligned)
    const firstLineActivation = previousActive < 0 && nextActive === 0 && nextFocus === 0
    setLyricScrollTarget(target, immediate || firstLineActivation, nextFocus)
  }
}

function updateActiveLyric(time, immediate = false, force = false) {
  if (!state.lyrics.length) return
  const nextActive = resolveLyricEmphasis(time)
  const nextFocus = resolveLyricScrollFocus(time)
  if (nextActive === state.activeLyric && nextFocus === state.focusLyric && !force) return
  const previousActive = state.activeLyric
  updateLyricEmphasis(nextActive, nextFocus, immediate, force)
  updateLyricScrollFocus(nextFocus, previousActive, nextActive, immediate, force)
}

function smootherStep(value) {
  const clamped = Math.max(0, Math.min(1, value))
  return clamped * clamped * clamped * (clamped * (clamped * 6 - 15) + 10)
}

function softenedLyricMotionProgress(progress) {
  // Ease only the first instant, then continuously rejoin the original timeline.
  return progress - .12 * progress * Math.pow(1 - progress, 3)
}

function lyricSpringFrames(visualDelta, queueDepth) {
  const depth = Math.min(6, queueDepth)
  const damping = .72 - depth * .014
  const frequency = 7.8
  const dampedFrequency = frequency * Math.sqrt(1 - damping * damping)
  const phase = damping / Math.sqrt(1 - damping * damping)
  const samples = 60
  return Array.from({ length: samples + 1 }, (_, index) => {
    const progress = index / samples
    const motionProgress = softenedLyricMotionProgress(progress)
    const spring = Math.exp(-damping * frequency * motionProgress) * (
      Math.cos(dampedFrequency * motionProgress) + phase * Math.sin(dampedFrequency * motionProgress)
    )
    const settle = 1 - smootherStep((progress - .84) / .16)
    const displacement = visualDelta * spring * settle
    return {
      offset: progress,
      transform: `translateY(${displacement.toFixed(3)}px)`,
    }
  })
}

function setLyricScrollTarget(target, immediate = false, focusIndex = state.focusLyric) {
  const max = Math.max(0, dom.lyricsScroller.scrollHeight - dom.lyricsScroller.clientHeight)
  const next = Math.min(max, Math.max(0, target))
  const previous = dom.lyricsScroller.scrollTop
  const delta = next - previous
  const lines = $$('.lyric-line', dom.lyricsScroller)
  cancelAnimationFrame(state.manualLyricFrame)
  state.manualLyricFrame = 0
  state.manualLyricTarget = next
  if (!immediate && Math.abs(delta) < .5 && !matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const visualTops = lines.map((line) => line.getBoundingClientRect().top)
  lines.forEach((line) => line.getAnimations().filter((animation) => animation.id?.startsWith('lyric-scroll-')).forEach((animation) => animation.cancel()))
  if (immediate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    dom.lyricsScroller.scrollTop = next
    return
  }

  dom.lyricsScroller.scrollTop = next

  lines.forEach((line, lineIndex) => {
    const visualDelta = visualTops[lineIndex] - line.getBoundingClientRect().top
    const relative = lineIndex - focusIndex
    const queueDepth = delta >= 0 ? Math.max(0, relative) : Math.max(0, -relative)
    const delay = Math.min(180, queueDepth * 30)
    const duration = 680 + Math.min(250, queueDepth * 50)
    const animation = line.animate(lyricSpringFrames(visualDelta, queueDepth), {
      duration,
      delay,
      easing: 'linear',
      fill: 'both',
    })
    animation.id = `lyric-scroll-${lineIndex}`
    animation.addEventListener('finish', () => animation.cancel(), { once: true })
  })
}

function setManualLyricReadability(readable, scheduleReset = true) {
  clearTimeout(state.manualLyricReadableTimer)
  const changed = state.manualLyricReadable !== readable
  state.manualLyricReadable = readable
  if (changed) {
    if (readable) {
      $$('.lyric-line', dom.lyricsScroller).forEach((line) => line.getAnimations().filter((animation) => animation.id?.startsWith('lyric-scroll-')).forEach((animation) => animation.cancel()))
    }
    $$('.lyric-line', dom.lyricsScroller).forEach((line, lineIndex) => {
      animateLyricOpacity(line, lineIndex, state.activeLyric, state.focusLyric, state.activeLyric, state.focusLyric, false, readable ? 180 : 420)
    })
  }
  if (readable && scheduleReset) {
    state.manualLyricReadableTimer = window.setTimeout(() => {
      setManualLyricReadability(false, false)
      updateActiveLyric(playbackClockTime(), false, true)
    }, 5000)
  }
}

function smoothManualLyricScroll(delta) {
  const scroller = dom.lyricsScroller
  setManualLyricReadability(true)
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  const current = scroller.scrollTop
  if (!Number.isFinite(state.manualLyricTarget) || Math.abs(state.manualLyricTarget - current) > scroller.clientHeight) {
    state.manualLyricTarget = current
  }
  state.manualLyricTarget = Math.max(0, Math.min(max, state.manualLyricTarget + delta))
  const start = current
  const distance = state.manualLyricTarget - start
  const startedAt = performance.now()
  const duration = 230 + Math.min(90, Math.abs(distance) * .12)
  cancelAnimationFrame(state.manualLyricFrame)
  const tick = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration)
    const eased = 1 - Math.pow(1 - progress, 3)
    scroller.scrollTop = start + distance * eased
    if (progress < 1) state.manualLyricFrame = requestAnimationFrame(tick)
    else state.manualLyricFrame = 0
  }
  state.manualLyricFrame = requestAnimationFrame(tick)
}

function queueMarkup() {
  return state.queue.length ? state.queue.map((track, index) => {
    const active = index === state.queueIndex
    return `<div class="queue-item ${active ? 'active' : ''}" data-queue-index="${index}" role="button" tabindex="0" draggable="true"${active ? ' aria-current="true"' : ''}><img ${thumbnailAttributes(track.cover, thumbnailPixelSize(38))} alt=""><span class="queue-item-copy"><strong>${escapeHtml(track.name)}</strong><small>${escapeHtml(track.artist)}</small></span>${active ? `<span class="queue-now">${icon('play')} 正在播放</span>` : `<span class="queue-item-time">${formatDuration(track.duration)}</span>`}<button type="button" class="queue-remove" data-queue-remove aria-label="从播放队列移除 ${attr(track.name)}" title="从队列移除">${icon('close')}</button></div>`
  }).join('') : `<div class="empty-state"><div class="empty-state-inner"><p>播放队列还是空的</p></div></div>`
}

function releaseClosedQueueDom(delay = 0) {
  clearTimeout(state.queueDomReleaseTimer)
  state.queueDomReleaseTimer = window.setTimeout(() => {
    state.queueDomReleaseTimer = 0
    if (!dom.queueDrawer.classList.contains('open')) dom.queueList.replaceChildren()
    if (!(dom.immersive.classList.contains('open') && state.immersiveView === 'queue')) {
      dom.immersiveQueueList.replaceChildren()
    }
  }, delay)
}

function scrollQueueToCurrent(container, behavior = 'smooth') {
  requestAnimationFrame(() => {
    const active = container?.querySelector('.queue-item.active')
    if (!active || !container) return
    const containerRect = container.getBoundingClientRect()
    const activeRect = active.getBoundingClientRect()
    const target = container.scrollTop
      + activeRect.top - containerRect.top
      - (container.clientHeight - activeRect.height) / 2
    const max = Math.max(0, container.scrollHeight - container.clientHeight)
    container.scrollTo({ top: Math.max(0, Math.min(max, target)), behavior })
  })
}

function renderQueue(options = {}) {
  const summary = `${state.queue.length} 首歌曲`
  $('#queueSummary').textContent = summary
  $('#immersiveQueueSummary').textContent = summary
  const drawerOpen = dom.queueDrawer.classList.contains('open')
  const immersiveQueueOpen = dom.immersive.classList.contains('open') && state.immersiveView === 'queue'
  if (drawerOpen || immersiveQueueOpen) {
    const markup = queueMarkup()
    if (drawerOpen) dom.queueList.innerHTML = markup
    if (immersiveQueueOpen) dom.immersiveQueueList.innerHTML = markup
  }
  releaseClosedQueueDom()
  const canClear = state.queue.length > 0
  $('#clearQueue')?.toggleAttribute('disabled', !canClear)
  $('#immersiveClearQueue')?.toggleAttribute('disabled', !canClear)
  if (options.focusCurrent) {
    if (dom.queueDrawer.classList.contains('open')) scrollQueueToCurrent(dom.queueList)
    if (dom.immersive.classList.contains('open') && state.immersiveView === 'queue') {
      const delay = dom.immersive.classList.contains('queue-view') ? 0 : 210
      window.setTimeout(() => {
        if (dom.immersive.classList.contains('open') && state.immersiveView === 'queue') {
          scrollQueueToCurrent(dom.immersiveQueueList)
        }
      }, delay)
    }
  }
  persistPlaybackSession()
  maybePreloadUpcomingCovers()
}

function clearUpcomingQueue() {
  if (!state.queue.length) return
  if (!state.current) {
    clearPlaybackQueue()
    return
  }
  if (state.queue.length === 1 && String(state.queue[0]?.id) === String(state.current.id)) {
    clearPlaybackQueue()
    toast('播放队列已清空')
    return
  }
  state.queue = [state.current]
  state.queueSource = [state.current]
  state.queueIndex = 0
  resetPlaybackFailureCycle()
  renderQueue()
  toast('当前歌曲会继续播放。', '已清空接下来播放')
}

function clearPlaybackQueue() {
  const generation = ++state.audioLoadGeneration
  state.current = null
  state.queue = []
  state.queueSource = []
  state.queueIndex = -1
  state.lyrics = []
  state.lyricBreaks = []
  clearPersistedPlaybackSession()
  resetPlaybackFailureCycle()
  resetAudioSource(generation)
  setPlayIcons(false)
  openImmersive(false)
  renderLyrics([], 'empty')
  updateNowPlaying()
}

function removeQueueTrack(index) {
  if (!Number.isInteger(index) || !state.queue[index]) return
  const removed = state.queue[index]
  const removingCurrent = String(removed.id) === String(state.current?.id)
  state.queue.splice(index, 1)
  state.queueSource = state.queueSource.filter((track) => String(track.id) !== String(removed.id))
  if (!state.queue.length) {
    clearPlaybackQueue()
  } else if (removingCurrent) {
    const nextIndex = Math.min(index, state.queue.length - 1)
    state.queueIndex = nextIndex
    renderQueue()
    loadTrack(state.queue[state.queueIndex], true)
  } else {
    state.queueIndex = currentQueueIndex()
    renderQueue()
  }
}

function reorderQueue(fromIndex, insertionIndex) {
  if (!Number.isInteger(fromIndex) || !state.queue[fromIndex]) return false
  const next = Math.max(0, Math.min(state.queue.length, insertionIndex))
  const adjusted = fromIndex < next ? next - 1 : next
  if (adjusted === fromIndex) return false
  const [moved] = state.queue.splice(fromIndex, 1)
  state.queue.splice(adjusted, 0, moved)
  state.queueIndex = currentQueueIndex()
  state.queueSource = [...state.queue]
  renderQueue()
  return true
}

function insertTrackIntoQueue(track, insertionIndex = state.queue.length) {
  if (!track) return false
  if (!state.current || !state.queue.length) {
    playTracks([track], 0, { keepSelectedFirst: true })
    return true
  }
  let next = Math.max(0, Math.min(state.queue.length, Number(insertionIndex)))
  const existingIndex = state.queue.findIndex((item) => String(item.id) === String(track.id))
  if (existingIndex >= 0) {
    const adjusted = existingIndex < next ? next - 1 : next
    if (adjusted === existingIndex) return false
    const [existing] = state.queue.splice(existingIndex, 1)
    if (existingIndex < next) next -= 1
    next = Math.max(0, Math.min(state.queue.length, next))
    state.queue.splice(next, 0, existing)
    state.queueIndex = currentQueueIndex()
    state.queueSource = [...state.queue]
    renderQueue()
    toast(`已调整队列位置：${track.name}`)
    return
  }
  state.queue.splice(next, 0, track)
  if (next <= state.queueIndex) state.queueIndex += 1
  if (!state.queueSource.some((item) => String(item.id) === String(track.id))) state.queueSource.push(track)
  renderQueue()
  toast(`已加入播放队列：${track.name}`)
}

function ownPlaylistById(id) {
  const playlistId = String(id || '')
  return state.userPlaylists.find((playlist) => String(playlist.id) === playlistId && playlist.creatorId === String(state.profile?.userId || '')) || null
}

function currentPlaylistOwned() {
  return Boolean(state.route === 'playlist' && state.currentPlaylist && ownPlaylistById(state.currentPlaylist.id))
}

function refreshCurrentPlaylistTrackList() {
  const list = $('#playlistTrackList', dom.page)
  if (!list) return
  const query = String($('[data-playlist-search]', dom.page)?.value || '').trim().toLocaleLowerCase()
  const tracks = query
    ? state.playlistTracks.filter((track) => `${track.name} ${track.artist} ${track.album}`.toLocaleLowerCase().includes(query))
    : state.playlistTracks
  list.innerHTML = tracks.length ? renderTrackTable(tracks) : '<div class="empty-state playlist-empty-state"><div class="empty-state-inner"><div class="empty-icon">' + icon('list') + '</div><h2>没有符合条件的歌曲</h2></div></div>'
  const count = $('[data-playlist-result-count]', dom.page)
  if (count) count.textContent = `${tracks.length} 首`
}

async function reorderCurrentPlaylist(track, targetTrack, after = false, options = {}) {
  if (!currentPlaylistOwned() || !track || !targetTrack) return false
  const fromIndex = state.playlistTracks.findIndex((item) => String(item.id) === String(track.id))
  const targetIndex = state.playlistTracks.findIndex((item) => String(item.id) === String(targetTrack.id))
  if (fromIndex < 0 || targetIndex < 0) return false
  let insertionIndex = targetIndex + (after ? 1 : 0)
  if (fromIndex < insertionIndex) insertionIndex -= 1
  insertionIndex = Math.max(0, Math.min(state.playlistTracks.length - 1, insertionIndex))
  if (insertionIndex === fromIndex) return false
  const previous = [...state.playlistTracks]
  const [moved] = state.playlistTracks.splice(fromIndex, 1)
  insertionIndex = Math.max(0, Math.min(state.playlistTracks.length, insertionIndex))
  state.playlistTracks.splice(insertionIndex, 0, moved)
  refreshCurrentPlaylistTrackList()
  try {
    const body = unwrap(await bridge.data.playlistReorder(state.currentPlaylist.id, state.playlistTracks.map((item) => item.id)))
    if (body?.code && Number(body.code) !== 200) throw new Error(body.message || '网易云音乐未接受新的歌曲顺序')
    if (!options.quiet) toast(`已调整顺序：${track.name}`)
    return true
  } catch (error) {
    state.playlistTracks = previous
    refreshCurrentPlaylistTrackList()
    toast(error.message || '无法调整歌单顺序', '调整失败', 'error')
    return false
  }
}

async function addTrackToCurrentPlaylistAt(track, targetTrack = null, after = false) {
  if (!currentPlaylistOwned() || !track) return false
  try {
    const added = await modifyPlaylist('add', state.currentPlaylist.id, track, { quiet: true })
    if (!added) return false
    if (targetTrack && String(targetTrack.id) !== String(track.id)) {
      await reorderCurrentPlaylist(track, targetTrack, after, { quiet: true })
    }
    toast(`已添加到歌单：${track.name}`)
    return true
  } catch (error) {
    toast(error.message || '无法添加到歌单', '操作失败', 'error')
    return false
  }
}

function queueReorderTarget(fromIndex, insertionIndex) {
  const next = Math.max(0, Math.min(state.queue.length, Number(insertionIndex)))
  return fromIndex < next ? next - 1 : next
}

function playlistReorderTarget(track, targetTrack, after = false) {
  if (!track || !targetTrack) return null
  const fromIndex = state.playlistTracks.findIndex((item) => String(item.id) === String(track.id))
  const targetIndex = state.playlistTracks.findIndex((item) => String(item.id) === String(targetTrack.id))
  if (fromIndex < 0 || targetIndex < 0) return null
  let insertionIndex = targetIndex + (after ? 1 : 0)
  if (fromIndex < insertionIndex) insertionIndex -= 1
  insertionIndex = Math.max(0, Math.min(state.playlistTracks.length - 1, insertionIndex))
  return { fromIndex, insertionIndex }
}

function transparentDragImage() {
  let image = $('#transparentDragImage')
  if (image) return image
  image = document.createElement('canvas')
  image.id = 'transparentDragImage'
  image.width = 1
  image.height = 1
  image.style.cssText = 'position:fixed;left:-10px;top:-10px;pointer-events:none'
  document.body.append(image)
  return image
}

function showTrackDragHud(track) {
  let hud = $('#trackDragHud')
  if (!hud) {
    hud = document.createElement('div')
    hud.id = 'trackDragHud'
    hud.className = 'track-drag-hud'
    hud.setAttribute('aria-hidden', 'true')
    document.body.append(hud)
  }
  const cover = track.cover ? `<img src="${attr(track.cover)}" alt="">` : '<span class="track-drag-hud-cover"></span>'
  hud.innerHTML = `${cover}<span class="track-drag-hud-copy"><strong>${escapeHtml(track.name)}</strong><small>${escapeHtml(track.artist)}</small></span><span class="track-drag-hud-status">移动歌曲</span>`
  hud.classList.toggle('immersive', dom.immersive.classList.contains('open'))
  hud.classList.remove('forbidden')
  hud.setAttribute('aria-hidden', 'false')
  document.body.classList.add('track-dragging')
}

function setTrackDragFeedback(type = 'move', label = '移动歌曲') {
  const hud = $('#trackDragHud')
  if (!hud) return
  if (state.dragFeedbackType === type && state.dragFeedbackLabel === label) return
  state.dragFeedbackType = type
  state.dragFeedbackLabel = label
  const forbidden = type === 'forbidden'
  hud.classList.toggle('forbidden', forbidden)
  const status = $('.track-drag-hud-status', hud)
  if (status) status.textContent = label
  document.documentElement.classList.toggle('drag-forbidden', forbidden)
}

function setDragInsertionMarker(row, position = '') {
  const className = position === 'after' ? 'drop-after' : position === 'before' ? 'drop-before' : ''
  if (state.dragMarkerRow === row && state.dragMarkerClass === className) return
  if (state.dragMarkerRow && state.dragMarkerClass) state.dragMarkerRow.classList.remove(state.dragMarkerClass)
  state.dragMarkerRow = row || null
  state.dragMarkerClass = className
  if (state.dragMarkerRow && className) state.dragMarkerRow.classList.add(className)
}

function dragHoverIndicator() {
  let indicator = $('#dragHoverIndicator')
  if (indicator) return indicator
  indicator = document.createElement('div')
  indicator.id = 'dragHoverIndicator'
  indicator.className = 'drag-hover-indicator'
  indicator.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="drag-hover-track" cx="12" cy="12" r="9"></circle><circle class="drag-hover-progress" cx="12" cy="12" r="9"></circle></svg>'
  document.body.append(indicator)
  return indicator
}

function clearPlaylistHoverNavigation() {
  clearTimeout(state.dragHoverTimer)
  state.dragHoverTimer = 0
  state.dragHoverPlaylistId = ''
  const indicator = $('#dragHoverIndicator')
  indicator?.classList.remove('active')
}

function updatePlaylistHoverNavigation(playlist, event) {
  const indicator = dragHoverIndicator()
  indicator.style.left = `${event.clientX}px`
  indicator.style.top = `${event.clientY}px`
  const id = String(playlist?.id || '')
  const currentId = state.route === 'playlist'
    ? String(state.currentPlaylist?.id || state.routePayload?.id || state.routePayload || '')
    : ''
  if (!id || id === currentId || id === state.dragHoverNavigatedPlaylistId) {
    clearPlaylistHoverNavigation()
    return
  }
  if (state.dragHoverPlaylistId === id && state.dragHoverTimer) return
  clearPlaylistHoverNavigation()
  state.dragHoverPlaylistId = id
  indicator.classList.remove('active')
  void indicator.offsetWidth
  indicator.classList.add('active')
  state.dragHoverTimer = window.setTimeout(() => {
    if (!state.draggedTrack || state.dragCancelled || state.dragHoverPlaylistId !== id) return
    state.dragHoverNavigatedPlaylistId = id
    clearPlaylistHoverNavigation()
    navigate('playlist', { id })
  }, 1000)
}

function beginTrackDrag(track, source, event, options = {}) {
  if (!track) return
  clearTimeout(state.queueAutoCloseTimer)
  clearPlaylistHoverNavigation()
  state.draggedTrack = track
  state.dragCancelled = false
  state.dragSource = source
  state.draggedPageIndex = Number.isInteger(options.pageIndex) ? options.pageIndex : -1
  state.dragOriginPlaylistId = source === 'page' && state.route === 'playlist' && state.currentPlaylist
    ? String(state.currentPlaylist.id)
    : ''
  state.dragDropHandled = false
  state.queueWasOpenAtDragStart = dom.queueDrawer.classList.contains('open')
  state.queueAutoOpenedForDrag = false
  state.dragFeedbackType = ''
  state.dragFeedbackLabel = ''
  state.dragPointerX = event.clientX || 0
  state.dragPointerY = event.clientY || 0
  state.dragLastNearQueueAt = 0
  state.dragHoverNavigatedPlaylistId = ''
  event.dataTransfer.effectAllowed = source === 'queue' ? 'copyMove' : 'copyMove'
  event.dataTransfer.setData('application/x-menoradio-track', String(track.id))
  event.dataTransfer.setData('text/plain', track.name)
  event.dataTransfer.setDragImage(transparentDragImage(), 0, 0)
  showTrackDragHud(track)
  setTrackDragFeedback('move', source === 'queue' ? '调整播放顺序' : '拖到播放队列或歌单')
}

function clearDragMarkers() {
  setDragInsertionMarker(null)
  state.dragPlaylistTargetElement?.classList.remove('drop-target')
  state.dragPlaylistTargetElement = null
  $('#playlistTrackList', dom.page)?.classList.remove('playlist-drop-target')
}

function setDragPlaylistTarget(element) {
  if (state.dragPlaylistTargetElement === element) return
  state.dragPlaylistTargetElement?.classList.remove('drop-target')
  state.dragPlaylistTargetElement = element || null
  state.dragPlaylistTargetElement?.classList.add('drop-target')
}

function playlistDropTarget(element) {
  const target = element?.closest?.('[data-playlist-id], [data-playlist-drop-liked]')
  if (!target || target.closest('#trackMenu')) return null
  if (target.hasAttribute('data-playlist-drop-liked')) return likedPlaylistOf()
  if (!target.closest('#playlistNav')) return null
  return ownPlaylistById(target.dataset.playlistId)
}

function finishTrackDrag() {
  clearTimeout(state.queueAutoCloseTimer)
  clearPlaylistHoverNavigation()
  if (state.queueAutoOpenedForDrag && state.dragDropHandled !== 'queue') {
    toggleQueue(false, { source: 'drag', focusCurrent: false })
  }
  state.draggedTrack = null
  state.dragCancelled = false
  state.dragSource = ''
  state.draggedPageIndex = -1
  state.dragOriginPlaylistId = ''
  state.dragDropHandled = false
  state.queueWasOpenAtDragStart = false
  state.queueAutoOpenedForDrag = false
  state.dragFeedbackType = ''
  state.dragFeedbackLabel = ''
  state.dragPointerX = 0
  state.dragPointerY = 0
  state.dragLastNearQueueAt = 0
  state.dragHoverNavigatedPlaylistId = ''
  state.playlistDropIndex = -1
  state.queueDragIndex = -1
  state.queueDropIndex = -1
  clearDragMarkers()
  $$('.track-row.dragging', dom.page).forEach((row) => row.classList.remove('dragging'))
  $$('.queue-item.dragging').forEach((row) => row.classList.remove('dragging'))
  document.body.classList.remove('track-dragging')
  document.documentElement.classList.remove('drag-forbidden')
  const hud = $('#trackDragHud')
  hud?.classList.remove('forbidden')
  hud?.setAttribute('aria-hidden', 'true')
}

function cancelActiveTrackDrag(event) {
  if (!state.draggedTrack || state.dragCancelled) return false
  event?.preventDefault?.()
  event?.stopImmediatePropagation?.()
  state.dragCancelled = true
  state.dragDropHandled = 'cancelled'
  setTrackDragFeedback('forbidden', '已取消拖动')
  window.setTimeout(finishTrackDrag, 0)
  return true
}

function isNearQueueEdge(event, threshold = 132) {
  if (dom.immersive.classList.contains('open')) return false
  if (Number.isFinite(event?.clientX) && event.clientX >= window.innerWidth - threshold) return true
  const rightScreenEdge = Number(window.screenX || 0) + Number(window.outerWidth || window.innerWidth)
  return Number.isFinite(event?.screenX) && event.screenX >= rightScreenEdge - threshold
}

function handleTrackDragEnd(event) {
  if (!state.draggedTrack) return
  const recentlyAtQueueEdge = performance.now() - state.dragLastNearQueueAt < 260
  if (!state.dragCancelled && !state.dragDropHandled && state.dragSource !== 'queue'
      && (isNearQueueEdge(event, 150) || recentlyAtQueueEdge)) {
    state.dragDropHandled = 'queue'
    insertTrackIntoQueue(state.draggedTrack, state.queue.length)
  }
  finishTrackDrag()
}

function draggedScrollContainerAtPoint(x, y) {
  const target = document.elementFromPoint(x, y)
  const queueRect = dom.queueDrawer?.classList.contains('open') ? dom.queueDrawer.getBoundingClientRect() : null
  if (queueRect && x >= queueRect.left - 8 && x <= window.innerWidth + 8 && y >= queueRect.top && y <= queueRect.bottom) {
    return $('.queue-list', dom.queueDrawer)
  }
  const immersiveQueue = $('.immersive-queue-list', dom.immersive)
  const immersiveRect = immersiveQueue?.getBoundingClientRect()
  if (immersiveRect && x >= immersiveRect.left && x <= immersiveRect.right && y >= immersiveRect.top && y <= immersiveRect.bottom) {
    return immersiveQueue
  }
  if (!target) return null
  const direct = target.closest('.queue-list, .immersive-queue-list')
  if (direct) return direct
  if (target.closest('#playlistTrackList, #page')) return dom.page
  const pageRect = dom.page?.getBoundingClientRect()
  if (pageRect && x >= pageRect.left && x <= pageRect.right && y >= pageRect.top && y <= pageRect.bottom) return dom.page
  return null
}

function hideTrackMenu() {
  dom.trackMenu.classList.remove('open')
  dom.trackMenu.setAttribute('aria-hidden', 'true')
  state.menuTrack = null
  state.menuPlaylist = null
}

function positionTrackMenu(anchor, point = null) {
  const rect = anchor?.getBoundingClientRect?.()
  const menuWidth = 244
  const left = point
    ? Math.max(10, Math.min(window.innerWidth - menuWidth - 10, point.x))
    : Math.max(10, Math.min(window.innerWidth - menuWidth - 10, rect.right - menuWidth))
  dom.trackMenu.style.left = `${left}px`
  dom.trackMenu.style.top = '0px'
  const height = dom.trackMenu.offsetHeight
  const top = point
    ? (point.y + height + 10 > window.innerHeight ? point.y - height : point.y)
    : (rect.bottom + height + 10 > window.innerHeight ? rect.top - height - 6 : rect.bottom + 6)
  dom.trackMenu.style.top = `${Math.max(8, top)}px`
}

function showTrackMenu(anchor, track, point = null) {
  if (!track) return
  state.menuTrack = track
  state.menuPlaylist = null
  const trackArtists = artistsOfTrack(track)
  const trackAlbum = albumOfTrack(track)
  const playlistId = state.route === 'playlist' ? String(state.routePayload?.id || state.routePayload || '') : ''
  const ownPlaylists = state.userPlaylists.filter((playlist) => playlist.creatorId === String(state.profile?.userId || ''))
  const canRemove = state.loggedIn && ownPlaylists.some((playlist) => String(playlist.id) === playlistId)
  const playlistChoices = state.loggedIn
    ? ownPlaylists.filter((playlist) => String(playlist.id) !== playlistId).slice(0, 18)
    : []
  dom.trackMenu.innerHTML = `<div class="track-menu-title">${escapeHtml(track.name)}</div>
    <button data-track-menu-action="play">${icon('play')}<span>播放</span></button>
    <button data-track-menu-action="next">${icon('next')}<span>下一首播放</span></button>
    ${trackArtists.length === 1 ? `<button data-track-artist-id="${attr(trackArtists[0].id)}" data-track-artist-name="${attr(trackArtists[0].name)}">${icon('user')}<span>歌手：${escapeHtml(trackArtists[0].name)}</span></button>` : ''}
    ${trackArtists.length > 1 ? `<button data-track-menu-action="choose-artist">${icon('user')}<span>歌手</span><small>›</small></button>
      <div class="track-menu-playlists" data-menu-artists hidden>${trackArtists.map((artist) => `<button data-track-artist-id="${attr(artist.id)}" data-track-artist-name="${attr(artist.name)}"><span>${escapeHtml(artist.name)}</span></button>`).join('')}</div>` : ''}
    ${trackAlbum ? `<button data-track-album-id="${attr(trackAlbum.id)}" data-track-album-name="${attr(trackAlbum.name)}">${icon('album')}<span>专辑：${escapeHtml(trackAlbum.name)}</span></button>` : ''}
    ${playlistChoices.length ? `<button data-track-menu-action="choose-playlist">${icon('list')}<span>添加到歌单</span><small>›</small></button>
      <div class="track-menu-playlists" data-menu-playlists hidden>${playlistChoices.map((playlist) => `<button data-add-playlist-id="${attr(playlist.id)}"><span>${escapeHtml(playlist.name)}</span></button>`).join('')}</div>` : ''}
    ${canRemove ? `<div class="track-menu-separator"></div><button class="danger" data-track-menu-action="remove" data-current-playlist-id="${attr(playlistId)}"><span>从歌单中移除</span></button>` : ''}`
  dom.trackMenu.classList.add('open')
  dom.trackMenu.setAttribute('aria-hidden', 'false')
  positionTrackMenu(anchor, point)
}

function showPlaylistMenu(anchor, playlist, point = null) {
  if (!playlist || isLikedPlaylist(playlist)) return
  const owned = playlist.creatorId === String(state.profile?.userId || '')
  state.menuTrack = null
  state.menuPlaylist = playlist
  dom.trackMenu.innerHTML = `<div class="track-menu-title">${escapeHtml(playlist.name)}</div>
    ${owned ? `<button data-playlist-menu-action="edit">${icon('edit')}<span>编辑歌单信息</span></button>
      <div class="track-menu-separator"></div><button class="danger" data-playlist-menu-action="delete">${icon('trash')}<span>删除歌单</span></button>`
      : `<button class="danger" data-playlist-menu-action="unsubscribe">${icon('heart')}<span>取消收藏</span></button>`}`
  dom.trackMenu.classList.add('open')
  dom.trackMenu.setAttribute('aria-hidden', 'false')
  positionTrackMenu(anchor, point)
}

function queueTrackNext(track) {
  if (!state.current || !state.queue.length) {
    playTracks([track], 0, { keepSelectedFirst: true })
    return
  }
  if (!state.queueSource.some((item) => String(item.id) === String(track.id))) state.queueSource.push(track)
  const currentIndex = currentQueueIndex()
  const existingIndex = state.queue.findIndex((item, index) => String(item.id) === String(track.id) && index !== currentIndex)
  if (existingIndex >= 0) {
    state.queue.splice(existingIndex, 1)
    if (existingIndex < currentIndex) state.queueIndex -= 1
  }
  const anchor = Math.max(0, currentQueueIndex())
  state.queue.splice(Math.min(anchor + 1, state.queue.length), 0, track)
  state.queueIndex = anchor
  renderQueue()
  toast(`接下来播放：${track.name}`)
}

function setTrackLiked(trackId, liked) {
  const id = String(trackId)
  if (liked) state.liked.add(id)
  else state.liked.delete(id)
  updateNowPlaying()
}

function playlistAlreadyContainsTrack(playlistId, trackId) {
  const id = String(playlistId || '')
  const songId = String(trackId || '')
  const likedPlaylist = likedPlaylistOf()
  if (likedPlaylist && String(likedPlaylist.id) === id && state.liked.has(songId)) return true
  if (state.route === 'playlist' && String(state.currentPlaylist?.id || state.routePayload?.id || state.routePayload || '') === id) {
    return state.playlistTracks.some((item) => String(item.id) === songId)
  }
  return false
}

async function modifyPlaylist(op, playlistId, track, options = {}) {
  if (!state.loggedIn || !playlistId || !track) return false
  if (op === 'add' && playlistAlreadyContainsTrack(playlistId, track.id)) {
    toast('歌单中已有这首歌')
    return false
  }
  try {
    const body = unwrap(await bridge.data.playlistTrack(op, playlistId, track.id))
    if (body?.code && Number(body.code) !== 200) throw new Error(body.message || '歌单操作失败')
    const likedPlaylist = likedPlaylistOf()
    if (likedPlaylist && String(likedPlaylist.id) === String(playlistId)) setTrackLiked(track.id, op === 'add')
    if (state.route === 'playlist' && String(state.routePayload?.id || state.routePayload) === String(playlistId)) {
      if (op === 'del') state.playlistTracks = state.playlistTracks.filter((item) => String(item.id) !== String(track.id))
      else if (!state.playlistTracks.some((item) => String(item.id) === String(track.id))) state.playlistTracks.push(track)
      refreshCurrentPlaylistTrackList()
    }
    if (!options.quiet) toast(op === 'add' ? `已添加到歌单：${track.name}` : `已从歌单移除：${track.name}`)
    return true
  } catch (error) {
    if (op === 'add' && /已存在|重复|already|exist/i.test(String(error?.message || ''))) {
      toast('歌单中已有这首歌')
      return false
    }
    if (!options.quiet) toast(error.message || '歌单操作失败', '操作失败', 'error')
    else throw error
    return false
  }
}

function applyPlaylistSubscriptionLocally(playlist, subscribed) {
  if (!playlist) return
  const id = String(playlist.id)
  playlist.subscribed = subscribed
  if (playlist.raw) playlist.raw.subscribed = subscribed
  if (state.currentPlaylist && String(state.currentPlaylist.id) === id) {
    state.currentPlaylist.subscribed = subscribed
    if (state.currentPlaylist.raw) state.currentPlaylist.raw.subscribed = subscribed
  }
  if (subscribed) {
    if (!state.userPlaylists.some((entry) => String(entry.id) === id)) state.userPlaylists.push(playlist)
  } else {
    state.userPlaylists = state.userPlaylists.filter((entry) => String(entry.id) !== id)
  }
  renderPlaylistNav(state.userPlaylists)
}

function updatePlaylistSubscriptionButtons(id, subscribed, pending = false) {
  $$('[data-playlist-subscribe]').forEach((button) => {
    const routeId = String(state.routePayload?.id || state.routePayload || '')
    if (routeId !== String(id)) return
    button.disabled = pending
    button.dataset.playlistSubscribed = String(subscribed)
    button.classList.toggle('active', subscribed)
    button.innerHTML = `${icon('heart')} ${pending ? '正在同步…' : subscribed ? '已收藏' : '收藏歌单'}`
  })
}

async function changePlaylistSubscription(playlist, subscribed) {
  if (!state.loggedIn) {
    showLogin()
    return false
  }
  const id = String(playlist?.id || '')
  if (!id || state.playlistSubscriptionPending.has(id)) return false
  if (Date.now() < Number(state.playlistSubscriptionCooldown.get(id) || 0)) return false
  const previous = Boolean(playlist.subscribed || state.userPlaylists.some((entry) => String(entry.id) === id && entry.creatorId !== String(state.profile?.userId || '')))
  state.playlistSubscriptionPending.add(id)
  updatePlaylistSubscriptionButtons(id, previous, true)
  try {
    const body = unwrap(await bridge.data.playlistSubscribe(id, subscribed))
    if (body?.code && Number(body.code) !== 200) throw new Error(body.message || '歌单收藏失败')
    applyPlaylistSubscriptionLocally(playlist, subscribed)
    updatePlaylistSubscriptionButtons(id, subscribed, true)
    state.playlistSubscriptionCooldown.set(id, Date.now() + 2200)
    toast(subscribed ? '已收藏歌单' : '已取消收藏歌单')
    window.setTimeout(async () => {
      if (Date.now() < Number(state.playlistSubscriptionCooldown.get(id) || 0)) return
      state.playlistSubscriptionCooldown.delete(id)
      updatePlaylistSubscriptionButtons(id, subscribed, false)
      if (state.profile?.userId) await loadUserPlaylists(state.profile.userId)
    }, 2250)
    return true
  } catch (error) {
    updatePlaylistSubscriptionButtons(id, previous, false)
    toast(error.message || '歌单收藏失败', '操作失败', 'error')
    return false
  } finally {
    state.playlistSubscriptionPending.delete(id)
  }
}

async function togglePlaylistSubscription(button) {
  const id = String(state.routePayload?.id || state.routePayload || '')
  const playlist = state.currentPlaylist || state.userPlaylists.find((entry) => String(entry.id) === id)
  if (!playlist || button.disabled) return
  return changePlaylistSubscription(playlist, button.dataset.playlistSubscribed !== 'true')
}

function scheduleImmersiveLyricLayoutSettle(delay = 0) {
  clearTimeout(state.immersiveLayoutSettleTimer)
  const generation = ++state.immersiveLayoutGeneration
  const settle = () => {
    if (generation !== state.immersiveLayoutGeneration) return
    const lyricScrollRunning = $$('.lyric-line', dom.lyricsScroller).some((line) => line.getAnimations().some((animation) => (
      animation.id?.startsWith('lyric-scroll-')
      && (animation.playState === 'running' || animation.playState === 'pending')
    )))
    // A delayed layout correction must not cut across a natural lyric move.
    // Let the existing convoy animation finish, then reuse the same animated
    // scroll path as seeking. Resize/full-screen alignment must not touch lyric
    // emphasis or explicit-break timing.
    if (lyricScrollRunning) {
      state.immersiveLayoutSettleTimer = window.setTimeout(settle, 80)
      return
    }
    state.immersiveLayoutSettleTimer = 0
    updateLyricScrollFocus(state.focusLyric, state.activeLyric, state.activeLyric, false, true)
  }
  state.immersiveLayoutSettleTimer = window.setTimeout(settle, Math.max(0, delay))
}

function applyImmersiveLayout(immediate = false) {
  const content = $('.immersive-content', dom.immersive)
  if (!content) return
  const width = window.innerWidth
  const height = window.innerHeight
  const clamp = (minimum, value, maximum) => Math.max(minimum, Math.min(maximum, value))
  const cover = Math.round(clamp(288, Math.min((height - 100) * .48, width * .32), 700))
  const gap = Math.round(clamp(26, width * .0195, 50))
  const padding = Math.round(clamp(38, width * .035, 90))
  const available = width - padding * 2 - cover - gap
  const compactLyricsInset = width < 1280 ? clamp(0, (1280 - width) * .30, 96) : 0
  const compactLyricsBonus = width < 1280 ? clamp(0, (1280 - width) * .36, 100) : 0
  const responsiveLyricsWidth = width * .40 + compactLyricsBonus
  const lyricsWidth = Math.round(clamp(390, Math.min(available - compactLyricsInset, responsiveLyricsWidth), 1020))
  const panelTail = Math.round(clamp(226, height * .27 - 35, 330))
  const panelHeight = Math.min(cover + panelTail, Math.max(0, height - 110))
  const autoLyricFontSize = adaptiveLyricFontSize(lyricsWidth, panelHeight)
  const focusRatio = clamp(.17, .17 + Math.max(0, height - 680) / 920 * .06, .23)
  const compactShift = width < 1200 ? Math.round(clamp(0, (1200 - width) * .08, 18)) : 0
  state.lyricFocusRatio = focusRatio
  if (immediate) content.classList.add('layout-instant')
  content.style.setProperty('--cover-size', `${cover}px`)
  content.style.setProperty('--lyrics-width', `${lyricsWidth}px`)
  content.style.setProperty('--content-gap', `${gap}px`)
  content.style.setProperty('--content-pad', `${padding}px`)
  content.style.setProperty('--panel-tail', `${panelTail}px`)
  content.style.setProperty('--lyric-focus-space', `${Math.round(panelHeight * focusRatio)}px`)
  content.style.setProperty('--lyric-bottom-space', `${Math.round(panelHeight * .64)}px`)
  content.style.setProperty('--content-shift', `${compactShift}px`)
  content.style.setProperty('--content-height', `${Math.max(0, height - 74)}px`)
  dom.immersive.style.setProperty('--auto-lyric-font-size', `${autoLyricFontSize}px`)
  if (immediate) requestAnimationFrame(() => content.classList.remove('layout-instant'))
  scheduleImmersiveLyricLayoutSettle(immediate ? 80 : 540)
}

function showImmersiveChrome() {
  clearTimeout(state.immersiveChromeTimer)
  dom.immersive.classList.remove('chrome-hidden')
  if (!dom.immersive.classList.contains('open')) return
  state.immersiveChromeTimer = window.setTimeout(() => dom.immersive.classList.add('chrome-hidden'), 2400)
}

function setImmersiveView(view = 'lyrics') {
  const nextView = view === 'queue' ? 'queue' : 'lyrics'
  if (state.immersiveView === nextView && !dom.immersive.classList.contains('view-switching')) return
  const previousView = state.immersiveView
  const generation = ++state.immersiveViewGeneration
  state.immersiveView = nextView
  clearTimeout(state.immersiveViewTimer)
  clearTimeout(state.immersiveViewPhaseTimer)
  dom.immersive.classList.remove('queue-leaving', 'lyrics-leaving')
  dom.immersive.classList.add('view-switching', previousView === 'queue' ? 'queue-leaving' : 'lyrics-leaving')
  state.immersiveViewPhaseTimer = window.setTimeout(() => {
    if (generation !== state.immersiveViewGeneration) return
    dom.immersive.classList.toggle('queue-view', nextView === 'queue')
    dom.immersive.classList.remove('queue-leaving', 'lyrics-leaving')
  }, 180)
  state.immersiveViewTimer = window.setTimeout(() => {
    if (generation !== state.immersiveViewGeneration) return
    dom.immersive.classList.remove('view-switching', 'queue-leaving', 'lyrics-leaving')
    if (nextView !== 'queue') releaseClosedQueueDom()
  }, 420)
  const queueOpen = nextView === 'queue'
  dom.immersiveQueuePanel.setAttribute('aria-hidden', String(!queueOpen))
  $('#immersiveLyricsView').classList.toggle('active', !queueOpen)
  $('#immersiveQueueView').classList.toggle('active', queueOpen)
  if (queueOpen) renderQueue({ focusCurrent: true })
}

async function setImmersiveFullScreen(value) {
  const active = await bridge.window.setFullScreen(Boolean(value))
  state.fullScreen = Boolean(active)
  dom.immersive.classList.toggle('fullscreen', state.fullScreen)
  const button = $('#immersiveFullScreen')
  button.classList.toggle('active', state.fullScreen)
  button.setAttribute('aria-label', state.fullScreen ? '退出全屏' : '全屏')
  button.title = state.fullScreen ? '退出全屏' : '全屏'
  updateMaximizeButton($('#immersiveMaximize'), state.maximized, state.fullScreen)
  return state.fullScreen
}

function openImmersive(open = true) {
  if (open && !state.current) return
  clearTimeout(state.immersiveAppSuspendTimer)
  // Keep the page visible under the slide transition. Once the player covers
  // it, skip the underlying (possibly hundreds of rows) layout tree so native
  // window resizing only needs to lay out the immersive player.
  if (!open) document.body.classList.remove('immersive-app-suspended')
  if (open) applyImmersiveLayout(true)
  dom.immersive.classList.toggle('open', open)
  dom.immersive.setAttribute('aria-hidden', String(!open))
  syncFloatingLyrics(true)
  if (open) {
    const generation = state.audioLoadGeneration
    if (state.coverReadyGeneration !== generation) updateNowPlaying()
    if (!state.lyricsLoading && state.lyricsReadyGeneration !== generation) void fetchLyrics(state.current, generation)
    syncLyricWords()
    showImmersiveChrome()
    state.immersiveAppSuspendTimer = window.setTimeout(() => {
      if (dom.immersive.classList.contains('open')) document.body.classList.add('immersive-app-suspended')
    }, 660)
  }
  else {
    clearTimeout(state.immersiveLayoutSettleTimer)
    state.immersiveLayoutSettleTimer = 0
    state.immersiveLayoutGeneration += 1
    if (state.fullScreen) setImmersiveFullScreen(false)
    setImmersiveView('lyrics')
    clearTimeout(state.immersiveChromeTimer)
    dom.immersive.classList.remove('chrome-hidden')
    $('#fontSizeMenu').classList.remove('open')
    $('#fontSizeMenu').setAttribute('aria-hidden', 'true')
    setImmersiveVolumePopover(false)
  }
}

function toggleQueue(open = !dom.queueDrawer.classList.contains('open'), options = {}) {
  clearTimeout(state.queuePointerCloseTimer)
  state.queuePointerCloseTimer = 0
  if (!open) state.queueAutoOpenedByPointer = false
  else if (options.source === 'pointer') state.queueAutoOpenedByPointer = true
  else if (options.source && options.source !== 'drag') state.queueAutoOpenedByPointer = false
  dom.queueDrawer.classList.toggle('open', open)
  dom.queueDrawer.setAttribute('aria-hidden', String(!open))
  if (open) renderQueue({ focusCurrent: options.focusCurrent !== false })
  else releaseClosedQueueDom(260)
}

function updateProfileUi() {
  $('#profileName').textContent = state.loggedIn ? state.profile?.nickname || '网易云用户' : '登录网易云音乐'
  $('#profileHint').textContent = state.loggedIn ? '' : '登录'
  const avatar = $('#profileAvatar')
  if (state.loggedIn && state.profile?.avatarUrl) {
    const label = state.profile?.nickname || '网易云用户'
    avatar.innerHTML = `<img src="${attr(String(state.profile.avatarUrl).replace(/^http:/, 'https:'))}" alt="${attr(label)}">`
  } else {
    avatar.innerHTML = icon('user')
  }
  const profileButton = $('#profileButton')
  profileButton.classList.add('interactive')
  profileButton.setAttribute('aria-disabled', 'false')
  profileButton.title = state.loggedIn ? '打开我的主页' : '登录网易云音乐'
}

async function loadAccount() {
  try {
    const auth = unwrap(await bridge.auth.state())
    state.loggedIn = Boolean(auth.loggedIn)
    state.profile = auth.profile || null
    updateProfileUi()
    let synchronized = true
    if (state.loggedIn && state.profile?.userId) {
      const results = await Promise.all([
        loadUserPlaylists(state.profile.userId),
        loadLikedSongs(state.profile.userId),
      ])
      synchronized = results.every(Boolean)
    } else renderPlaylistNav([])
    clearTimeout(state.accountRetryTimer)
    if (!synchronized && navigator.onLine) state.accountRetryTimer = window.setTimeout(() => loadAccount(), 4200)
  } catch {
    updateProfileUi()
    clearTimeout(state.accountRetryTimer)
    if (navigator.onLine) state.accountRetryTimer = window.setTimeout(() => loadAccount(), 4200)
  }
}

async function loadLikedSongs(uid) {
  try {
    const body = unwrap(await bridge.data.likeList(uid))
    if (body?.code && Number(body.code) !== 200) throw new Error(body.message || '收藏列表同步失败')
    state.liked = new Set((body.ids || []).map(String))
    updateLikeButtonsOnly()
    return true
  } catch {}
  updateLikeButtonsOnly()
  return false
}

async function loadUserPlaylists(uid) {
  try {
    const body = unwrap(await bridge.data.userPlaylists(uid))
    if (body?.code && Number(body.code) !== 200) throw new Error(body.message || '歌单同步失败')
    state.userPlaylists = (body.playlist || []).map(normalizePlaylist)
    renderPlaylistNav(state.userPlaylists)
    return true
  } catch {
    if (!state.userPlaylists.length) renderPlaylistNav([])
    return false
  }
}

function renderPlaylistNav(playlists) {
  if (!state.loggedIn) {
    dom.playlistNav.innerHTML = '<div class="nav-heading-row"><p class="nav-heading">我的歌单</p></div><button class="nav-item" data-login><svg><use href="#i-list"></use></svg><span>登录后同步歌单</span></button>'
    return
  }
  const uid = String(state.profile?.userId || '')
  const created = playlists.filter((playlist) => playlist.creatorId === uid)
  const likedPlaylist = likedPlaylistOf(playlists)
  const own = created.filter((playlist) => playlist !== likedPlaylist)
  const collected = playlists.filter((playlist) => playlist.creatorId !== uid)
  const items = (entries, emptyText) => entries.length
    ? entries.map((playlist) => `<div class="playlist-nav-item"><button class="nav-item" data-playlist-id="${attr(playlist.id)}" data-playlist-owned="${playlist.creatorId === uid}" title="${attr(playlist.name)}">${icon('list')}<span>${escapeHtml(playlist.name)}</span></button><button type="button" class="playlist-nav-more" data-playlist-menu-id="${attr(playlist.id)}" aria-label="管理 ${attr(playlist.name)}" title="更多">${icon('more')}</button></div>`).join('')
    : `<div class="playlist-nav-empty">${escapeHtml(emptyText)}</div>`
  dom.playlistNav.innerHTML = `<section class="playlist-nav-section" aria-label="创建的歌单">
      <div class="nav-heading-row"><p class="nav-heading">创建的歌单 ${own.length}</p><button type="button" class="tiny-button" data-create-playlist aria-label="创建歌单" title="创建歌单">${icon('plus')}</button></div>
      ${items(own, '还没有创建歌单')}
    </section>
    <section class="playlist-nav-section" aria-label="收藏的歌单">
      <div class="nav-heading-row"><p class="nav-heading">收藏的歌单 ${collected.length}</p></div>
      ${items(collected, '还没有收藏歌单')}
    </section>`
}

function closeModal() {
  cancelApplicationResetHold()
  state.loginGeneration += 1
  dom.modalLayer.classList.remove('open')
  dom.modalLayer.setAttribute('aria-hidden', 'true')
  setTimeout(() => { if (!dom.modalLayer.classList.contains('open')) dom.modalLayer.innerHTML = '' }, 220)
  if (pendingAutomaticRelease) window.setTimeout(flushPendingAutomaticUpdate, 240)
}

function showUpdateModal(release, { automatic = false } = {}) {
  if (!release?.tag || !release?.updateAvailable) return
  if (dom.modalLayer.classList.contains('open')) {
    if (automatic) pendingAutomaticRelease = release
    return
  }
  pendingAutomaticRelease = null
  try { localStorage.setItem(updateNotificationStorageKey, release.tag) } catch {}
  const releaseBody = String(release.body || '').trim()
  dom.modalLayer.innerHTML = `<div class="modal update-modal" role="dialog" aria-modal="true" aria-labelledby="updateModalTitle">
    <div class="modal-header"><div><h2 id="updateModalTitle">发现新版本</h2><p class="update-version">MenoRadio ${escapeHtml(release.tag)}</p></div><button type="button" class="icon-button" data-close-modal aria-label="关闭">${icon('close')}</button></div>
    ${releaseBody ? `<article class="release-markdown markdown-document">${renderSafeMarkdown(releaseBody)}</article>` : ''}
    <p class="update-once-note">此更新提醒仅显示一次，不会再次弹窗。</p>
    <div class="modal-actions"><button type="button" class="primary-button" data-update-release>前往github获取新版本</button><button type="button" class="secondary-button" data-close-modal>关闭</button></div>
  </div>`
  dom.modalLayer.classList.add('open')
  dom.modalLayer.setAttribute('aria-hidden', 'false')
  $$('[data-close-modal]', dom.modalLayer).forEach((button) => button.addEventListener('click', closeModal))
  $('[data-update-release]', dom.modalLayer)?.addEventListener('click', () => {
    bridge.app.openExternal(release.url || 'https://github.com/ichiris/MenoRadio/releases')
    closeModal()
  })
  $$('[data-external]', dom.modalLayer).forEach((button) => button.addEventListener('click', () => bridge.app.openExternal(button.dataset.external)))
}

function flushPendingAutomaticUpdate() {
  const release = pendingAutomaticRelease
  if (!release) return
  if (dom.modalLayer.classList.contains('open')) return
  pendingAutomaticRelease = null
  let notifiedTag = ''
  try { notifiedTag = localStorage.getItem(updateNotificationStorageKey) || '' } catch {}
  if (notifiedTag === release.tag) return
  showUpdateModal(release, { automatic: true })
}

async function checkForUpdates({ automatic = false, button = null } = {}) {
  const original = button?.innerHTML || ''
  if (button) {
    button.disabled = true
    button.textContent = '检查中…'
  }
  try {
    if (!updateCheckPromise) {
      updateCheckPromise = bridge.app.checkUpdate().finally(() => { updateCheckPromise = null })
    }
    const release = await updateCheckPromise
    if (!release?.updateAvailable) {
      if (!automatic) toast('已是最新版本')
      return
    }
    let notifiedTag = ''
    try { notifiedTag = localStorage.getItem(updateNotificationStorageKey) || '' } catch {}
    if (automatic && notifiedTag === release.tag) return
    showUpdateModal(release, { automatic })
  } catch {
    if (!automatic) toast('检查更新失败')
  } finally {
    if (button?.isConnected) {
      button.disabled = false
      button.innerHTML = original
    }
  }
}

function showCreatePlaylist() {
  if (!state.loggedIn) return showLogin()
  dom.modalLayer.innerHTML = `<div class="modal create-playlist-modal" role="dialog" aria-modal="true" aria-labelledby="createPlaylistTitle">
    <div class="modal-header"><h2 id="createPlaylistTitle">创建歌单</h2><button class="icon-button" data-close-modal>${icon('close')}</button></div>
    <form class="login-form" data-create-playlist-form>
      <label class="login-field"><span>歌单名称</span><input name="name" type="text" maxlength="40" autocomplete="off" required></label>
      <div class="modal-actions"><button class="secondary-button" type="button" data-close-modal>取消</button><button class="primary-button" type="submit">创建</button></div>
    </form>
  </div>`
  dom.modalLayer.classList.add('open')
  dom.modalLayer.setAttribute('aria-hidden', 'false')
  $$('[data-close-modal]', dom.modalLayer).forEach((button) => button.addEventListener('click', closeModal))
  const form = $('[data-create-playlist-form]', dom.modalLayer)
  const input = $('input[name="name"]', form)
  setTimeout(() => input?.focus(), 0)
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const name = String(new FormData(form).get('name') || '').trim()
    if (!name) return input?.focus()
    const button = $('button[type="submit"]', form)
    button.disabled = true
    button.textContent = '正在创建…'
    try {
      const body = unwrap(await bridge.data.playlistCreate(name))
      if (body?.code && Number(body.code) !== 200) throw new Error(body.message || '歌单创建失败')
      closeModal()
      await loadUserPlaylists(state.profile?.userId)
      toast(`已创建歌单“${name}”`)
      const id = body?.id || body?.playlist?.id
      if (id) navigate('playlist', { id: String(id) })
    } catch (error) {
      button.disabled = false
      button.textContent = '创建'
      toast(error.message || '歌单创建失败', '操作失败', 'error')
    }
  })
}

function showEditPlaylist(playlist) {
  if (!playlist || playlist.creatorId !== String(state.profile?.userId || '') || isLikedPlaylist(playlist)) return
  dom.modalLayer.innerHTML = `<div class="modal create-playlist-modal" role="dialog" aria-modal="true" aria-labelledby="editPlaylistTitle">
    <div class="modal-header"><div><h2 id="editPlaylistTitle">编辑歌单信息</h2><p>${escapeHtml(playlist.name)}</p></div><button class="icon-button" data-close-modal>${icon('close')}</button></div>
    <form class="login-form" data-edit-playlist-form>
      <label class="login-field"><span>名称</span><input name="name" type="text" maxlength="40" value="${attr(playlist.name)}" autocomplete="off" required></label>
      <label class="login-field"><span>简介</span><textarea class="playlist-description-input" name="description" maxlength="1000" placeholder="介绍一下这个歌单">${escapeHtml(playlist.description)}</textarea></label>
      <div class="modal-actions"><button class="secondary-button" type="button" data-close-modal>取消</button><button class="primary-button" type="submit">保存</button></div>
    </form>
  </div>`
  dom.modalLayer.classList.add('open')
  dom.modalLayer.setAttribute('aria-hidden', 'false')
  $$('[data-close-modal]', dom.modalLayer).forEach((button) => button.addEventListener('click', closeModal))
  const form = $('[data-edit-playlist-form]', dom.modalLayer)
  const nameInput = $('input[name="name"]', form)
  setTimeout(() => { nameInput?.focus(); nameInput?.select() }, 0)
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(form)
    const name = String(data.get('name') || '').trim()
    const description = String(data.get('description') || '').trim()
    if (!name) return nameInput?.focus()
    const button = $('button[type="submit"]', form)
    button.disabled = true
    button.textContent = '正在保存…'
    try {
      const body = unwrap(await bridge.data.playlistUpdate(playlist.id, name, description, playlist.tags))
      if (body?.code && Number(body.code) !== 200) throw new Error(body.message || '歌单信息保存失败')
      closeModal()
      await loadUserPlaylists(state.profile?.userId)
      toast('歌单信息已保存')
      if (state.route === 'playlist' && String(state.routePayload?.id || state.routePayload) === String(playlist.id)) {
        await renderPlaylist(state.routePayload)
      }
    } catch (error) {
      button.disabled = false
      button.textContent = '保存'
      toast(error.message || '歌单信息保存失败', '操作失败', 'error')
    }
  })
}

function showDeletePlaylist(playlist) {
  if (!playlist || playlist.creatorId !== String(state.profile?.userId || '') || isLikedPlaylist(playlist)) return
  dom.modalLayer.innerHTML = `<div class="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="deletePlaylistTitle">
    <div class="modal-header"><div><h2 id="deletePlaylistTitle">删除歌单？</h2><p>“${escapeHtml(playlist.name)}”将从网易云音乐中删除，此操作无法撤销。</p></div><button class="icon-button" data-close-modal>${icon('close')}</button></div>
    <div class="modal-actions"><button class="secondary-button" type="button" data-close-modal>取消</button><button class="danger-button" type="button" data-confirm-delete-playlist>删除</button></div>
  </div>`
  dom.modalLayer.classList.add('open')
  dom.modalLayer.setAttribute('aria-hidden', 'false')
  $$('[data-close-modal]', dom.modalLayer).forEach((button) => button.addEventListener('click', closeModal))
  $('[data-confirm-delete-playlist]', dom.modalLayer).addEventListener('click', async (event) => {
    const button = event.currentTarget
    button.disabled = true
    button.textContent = '正在删除…'
    try {
      const body = unwrap(await bridge.data.playlistDelete(playlist.id))
      if (body?.code && Number(body.code) !== 200) throw new Error(body.message || '歌单删除失败')
      const viewingDeleted = state.route === 'playlist' && String(state.routePayload?.id || state.routePayload) === String(playlist.id)
      closeModal()
      await loadUserPlaylists(state.profile?.userId)
      toast(`已删除歌单“${playlist.name}”`)
      if (viewingDeleted) navigate('home')
    } catch (error) {
      button.disabled = false
      button.textContent = '删除'
      toast(error.message || '歌单删除失败', '操作失败', 'error')
    }
  })
}

async function unsubscribePlaylist(playlist) {
  if (!playlist || playlist.creatorId === String(state.profile?.userId || '')) return
  return changePlaylistSubscription(playlist, false)
}

function showLogin() {
  const generation = ++state.loginGeneration
  dom.modalLayer.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="loginTitle">
    <div class="modal-header"><h2 id="loginTitle">登录网易云音乐</h2><button class="icon-button" data-close-modal>${icon('close')}</button></div>
    <div class="login-tabs"><button class="active" data-login-tab="qr">扫码</button><button data-login-tab="account">账号</button><button data-login-tab="cookie">Cookie</button></div>
    <div class="login-panel" data-login-panel="qr"><div class="qr-wrap"><span class="qr-loading">正在获取二维码…</span></div><div class="qr-status"><strong>请稍候</strong><span>正在连接网易云音乐</span></div></div>
    <div class="login-panel" data-login-panel="account" hidden><form class="login-form" data-password-form><label class="login-field"><span>手机号或邮箱</span><input name="account" type="text" autocomplete="username" spellcheck="false" required></label><label class="login-field"><span>密码</span><input name="password" type="password" autocomplete="current-password" required></label><p class="password-note">密码仅用于本次登录，不会保存。若遇到网易云验证，请改用扫码。</p><div class="modal-actions"><button class="primary-button" type="submit">登录</button></div></form></div>
    <div class="login-panel" data-login-panel="cookie" hidden><p class="cookie-help">粘贴已登录网页的 Cookie，至少包含 <strong>MUSIC_U</strong>。</p><textarea class="cookie-input" placeholder="MUSIC_U=...; NMTID=..."></textarea><div class="modal-actions"><button class="secondary-button" data-cookie-help>获取方法 ${icon('external')}</button><button class="primary-button" data-import-cookie>登录</button></div></div>
  </div>`
  dom.modalLayer.classList.add('open')
  dom.modalLayer.setAttribute('aria-hidden', 'false')
  bindLoginModal(generation)
  beginQrLogin(generation)
}

function bindLoginModal(generation) {
  $('[data-close-modal]', dom.modalLayer).addEventListener('click', closeModal)
  $$('[data-login-tab]', dom.modalLayer).forEach((tab) => tab.addEventListener('click', () => {
    $$('[data-login-tab]', dom.modalLayer).forEach((button) => button.classList.toggle('active', button === tab))
    $$('[data-login-panel]', dom.modalLayer).forEach((panel) => panel.hidden = panel.dataset.loginPanel !== tab.dataset.loginTab)
  }))
  $('[data-cookie-help]', dom.modalLayer).addEventListener('click', () => bridge.app.openExternal('https://github.com/GH4NG/LyricEaseLoginHelper#获取-cookie-信息'))
  $('[data-password-form]', dom.modalLayer).addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.currentTarget
    const account = String(new FormData(form).get('account') || '').trim()
    const password = String(new FormData(form).get('password') || '')
    const button = $('button[type="submit"]', form)
    if (!account || !password) return
    button.disabled = true
    button.textContent = '正在登录…'
    try {
      const auth = unwrap(await bridge.auth.loginPassword(account, password))
      state.loggedIn = true
      state.profile = auth.profile
      closeModal()
      await afterLogin()
      toast(`欢迎回来，${state.profile?.nickname || '网易云用户'}`, '登录成功')
    } catch (error) {
      toast(error.message, '账号登录失败', 'error')
      button.disabled = false
      button.textContent = '登录'
    }
  })
  $('[data-import-cookie]', dom.modalLayer).addEventListener('click', async (event) => {
    const button = event.currentTarget
    const value = $('.cookie-input', dom.modalLayer).value
    if (!value.trim()) return toast('请先粘贴 Cookie', '', 'error')
    button.disabled = true
    button.textContent = '正在验证…'
    try {
      const auth = unwrap(await bridge.auth.importCookie(value))
      state.loggedIn = true
      state.profile = auth.profile
      closeModal()
      await afterLogin()
      toast(`欢迎回来，${state.profile?.nickname || '网易云用户'}`, '登录成功')
    } catch (error) {
      toast(error.message, 'Cookie 登录失败', 'error')
      button.disabled = false
      button.textContent = '登录'
    }
  })
}

async function beginQrLogin(generation) {
  const wrap = $('.qr-wrap', dom.modalLayer)
  const status = $('.qr-status', dom.modalLayer)
  try {
    const qr = unwrap(await bridge.auth.createQr())
    if (generation !== state.loginGeneration) return
    wrap.innerHTML = `<img src="${attr(qr.dataUrl)}" alt="网易云音乐登录二维码">`
    status.innerHTML = '<strong>打开网易云音乐 App 扫码</strong><span>在手机上确认登录</span>'
    pollQr(qr.key, generation)
  } catch (error) {
    if (generation !== state.loginGeneration) return
    wrap.innerHTML = `<span class="qr-loading">二维码加载失败</span>`
    status.innerHTML = `<strong>暂时无法扫码</strong><span>${escapeHtml(error.message)}</span>`
  }
}

async function pollQr(key, generation) {
  if (generation !== state.loginGeneration) return
  try {
    const result = unwrap(await bridge.auth.checkQr(key))
    if (generation !== state.loginGeneration) return
    const status = $('.qr-status', dom.modalLayer)
    if (!status) return
    if (result.code === 802) {
      status.innerHTML = '<strong>已扫码</strong><span>请在手机上轻点“授权登录”</span>'
    } else if (result.code === 803 || result.loggedIn) {
      status.innerHTML = '<strong>登录成功</strong><span>正在同步你的音乐</span>'
      closeModal()
      await loadAccount()
      await afterLogin()
      toast(`欢迎回来，${state.profile?.nickname || '网易云用户'}`, '登录成功')
      return
    } else if (result.code === 800) {
      $('.qr-wrap', dom.modalLayer)?.classList.add('expired')
      $('.qr-wrap', dom.modalLayer)?.addEventListener('click', () => {
        const nextGeneration = ++state.loginGeneration
        $('.qr-wrap', dom.modalLayer).classList.remove('expired')
        $('.qr-wrap', dom.modalLayer).innerHTML = '<span class="qr-loading">正在刷新…</span>'
        beginQrLogin(nextGeneration)
      }, { once: true })
      return
    }
  } catch {}
  setTimeout(() => pollQr(key, generation), 2200)
}

async function afterLogin() {
  updateProfileUi()
  if (state.profile?.userId) await Promise.all([
    loadUserPlaylists(state.profile.userId),
    loadLikedSongs(state.profile.userId),
  ])
  state.home = null
  if (['home', 'liked', 'daily', 'settings'].includes(state.route)) renderRoute()
}

async function logout() {
  await bridge.auth.logout()
  state.loggedIn = false
  state.profile = null
  state.userPlaylists = []
  state.liked = new Set()
  state.home = null
  updateProfileUi()
  renderPlaylistNav([])
  toast('已从本机移除登录会话')
  navigate('home')
}

function updateMaximizeButton(button, maximized, fullScreen = false) {
  if (!button) return
  const iconName = fullScreen ? 'fullscreen-exit' : maximized ? 'restore' : 'window'
  const label = fullScreen ? '退出全屏' : maximized ? '还原' : '最大化'
  button.classList.toggle('restored', maximized && !fullScreen)
  button.classList.toggle('fullscreen-exit', fullScreen)
  button.innerHTML = icon(iconName)
  button.setAttribute('aria-label', label)
  button.title = label
}

function normalizedPageZoom(value) {
  const factor = Number(value)
  if (!Number.isFinite(factor)) return 1
  return Math.max(.5, Math.min(2, factor))
}

function hideZoomControls(delay = 0) {
  clearTimeout(zoomControlsHideTimer)
  zoomControlsHideTimer = window.setTimeout(() => {
    if (dom.zoomControls.matches(':hover, :focus-within')) return
    dom.zoomControls.classList.remove('open')
    dom.zoomControls.setAttribute('aria-hidden', 'true')
  }, Math.max(0, delay))
}

function showZoomControls() {
  clearTimeout(zoomControlsHideTimer)
  dom.zoomControls.classList.add('open')
  dom.zoomControls.setAttribute('aria-hidden', 'false')
  hideZoomControls(3200)
}

function updateZoomControls(value, { show = true, persist = true } = {}) {
  const factor = normalizedPageZoom(value)
  const inverse = 1 / factor
  dom.zoomValue.textContent = `${Math.round(factor * 100)}%`
  dom.zoomControls.style.setProperty('--zoom-overlay-inverse', String(inverse))
  dom.zoomControls.style.setProperty('--zoom-overlay-right', `${12 * inverse}px`)
  dom.zoomControls.style.setProperty('--zoom-overlay-top', `${48 * inverse}px`)
  if (persist) localStorage.setItem(zoomStorageKey, String(factor))
  if (show) showZoomControls()
  return factor
}

async function restorePageZoom() {
  const saved = normalizedPageZoom(localStorage.getItem(zoomStorageKey) || 1)
  restoringPageZoom = true
  try {
    const applied = await bridge.window.setZoom(saved, false)
    updateZoomControls(applied, { show: false })
  } catch {
    updateZoomControls(1, { show: false })
  } finally {
    restoringPageZoom = false
  }
}

async function stepPageZoom(direction) {
  try {
    const factor = await bridge.window.stepZoom(direction)
    updateZoomControls(factor)
  } catch {}
}

async function resetPageZoom() {
  try {
    const factor = await bridge.window.setZoom(1)
    updateZoomControls(factor)
  } catch {}
}

function bindEvents() {
  window.addEventListener('beforeunload', persistPlaybackSession)
  window.addEventListener('pagehide', persistPlaybackSession)
  installPageTransitions()
  $('#minimizeButton').addEventListener('click', () => bridge.window.minimize())
  $('#maximizeButton').addEventListener('click', () => bridge.window.maximize())
  $('#closeButton').addEventListener('click', () => bridge.window.close())
  $('#immersiveMinimize').addEventListener('click', () => bridge.window.minimize())
  $('#immersiveMaximize').addEventListener('click', () => state.fullScreen ? setImmersiveFullScreen(false) : bridge.window.maximize())
  $('#immersiveClose').addEventListener('click', () => bridge.window.close())
  $('#backButton').addEventListener('click', () => moveHistory(-1))
  $('#forwardButton').addEventListener('click', () => moveHistory(1))
  bridge.window.onMaximized((maximized) => {
    state.maximized = Boolean(maximized)
    updateMaximizeButton($('#maximizeButton'), state.maximized)
    if (!state.fullScreen) updateMaximizeButton($('#immersiveMaximize'), state.maximized)
  })
  bridge.window.onFullScreen((fullScreen) => {
    state.fullScreen = Boolean(fullScreen)
    dom.immersive.classList.toggle('fullscreen', state.fullScreen)
    const button = $('#immersiveMaximize')
    const fullScreenButton = $('#immersiveFullScreen')
    fullScreenButton.classList.toggle('active', state.fullScreen)
    fullScreenButton.setAttribute('aria-label', state.fullScreen ? '退出全屏' : '全屏')
    fullScreenButton.title = state.fullScreen ? '退出全屏' : '全屏'
    updateMaximizeButton(button, state.maximized, state.fullScreen)
  })
  bridge.window.onZoomChanged((factor) => {
    updateZoomControls(factor, { show: !restoringPageZoom })
  })
  $('#zoomOut').addEventListener('click', () => stepPageZoom(-1))
  $('#zoomIn').addEventListener('click', () => stepPageZoom(1))
  $('#zoomReset').addEventListener('click', resetPageZoom)
  dom.zoomControls.addEventListener('pointerenter', () => clearTimeout(zoomControlsHideTimer))
  dom.zoomControls.addEventListener('pointerleave', () => hideZoomControls(900))

  $('#profileButton').addEventListener('click', () => {
    if (!state.loggedIn) return showLogin()
    navigate('user', { uid: String(state.profile?.userId || ''), name: state.profile?.nickname || '网易云用户' })
  })
  $('#playButton').addEventListener('click', togglePlayback)
  $('#previousButton').addEventListener('click', () => nextTrack(-1))
  $('#nextButton').addEventListener('click', () => nextTrack(1))
  $('#playModeButton').addEventListener('click', cyclePlayMode)
  $('#likeButton').addEventListener('click', toggleLike)
  $('#immersiveLike').addEventListener('click', toggleLike)
  $('#nowPlayingInfo').addEventListener('click', () => openImmersive(true))
  $('#closeImmersive').addEventListener('click', () => openImmersive(false))
  $('#immersiveLyricsView').addEventListener('click', () => setImmersiveView('lyrics'))
  $('#immersiveQueueView').addEventListener('click', () => setImmersiveView('queue'))
  $('#immersiveFullScreen').addEventListener('click', () => setImmersiveFullScreen(!state.fullScreen))
  dom.immersive.addEventListener('pointermove', showImmersiveChrome)
  dom.immersive.addEventListener('pointerdown', showImmersiveChrome)
  window.addEventListener('blur', () => {
    if (dom.immersive.classList.contains('open')) dom.immersive.classList.add('chrome-hidden')
  })
  window.addEventListener('focus', showImmersiveChrome)
  dom.playerBar.addEventListener('click', (event) => {
    if (state.current && !event.target.closest('button, input')) openImmersive(true)
  })
  let playerBarDragBlocked = false
  const restorePlayerBarDrag = () => {
    playerBarDragBlocked = false
    dom.playerBar.setAttribute('draggable', 'true')
  }
  dom.playerBar.setAttribute('draggable', 'true')
  $('#nowPlayingInfo').setAttribute('draggable', 'true')
  dom.playerBar.addEventListener('pointerdown', (event) => {
    const fromNowPlaying = Boolean(event.target.closest('#nowPlayingInfo'))
    playerBarDragBlocked = !fromNowPlaying && Boolean(event.target.closest('button, input, select, textarea'))
    dom.playerBar.setAttribute('draggable', String(!playerBarDragBlocked))
  }, true)
  dom.playerBar.addEventListener('pointerup', restorePlayerBarDrag, true)
  dom.playerBar.addEventListener('pointercancel', restorePlayerBarDrag, true)
  window.addEventListener('pointerup', restorePlayerBarDrag, true)
  window.addEventListener('pointercancel', restorePlayerBarDrag, true)
  window.addEventListener('blur', restorePlayerBarDrag)
  dom.playerBar.addEventListener('dragstart', (event) => {
    if (playerBarDragBlocked || !state.current || (event.target.closest('button, input') && !event.target.closest('#nowPlayingInfo'))) {
      event.preventDefault()
      return
    }
    beginTrackDrag(state.current, 'player', event)
  })
  dom.playerBar.addEventListener('dragend', (event) => {
    restorePlayerBarDrag()
    handleTrackDragEnd(event)
  })
  $('#queueButton').addEventListener('click', () => toggleQueue(undefined, { source: 'click' }))
  $('#closeQueue').addEventListener('click', () => toggleQueue(false, { source: 'click' }))
  $('#clearQueue').addEventListener('click', clearUpcomingQueue)
  $('#immersiveClearQueue').addEventListener('click', clearUpcomingQueue)
  $('#volumeButton').addEventListener('click', toggleMute)
  $('#volumeRange').addEventListener('input', (event) => setVolume(event.currentTarget.value))
  $('#immersiveVolumeRange').addEventListener('input', (event) => setVolume(event.currentTarget.value))
  $('#immersiveMuteToggle').addEventListener('click', toggleMute)
  $('#volumeWheelZone').addEventListener('wheel', adjustVolumeFromWheel, { passive: false })
  $('#immersiveVolume').addEventListener('wheel', adjustImmersiveVolumeFromWheel, { passive: false })
  $('#immersiveVolumePopover').addEventListener('wheel', adjustImmersiveVolumeFromWheel, { passive: false })
  $('#immersiveVolume').addEventListener('mouseenter', () => {
    if (state.immersiveVolumeTemporary) setImmersiveVolumePopover(true, { temporary: true })
  })
  $('#immersiveVolumePopover').addEventListener('mouseenter', pauseImmersiveVolumeAutoClose)
  $('.immersive-volume-control').addEventListener('mouseleave', () => {
    if (state.immersiveVolumeTemporary) setImmersiveVolumePopover(false)
  })
  $('#immersiveVolume').addEventListener('click', (event) => {
    event.stopPropagation()
    const popover = $('#immersiveVolumePopover')
    const open = !popover.classList.contains('open')
    if (!open && state.immersiveVolumeTemporary) setImmersiveVolumePopover(true)
    else setImmersiveVolumePopover(open)
  })
  $('#immersiveVolumePopover').addEventListener('click', (event) => event.stopPropagation())
  for (const range of [dom.playerProgress, dom.immersiveProgress]) {
    range.addEventListener('pointerdown', () => { state.timelineScrubbing = true })
    range.addEventListener('input', () => previewSeekFromRange(range))
    range.addEventListener('change', () => commitSeekFromRange(range))
    range.addEventListener('pointercancel', cancelTimelineScrub)
  }
  $('#translationToggle').addEventListener('click', () => { state.showTranslation = !state.showTranslation; updateLyricVisibility() })
  $('#fontSizeToggle').addEventListener('click', (event) => {
    event.stopPropagation()
    const menu = $('#fontSizeMenu')
    const open = !menu.classList.contains('open')
    menu.classList.toggle('open', open)
    menu.setAttribute('aria-hidden', String(!open))
  })
  $('#fontSizeMenu').addEventListener('click', (event) => {
    const option = event.target.closest('[data-lyric-scale-value]')
    if (!option) return
    event.stopPropagation()
    state.lyricScale = option.dataset.lyricScaleValue
    localStorage.setItem('menoradio.lyricScale', state.lyricScale)
    applyDisplaySettings()
    $('#fontSizeMenu').classList.remove('open')
    $('#fontSizeMenu').setAttribute('aria-hidden', 'true')
    requestAnimationFrame(() => updateActiveLyric(playbackClockTime(), true, true))
  })

  dom.audio.addEventListener('play', () => {
    if (!state.playbackIntentPlaying) {
      dom.audio.pause()
      return
    }
    setPlayIcons(true)
    reportPlaybackBuffer(true)
    startLyricsClock()
  })
  dom.audio.addEventListener('playing', () => {
    if (!state.playbackIntentPlaying) {
      dom.audio.pause()
      return
    }
    resetPlaybackFailureCycle()
    state.playbackStarving = false
    state.playingGeneration = state.audioLoadGeneration
    scheduleCurrentPlaybackCover()
    maybePreloadUpcomingCovers()
    reportPlaybackBuffer(true)
    startLyricsClock()
  })
  dom.audio.addEventListener('canplay', () => {
    state.playbackStarving = false
    reportPlaybackBuffer(true)
    maybePreloadUpcomingCovers()
  })
  dom.audio.addEventListener('pause', () => {
    setPlayIcons(false)
    stopLyricsClock()
    reportPlaybackBuffer(true)
    syncFloatingLyrics(true)
  })
  dom.audio.addEventListener('waiting', () => {
    state.playbackStarving = true
    reportPlaybackBuffer(true)
  })
  dom.audio.addEventListener('stalled', () => {
    state.playbackStarving = true
    reportPlaybackBuffer(true)
  })
  dom.audio.addEventListener('seeking', () => {
    state.playbackStarving = true
    reportPlaybackBuffer(true)
  })
  dom.audio.addEventListener('seeked', () => {
    const completedPendingSeek = finishPendingAudioSeek()
    state.playbackStarving = dom.audio.readyState <= 2
    reportPlaybackBuffer(true)
    if (completedPendingSeek) updateActiveLyric(dom.audio.currentTime || 0, false, true)
    if (state.playbackIntentPlaying && !dom.audio.paused) startLyricsClock()
    else syncLyricWords()
  })
  dom.audio.addEventListener('progress', () => reportPlaybackBuffer())
  dom.audio.addEventListener('loadedmetadata', () => {
    applyPendingAudioSeek()
    reportPlaybackBuffer(true)
    if (!state.timelineScrubbing) updatePlaybackPositionUi(playbackClockTime(), playbackDuration())
  })
  dom.audio.addEventListener('ratechange', startLyricsClock)
  dom.audio.addEventListener('volumechange', updateVolumeUi)
  dom.audio.addEventListener('ended', onTrackEnded)
  dom.audio.addEventListener('timeupdate', () => {
    finishPendingAudioSeek()
    const actualCurrent = dom.audio.currentTime || 0
    if (!state.timelineScrubbing && !Number.isFinite(state.pendingSeekTime) && actualCurrent > 0) {
      state.lastStablePlaybackTime = actualCurrent
      state.playbackStarving = false
      if (state.optimizedPlaybackRecoveryStartedAt
        && performance.now() - state.optimizedPlaybackRecoveryStartedAt > 8000) {
        state.optimizedPlaybackInPlaceRetryGeneration = 0
        state.playbackProxyFallbackGeneration = 0
        state.optimizedPlaybackRecoveryStartedAt = 0
      }
    }
    if (state.timelineScrubbing) {
      reportPlaybackBuffer()
      return
    }
    const current = playbackClockTime()
    const duration = playbackDuration()
    updatePlaybackPositionUi(current, duration)
    updateActiveLyric(current)
    reportPlaybackBuffer()
    if ('mediaSession' in navigator && Number.isFinite(duration) && duration > 0) {
      try { navigator.mediaSession.setPositionState({ duration, playbackRate: dom.audio.playbackRate, position: Math.min(current, duration) }) } catch {}
    }
  })
  dom.audio.addEventListener('error', () => {
    if (performance.now() < state.ignoreAudioErrorsUntil) return
    if (dom.audio.src && state.current && dom.audio.error) {
      const mediaErrorCode = Number(dom.audio.error.code || 0)
      // Chromium emits MEDIA_ERR_ABORTED when a seek or a replacement Range
      // intentionally cancels the previous request. It is not a network fault.
      if (mediaErrorCode === 1) return
      if (!state.playbackIntentPlaying && state.timelineAtEnd) {
        dom.audio.pause()
        clearPendingAudioSeek()
        updatePlaybackPositionUi(playbackDuration(), playbackDuration(), true)
        return
      }
      if (state.passiveAudioGeneration === state.audioLoadGeneration && dom.audio.paused) {
        state.audioSourceTrackId = ''
        state.audioSourcePromise = null
        state.audioSourcePromiseGeneration = 0
        state.passiveAudioGeneration = 0
        dom.audio.removeAttribute('src')
        try { dom.audio.load() } catch {}
        return
      }
      const generation = state.audioLoadGeneration
      const shouldResume = state.playbackIntentPlaying
      if (state.mediaLoadingOptimization
        && String(dom.audio.currentSrc || dom.audio.src || '').startsWith('menoradio-media:')
        && state.currentAudioDirectUrl) {
        const retryTarget = optimizedPlaybackRecoveryTarget()
        state.ignoreAudioErrorsUntil = performance.now() + 900
        let freshToken = false
        if (state.optimizedPlaybackInPlaceRetryGeneration !== generation) {
          state.optimizedPlaybackInPlaceRetryGeneration = generation
        } else if (state.playbackProxyFallbackGeneration !== generation) {
          state.playbackProxyFallbackGeneration = generation
          freshToken = true
        } else {
          handlePlaybackFailure(state.current, generation, playbackError('音频连接中断', 'network', { mediaErrorCode }))
          return
        }
        void recoverOptimizedPlayback(generation, { freshToken, target: retryTarget, shouldResume })
          .then((recovered) => {
            if (!recovered && generation === state.audioLoadGeneration) {
              handlePlaybackFailure(state.current, generation, playbackError('音频连接恢复失败', 'network', { mediaErrorCode }))
            }
          })
        return
      }
      const kind = mediaErrorCode === 4 ? 'unavailable' : 'network'
      const error = playbackError(`音频连接中断（错误代码 ${mediaErrorCode || '未知'}）`, kind, { mediaErrorCode })
      handlePlaybackFailure(state.current, state.audioLoadGeneration, error)
    }
  })

  dom.page.addEventListener('click', onPageClick)
  dom.page.addEventListener('dblclick', (event) => {
    if (event.target.closest('button, input, a')) return
    const row = event.target.closest('[data-track-index]')
    if (!row) return
    const index = Number(row.dataset.trackIndex)
    if (state.pageTracks[index]) playTracks(state.pageTracks, index, { keepSelectedFirst: true })
  })
  dom.page.addEventListener('dragstart', (event) => {
    const row = event.target.closest('[data-track-index]')
    if (!row || event.target.closest('button')) return
    const pageIndex = Number(row.dataset.trackIndex)
    const track = state.pageTracks[pageIndex]
    if (!track) return
    beginTrackDrag(track, 'page', event, { pageIndex })
    requestAnimationFrame(() => row.classList.add('dragging'))
  })
  dom.page.addEventListener('dragover', (event) => {
    const list = event.target.closest('#playlistTrackList')
    if (!list || !state.draggedTrack || state.dragCancelled || !currentPlaylistOwned()) return
    const samePlaylistDrag = state.dragSource === 'page' && state.dragOriginPlaylistId === String(state.currentPlaylist.id)
    event.preventDefault()
    const row = event.target.closest('[data-track-index]')
    const after = row ? event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2 : true
    if (samePlaylistDrag) {
      const targetTrack = row
        ? state.pageTracks[Number(row.dataset.trackIndex)]
        : state.playlistTracks[state.playlistTracks.length - 1]
      const target = playlistReorderTarget(state.draggedTrack, targetTrack, after)
      if (!target || target.insertionIndex === target.fromIndex) {
        setDragInsertionMarker(null)
        event.dataTransfer.dropEffect = 'none'
        setTrackDragFeedback('forbidden', '位置未改变')
        return
      }
      event.dataTransfer.dropEffect = 'move'
      setTrackDragFeedback('move', '调整歌单顺序')
      setDragInsertionMarker(row, after ? 'after' : 'before')
    } else {
      event.dataTransfer.dropEffect = 'copy'
      setTrackDragFeedback('copy', '加入当前歌单')
      setDragInsertionMarker(row, row ? (after ? 'after' : 'before') : '')
    }
  })
  dom.page.addEventListener('dragleave', (event) => {
    const list = event.target.closest?.('#playlistTrackList')
    if (list && !list.contains(event.relatedTarget)) {
      setDragInsertionMarker(null)
    }
  })
  dom.page.addEventListener('drop', (event) => {
    const list = event.target.closest('#playlistTrackList')
    if (!list || !state.draggedTrack || state.dragCancelled || !currentPlaylistOwned()) return
    const samePlaylistDrag = state.dragSource === 'page' && state.dragOriginPlaylistId === String(state.currentPlaylist.id)
    event.preventDefault()
    event.stopPropagation()
    state.dragDropHandled = 'playlist'
    const row = event.target.closest('[data-track-index]')
    const targetTrack = row
      ? state.pageTracks[Number(row.dataset.trackIndex)]
      : state.playlistTracks[state.playlistTracks.length - 1] || null
    const after = row ? event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2 : true
    if (!samePlaylistDrag) {
      addTrackToCurrentPlaylistAt(state.draggedTrack, targetTrack, after)
      window.setTimeout(finishTrackDrag, 0)
      return
    }
    if (!targetTrack || String(targetTrack.id) === String(state.draggedTrack.id)) {
      window.setTimeout(finishTrackDrag, 0)
      return
    }
    const target = playlistReorderTarget(state.draggedTrack, targetTrack, after)
    if (target && target.insertionIndex !== target.fromIndex) {
      reorderCurrentPlaylist(state.draggedTrack, targetTrack, after)
    }
    window.setTimeout(finishTrackDrag, 0)
  })
  dom.page.addEventListener('dragend', handleTrackDragEnd)
  dom.page.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('[data-track-index]')
    if (!row) return
    const track = state.pageTracks[Number(row.dataset.trackIndex)]
    if (!track) return
    event.preventDefault()
    showTrackMenu(null, track, { x: event.clientX, y: event.clientY })
  })
  dom.page.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-search-form]')
    if (!form) return
    event.preventDefault()
    const query = $('[data-page-search]', form)?.value.trim() || ''
    if (query) navigate('search', { keywords: query, type: state.searchType || 1018 })
  })
  dom.page.addEventListener('input', (event) => {
    if (event.target.matches('[data-audio-normalization]')) {
      state.audioNormalization = event.target.checked
      localStorage.setItem('menoradio.audioNormalization', String(state.audioNormalization))
      applyEffectiveAudioVolume()
      updateVolumeUi()
      return
    }
    if (event.target.matches('[data-media-loading-optimization]')) {
      state.mediaLoadingOptimization = event.target.checked
      localStorage.setItem('menoradio.mediaLoadingOptimization', String(state.mediaLoadingOptimization))
      state.upcomingPreloadSignature = ''
      if (state.mediaLoadingOptimization) {
        maybePreloadUpcomingCovers()
      } else {
        clearCoverPreloads()
        clearAudioPreloads()
      }
      return
    }
    if (event.target.matches('[data-legacy-player]')) {
      state.legacyPlayer = event.target.checked
      localStorage.setItem('menoradio.legacyPlayer', String(state.legacyPlayer))
      $$('[data-modern-player-setting]', dom.page).forEach((card) => { card.hidden = state.legacyPlayer })
      refreshPlayerStyle({ lyrics: true, backdrop: true })
      return
    }
    if (event.target.matches('[data-word-highlight]')) {
      state.wordHighlight = event.target.checked
      localStorage.setItem('menoradio.wordHighlight', String(state.wordHighlight))
      refreshPlayerStyle({ lyrics: true })
      return
    }
    if (event.target.matches('[data-depth-blur]')) {
      state.depthBlur = event.target.checked
      localStorage.setItem('menoradio.depthBlur', String(state.depthBlur))
      refreshPlayerStyle()
      return
    }
    if (event.target.matches('[data-quick-queue-reveal]')) {
      state.quickQueueReveal = event.target.checked
      localStorage.setItem('menoradio.quickQueueReveal', String(state.quickQueueReveal))
      if (!state.quickQueueReveal && state.queueAutoOpenedByPointer && dom.queueDrawer.classList.contains('open')) {
        toggleQueue(false, { source: 'pointer', focusCurrent: false })
      }
      return
    }
    if (event.target.matches('[data-playlist-search]')) {
      refreshCurrentPlaylistTrackList()
    }
    if (event.target.matches('[data-font-search]')) {
      const input = event.target
      clearTimeout(state.fontSearchTimer)
      state.fontSearchTimer = window.setTimeout(() => {
        if (input.isConnected) renderFontOptions(input.value, true)
      }, 180)
    }
    if (event.target.matches('[data-floating-font-search]')) {
      const input = event.target
      clearTimeout(state.fontSearchTimer)
      state.fontSearchTimer = window.setTimeout(() => {
        if (input.isConnected) renderFloatingFontOptions(input.value, true)
      }, 140)
    }
    if (event.target.matches('[data-floating-color-hue]')) {
      floatingColorDraft = floatingColorDraft || hexToHsv(state.floatingLyrics.color)
      floatingColorDraft.h = Number(event.target.value) || 0
      updateFloatingColorPicker()
      return
    }
    if (event.target.matches('[data-floating-color-rgb]')) {
      const value = parseRgbColor(event.target.value)
      event.target.classList.toggle('invalid', !value)
      if (value) {
        floatingColorDraft = hexToHsv(value)
        updateFloatingColorPicker({ preserveRgb: true })
      }
      return
    }
    const floatingSetting = event.target.closest('[data-floating-setting]')
    if (floatingSetting) {
      const key = floatingSetting.dataset.floatingSetting
      let value = floatingSetting.type === 'checkbox' ? floatingSetting.checked : floatingSetting.value
      if (key === 'fontSize') value = Math.max(12, Math.min(120, Number(value) || 30))
      if (key === 'opacity') {
        value = Math.max(.15, Math.min(1, Number(value) || 1))
        floatingSetting.closest('.setting-range')?.querySelector('output')?.replaceChildren(document.createTextNode(`${Math.round(value * 100)}%`))
      }
      state.floatingLyrics[key] = value
      configureFloatingLyrics({ [key]: value })
    }
  })
  dom.page.addEventListener('pointerdown', (event) => {
    const resetFloatingLyrics = event.target.closest?.('[data-reset-floating-lyrics]')
    if (resetFloatingLyrics && event.button === 0) {
      event.preventDefault()
      beginFloatingLyricsResetHold(resetFloatingLyrics, event)
      return
    }
    const field = event.target.closest?.('[data-floating-color-field]')
    if (!field || event.button !== 0) return
    event.preventDefault()
    field.setPointerCapture?.(event.pointerId)
    updateFloatingColorFromPointer(event, field)
    const move = (moveEvent) => updateFloatingColorFromPointer(moveEvent, field)
    const done = () => {
      field.removeEventListener('pointermove', move)
      field.removeEventListener('pointerup', done)
      field.removeEventListener('pointercancel', done)
    }
    field.addEventListener('pointermove', move)
    field.addEventListener('pointerup', done)
    field.addEventListener('pointercancel', done)
  })
  dom.page.addEventListener('scroll', (event) => {
    const list = event.target.closest?.('[data-font-list]')
    if (list && list.scrollHeight - list.scrollTop - list.clientHeight <= 90) {
      renderFontOptions($('[data-font-search]', dom.page)?.value || '', false)
      return
    }
    const floatingList = event.target.closest?.('[data-floating-font-list]')
    if (floatingList && floatingList.scrollHeight - floatingList.scrollTop - floatingList.clientHeight <= 90) {
      renderFloatingFontOptions($('[data-floating-font-search]', dom.page)?.value || '', false)
    }
  }, true)
  dom.playlistNav.addEventListener('click', onPageClick)
  dom.playlistNav.addEventListener('contextmenu', (event) => {
    const item = event.target.closest('[data-playlist-id], [data-playlist-menu-id]')
    if (!item) return
    const id = item.dataset.playlistId || item.dataset.playlistMenuId
    const playlist = state.userPlaylists.find((entry) => String(entry.id) === String(id))
    if (!playlist || isLikedPlaylist(playlist)) return
    event.preventDefault()
    showPlaylistMenu(null, playlist, { x: event.clientX, y: event.clientY })
  })
  dom.queueList.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-queue-remove]')
    if (remove) {
      event.stopPropagation()
      const item = remove.closest('[data-queue-index]')
      removeQueueTrack(Number(item?.dataset.queueIndex))
      return
    }
    if (state.queueJustDragged) return
    const item = event.target.closest('[data-queue-index]')
    if (!item) return
    const index = Number(item.dataset.queueIndex)
    if (!Number.isInteger(index) || !state.queue[index]) return
    state.queueIndex = index
    renderQueue()
    loadTrack(state.queue[state.queueIndex], true)
  })
  dom.queueList.addEventListener('dragstart', (event) => {
    if (event.target.closest('[data-queue-remove]')) {
      event.preventDefault()
      return
    }
    const item = event.target.closest('[data-queue-index]')
    if (!item) return
    state.queueDragIndex = Number(item.dataset.queueIndex)
    state.queueDropIndex = state.queueDragIndex
    beginTrackDrag(state.queue[state.queueDragIndex], 'queue', event)
    requestAnimationFrame(() => item.classList.add('dragging'))
  })
  dom.queueList.addEventListener('dragover', (event) => {
    const item = event.target.closest('[data-queue-index]')
    if ((state.queueDragIndex < 0 && !state.draggedTrack) || state.dragCancelled) return
    event.preventDefault()
    const targetIndex = item ? Number(item.dataset.queueIndex) : state.queue.length
    const after = item ? event.clientY > item.getBoundingClientRect().top + item.offsetHeight / 2 : true
    state.queueDropIndex = targetIndex + (item && after ? 1 : 0)
    if (state.dragSource === 'queue' && queueReorderTarget(state.queueDragIndex, state.queueDropIndex) === state.queueDragIndex) {
      setDragInsertionMarker(null)
      event.dataTransfer.dropEffect = 'none'
      setTrackDragFeedback('forbidden', '位置未改变')
      return
    }
    event.dataTransfer.dropEffect = state.dragSource === 'queue' ? 'move' : 'copy'
    setTrackDragFeedback(state.dragSource === 'queue' ? 'move' : 'copy', state.dragSource === 'queue' ? '调整播放顺序' : '加入播放队列')
    setDragInsertionMarker(item, item ? (after ? 'after' : 'before') : '')
  })
  dom.queueList.addEventListener('drop', (event) => {
    if ((state.queueDragIndex < 0 && !state.draggedTrack) || state.dragCancelled) return
    event.preventDefault()
    if (state.dragSource === 'queue') reorderQueue(state.queueDragIndex, state.queueDropIndex)
    else insertTrackIntoQueue(state.draggedTrack, state.queueDropIndex)
    state.dragDropHandled = 'queue'
    state.queueJustDragged = true
    window.setTimeout(() => { state.queueJustDragged = false }, 0)
    state.queueDragIndex = -1
    state.queueDropIndex = -1
    window.setTimeout(finishTrackDrag, 0)
  })
  dom.queueList.addEventListener('dragend', handleTrackDragEnd)
  dom.immersiveQueueList.addEventListener('click', (event) => {
    const item = event.target.closest('[data-queue-index]')
    if (!item) return
    const index = Number(item.dataset.queueIndex)
    if (event.target.closest('[data-queue-remove]')) {
      event.stopPropagation()
      removeQueueTrack(index)
      return
    }
    if (!state.queue[index] || state.queueJustDragged) return
    state.queueIndex = index
    renderQueue()
    loadTrack(state.queue[index], true)
  })
  dom.immersiveQueueList.addEventListener('dragstart', (event) => {
    if (event.target.closest('[data-queue-remove]')) return event.preventDefault()
    const item = event.target.closest('[data-queue-index]')
    if (!item) return
    state.queueDragIndex = Number(item.dataset.queueIndex)
    state.queueDropIndex = state.queueDragIndex
    beginTrackDrag(state.queue[state.queueDragIndex], 'queue', event)
    requestAnimationFrame(() => item.classList.add('dragging'))
  })
  dom.immersiveQueueList.addEventListener('dragover', (event) => {
    if ((state.queueDragIndex < 0 && !state.draggedTrack) || state.dragCancelled) return
    event.preventDefault()
    const item = event.target.closest('[data-queue-index]')
    const targetIndex = item ? Number(item.dataset.queueIndex) : state.queue.length
    const after = item ? event.clientY > item.getBoundingClientRect().top + item.offsetHeight / 2 : true
    state.queueDropIndex = targetIndex + (item && after ? 1 : 0)
    if (state.dragSource === 'queue' && queueReorderTarget(state.queueDragIndex, state.queueDropIndex) === state.queueDragIndex) {
      setDragInsertionMarker(null)
      event.dataTransfer.dropEffect = 'none'
      setTrackDragFeedback('forbidden', '位置未改变')
      return
    }
    event.dataTransfer.dropEffect = state.dragSource === 'queue' ? 'move' : 'copy'
    setTrackDragFeedback(state.dragSource === 'queue' ? 'move' : 'copy', state.dragSource === 'queue' ? '调整播放顺序' : '加入播放队列')
    setDragInsertionMarker(item, item ? (after ? 'after' : 'before') : '')
  })
  dom.immersiveQueueList.addEventListener('drop', (event) => {
    if ((state.queueDragIndex < 0 && !state.draggedTrack) || state.dragCancelled) return
    event.preventDefault()
    if (state.dragSource === 'queue') reorderQueue(state.queueDragIndex, state.queueDropIndex)
    else insertTrackIntoQueue(state.draggedTrack, state.queueDropIndex)
    state.dragDropHandled = 'queue'
    state.queueJustDragged = true
    window.setTimeout(() => { state.queueJustDragged = false }, 0)
    state.queueDragIndex = -1
    state.queueDropIndex = -1
    window.setTimeout(finishTrackDrag, 0)
  })
  dom.immersiveQueueList.addEventListener('dragend', handleTrackDragEnd)
  dom.trackMenu.addEventListener('click', (event) => {
    event.stopPropagation()
    const playlist = state.menuPlaylist
    const playlistAction = event.target.closest('[data-playlist-menu-action]')
    if (playlistAction && playlist) {
      const action = playlistAction.dataset.playlistMenuAction
      hideTrackMenu()
      if (action === 'edit') showEditPlaylist(playlist)
      else if (action === 'delete') showDeletePlaylist(playlist)
      else if (action === 'unsubscribe') unsubscribePlaylist(playlist)
      return
    }
    const track = state.menuTrack
    const artistLink = event.target.closest('[data-track-artist-id]')
    if (artistLink && track) {
      const payload = { id: artistLink.dataset.trackArtistId, name: artistLink.dataset.trackArtistName || '歌手' }
      hideTrackMenu()
      navigate('artist', payload)
      return
    }
    const albumLink = event.target.closest('[data-track-album-id]')
    if (albumLink && track) {
      const payload = { id: albumLink.dataset.trackAlbumId, name: albumLink.dataset.trackAlbumName || '专辑' }
      hideTrackMenu()
      navigate('album', payload)
      return
    }
    const add = event.target.closest('[data-add-playlist-id]')
    if (add && track) {
      modifyPlaylist('add', add.dataset.addPlaylistId, track)
      hideTrackMenu()
      return
    }
    const action = event.target.closest('[data-track-menu-action]')
    if (!action || !track) return
    if (action.dataset.trackMenuAction === 'play') {
      const index = state.pageTracks.findIndex((item) => item.id === track.id)
      playTracks(index >= 0 ? state.pageTracks : [track], Math.max(0, index), { keepSelectedFirst: true })
      hideTrackMenu()
    } else if (action.dataset.trackMenuAction === 'next') {
      queueTrackNext(track)
      hideTrackMenu()
    } else if (action.dataset.trackMenuAction === 'choose-playlist') {
      const choices = $('[data-menu-playlists]', dom.trackMenu)
      if (choices) choices.hidden = !choices.hidden
      const artists = $('[data-menu-artists]', dom.trackMenu)
      if (artists) artists.hidden = true
    } else if (action.dataset.trackMenuAction === 'choose-artist') {
      const artists = $('[data-menu-artists]', dom.trackMenu)
      if (artists) artists.hidden = !artists.hidden
      const choices = $('[data-menu-playlists]', dom.trackMenu)
      if (choices) choices.hidden = true
    } else if (action.dataset.trackMenuAction === 'remove') {
      modifyPlaylist('del', action.dataset.currentPlaylistId, track)
      hideTrackMenu()
    }
  })
  dom.lyricsScroller.addEventListener('click', (event) => {
    const line = event.target.closest('[data-time]')
    if (line && state.current) {
      setManualLyricReadability(false, false)
      void seekCurrentTrack(Number(line.dataset.time))
    }
  })
  dom.lyricsScroller.addEventListener('wheel', (event) => {
    if (!state.lyrics.length) return
    event.preventDefault()
    const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 34 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? dom.lyricsScroller.clientHeight : 1
    smoothManualLyricScroll(event.deltaY * scale)
  }, { passive: false })
  dom.modalLayer.addEventListener('click', (event) => { if (event.target === dom.modalLayer) closeModal() })

  $$('[data-player-action]').forEach((button) => button.addEventListener('click', () => {
    const action = button.dataset.playerAction
    if (action === 'play') togglePlayback()
    if (action === 'previous') nextTrack(-1)
    if (action === 'next') nextTrack(1)
    if (action === 'mode') cyclePlayMode()
  }))

  document.addEventListener('click', (event) => {
    if (dom.queueDrawer.classList.contains('open') && !state.draggedTrack
        && !event.target.closest('#queueDrawer, #queueButton')) {
      toggleQueue(false, { source: 'outside', focusCurrent: false })
    }
    if (!event.target.closest('#trackMenu, .track-more, .playlist-nav-more')) hideTrackMenu()
    const nav = event.target.closest('[data-route]')
    if (nav) {
      if (nav.dataset.route === 'radio') startPrivateRadio()
      else navigate(nav.dataset.route)
    }
    if (!event.target.closest('.font-size-control')) {
      $('#fontSizeMenu').classList.remove('open')
      $('#fontSizeMenu').setAttribute('aria-hidden', 'true')
    }
    if (!event.target.closest('.immersive-volume-control')) {
      setImmersiveVolumePopover(false)
    }
    if (!event.target.closest('.font-picker-control')) {
      const popover = $('[data-font-popover]', dom.page)
      const picker = $('[data-font-picker]', dom.page)
      popover?.classList.remove('open')
      popover?.setAttribute('aria-hidden', 'true')
      picker?.setAttribute('aria-expanded', 'false')
      const floatingPopover = $('[data-floating-font-popover]', dom.page)
      const floatingPicker = $('[data-floating-font-picker]', dom.page)
      floatingPopover?.classList.remove('open')
      floatingPopover?.setAttribute('aria-hidden', 'true')
      floatingPicker?.setAttribute('aria-expanded', 'false')
    }
    if (!event.target.closest('[data-choice-control]')) closeChoicePickers()
    if (!event.target.closest('.floating-color-control')) {
      const colorPopover = $('[data-floating-color-popover]', dom.page)
      if (colorPopover) colorPopover.hidden = true
      $('[data-floating-color-picker]', dom.page)?.setAttribute('aria-expanded', 'false')
    }
  })
  document.addEventListener('pointermove', (event) => {
    if (floatingLyricsResetHold && event.pointerId === floatingLyricsResetHold.pointerId) {
      const rect = floatingLyricsResetHold.button.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
        cancelFloatingLyricsResetHold()
      }
    }
    if (applicationResetHold && event.pointerId === applicationResetHold.pointerId) {
      const rect = applicationResetHold.button.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
        cancelApplicationResetHold()
      }
    }
    if (state.draggedTrack || dom.immersive.classList.contains('open')) return
    if (String(state.route || '').startsWith('settings')) {
      if (state.queueAutoOpenedByPointer && dom.queueDrawer.classList.contains('open')) {
        toggleQueue(false, { source: 'pointer', focusCurrent: false })
      }
      return
    }
    const drawerOpen = dom.queueDrawer.classList.contains('open')
    if (state.quickQueueReveal && !drawerOpen && event.clientX >= window.innerWidth - 10) {
      toggleQueue(true, { source: 'pointer', focusCurrent: true })
      return
    }
    if (!drawerOpen || !state.queueAutoOpenedByPointer) return
    const rect = dom.queueDrawer.getBoundingClientRect()
    const insideDrawer = event.clientX >= rect.left - 8 && event.clientY >= rect.top && event.clientY <= rect.bottom
    if (insideDrawer) {
      clearTimeout(state.queuePointerCloseTimer)
      state.queuePointerCloseTimer = 0
      return
    }
    if (state.queuePointerCloseTimer) return
    state.queuePointerCloseTimer = window.setTimeout(() => {
      if (state.queueAutoOpenedByPointer && !state.draggedTrack) {
        toggleQueue(false, { source: 'pointer', focusCurrent: false })
      }
    }, 180)
  }, { passive: true })
  document.addEventListener('mouseout', (event) => {
    if (event.relatedTarget || !state.queueAutoOpenedByPointer || state.draggedTrack) return
    toggleQueue(false, { source: 'pointer', focusCurrent: false })
  })
  document.addEventListener('pointerdown', (event) => {
    if (event.button === 2) cancelActiveTrackDrag(event)
  }, true)
  document.addEventListener('pointerup', (event) => {
    if (floatingLyricsResetHold && event.pointerId === floatingLyricsResetHold.pointerId) cancelFloatingLyricsResetHold()
    if (applicationResetHold && event.pointerId === applicationResetHold.pointerId) cancelApplicationResetHold()
  }, true)
  document.addEventListener('pointercancel', (event) => {
    if (floatingLyricsResetHold && event.pointerId === floatingLyricsResetHold.pointerId) cancelFloatingLyricsResetHold()
    if (applicationResetHold && event.pointerId === applicationResetHold.pointerId) cancelApplicationResetHold()
  }, true)
  window.addEventListener('blur', () => {
    cancelFloatingLyricsResetHold()
    cancelApplicationResetHold()
  })
  document.addEventListener('mousedown', (event) => {
    if (event.button === 2) cancelActiveTrackDrag(event)
  }, true)
  document.addEventListener('contextmenu', (event) => cancelActiveTrackDrag(event), true)
  document.addEventListener('wheel', (event) => {
    if (!state.draggedTrack || state.dragCancelled) return
    const scroller = draggedScrollContainerAtPoint(state.dragPointerX, state.dragPointerY)
    if (!scroller) return
    const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 34
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? scroller.clientHeight
        : 1
    event.preventDefault()
    const previous = scroller.scrollTop
    scroller.scrollTop = previous + event.deltaY * scale
    // Native HTML drag does not always emit another dragover after wheel
    // scrolling. Refresh the marker on the next frame so placement remains
    // responsive even while the pointer itself is stationary.
    if (scroller.scrollTop !== previous) {
      requestAnimationFrame(() => {
        const target = document.elementFromPoint(state.dragPointerX, state.dragPointerY)
        target?.closest?.('[data-track-index], [data-queue-id]')?.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true,
          clientX: state.dragPointerX,
          clientY: state.dragPointerY,
        }))
      })
    }
  }, { capture: true, passive: false })
  document.addEventListener('dragover', (event) => {
    if (!state.draggedTrack) return
    state.dragPointerX = event.clientX
    state.dragPointerY = event.clientY
    if (event.buttons & 2) {
      cancelActiveTrackDrag(event)
      return
    }
    if (state.dragCancelled) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'none'
      return
    }
    const playlist = playlistDropTarget(event.target)
    clearTimeout(state.queueAutoCloseTimer)
    if (playlist && playlist.creatorId === String(state.profile?.userId || '')) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      setTrackDragFeedback('copy', '加入歌单')
      setDragPlaylistTarget(event.target.closest('[data-playlist-id], [data-playlist-drop-liked]'))
      updatePlaylistHoverNavigation(playlist, event)
    } else {
      setDragPlaylistTarget(null)
      clearPlaylistHoverNavigation()
    }
    if (state.dragSource === 'queue' || dom.immersive.classList.contains('open')) {
      if (!event.defaultPrevented) setTrackDragFeedback('forbidden', '不能放在这里')
      return
    }
    const nearRightEdge = isNearQueueEdge(event)
    if (nearRightEdge) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      setTrackDragFeedback('copy', '加入播放队列')
      state.dragLastNearQueueAt = performance.now()
      if (!dom.queueDrawer.classList.contains('open')) {
        state.queueAutoOpenedForDrag = true
        toggleQueue(true, { source: 'drag', focusCurrent: false })
      }
      return
    }
    if (!state.queueAutoOpenedForDrag) {
      if (!event.defaultPrevented) setTrackDragFeedback('forbidden', '不能放在这里')
      return
    }
    const drawerRect = dom.queueDrawer.getBoundingClientRect()
    if (event.clientX >= drawerRect.left - 24) return
    state.queueAutoCloseTimer = window.setTimeout(() => {
      if (!state.draggedTrack || !state.queueAutoOpenedForDrag) return
      toggleQueue(false, { source: 'drag', focusCurrent: false })
      state.queueAutoOpenedForDrag = false
    }, 160)
    if (!event.defaultPrevented) setTrackDragFeedback('forbidden', '不能放在这里')
  })
  document.addEventListener('drop', (event) => {
    if (!state.draggedTrack || state.dragCancelled || state.dragDropHandled) return
    const playlist = playlistDropTarget(event.target)
    if (playlist && playlist.creatorId === String(state.profile?.userId || '')) {
      event.preventDefault()
      state.dragDropHandled = 'playlist'
      modifyPlaylist('add', playlist.id, state.draggedTrack)
      window.setTimeout(finishTrackDrag, 0)
      return
    }
    if (isNearQueueEdge(event, 150)) {
      event.preventDefault()
      state.dragDropHandled = 'queue'
      insertTrackIntoQueue(state.draggedTrack, state.queue.length)
      window.setTimeout(finishTrackDrag, 0)
    }
  })
  document.addEventListener('dragend', handleTrackDragEnd)
  document.addEventListener('keydown', (event) => {
    const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      if (state.route !== 'search' || state.routePayload) navigate('search')
      setTimeout(() => { const search = $('[data-page-search]', dom.page); search?.focus(); search?.select() }, 0)
    } else if (!typing && event.code === 'Space') {
      event.preventDefault(); togglePlayback()
    } else if (event.key === 'Escape') {
      if (dom.modalLayer.classList.contains('open')) closeModal()
      else if (dom.immersive.classList.contains('open')) openImmersive(false)
      else toggleQueue(false)
    }
  })
  window.addEventListener('resize', () => {
    hideTrackMenu()
    if (!dom.immersive.classList.contains('open')) return
    clearTimeout(state.immersiveLayoutTimer)
    state.immersiveLayoutTimer = window.setTimeout(() => applyImmersiveLayout(false), 220)
  })
  window.addEventListener('online', async () => {
    // Resume thumbnails that exhausted their transient retry budget while the
    // machine was offline. Keep them in the managed thumbnail path so the
    // concurrency and bandwidth limits still apply after connectivity returns.
    document.querySelectorAll('img[data-thumbnail-src]').forEach((image) => {
      if (image.dataset.thumbnailLoaded === 'true') return
      delete image.dataset.thumbnailRetryCycle
      thumbnailLoads.delete(image)
      void loadThumbnail(image, 0)
    })
    state.home = null
    await loadAccount()
    if (state.route === 'home') renderHome()
    else if (state.route === 'daily') renderDaily()
    else if (state.route === 'search' && state.routePayload?.keywords) searchNow(state.routePayload.keywords, state.routePayload.type || 1018)
    else if (state.route === 'playlist') renderPlaylist(state.routePayload)
    if (state.current && !dom.audio.src) {
      void ensureAudioSource(state.current, state.audioLoadGeneration, { passive: true })
    }
  })

  if ('mediaSession' in navigator) {
    const actions = {
      play: () => {
        if (dom.audio.paused) void togglePlayback()
      },
      pause: () => {
        state.playbackIntentPlaying = false
        dom.audio.pause()
      },
      previoustrack: () => nextTrack(-1), nexttrack: () => nextTrack(1),
      seekto: (details) => {
        if (details.seekTime == null) return
        void seekCurrentTrack(details.seekTime)
      },
      seekbackward: (details) => {
        void seekCurrentTrack(Math.max(0, playbackClockTime() - (details.seekOffset || 10)))
      },
      seekforward: (details) => {
        void seekCurrentTrack(Math.min(playbackDuration(), playbackClockTime() + (details.seekOffset || 10)))
      },
    }
    for (const [action, handler] of Object.entries(actions)) {
      try { navigator.mediaSession.setActionHandler(action, handler) } catch {}
    }
  }
}

function onPageClick(event) {
  const descriptionToggle = event.target.closest('[data-toggle-description]')
  if (descriptionToggle) {
    const root = descriptionToggle.closest('[data-expandable-description]')
    const expanded = descriptionToggle.getAttribute('aria-expanded') === 'true'
    const next = !expanded
    root?.classList.toggle('is-collapsed', !next)
    descriptionToggle.setAttribute('aria-expanded', String(next))
    descriptionToggle.textContent = next ? '收起' : '展开'
    if (!next && root) requestAnimationFrame(() => refreshExpandableDescription(root))
    return
  }
  const searchHistory = event.target.closest('[data-search-history]')
  if (searchHistory) {
    return navigate('search', { keywords: searchHistory.dataset.searchHistory, type: state.searchType || 1018 })
  }
  const clearSearchHistory = event.target.closest('[data-clear-search-history]')
  if (clearSearchHistory) {
    state.searchHistory = []
    try { localStorage.removeItem(searchHistoryStorageKey) } catch {}
    renderSearch('', state.searchType || 1018)
    return
  }
  const clearRecent = event.target.closest('[data-clear-recent]')
  if (clearRecent) {
    state.recent = []
    renderRoute()
    toast('已清空最近播放')
    return
  }
  const searchType = event.target.closest('[data-search-type]')
  if (searchType) {
    const query = String(searchType.dataset.searchQuery || $('[data-page-search]', dom.page)?.value || '').trim()
    return query ? searchNow(query, Number(searchType.dataset.searchType)) : renderSearch('', Number(searchType.dataset.searchType))
  }
  const searchRefine = event.target.closest('[data-search-refine]')
  if (searchRefine) return navigate('search', { keywords: searchRefine.dataset.searchRefine, type: 1 })
  const artist = event.target.closest('[data-artist-id]')
  if (artist) return navigate('artist', { id: artist.dataset.artistId, name: artist.dataset.artistName || '歌手' })
  const album = event.target.closest('[data-album-id]')
  if (album) return navigate('album', { id: album.dataset.albumId, name: album.dataset.albumName || '专辑' })
  const user = event.target.closest('[data-user-id]')
  if (user) return navigate('user', { uid: user.dataset.userId, name: user.dataset.userName || '网易云用户' })
  const routeLink = event.target.closest('[data-route-link]')
  if (routeLink) return navigate(routeLink.dataset.routeLink)
  const login = event.target.closest('[data-login]')
  if (login) return showLogin()
  const logoutButton = event.target.closest('[data-logout]')
  if (logoutButton) return logout()
  const createPlaylist = event.target.closest('[data-create-playlist]')
  if (createPlaylist) return showCreatePlaylist()
  const clearCache = event.target.closest('[data-clear-cache]')
  if (clearCache) return clearApplicationCache(clearCache)
  const checkUpdate = event.target.closest('[data-check-update]')
  if (checkUpdate) return checkForUpdates({ button: checkUpdate })
  const external = event.target.closest('[data-external]')
  if (external) return bridge.app.openExternal(external.dataset.external)
  const resetFloatingLyrics = event.target.closest('[data-reset-floating-lyrics]')
  if (resetFloatingLyrics) {
    event.preventDefault()
    return
  }
  const resetApplication = event.target.closest('[data-reset-application]')
  if (resetApplication) {
    event.preventDefault()
    return showApplicationResetConfirmation()
  }
  const floatingToggle = event.target.closest('[data-floating-toggle]')
  if (floatingToggle) {
    const key = floatingToggle.dataset.floatingToggle
    const value = !Boolean(state.floatingLyrics[key])
    state.floatingLyrics[key] = value
    floatingToggle.classList.toggle('active', value)
    return configureFloatingLyrics({ [key]: value })
  }
  const floatingAlign = event.target.closest('[data-floating-align]')
  if (floatingAlign) {
    const value = floatingAlign.dataset.floatingAlign
    state.floatingLyrics.align = value
    $$('[data-floating-align]', dom.page).forEach((button) => button.classList.toggle('active', button === floatingAlign))
    return configureFloatingLyrics({ align: value })
  }
  const floatingFontPicker = event.target.closest('[data-floating-font-picker]')
  if (floatingFontPicker) {
    const popover = $('[data-floating-font-popover]', dom.page)
    const open = !popover?.classList.contains('open')
    popover?.classList.toggle('open', open)
    popover?.setAttribute('aria-hidden', String(!open))
    floatingFontPicker.setAttribute('aria-expanded', String(open))
    if (open) {
      if (state.fontsLoaded) renderFloatingFontOptions($('[data-floating-font-search]', dom.page)?.value || '', true)
      else loadSystemFonts()
    }
    return
  }
  const floatingFontOption = event.target.closest('[data-floating-font-name]')
  if (floatingFontOption) {
    const value = floatingFontOption.dataset.floatingFontName
    state.floatingLyrics.fontFamily = value
    const label = $('[data-floating-font-picker] span', dom.page)
    if (label) {
      label.textContent = fontLabel(value)
      label.style.fontFamily = fontCss(value)
    }
    $('[data-floating-font-popover]', dom.page)?.classList.remove('open')
    $('[data-floating-font-popover]', dom.page)?.setAttribute('aria-hidden', 'true')
    $('[data-floating-font-picker]', dom.page)?.setAttribute('aria-expanded', 'false')
    return configureFloatingLyrics({ fontFamily: value })
  }
  const floatingColorPicker = event.target.closest('[data-floating-color-picker]')
  if (floatingColorPicker) {
    const popover = $('[data-floating-color-popover]', dom.page)
    const open = Boolean(popover?.hidden)
    if (popover) popover.hidden = !open
    floatingColorPicker.setAttribute('aria-expanded', String(open))
    floatingColorDraft = hexToHsv(state.floatingLyrics.color)
    updateFloatingColorPicker()
    return
  }
  if (event.target.closest('[data-floating-color-cancel]')) {
    floatingColorDraft = hexToHsv(state.floatingLyrics.color)
    const popover = $('[data-floating-color-popover]', dom.page)
    if (popover) popover.hidden = true
    $('[data-floating-color-picker]', dom.page)?.setAttribute('aria-expanded', 'false')
    return
  }
  if (event.target.closest('[data-floating-color-apply]')) {
    const rgbInput = $('[data-floating-color-rgb]', dom.page)
    if (rgbInput?.classList.contains('invalid')) {
      rgbInput.focus()
      return
    }
    const value = hsvToHex(floatingColorDraft || hexToHsv(state.floatingLyrics.color))
    state.floatingLyrics.color = value
    const swatch = $('[data-floating-color-picker]', dom.page)
    if (swatch) swatch.style.setProperty('--swatch', value)
    const popover = $('[data-floating-color-popover]', dom.page)
    if (popover) popover.hidden = true
    swatch?.setAttribute('aria-expanded', 'false')
    return configureFloatingLyrics({ color: value })
  }
  const playlistMenu = event.target.closest('[data-playlist-menu-id]')
  if (playlistMenu) {
    event.stopPropagation()
    const playlist = state.userPlaylists.find((entry) => String(entry.id) === String(playlistMenu.dataset.playlistMenuId))
    return showPlaylistMenu(playlistMenu, playlist)
  }
  const playlistPlay = event.target.closest('[data-playlist-play]')
  if (playlistPlay) return playPlaylistFromCard(playlistPlay)
  const playlist = event.target.closest('[data-playlist-id]')
  if (playlist) return navigate('playlist', { id: playlist.dataset.playlistId })
  const fontPicker = event.target.closest('[data-font-picker]')
  if (fontPicker) {
    const popover = $('[data-font-popover]', dom.page)
    const open = !popover?.classList.contains('open')
    popover?.classList.toggle('open', open)
    popover?.setAttribute('aria-hidden', String(!open))
    fontPicker.setAttribute('aria-expanded', String(open))
    if (open) {
      setTimeout(() => $('[data-font-search]', dom.page)?.focus(), 0)
      if (state.fontsLoaded) renderFontOptions($('[data-font-search]', dom.page)?.value || '', true)
      else loadSystemFonts()
    }
    return
  }
  const fontOption = event.target.closest('[data-font-name]')
  if (fontOption) {
    state.fontFamily = fontOption.dataset.fontName
    localStorage.setItem('menoradio.fontFamily', state.fontFamily)
    applyDisplaySettings()
    const pickerLabel = $('[data-font-picker] span', dom.page)
    if (pickerLabel) {
      pickerLabel.textContent = fontLabel(state.fontFamily)
      pickerLabel.style.fontFamily = fontCss(state.fontFamily)
    }
    $('[data-font-popover]', dom.page)?.classList.remove('open')
    $('[data-font-popover]', dom.page)?.setAttribute('aria-hidden', 'true')
    $('[data-font-picker]', dom.page)?.setAttribute('aria-expanded', 'false')
    return
  }
  const choicePicker = event.target.closest('[data-choice-picker]')
  if (choicePicker) {
    const control = choicePicker.closest('[data-choice-control]')
    const popover = $('[data-choice-popover]', control)
    const open = !popover?.classList.contains('open')
    closeChoicePickers(control)
    popover?.classList.toggle('open', open)
    popover?.setAttribute('aria-hidden', String(!open))
    choicePicker.setAttribute('aria-expanded', String(open))
    return
  }
  const choiceOption = event.target.closest('[data-choice-value]')
  if (choiceOption) {
    const control = choiceOption.closest('[data-choice-control]')
    const name = control?.dataset.choiceControl
    const value = choiceOption.dataset.choiceValue
    if (name === 'audio-quality' && audioQualities.some(([optionValue]) => optionValue === value)) {
      if (state.audioQuality !== value) clearAudioPreloads()
      state.audioQuality = value
      localStorage.setItem('menoradio.audioQuality', value)
      updateChoicePicker(control, value)
    }
    if (name === 'theme' && themes.some(([optionValue]) => optionValue === value)) {
      state.theme = value
      localStorage.setItem('menoradio.theme', value)
      applyTheme()
      updateChoicePicker(control, value)
    }
    if (name === 'floating-lyrics-mode' && floatingLyricModes.some(([optionValue]) => optionValue === value)) {
      state.floatingLyrics.mode = value
      updateChoicePicker(control, value)
      configureFloatingLyrics({ mode: value })
    }
    if (name === 'floating-no-translation-position' && floatingLyricVerticalPositions.some(([optionValue]) => optionValue === value)) {
      state.floatingLyrics.noTranslationPosition = value
      updateChoicePicker(control, value)
      configureFloatingLyrics({ noTranslationPosition: value })
    }
    return
  }
  const playlistSearchToggle = event.target.closest('[data-toggle-playlist-search]')
  if (playlistSearchToggle) {
    const panel = $('#playlistSearchPanel', dom.page)
    const open = panel?.hidden !== false
    if (panel) panel.hidden = !open
    playlistSearchToggle.setAttribute('aria-expanded', String(open))
    playlistSearchToggle.classList.toggle('active', open)
    if (open) setTimeout(() => $('[data-playlist-search]', dom.page)?.focus(), 0)
    return
  }
  const playlistSubscribe = event.target.closest('[data-playlist-subscribe]')
  if (playlistSubscribe) return togglePlaylistSubscription(playlistSubscribe)
  const more = event.target.closest('.track-more')
  if (more) {
    const row = more.closest('[data-track-index]')
    return showTrackMenu(more, state.pageTracks[Number(row?.dataset.trackIndex)])
  }
  const row = event.target.closest('[data-track-index]')
  if (row) {
    state.selectedTrackIndex = Number(row.dataset.trackIndex)
    $$('.track-row', dom.page).forEach((item) => item.classList.toggle('selected', item === row))
    return
  }
  if (event.target.closest('[data-playlist-play-all]')) return playAllTracks(state.playlistTracks)
  if (event.target.closest('[data-play-all]')) return playAllTracks(state.pageTracks)
  if (event.target.closest('[data-play-home]')) return playAllTracks(state.home?.newSongs || [])
  state.selectedTrackIndex = -1
  $$('.track-row.selected', dom.page).forEach((item) => item.classList.remove('selected'))
}
 
async function init() {
  const initializationStarted = performance.now()
  // This setting existed briefly in older builds. The limiter and its UI are
  // gone, so remove the orphaned value explicitly instead of leaving an
  // invisible upgrade-time restriction behind.
  try { localStorage.removeItem('menoradio.networkRateLimit') } catch {}
  installImageRetry()
  installThumbnailLoading()
  bindEvents()
  await restorePageZoom()
  applyDisplaySettings()
  try {
    const snapshot = await bridge.floatingLyrics.state()
    state.floatingLyrics = { ...state.floatingLyrics, ...(snapshot?.config || {}) }
  } catch {}
  bridge.floatingLyrics.onStateChanged((snapshot) => {
    state.floatingLyrics = { ...state.floatingLyrics, ...(snapshot?.config || {}) }
    if (state.route === 'settings-floating') syncFloatingLyricsSettingsControls()
  })
  if (!['repeat-one', 'repeat-all', 'shuffle'].includes(state.playMode)) state.playMode = 'repeat-all'
  updatePlayModeButtons()
  const savedVolume = Number(localStorage.getItem('menoradio.volume'))
  state.userVolume = Number.isFinite(savedVolume) ? Math.max(0, Math.min(1, savedVolume)) : .75
  applyEffectiveAudioVolume()
  updateVolumeUi()
  let playbackSessionRestored = false
  try {
    playbackSessionRestored = restorePlaybackSession()
  } catch (error) {
    // A corrupt or incompatible snapshot must never strand the user on the
    // initialization screen. Keep the saved data for a future compatible
    // build and continue with an empty player for this launch.
    console.warn('[playback-session] Restore failed without blocking startup:', error)
  }
  if (!playbackSessionRestored) {
    updateRange(dom.playerProgress, 0, 1)
    updateRange(dom.immersiveProgress, 0, 1)
    setPlayIcons(false)
  }
  applyImmersiveLayout(true)
  installAudioDeviceGuard()
  bridge.window.isFullScreen().then((value) => {
    state.fullScreen = Boolean(value)
    dom.immersive.classList.toggle('fullscreen', state.fullScreen)
    $('#immersiveFullScreen').classList.toggle('active', state.fullScreen)
  }).catch(() => {})
  // Do not start account/profile synchronization beside the initial home
  // request. The combined API fan-out and first thumbnail batch was the source
  // of the large one-sample network spike at the end of initialization. Home
  // already uses the persisted cookie in the main process, so it can render
  // first; the sidebar/account state follows without reloading the page.
  const homeReady = renderHome().catch(() => {})
  // Account synchronization follows the home request instead of competing
  // with it. Do not await homeReady outside the timeout race: a stalled
  // network request must never leave the initialization screen visible forever.
  const accountReady = homeReady.then(() => loadAccount()).catch(() => {})
  try {
    await Promise.race([
      Promise.allSettled([homeReady, accountReady]),
      new Promise((resolve) => window.setTimeout(resolve, 3200)),
    ])
  } finally {
    const remaining = Math.max(0, 520 - (performance.now() - initializationStarted))
    window.setTimeout(() => {
      dom.initializingScreen?.classList.add('hiding')
      window.setTimeout(() => {
        dom.initializingScreen?.remove()
        // Update discovery is deliberately outside initialization. A slow or
        // unavailable GitHub connection must not delay the app becoming usable.
        window.setTimeout(() => { void checkForUpdates({ automatic: true }) }, 900)
      }, 320)
    }, remaining)
  }
}

function dismissInitializingScreen(delay = 0) {
  window.setTimeout(() => {
    dom.initializingScreen?.classList.add('hiding')
    window.setTimeout(() => dom.initializingScreen?.remove(), 320)
  }, Math.max(0, delay))
}

init().catch((error) => {
  console.error('[init] MenoRadio continued after an initialization error:', error)
  dismissInitializingScreen()
})
