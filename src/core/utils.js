(() => {
  const fontFamilies = {
    // 'system' is the stored key of the default choice, now the bundled font.
    system: '"MenoRadio Sarasa UI SC", "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif',
    segoe: '"Segoe UI Variable Text", "MenoRadio Sarasa UI SC", "Segoe UI", sans-serif',
    yahei: '"Microsoft YaHei UI", "MenoRadio Sarasa UI SC", "Microsoft YaHei", sans-serif',
    sarasa: '"Sarasa UI SC", "MenoRadio Sarasa UI SC", "Sarasa Gothic SC", "Microsoft YaHei UI", sans-serif',
    noto: '"Noto Sans CJK SC", "MenoRadio Sarasa UI SC", "Microsoft YaHei UI", sans-serif',
  }

  const legacyFontNames = {
    segoe: 'Segoe UI Variable Text',
    yahei: 'Microsoft YaHei UI',
    sarasa: 'Sarasa UI SC',
    noto: 'Noto Sans CJK SC',
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value))
  }

  function adaptiveLyricFontSize(lyricsWidth, panelHeight) {
    const width = Math.max(0, Number(lyricsWidth) || 0)
    const height = Math.max(0, Number(panelHeight) || 0)
    const shortEdge = Math.min(width, height)
    const defaultShortEdge = 576
    const fullScreenShortEdge = 1020
    const size = 30 + (shortEdge - defaultShortEdge) * (10 / (fullScreenShortEdge - defaultShortEdge))
    return Math.round(clamp(size, 24, 40) * 100) / 100
  }

  function hexToHsv(hex) {
    const match = String(hex || '').match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i)
    const [r, g, b] = match ? match.slice(1).map((value) => parseInt(value, 16) / 255) : [1, 1, 1]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const delta = max - min
    let h = 0
    if (delta) {
      if (max === r) h = ((g - b) / delta) % 6
      else if (max === g) h = (b - r) / delta + 2
      else h = (r - g) / delta + 4
    }
    return { h: (h * 60 + 360) % 360, s: max ? delta / max : 0, v: max }
  }

  function hsvToHex({ h, s, v }) {
    const chroma = v * s
    const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1))
    const m = v - chroma
    const rgb = h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x] : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x]
    return `#${rgb.map((value) => Math.round((value + m) * 255).toString(16).padStart(2, '0')).join('')}`
  }

  function hexToRgbText(hex) {
    const match = String(hex || '').match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i)
    if (!match) return '255, 255, 255'
    return match.slice(1).map((value) => parseInt(value, 16)).join(', ')
  }

  function parseRgbColor(value) {
    const numbers = String(value || '').match(/\d+(?:\.\d+)?/g)
    if (!numbers || numbers.length !== 3) return null
    const rgb = numbers.map((part) => Math.round(Number(part)))
    if (rgb.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) return null
    return `#${rgb.map((part) => part.toString(16).padStart(2, '0')).join('')}`
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    }[char]))
  }

  function attr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;')
  }

  function truncate(value, length = 120) {
    const text = String(value || '').replace(/\s+/g, ' ').trim()
    return text.length > length ? `${text.slice(0, length)}…` : text
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
    const whole = Math.floor(seconds)
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
  }

  function formatDuration(ms) {
    return formatTime(Number(ms || 0) / 1000)
  }

  function formatCount(value) {
    const count = Number(value || 0)
    if (count >= 100000000) return `${(count / 100000000).toFixed(1)} 亿`
    if (count >= 10000) return `${(count / 10000).toFixed(count >= 100000 ? 0 : 1)} 万`
    return String(count)
  }

  function formatBytes(value) {
    const bytes = Math.max(0, Number(value || 0))
    if (bytes < 1024) return `${Math.round(bytes)}B`
    const units = ['KB', 'MB', 'GB']
    let size = bytes / 1024
    let unit = units[0]
    for (let index = 1; index < units.length && size >= 1024; index += 1) {
      size /= 1024
      unit = units[index]
    }
    return `${size >= 100 ? size.toFixed(0) : size >= 10 ? size.toFixed(1) : size.toFixed(2)}${unit}`
  }

  function hashColor(text, offset = 0) {
    let hash = 2166136261 + offset
    for (const char of String(text)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
    const hue = Math.abs(hash) % 360
    return `hsl(${hue} 32% ${offset ? 34 : 44}%)`
  }

  const defaultFontLabel = '默认(Sarasa UI SC)'
  const localFontLoads = new Map()

  function cssFontName(value) {
    return `"${String(value).replace(/["\\]/g, '\\$&').replace(/[\r\n\f]/g, ' ')}"`
  }

  function localFontAlias(value) {
    return `MenoRadio Local ${String(value)}`
  }

  function ensureLocalFont(value) {
    const name = legacyFontNames[value] || String(value || '')
    if (!name || name === 'system' || typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return Promise.resolve(false)
    if (localFontLoads.has(name)) return localFontLoads.get(name)
    // GDI lists some faces (e.g. Yu Gothic UI Semilight) as families, while
    // DirectWrite only exposes their typographic family to CSS. local() also
    // resolves full face names, so keep a face alias behind the native family.
    const loading = Promise.resolve().then(() => {
      const face = new FontFace(localFontAlias(name), `local(${cssFontName(name)})`)
      return face.load()
    }).then((face) => {
      document.fonts.add(face)
      return true
    }).catch(() => false)
    localFontLoads.set(name, loading)
    return loading
  }

  function fontCss(value) {
    if (fontFamilies[value]) return fontFamilies[value]
    if (!value) return fontFamilies.system
    return `${cssFontName(value)}, ${cssFontName(localFontAlias(value))}, "MenoRadio Sarasa UI SC", "Microsoft YaHei UI", sans-serif`
  }

  function fontLabel(value) {
    if (value === 'system') return defaultFontLabel
    if (legacyFontNames[String(value || '').toLowerCase()]) return legacyFontNames[String(value).toLowerCase()]
    return String(value || defaultFontLabel)
  }

  function sizedImageUrl(value, size = 96) {
    const source = String(value || '').replace(/^http:/i, 'https:')
    if (!/^https:/i.test(source)) return source
    try {
      const url = new URL(source)
      const host = url.hostname.toLowerCase()
      if (!host.endsWith('music.126.net') && !host.endsWith('music.163.com')) return source
      const edge = Math.max(32, Math.min(1600, Math.round(Number(size) || 96)))
      url.searchParams.set('param', `${edge}y${edge}`)
      return url.toString()
    } catch {
      return source
    }
  }

  function upcomingTracks(queue, currentIndex, count = 3) {
    if (!Array.isArray(queue) || queue.length < 2 || count <= 0) return []
    const start = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < queue.length ? currentIndex : 0
    const result = []
    const seen = new Set([String(queue[start]?.id ?? '')])
    for (let offset = 1; offset < queue.length && result.length < count; offset += 1) {
      const track = queue[(start + offset) % queue.length]
      const key = String(track?.id ?? '')
      if (!track || !key || seen.has(key)) continue
      seen.add(key)
      result.push(track)
    }
    return result
  }

  window.MenoRadioCore = Object.assign(window.MenoRadioCore || {}, {
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
    ensureLocalFont,
    sizedImageUrl,
    upcomingTracks,
  })
})()
