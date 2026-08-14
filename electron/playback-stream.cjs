const PLAYBACK_HEADROOM_BYTES_PER_SECOND = 512 * 1024
const MIN_PLAYBACK_BYTES_PER_SECOND = 768 * 1024
const MAX_PLAYBACK_BYTES_PER_SECOND = 16 * 1024 * 1024

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function playbackBytesPerSecond(source = {}, track = {}) {
  const bitrate = positiveNumber(source.br)
  const size = positiveNumber(source.size)
  const durationMs = positiveNumber(source.time) || positiveNumber(track.duration)
  const measured = bitrate > 0
    ? bitrate / 8
    : (size > 0 && durationMs > 0 ? size / (durationMs / 1000) : 0)
  return Math.round(Math.max(
    MIN_PLAYBACK_BYTES_PER_SECOND,
    Math.min(MAX_PLAYBACK_BYTES_PER_SECOND, measured + PLAYBACK_HEADROOM_BYTES_PER_SECOND),
  ))
}

function parseByteRange(value) {
  const match = /^bytes=(\d+)-(\d*)$/i.exec(String(value || '').trim())
  if (!match) return { start: 0, end: null }
  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : null
  if (!Number.isSafeInteger(start) || start < 0) return { start: 0, end: null }
  if (end !== null && (!Number.isSafeInteger(end) || end < start)) return { start: 0, end: null }
  return { start, end }
}

function requestedByteRange(value, totalBytes = 0) {
  const requested = parseByteRange(value)
  const total = Math.max(0, Math.floor(positiveNumber(totalBytes)))
  const maximumEnd = total > 0 ? total - 1 : Number.MAX_SAFE_INTEGER
  const requestedEnd = requested.end === null ? maximumEnd : Math.min(requested.end, maximumEnd)
  const end = requestedEnd
  return {
    start: requested.start,
    end,
    length: total > 0 || requested.end !== null ? Math.max(0, end - requested.start + 1) : 0,
    header: `bytes=${requested.start}-${end === Number.MAX_SAFE_INTEGER ? '' : end}`,
  }
}

function effectivePlaybackBytesPerSecond(source = {}, userLimit = 0) {
  const adaptive = playbackBytesPerSecond(source, source)
  const limit = positiveNumber(userLimit)
  return Math.round(limit > 0 ? Math.min(adaptive, limit) : adaptive)
}

function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || '').trim())
  if (!match) return null
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? 0 : Number(match[3]),
  }
}

module.exports = {
  playbackBytesPerSecond,
  effectivePlaybackBytesPerSecond,
  parseByteRange,
  requestedByteRange,
  parseContentRange,
}
