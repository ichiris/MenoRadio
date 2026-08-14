const assert = require('node:assert/strict')
const test = require('node:test')

const { createLyricsLoader, hasLyricsPayload } = require('../electron/lyrics-loader.cjs')

test('lyrics payload validation accepts lyrics and explicit no-lyrics responses', () => {
  assert.equal(hasLyricsPayload({ lrc: { lyric: '[00:01]line' } }), true)
  assert.equal(hasLyricsPayload({ yrc: { lyric: '   ' } }), false)
  assert.equal(hasLyricsPayload({ nolyric: true }), true)
  assert.equal(hasLyricsPayload({ code: 200 }), false)
})

test('lyrics loader returns the modern response without starting the fallback', async () => {
  let fallbackCalls = 0
  const loader = createLyricsLoader({
    fetchNew: async () => ({ lrc: { lyric: '[00:01]modern' } }),
    fetchLegacy: async () => {
      fallbackCalls += 1
      return { lrc: { lyric: '[00:01]legacy' } }
    },
    hedgeDelayMs: 20,
    timeoutMs: 100,
  })

  const body = await loader.load(1)
  assert.equal(body.lrc.lyric, '[00:01]modern')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(fallbackCalls, 0)
})

test('lyrics loader hedges a stalled modern request and deduplicates concurrent loads', async () => {
  let modernCalls = 0
  let fallbackCalls = 0
  const loader = createLyricsLoader({
    fetchNew: () => {
      modernCalls += 1
      return new Promise(() => {})
    },
    fetchLegacy: async () => {
      fallbackCalls += 1
      return { lrc: { lyric: '[00:01]fallback' } }
    },
    hedgeDelayMs: 2,
    timeoutMs: 100,
  })

  const [first, second] = await Promise.all([loader.load(2), loader.load(2)])
  assert.equal(first.lrc.lyric, '[00:01]fallback')
  assert.equal(second, first)
  assert.equal(modernCalls, 1)
  assert.equal(fallbackCalls, 1)

  const cached = await loader.load(2)
  assert.equal(cached, first)
  assert.equal(modernCalls, 1)
  assert.equal(fallbackCalls, 1)
})
