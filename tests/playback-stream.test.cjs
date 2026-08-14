const assert = require('node:assert/strict')
const test = require('node:test')

const {
  DEFAULT_SEGMENT_BYTES,
  playbackBytesPerSecond,
  boundedByteRange,
  parseContentRange,
} = require('../electron/playback-stream.cjs')

test('playback ranges clamp open-ended media requests to one small upstream segment', () => {
  const range = boundedByteRange('bytes=0-', 10 * 1024 * 1024)
  assert.deepEqual(range, {
    start: 0,
    end: DEFAULT_SEGMENT_BYTES - 1,
    length: DEFAULT_SEGMENT_BYTES,
    header: `bytes=0-${DEFAULT_SEGMENT_BYTES - 1}`,
  })
})

test('playback ranges preserve seeks and never cross the source length', () => {
  assert.deepEqual(boundedByteRange('bytes=900000-', 1000000), {
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

test('adaptive playback rate uses the current source only and keeps four megabits of headroom', () => {
  assert.equal(playbackBytesPerSecond({ br: 320000 }), 768 * 1024)
  assert.equal(playbackBytesPerSecond({ br: 4000000 }), 500000 + (512 * 1024))
  assert.equal(playbackBytesPerSecond({ size: 30000000, time: 300000 }), 768 * 1024)
})
