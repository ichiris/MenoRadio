const PLAYBACK_CRUISE_FACTOR = 1.5
const MIN_PLAYBACK_BYTES_PER_SECOND = 96 * 1024
const FALLBACK_PLAYBACK_BYTES_PER_SECOND = 192 * 1024
// Keep even very high bitrate tiers below the short full-bandwidth bursts that
// disturb latency-sensitive traffic. The buffer watermarks still give these
// formats room to start quickly without downloading the whole file.
const MAX_PLAYBACK_BYTES_PER_SECOND = Math.round(1.4 * 1024 * 1024)
const PLAYBACK_BURST_BYTES_PER_SECOND = Math.round(1.4 * 1024 * 1024)
const PLAYBACK_STARTUP_BYTES = 512 * 1024
const PLAYBACK_SEGMENT_BYTES = 128 * 1024
const PLAYBACK_BUFFER_LOW_SECONDS = 10
const PLAYBACK_BUFFER_HIGH_SECONDS = 25
const PLAYBACK_SEEK_PRIMING_MS = 2800
const PLAYBACK_RANGE_MINIMUM_SECONDS = 10

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function measuredBytesPerSecond(source = {}, track = {}) {
  const bitrate = positiveNumber(source.br)
  const size = positiveNumber(source.size)
  const durationMs = positiveNumber(source.time) || positiveNumber(track.duration)
  if (bitrate > 0) return bitrate / 8
  if (size > 0 && durationMs > 0) return size / (durationMs / 1000)
  return 0
}

function playbackBytesPerSecond(source = {}, track = {}) {
  const measured = measuredBytesPerSecond(source, track)
  if (!measured) return FALLBACK_PLAYBACK_BYTES_PER_SECOND
  return Math.round(Math.max(
    MIN_PLAYBACK_BYTES_PER_SECOND,
    Math.min(MAX_PLAYBACK_BYTES_PER_SECOND, measured * PLAYBACK_CRUISE_FACTOR),
  ))
}

function effectivePlaybackBytesPerSecond(source = {}, userLimit = 0) {
  const adaptive = playbackBytesPerSecond(source, source)
  const limit = positiveNumber(userLimit)
  return Math.round(limit > 0 ? Math.min(adaptive, limit) : adaptive)
}

function playbackBurstBytesPerSecond(source = {}, userLimit = 0) {
  const cruise = effectivePlaybackBytesPerSecond(source, userLimit)
  const limit = positiveNumber(userLimit)
  const burst = Math.max(cruise, PLAYBACK_BURST_BYTES_PER_SECOND)
  return Math.round(limit > 0 ? Math.min(burst, limit) : burst)
}

function playbackSegmentBytes(remaining = Number.MAX_SAFE_INTEGER) {
  const value = Math.max(0, Math.floor(Number(remaining) || 0))
  return Math.min(PLAYBACK_SEGMENT_BYTES, value)
}

function playbackRangeMinimumBytes(source = {}, track = {}) {
  const encodedBytesPerSecond = measuredBytesPerSecond(source, track)
    || FALLBACK_PLAYBACK_BYTES_PER_SECOND
  return Math.max(
    PLAYBACK_SEGMENT_BYTES * 2,
    Math.min(8 * 1024 * 1024, Math.round(encodedBytesPerSecond * PLAYBACK_RANGE_MINIMUM_SECONDS)),
  )
}

function playbackRangeIsPrimed(source = {}) {
  return Math.max(0, Number(source.rangeBytesPumped) || 0)
    >= Math.max(0, Number(source.rangeMinimumBytes) || 0)
}

function resetPlaybackBufferForSeek(source, now = Date.now()) {
  if (!source || source.cancelled) return false
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  source.bufferAheadSeconds = 0
  source.bufferKnown = false
  source.bufferGateClosed = false
  source.rangeBytesPumped = 0
  source.seekPrimingUntil = timestamp + PLAYBACK_SEEK_PRIMING_MS
  source.availableAt = Math.min(
    Number.isFinite(Number(source.availableAt)) ? Number(source.availableAt) : timestamp,
    timestamp,
  )
  return true
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
  PLAYBACK_STARTUP_BYTES,
  PLAYBACK_BUFFER_LOW_SECONDS,
  PLAYBACK_BUFFER_HIGH_SECONDS,
  PLAYBACK_SEEK_PRIMING_MS,
  playbackBytesPerSecond,
  effectivePlaybackBytesPerSecond,
  playbackBurstBytesPerSecond,
  playbackSegmentBytes,
  playbackRangeMinimumBytes,
  playbackRangeIsPrimed,
  resetPlaybackBufferForSeek,
  parseByteRange,
  requestedByteRange,
  parseContentRange,
}
