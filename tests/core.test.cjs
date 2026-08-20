const assert = require('node:assert/strict')
const test = require('node:test')

global.window = {}
require('../src/core/utils.js')
require('../src/core/playback-queue.js')
require('../src/core/lyrics-parser.js')

const core = global.window.MenoRadioCore

test('formatters retain renderer-facing output', () => {
  assert.equal(core.formatTime(61.9), '1:01')
  assert.equal(core.formatDuration(125000), '2:05')
  assert.equal(core.formatBytes(0), '0B')
  assert.equal(core.formatCount(12000), '1.2 万')
})

test('adaptive lyric sizing follows the rendered panel instead of viewport height', () => {
  assert.equal(core.adaptiveLyricFontSize(576, 610), 30)
  assert.equal(core.adaptiveLyricFontSize(1020, 1030), 40)
  assert.equal(core.adaptiveLyricFontSize(390, 610), core.adaptiveLyricFontSize(390, 1200))
  assert.equal(core.adaptiveLyricFontSize(300, 300), 24)
})

test('NetEase image helpers request bounded thumbnails without changing unrelated URLs', () => {
  assert.equal(core.sizedImageUrl('http://p1.music.126.net/cover.jpg', 94), 'https://p1.music.126.net/cover.jpg?param=94y94')
  assert.equal(core.sizedImageUrl('https://example.com/cover.jpg', 94), 'https://example.com/cover.jpg')
  assert.equal(core.sizedImageUrl('data:image/png;base64,AA', 94), 'data:image/png;base64,AA')
})

test('upcoming cover selection wraps once and excludes the current track', () => {
  const queue = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]
  assert.deepEqual(core.upcomingTracks(queue, 3, 3).map(({ id }) => id), [5, 1, 2])
  assert.deepEqual(core.upcomingTracks([{ id: 1 }], 0, 3), [])
})

test('queue construction preserves order and removes duplicate tracks', () => {
  const tracks = [{ id: 1 }, { id: 2 }, { id: 1 }, { id: 3 }]
  assert.deepEqual(core.buildPlaybackQueue(tracks, 'sequence').map(({ id }) => id), [1, 2, 3])
  assert.deepEqual(core.buildPlaybackQueue(tracks, 'repeat-one', tracks[1]).map(({ id }) => id), [1, 2, 3])
  assert.deepEqual(core.rotateTracks(core.uniqueTracks(tracks), 1).map(({ id }) => id), [2, 3, 1])

  const shuffled = core.buildPlaybackQueue(tracks, 'shuffle', tracks[1], true)
  assert.equal(shuffled[0].id, 2)
  assert.deepEqual(new Set(shuffled.map(({ id }) => id)), new Set([1, 2, 3]))
})

test('LRC parser keeps explicit instrumental breaks', () => {
  const parsed = core.parseLrcDocument('[00:01.20]第一句\n[00:10.00]\n[00:12.50]第二句')
  assert.deepEqual(parsed.lines, [
    { time: 1.2, text: '第一句' },
    { time: 12.5, text: '第二句' },
  ])
  assert.deepEqual(parsed.breaks, [10])
})

test('lyrics parsers discard production credits without turning them into instrumental breaks', () => {
  const parsed = core.parseLrcDocument('[00:01.00]作曲：yanaginagi\n[00:02.00]编曲：binaria\n[00:03.00]作词：Annabel\n[00:04.00]動き出す 身体の奥には')
  assert.deepEqual(parsed.lines, [{ time: 4, text: '動き出す 身体の奥には' }])
  assert.deepEqual(parsed.breaks, [])
  assert.deepEqual(core.parseYrc('[1000,800](1000,800,0)Composer: yanaginagi\n[2000,900](2000,900,0)動き出す'), [
    { time: 2, duration: .9, text: '動き出す' },
  ])
})

test('timed and translated lyrics merge by timestamp without mutating text', () => {
  const original = [{ time: 1, text: 'line' }]
  const timed = [{ time: 1.1, duration: 2, text: 'timed' }]
  const withDuration = core.applyTimedDurations(original, timed)
  assert.deepEqual(withDuration, [{ time: 1, duration: 2, text: 'line' }])
  assert.deepEqual(core.mergeLyrics(withDuration, [{ time: 1.04, text: '译文' }], []), [
    { time: 1, duration: 2, text: 'line', translation: '译文', romanization: '' },
  ])
})
