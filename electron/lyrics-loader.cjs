const DEFAULT_HEDGE_DELAY_MS = 260
const DEFAULT_TIMEOUT_MS = 6000
const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000
const DEFAULT_CACHE_LIMIT = 160

function hasLyricsPayload(body) {
  if (!body || typeof body !== 'object') return false
  if (body.nolyric === true || body.uncollected === true) return true
  return ['yrc', 'lrc', 'tlyric', 'romalrc'].some((key) =>
    typeof body[key]?.lyric === 'string' && body[key].lyric.trim().length > 0
  )
}

function createLyricsLoader({
  fetchNew,
  fetchLegacy,
  hedgeDelayMs = DEFAULT_HEDGE_DELAY_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  cacheLimit = DEFAULT_CACHE_LIMIT,
} = {}) {
  if (typeof fetchNew !== 'function' || typeof fetchLegacy !== 'function') {
    throw new TypeError('Both lyric request functions are required')
  }

  const cache = new Map()
  const inflight = new Map()

  function remember(key, body) {
    cache.delete(key)
    cache.set(key, { body, expiresAt: Date.now() + cacheTtlMs })
    while (cache.size > cacheLimit) cache.delete(cache.keys().next().value)
    return body
  }

  function requestFastest(id) {
    return new Promise((resolve, reject) => {
      let settled = false
      let legacyStarted = false
      let failures = 0
      let lastError = null

      const finish = (body) => {
        if (settled || !hasLyricsPayload(body)) return false
        settled = true
        clearTimeout(hedgeTimer)
        clearTimeout(deadlineTimer)
        resolve(body)
        return true
      }

      const fail = (error) => {
        if (settled) return
        failures += 1
        lastError = error
        if (!legacyStarted) startLegacy()
        if (failures >= 2) {
          settled = true
          clearTimeout(hedgeTimer)
          clearTimeout(deadlineTimer)
          reject(lastError || new Error('歌词服务暂时不可用'))
        }
      }

      const run = (request) => {
        Promise.resolve()
          .then(() => request(id))
          .then((body) => {
            if (!finish(body)) fail(new Error('歌词响应无效'))
          }, fail)
      }

      const startLegacy = () => {
        if (legacyStarted || settled) return
        legacyStarted = true
        run(fetchLegacy)
      }

      const hedgeTimer = setTimeout(startLegacy, hedgeDelayMs)
      const deadlineTimer = setTimeout(() => {
        if (settled) return
        settled = true
        clearTimeout(hedgeTimer)
        reject(lastError || new Error('歌词请求超时'))
      }, timeoutMs)

      run(fetchNew)
    })
  }

  function load(id) {
    const key = String(id || '')
    if (!key) return Promise.reject(new Error('无效的歌曲'))

    const cached = cache.get(key)
    if (cached?.expiresAt > Date.now()) {
      cache.delete(key)
      cache.set(key, cached)
      return Promise.resolve(cached.body)
    }
    if (cached) cache.delete(key)
    if (inflight.has(key)) return inflight.get(key)

    const pending = requestFastest(key)
      .then((body) => remember(key, body))
      .finally(() => inflight.delete(key))
    inflight.set(key, pending)
    return pending
  }

  return { load, clear: () => cache.clear() }
}

module.exports = {
  hasLyricsPayload,
  createLyricsLoader,
}
