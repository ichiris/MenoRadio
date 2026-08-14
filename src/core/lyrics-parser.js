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

  function parseYrc(text) {
    const lines = []
    for (const raw of String(text || '').split(/\r?\n/)) {
      const stamp = raw.match(/^\[(\d+),(\d+)\]/)
      if (!stamp) continue
      const content = raw.replace(/^\[\d+,\d+\]/, '').replace(/\(\d+,\d+,\d+\)/g, '').trim()
      if (!content || isLyricMetadataLine(content)) continue
      lines.push({ time: Number(stamp[1]) / 1000, duration: Number(stamp[2]) / 1000, text: content })
    }
    return lines.sort((a, b) => a.time - b.time)
  }

  function applyTimedDurations(original, timed) {
    if (!original.length) return timed
    if (!timed.length) return original
    return original.map((line) => {
      const match = timed.find((candidate) => Math.abs(candidate.time - line.time) < .28)
      return match ? { ...line, duration: match.duration } : line
    })
  }

  function mergeLyrics(original, translated, romanized) {
    const translationMap = new Map(translated.map((line) => [Math.round(line.time * 10), line.text]))
    const romanizedMap = new Map(romanized.map((line) => [Math.round(line.time * 10), line.text]))
    return original.map((line) => ({
      ...line,
      translation: translationMap.get(Math.round(line.time * 10)) || '',
      romanization: romanizedMap.get(Math.round(line.time * 10)) || '',
    }))
  }

  window.MenoRadioCore = Object.assign(window.MenoRadioCore || {}, {
    lrcStampTime,
    isLyricMetadataLine,
    parseLrcDocument,
    parseLrc,
    parseYrc,
    applyTimedDurations,
    mergeLyrics,
  })
})()
