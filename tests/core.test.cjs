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
    { time: 2, duration: .9, text: '動き出す', words: [{ time: 2, duration: .9, text: '動き出す' }] },
  ])
})

test('YRC keeps timing and spacing, including a single nonempty fragment', () => {
  const [line] = core.parseYrc('[1000,2000](1000,600,0)Hold (1600,500,0)on (2100,900,0)tight')
  assert.equal(line.text, 'Hold on tight')
  assert.deepEqual(line.words, [
    { time: 1, duration: .6, text: 'Hold ' },
    { time: 1.6, duration: .5, text: 'on ' },
    { time: 2.1, duration: .9, text: 'tight' },
  ])
  assert.deepEqual(core.parseYrc('[2000,0](2000,0,0)あ')[0].words, [{ time: 2, duration: 0, text: 'あ' }])
})

test('valid YRC is used independently of LRC text, timing and line count', () => {
  const body = {
    lrc: { lyric: '[00:01.00]Entirely different original' },
    yrc: { lyric: '[21150,800](21150,800,0)綺麗\n[97370,600](97370,600,0)追加句' },
  }
  const document = core.buildLyricDocument(body, true)
  assert.deepEqual(document.lines.map((line) => line.text), ['綺麗', '追加句'])
  assert.deepEqual(document.lines.map((line) => line.time), [21.15, 97.37])
  assert.ok(document.lines.every((line) => line.words.length === 1))
  assert.deepEqual(document.breaks, [])
})

test('malformed YRC falls back as a whole instead of silently dropping broken lines', () => {
  const body = { lrc: { lyric: '[00:01.00]Fallback' } }
  for (const invalid of [
    '[1000,1000](1000,1000,0)Valid\n[2000,1000]Missing stamps',
    '[1000,1000](1000,1000,0)Valid\n[bad,1000](2000,1000,0)Broken',
    '[1000,1000](1000,1000,0)Valid\n[2000,1000](2000,not-a-number,0)Broken',
    '[9007199254740992,1000](1000,1000,0)Overflow',
  ]) {
    assert.deepEqual(core.parseYrc(invalid), [])
    const document = core.buildLyricDocument({ ...body, yrc: { lyric: invalid } }, true)
    assert.equal(document.lines[0].text, 'Fallback')
    assert.equal(document.lines[0].words, undefined)
  }
  assert.equal(core.parseYrc('{"t":0,"c":[{"tx":"Title"}]}\n[1000,1000](1000,1000,0)Solo').length, 1)
})

test('YRC translations use their own timestamps, with LRC translations as an optional fallback', () => {
  const body = {
    lrc: { lyric: '[00:20.59]Different text\n[00:23.19]Another line' },
    yrc: { lyric: '[21150,2170](21150,2170,0)綺麗\n[23320,2620](23320,2620,0)次の句' },
    tlyric: { lyric: '[00:20.59]LRC translation\n[00:23.19]下一句' },
    ytlrc: { lyric: '[00:21.15]YRC translation' },
    yromalrc: { lyric: '[00:21.15]kirei' },
  }
  const document = core.buildLyricDocument(body, true)
  assert.deepEqual(document.lines.map((line) => line.time), [21.15, 23.32])
  assert.equal(document.lines[0].translation, 'YRC translation')
  assert.equal(document.lines[0].romanization, 'kirei')
  assert.equal(document.lines[1].translation, '下一句')
})

test('disabling word timing restores LRC text and timestamps; YRC alone is still readable', () => {
  const body = { lrc: { lyric: '[00:01.00]Original' }, yrc: { lyric: '[2000,1000](2000,1000,0)Timed' } }
  const ordinary = core.buildLyricDocument(body, false)
  assert.equal(ordinary.lines[0].text, 'Original')
  assert.equal(ordinary.lines[0].time, 1)
  assert.equal(ordinary.lines[0].words, undefined)
  const yrcOnly = core.buildLyricDocument({ yrc: body.yrc }, false)
  assert.equal(yrcOnly.lines[0].text, 'Timed')
})

test('explicit blanks are delayed beyond the final YRC word, even when the line duration is shorter', () => {
  const body = {
    lrc: { lyric: '[00:01.00]前句\n[00:01.50]\n[00:12.00]后句' },
    yrc: { lyric: '[2000,1000](2000,500,0)前(2500,2000,0)句\n[12000,2000](12000,2000,0)后句' },
  }
  assert.deepEqual(core.buildLyricDocument(body).breaks, [4.5])
})

test('YRC never infers breaks and explicit short breaks need no minimum gap', () => {
  const lines = core.parseYrc('[1000,2000](1000,2000,0)前句\n[9000,2000](9000,2000,0)后句')
  assert.deepEqual(core.alignLyricBreaks(lines, []), [])
  assert.deepEqual(core.alignLyricBreaks(lines, [2.9]), [3])
  const short = core.parseYrc('[1000,1000](1000,1000,0)前句\n[2100,1000](2100,1000,0)后句')
  assert.deepEqual(core.alignLyricBreaks(short, [1.9]), [2])
  const continuous = core.parseYrc('[1000,2100](1000,2100,0)前句\n[3000,2000](3000,2000,0)后句')
  assert.deepEqual(core.alignLyricBreaks(continuous, [2.9]), [])
  const touching = core.parseYrc('[1000,2000](1000,2000,0)前句\n[3000,2000](3000,2000,0)后句')
  assert.deepEqual(core.alignLyricBreaks(touching, [2.9]), [])
  assert.deepEqual(core.alignLyricBreaks([{ time: 1, text: '普通' }, { time: 8, text: '歌词' }], [3]), [3])
})
