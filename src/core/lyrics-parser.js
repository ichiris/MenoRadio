(() => {
  function lrcStampTime(stamp) {
    const fraction = Number(`0.${String(stamp[3] || '0').padEnd(2, '0').slice(0, 3)}`)
    return Number(stamp[1]) * 60 + Number(stamp[2]) + fraction
  }

  function isLyricMetadataLine(text) {
    const value = String(text || '').trim().replace(/^[【\[]\s*|\s*[】\]]$/g, '')
    if (!value) return false
    return /^(?:(?:作[词詞曲]|填[词詞]|[编編]曲|[词詞]曲|制作人|製作人|[监監]制|混音|母[带帶]|[录錄]音|和[声聲]|人[声聲][编編]辑|配唱制作人|吉他|[贝貝]斯|鼓手)\s*[:：]|(?:lyrics?|lyricist|composer|arranger|producer|produced\s+by|mixed\s+by|mastered\s+by)\s*[:：])/i.test(value)
  }

  function parseLrcDocument(text) {
    const lines = []
    const breaks = []
    for (const raw of String(text || '').split(/\r?\n/)) {
      const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
      if (!stamps.length) continue
      const content = raw.replace(/\[[^\]]+\]/g, '').trim()
      if (content && isLyricMetadataLine(content)) continue
      for (const stamp of stamps) {
        const time = lrcStampTime(stamp)
        if (content) lines.push({ time, text: content })
        else breaks.push(time)
      }
    }
    return {
      lines: lines.sort((a, b) => a.time - b.time),
      breaks: [...new Set(breaks)].sort((a, b) => a - b),
    }
  }

  function parseLrc(text) {
    return parseLrcDocument(text).lines
  }

  // A complete YRC document stands on its own: LRC text, timing and line
  // counts never determine whether a word-timed line can be displayed.
  function parseYrc(text) {
    const lines = []
    const milliseconds = (value) => {
      const number = Number(value)
      return Number.isSafeInteger(number) && number >= 0 ? number / 1000 : Number.NaN
    }
    for (const raw of String(text || '').split(/\r?\n/)) {
      const value = raw.trim()
      if (!value) continue
      // NetEase may include JSON credit records alongside the timed lines.
      if (value.startsWith('{')) {
        try {
          const metadata = JSON.parse(value)
          if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return []
        } catch { return [] }
        continue
      }
      const stamp = value.match(/^\[(\d+),(\d+)\]/)
      if (!stamp) return []
      const time = milliseconds(stamp[1])
      const duration = milliseconds(stamp[2])
      if (!Number.isFinite(time + duration)) return []
      const body = value.slice(stamp[0].length)
      if (!body.trim()) continue
      const stamps = [...body.matchAll(/\((\d+),(\d+),\d+\)/g)]
      if (!stamps.length || body.slice(0, stamps[0].index).trim()) return []
      const words = []
      for (let index = 0; index < stamps.length; index += 1) {
        const wordStamp = stamps[index]
        const start = wordStamp.index + wordStamp[0].length
        const end = stamps[index + 1]?.index ?? body.length
        const text = body.slice(start, end)
        const wordTime = milliseconds(wordStamp[1])
        const wordDuration = milliseconds(wordStamp[2])
        if (!Number.isFinite(wordTime + wordDuration) || /\(\d+,[^)]*\)/.test(text)) return []
        words.push({ time: wordTime, duration: wordDuration, text })
      }
      words[0].text = words[0].text.trimStart()
      words[words.length - 1].text = words[words.length - 1].text.trimEnd()
      const visibleWords = words.filter((word) => word.text.length)
      const content = visibleWords.map((word) => word.text).join('')
      if (!content.trim() || isLyricMetadataLine(content)) continue
      lines.push({ time, duration, text: content, words: visibleWords })
    }
    return lines.sort((a, b) => a.time - b.time)
  }

  // Only timestamped LRC blank lines are breaks. If a marker interrupts a
  // word-timed line, delay it until the line and its last word both finish.
  function alignLyricBreaks(lines, breaks) {
    const result = []
    const originalOrder = [...lines].sort((a, b) => (a.lrcTime ?? a.time) - (b.lrcTime ?? b.time))
    for (const marker of breaks) {
      if (!Number.isFinite(marker)) continue
      const owner = originalOrder.filter((line) => (line.lrcTime ?? line.time) <= marker).at(-1)
      const index = owner ? lines.indexOf(owner) : -1
      const end = owner?.words?.length
        ? Math.max(owner.time + (Number(owner.duration) || 0),
          ...owner.words.map((word) => word.time + (Number(word.duration) || 0)))
        : Number.NaN
      const value = Number.isFinite(end) ? Math.max(marker, end) : marker
      const next = lines[index + 1]
      if (!next || value < next.time) result.push(value)
    }
    return [...new Set(result.map((value) => Math.round(value * 1000) / 1000))].sort((a, b) => a - b)
  }

  function mergeLyrics(original, translated, romanized) {
    const translationMap = new Map(translated.map((line) => [Math.round(line.time * 10), line.text]))
    const romanizedMap = new Map(romanized.map((line) => [Math.round(line.time * 10), line.text]))
    return original.map((line) => {
      const key = Math.round((line.lrcTime ?? line.time) * 10)
      return {
        ...line,
        translation: translationMap.get(key) || '',
        romanization: romanizedMap.get(key) || '',
      }
    })
  }

  function buildLyricDocument(body, useWordTiming = true) {
    const original = parseLrcDocument(body?.lrc?.lyric)
    const timed = parseYrc(body?.yrc?.lyric)
    const useYrc = timed.length > 0 && (useWordTiming || !original.lines.length)
    // Equal line counts allow an ordinal link to LRC translations and blank
    // markers. This optional link never filters or changes the YRC lines.
    const linked = useYrc ? timed.map((line, index) => original.lines.length === timed.length
      ? { ...line, lrcTime: original.lines[index].time } : line) : original.lines
    let lines = mergeLyrics(linked, parseLrc(body?.tlyric?.lyric), parseLrc(body?.romalrc?.lyric))
    if (useYrc) {
      const extras = mergeLyrics(timed, parseLrc(body?.ytlrc?.lyric), parseLrc(body?.yromalrc?.lyric))
      lines = lines.map((line, index) => ({ ...line,
        translation: extras[index].translation || line.translation,
        romanization: extras[index].romanization || line.romanization,
      }))
    }
    return { lines, breaks: alignLyricBreaks(lines, original.breaks) }
  }

  window.MenoRadioCore = Object.assign(window.MenoRadioCore || {}, {
    lrcStampTime,
    isLyricMetadataLine,
    parseLrcDocument,
    parseLrc,
    parseYrc,
    alignLyricBreaks,
    mergeLyrics,
    buildLyricDocument,
  })
})()
