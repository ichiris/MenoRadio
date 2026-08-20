const assert = require('node:assert/strict')
const test = require('node:test')

const {
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
  requestedByteRange,
  parseContentRange,
} = require('../electron/playback-stream.cjs')
const {
  normalizeAudioQuality,
  requestedApiAudioQuality,
} = require('../electron/audio-quality.cjs')

test('playback ranges preserve one continuous open-ended media response', () => {
  const range = requestedByteRange('bytes=0-', 10 * 1024 * 1024)
  assert.deepEqual(range, {
    start: 0,
    end: (10 * 1024 * 1024) - 1,
    length: 10 * 1024 * 1024,
    header: `bytes=0-${(10 * 1024 * 1024) - 1}`,
  })
})

test('playback ranges preserve seeks and never cross the source length', () => {
  assert.deepEqual(requestedByteRange('bytes=900000-', 1000000), {
    start: 900000,
    end: 999999,
    length: 100000,
    header: 'bytes=900000-999999',
  })
  assert.deepEqual(parseContentRange('bytes 900000-999999/1000000'), {
    start: 900000,
    end: 999999,
    total: 1000000,
  })
})

test('adaptive playback rate follows encoded bitrate instead of flooding the whole file', () => {
  assert.equal(playbackBytesPerSecond({ br: 320000 }), 96 * 1024)
  assert.equal(playbackBytesPerSecond({ br: 4000000 }), 750000)
  assert.equal(playbackBytesPerSecond({ size: 30000000, time: 300000 }), 150000)
  assert.equal(playbackBytesPerSecond({}), 192 * 1024)
})

test('startup burst and user cap remain bounded', () => {
  assert.equal(playbackBurstBytesPerSecond({ br: 320000 }, 0), Math.round(1.4 * 1024 * 1024))
  assert.equal(playbackBurstBytesPerSecond({ br: 4000000 }, 900000), 900000)
  assert.equal(effectivePlaybackBytesPerSecond({ br: 4000000 }, 600000), 600000)
})

test('network segments are small and buffer watermarks stay ordered', () => {
  assert.equal(playbackSegmentBytes(10 * 1024 * 1024), 128 * 1024)
  assert.equal(playbackSegmentBytes(4096), 4096)
  assert.equal(PLAYBACK_STARTUP_BYTES, 512 * 1024)
  assert.ok(PLAYBACK_BUFFER_LOW_SECONDS < PLAYBACK_BUFFER_HIGH_SECONDS)
})

test('seeking clears stale buffered-ahead state and temporarily opens the gate', () => {
  const source = {
    bufferAheadSeconds: 42,
    bufferKnown: true,
    bufferGateClosed: true,
    rangeBytesPumped: 900000,
    availableAt: 5000,
    cancelled: false,
  }
  assert.equal(resetPlaybackBufferForSeek(source, 4000), true)
  assert.equal(source.bufferAheadSeconds, 0)
  assert.equal(source.bufferKnown, false)
  assert.equal(source.bufferGateClosed, false)
  assert.equal(source.rangeBytesPumped, 0)
  assert.equal(source.availableAt, 4000)
  assert.equal(source.seekPrimingUntil, 4000 + PLAYBACK_SEEK_PRIMING_MS)
})

test('a fresh range must provide its own playable bytes before the buffer gate can close', () => {
  const rangeMinimumBytes = playbackRangeMinimumBytes({ br: 320000 })
  const source = { rangeMinimumBytes, rangeBytesPumped: rangeMinimumBytes - 1 }
  assert.equal(rangeMinimumBytes, 400000)
  assert.equal(playbackRangeIsPrimed(source), false)
  source.rangeBytesPumped += 1
  assert.equal(playbackRangeIsPrimed(source), true)
})

test('current NetEase quality levels pass through and legacy values migrate', () => {
  assert.equal(normalizeAudioQuality('standard'), 'standard')
  assert.equal(normalizeAudioQuality('hires'), 'hires')
  assert.equal(normalizeAudioQuality('jyeffect'), 'jyeffect')
  assert.equal(normalizeAudioQuality('jymaster'), 'jymaster')
  assert.equal(normalizeAudioQuality('higher'), 'exhigh')
  assert.equal(normalizeAudioQuality('dolby'), 'sky')
  assert.equal(normalizeAudioQuality('unknown'), 'best')
  assert.equal(requestedApiAudioQuality('best'), 'jymaster')
  assert.equal(requestedApiAudioQuality('lossless'), 'lossless')
})
