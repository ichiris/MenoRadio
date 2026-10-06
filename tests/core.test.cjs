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

test('word-timed lyrics keep per-word timing when the words rebuild the line', () => {
  const [line] = core.parseYrc('[1000,2000](1000,600,0)Hold (1600,500,0)on (2100,900,0)tight')
  assert.equal(line.text, 'Hold on tight')
  assert.deepEqual(line.words, [
    { time: 1, duration: .6, text: 'Hold ' },
    { time: 1.6, duration: .5, text: 'on ' },
    { time: 2.1, duration: .9, text: 'tight' },
  ])
  const matched = core.applyTimedDurations([{ time: 1, text: 'Hold on tight' }], [line])
  assert.deepEqual(matched[0].words, line.words)
  const mismatched = core.applyTimedDurations([{ time: 1, text: 'Something else' }], [line])
  assert.deepEqual(mismatched, [{ time: 1, duration: 2, text: 'Something else' }])
})

test('word timing survives LRC/YRC drift and full-width punctuation differences', () => {
  const timed = core.parseYrc('[21150,800](21150,400,0)綺(21550,400,0)麗\n[97370,600](97370,300,0)（(97670,300,0)酔）')
  const merged = core.applyTimedDurations([
    { time: 20.59, text: '綺麗' },
    { time: 90.9, text: '(酔)' },
  ], timed)
  assert.equal(merged[0].words?.length, 2)
  assert.equal(merged[1].words?.length, 2)
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

test('YRC starts drive line timing while translations retain their LRC timestamps', () => {
  const lrc = core.parseLrcDocument('[00:20.59]綺麗\n[00:23.19]次の句')
  const yrc = core.parseYrc('[21150,2170](21150,180,0)綺(21330,1990,0)麗\n[23320,2620](23320,1000,0)次の(24320,1620,0)句')
  const lines = core.applyTimedDurations(lrc.lines, yrc)
  const merged = core.mergeLyrics(lines, [{ time: 20.59, text: '美丽' }, { time: 23.19, text: '下一句' }], [{ time: 20.59, text: 'kirei' }])
  assert.deepEqual(merged.map((line) => line.time), [21.15, 23.32])
  assert.equal(merged[0].translation, '美丽')
  assert.equal(merged[0].romanization, 'kirei')
  assert.equal(merged[1].translation, '下一句')
  assert.equal(lrc.lines[0].time, 20.59)
})

test('blank LRC markers cannot interrupt YRC words, including a delayed YRC start', () => {
  const lrc = core.parseLrcDocument('[00:01.00]前句\n[00:01.50]\n[00:12.00]后句')
  const yrc = core.parseYrc('[2000,1000](2000,500,0)前(2500,2000,0)句\n[12000,2000](12000,1000,0)后(13000,1000,0)句')
  const lines = core.applyTimedDurations(lrc.lines, yrc)
  assert.deepEqual(core.alignLyricBreaks(lines, lrc.breaks), [4.5])
})

test('YRC end times infer instrumental gaps and discard markers that run into the next line', () => {
  const lines = core.parseYrc('[1000,2000](1000,1000,0)前(2000,1000,0)句\n[9000,2000](9000,1000,0)后(10000,1000,0)句')
  assert.deepEqual(core.alignLyricBreaks(lines, []), [3])
  const continuous = core.parseYrc('[1000,2100](1000,1000,0)前(2000,1100,0)句\n[3000,2000](3000,1000,0)后(4000,1000,0)句')
  assert.deepEqual(core.alignLyricBreaks(continuous, [2.9]), [])
  assert.deepEqual(core.alignLyricBreaks([{ time: 1, text: '普通' }, { time: 8, text: '歌词' }], [3]), [3])
})
