const assert = require('node:assert/strict')
const test = require('node:test')

const {
  playbackBytesPerSecond,
  effectivePlaybackBytesPerSecond,
  requestedByteRange,
  parseContentRange,
} = require('../electron/playback-stream.cjs')

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

test('adaptive playback rate uses the current source only and keeps four megabits of headroom', () => {
  assert.equal(playbackBytesPerSecond({ br: 320000 }), 768 * 1024)
  assert.equal(playbackBytesPerSecond({ br: 4000000 }), 500000 + (512 * 1024))
  assert.equal(playbackBytesPerSecond({ size: 30000000, time: 300000 }), 768 * 1024)
})

test('a user media limit caps playback without changing the adaptive default', () => {
  assert.equal(effectivePlaybackBytesPerSecond({ br: 4000000 }, 0), 500000 + (512 * 1024))
  assert.equal(effectivePlaybackBytesPerSecond({ br: 4000000 }, 900000), 900000)
})
