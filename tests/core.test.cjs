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


test('installed face aliases retain native families, bundled fallback and safe CSS names', () => {
  assert.ok(core.fontCss('system').startsWith('"MenoRadio Sarasa UI SC",'))
  assert.ok(core.fontCss('Yu Gothic UI Semilight').startsWith('"Yu Gothic UI Semilight", "MenoRadio Local Yu Gothic UI Semilight",'))
  assert.ok(core.fontCss('Sarasa UI SC').startsWith('"Sarasa UI SC",'))
  assert.ok(core.fontCss('Yu Gothic UI Semilight').includes('"MenoRadio Sarasa UI SC"'))
  assert.equal(core.fontCss(''), core.fontCss('system'))
  assert.ok(core.fontCss('Quoted "Face"').includes(String.raw`"Quoted \"Face\""`))
})

test('local face loading is shared, resolves complete face names and fails without replacing the selected font', async () => {
  const vm = require('node:vm')
  const fs = require('node:fs')
  const path = require('node:path')
  const faces = [], registered = []
  const context = vm.createContext({
    window: {}, document: { fonts: { add: (face) => registered.push(face) } },
    FontFace: class {
      constructor(family, source) { this.family = family; this.source = source; faces.push(this) }
      load() { return this.source.includes('Missing') ? Promise.reject(new Error('Unavailable')) : Promise.resolve(this) }
    },
  })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/core/utils.js'), 'utf8'), context)
  const fonts = context.window.MenoRadioCore
  const first = fonts.ensureLocalFont('Yu Gothic UI Semilight')
  assert.equal(first, fonts.ensureLocalFont('Yu Gothic UI Semilight'))
  assert.equal(await first, true)
  assert.equal(faces[0].source, 'local("Yu Gothic UI Semilight")')
  assert.equal(faces[0].family, 'MenoRadio Local Yu Gothic UI Semilight')
  assert.equal(registered.length, 1)
  assert.equal(await fonts.ensureLocalFont('Missing font'), false)
  assert.equal(registered.length, 1)
  assert.ok(fonts.fontCss('Missing font').startsWith('"Missing font",'))
  assert.equal(await fonts.ensureLocalFont('system'), false)
  assert.equal(faces.length, 2)
})

function lyricMotionRenderer() {
  const fs = require('node:fs')
  const path = require('node:path')
  const vm = require('node:vm')
  let rectReads = 0
  const animations = []
  const scroller = { scrollHeight: 30000, clientHeight: 800, scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 800 }) }
  const lines = Array.from({ length: 300 }, (_, index) => ({
    getBoundingClientRect() { rectReads += 1; return { top: index * 100 - scroller.scrollTop, bottom: index * 100 + 80 - scroller.scrollTop } },
    getAnimations: () => [],
    animate(frames, options) {
      animations.push({ index, frames, options })
      return { addEventListener() {} }
    },
  }))
  const context = vm.createContext({
    state: { focusLyric: 0 },
    dom: { lyricsScroller: scroller, immersive: { classList: { contains: () => true } } },
    $$: () => lines,
    matchMedia: () => ({ matches: false }),
    cancelAnimationFrame() {},
    getComputedStyle() { throw new Error('Immediate alignment must not read computed styles') },
  })
  const source = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8')
  for (const name of ['smootherStep', 'softenedLyricMotionProgress', 'lyricSpringFrames', 'setLyricScrollTarget', 'lyricOpacitySnapshot', 'animateLyricWordLift']) {
    const fn = source.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'))
    assert.ok(fn)
    vm.runInContext(fn[0], context)
  }
  return { context, scroller, animations, rectReads: () => rectReads }
}

test('initial lyric alignment does not measure every line or create animations', () => {
  const r = lyricMotionRenderer()
  r.context.setLyricScrollTarget(5100, true)
  assert.equal(r.scroller.scrollTop, 5100)
  assert.equal(r.rectReads(), 0)
  assert.equal(r.animations.length, 0)
  assert.equal(r.context.lyricOpacitySnapshot({}, .34, true), .34)
})

test('word highlight state stays current while hidden without reading styles or animating glyphs', () => {
  const r = lyricMotionRenderer()
  r.context.dom.immersive.classList.contains = () => false
  const classes = new Set()
  const word = {
    classList: { contains: (name) => classes.has(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
    getAnimations: () => [],
    animate() { throw new Error('Hidden words must not start animations') },
  }
  r.context.animateLyricWordLift(word, true)
  assert.equal(classes.has('sung'), true)
  r.context.animateLyricWordLift(word, false)
  assert.equal(classes.has('sung'), false)
})

test('lyric motion keeps the visible spring trajectory and skips lines that never enter the panel', () => {
  const r = lyricMotionRenderer()
  r.context.setLyricScrollTarget(100, false, 1)
  assert.equal(r.scroller.scrollTop, 100)
  assert.ok(r.animations.length < 15, 'A single-line move must not animate all 300 lines')
  for (let index = 0; index < 9; index += 1) {
    const animation = r.animations.find((item) => item.index === index)
    assert.ok(animation, 'Every visible/incoming line retains its animation')
    assert.equal(JSON.stringify(animation.frames), JSON.stringify(r.context.lyricSpringFrames(100, Math.max(0, index - 1))))
  }
  // The culling allowance contains the full spring path, including its rebound.
  for (const depth of [0, 1, 6, 100]) {
    for (const frame of r.context.lyricSpringFrames(100, depth)) {
      const displacement = Number(frame.transform.match(/-?\d+(?:\.\d+)?/)[0])
      assert.ok(displacement >= -20 && displacement <= 100)
    }
  }
  // A large seek still animates all lines that travel through the viewport.
  r.animations.length = 0
  r.scroller.scrollTop = 0
  r.context.setLyricScrollTarget(10000, false, 100)
  for (let index = 0; index <= 107; index += 1) {
    assert.ok(r.animations.some((item) => item.index === index))
  }
})

function immersiveTransitionRenderer() {
  const fs = require('node:fs')
  const path = require('node:path')
  const vm = require('node:vm')
  const frames = [], idle = [], timers = []
  const classList = () => {
    const classes = new Set()
    return { contains: (name) => classes.has(name), add: (...names) => names.forEach((name) => classes.add(name)), remove: (...names) => names.forEach((name) => classes.delete(name)), toggle: (name, on) => on ? classes.add(name) : classes.delete(name) }
  }
  const player = { classList: classList(), inert: true, setAttribute(name, value) { this[name] = value } }
  let clock = 1000
  const context = vm.createContext({
    state: { current: { id: 1 }, audioLoadGeneration: 1, coverReadyGeneration: 1, lyricsReadyGeneration: 1, immersiveTransitionGeneration: 0, immersiveSurfaceRevision: 0, immersiveSurfacePrepared: false, immersiveSurfaceCooldownUntil: 0 },
    dom: { immersive: player, app: { classList: classList() } },
    document: { hidden: false, body: { classList: classList(), style: { setProperty(name, value) { this[name] = value }, removeProperty(name) { delete this[name] } } } },
    window: { requestIdleCallback: (fn) => { idle.push(fn); return idle.length }, setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length } },
    immersiveFontWarmupEnabled: true,
    matchMedia: () => ({ matches: false }),
    performance: { now: () => clock },
    requestAnimationFrame: (fn) => frames.push(fn), clearTimeout() {},
    applyImmersiveLayout() {}, syncFloatingLyrics() {}, syncLyricWords() {}, showImmersiveChrome() {},
    setImmersiveView() {}, setImmersiveVolumePopover() {},
    $: () => ({ classList: classList(), setAttribute() {} }),
  })
  const source = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8')
  for (const name of ['syncImmersiveAppPresentation', 'afterImmersivePaints', 'warmImmersiveSurface', 'scheduleImmersiveSurfaceWarmup', 'commitImmersiveVisibility', 'openImmersive']) {
    const fn = source.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'))
    assert.ok(fn)
    vm.runInContext(fn[0], context)
  }
  return {
    context, player, idle, timers,
    async frame() { clock += 16; frames.splice(0).forEach((fn) => fn(clock)); await Promise.resolve() },
    async finish() { for (let index = 0; index < 6; index += 1) await this.frame() },
  }
}

test('cold entrance starts after prepainting and resetting the closed surface; normal exit retains the page', async () => {
  const r = immersiveTransitionRenderer()
  r.context.openImmersive(true)
  assert.equal(r.player.classList.contains('open'), false)
  assert.equal(r.player.classList.contains('render-warming'), true)
  assert.equal(r.player.inert, true)
  await r.frame()
  await r.frame()
  assert.equal(r.player.classList.contains('render-warming'), true)
  await r.frame()
  assert.equal(r.player.classList.contains('render-warming'), false)
  assert.equal(r.player.classList.contains('render-reset'), true)
  await r.finish()
  assert.equal(r.player.classList.contains('open'), true)
  assert.equal(r.player.classList.contains('render-reset'), false)
  assert.equal(r.player.inert, false)
  assert.equal(r.player['aria-hidden'], 'false')
  assert.equal(r.context.dom.app.classList.contains('immersive-receded'), true)
  assert.equal(r.context.document.body.style['background-color'], '#0a0b0d')
  assert.equal(r.timers.length, 0, 'Ordinary playback must not discard the underlying page')
  r.context.openImmersive(false)
  assert.equal(r.player.inert, true)
  assert.equal(r.player.classList.contains('open'), false)
  assert.equal(r.context.document.body.classList.contains('immersive-app-suspended'), false)
  assert.equal(r.context.dom.app.classList.contains('immersive-receded'), false)
  assert.equal(r.context.document.body.style['background-color'], undefined)
})

test('rapid open-close-open cannot commit an obsolete entrance or skip its reset', async () => {
  const r = immersiveTransitionRenderer()
  r.context.openImmersive(true)
  r.context.openImmersive(false)
  await r.finish()
  assert.equal(r.player.classList.contains('open'), false)
  r.context.state.immersiveSurfacePrepared = false
  r.context.openImmersive(true)
  r.context.openImmersive(false)
  r.context.openImmersive(true)
  assert.equal(r.player.classList.contains('open'), false)
  await r.finish()
  assert.equal(r.player.classList.contains('open'), true)
  assert.equal(r.player.classList.contains('render-warming'), false)
})

test('an exit following live resize restores the underlying page before sliding away', async () => {
  const r = immersiveTransitionRenderer()
  r.context.state.immersiveSurfacePrepared = true
  r.context.openImmersive(true)
  r.context.document.body.classList.add('immersive-app-suspended')
  r.context.openImmersive(false)
  assert.equal(r.context.document.body.classList.contains('immersive-app-suspended'), false)
  assert.equal(r.player.classList.contains('open'), true)
  await r.finish()
  assert.equal(r.player.classList.contains('open'), false)
})

test('prepainting is shared, invalidates changed artwork and does not interrupt exit', async () => {
  const r = immersiveTransitionRenderer()
  const first = r.context.warmImmersiveSurface()
  assert.equal(first, r.context.warmImmersiveSurface())
  r.context.scheduleImmersiveSurfaceWarmup()
  await r.finish()
  await first
  assert.equal(r.context.state.immersiveSurfacePrepared, false)
  assert.equal(r.idle.length, 1, 'Changed content must be prepainted again')
  r.context.state.immersiveSurfaceCooldownUntil = 1660
  r.context.scheduleImmersiveSurfaceWarmup(false)
  assert.equal(r.player.classList.contains('render-warming'), false)
})

test('legacy player and reduced motion enter without prepainting delays', async () => {
  for (const legacy of [true, false]) {
    const r = immersiveTransitionRenderer()
    r.context.state.legacyPlayer = legacy
    if (!legacy) r.context.matchMedia = () => ({ matches: true })
    r.context.openImmersive(true)
    await Promise.resolve()
    assert.equal(r.player.classList.contains('open'), true)
    assert.equal(r.player.classList.contains('render-warming'), false)
    assert.equal(r.context.dom.app.classList.contains('immersive-receded'), !legacy)
  }
})

test('changing to legacy while open restores the main page presentation', async () => {
  const r = immersiveTransitionRenderer()
  r.context.state.immersiveSurfacePrepared = true
  r.context.openImmersive(true)
  r.context.state.legacyPlayer = true
  r.context.syncImmersiveAppPresentation()
  assert.equal(r.context.dom.app.classList.contains('immersive-receded'), false)
  assert.equal(r.context.document.body.style['background-color'], undefined)
})

test('unsung words retain constant brightness through line fades without rewriting settled styles', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
  const source = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8')
  const values = new Map([['--lyric-opacity', '1']])
  let fading = false, reads = 0, writes = 0
  const context = vm.createContext({
    lyricUnsungAlpha: .34,
    lyricOpacityAnimating: () => fading,
    getComputedStyle: () => { reads += 1; return { opacity: '.5' } },
  })
  vm.runInContext(source.match(/^function applyLyricWordRest\([^]*?^}/m)[0], context)
  const line = { style: {
    getPropertyValue: (name) => values.get(name) || '',
    setProperty: (name, value) => { writes += 1; values.set(name, value) },
  } }
  context.applyLyricWordRest(line)
  context.applyLyricWordRest(line)
  assert.equal(reads, 0)
  assert.equal(writes, 1)
  assert.equal(values.get('--word-rest'), '0.340')
  fading = true
  context.applyLyricWordRest(line)
  assert.equal(reads, 1)
  assert.equal(values.get('--word-rest'), '0.680', 'Live opacity still compensates unsung brightness during fades')
  fading = false
  values.set('--lyric-opacity', '.34')
  context.applyLyricWordRest(line)
  assert.equal(values.get('--word-rest'), '1.000')
})
