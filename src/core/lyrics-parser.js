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

  function compactLyricText(text) {
    // NFKC folds full-width brackets and ideographic spaces, which the two
    // lyric sources often write differently for the same line.
    return String(text || '').normalize('NFKC').replace(/\s+/g, '')
  }

  // Word stamps look like "(start,duration,0)text". The text of a word runs
  // until the next stamp and keeps its spacing so Latin lyrics stay readable.
  function parseYrcWords(body, content) {
    const stamps = [...body.matchAll(/\((\d+),(\d+),\d+\)/g)]
    const words = []
    stamps.forEach((stamp, index) => {
      const start = stamp.index + stamp[0].length
      const end = index + 1 < stamps.length ? stamps[index + 1].index : body.length
      const text = body.slice(start, end)
      if (!text.trim()) return
      words.push({ time: Number(stamp[1]) / 1000, duration: Number(stamp[2]) / 1000, text })
    })
    if (words.length < 2) return []
    words[0].text = words[0].text.trimStart()
    words[words.length - 1].text = words[words.length - 1].text.trimEnd()
    return compactLyricText(words.map((word) => word.text).join('')) === compactLyricText(content) ? words : []
  }

  function parseYrc(text) {
    const lines = []
    for (const raw of String(text || '').split(/\r?\n/)) {
      const stamp = raw.match(/^\[(\d+),(\d+)\]/)
      if (!stamp) continue
      const body = raw.replace(/^\[\d+,\d+\]/, '')
      const content = body.replace(/\(\d+,\d+,\d+\)/g, '').trim()
      if (!content || isLyricMetadataLine(content)) continue
      const line = { time: Number(stamp[1]) / 1000, duration: Number(stamp[2]) / 1000, text: content }
      const words = parseYrcWords(body, content)
      if (words.length) line.words = words
      lines.push(line)
    }
    return lines.sort((a, b) => a.time - b.time)
  }

  function applyTimedDurations(original, timed) {
    if (!original.length) return timed
    if (!timed.length) return original
    return original.map((line) => {
      // LRC and YRC are timed independently and commonly drift apart by half
      // a second. A line with identical text is matched across a wider window
      // (nearest wins, so repeated choruses stay paired with their own line);
      // a differing line only borrows the duration of a very close stamp.
      const text = compactLyricText(line.text)
      let sameText = null
      for (const candidate of timed) {
        const distance = Math.abs(candidate.time - line.time)
        if (distance > 8 || compactLyricText(candidate.text) !== text) continue
        if (!sameText || distance < Math.abs(sameText.time - line.time)) sameText = candidate
      }
      // A word-timed line follows the YRC clock, otherwise the line would be
      // left (or highlighted) before its words have been sung. lrcTime keeps
      // the original stamp, which translations are keyed by.
      if (sameText?.words?.length) return { ...line, time: sameText.time, lrcTime: line.time, duration: sameText.duration, words: sameText.words }
      if (sameText) return { ...line, duration: sameText.duration }
      const match = timed.find((candidate) => Math.abs(candidate.time - line.time) < .28)
      return match ? { ...line, duration: match.duration } : line
    }).sort((a, b) => a.time - b.time)
  }

  // Instrumental breaks. LRC blank stamps were written against the LRC clock,
  // so one landing while a word-timed line is still being sung moves to the
  // end of that line. YRC also knows when every line ends, so a long silence
  // after a word-timed line is a break even when the LRC never marked it.
  function alignLyricBreaks(lines, breaks, minimumGap = 4) {
    const result = []
    const lineBefore = (time) => {
      let index = -1
      while (index + 1 < lines.length && lines[index + 1].time <= time) index += 1
      return index
    }
    const sungUntil = (line) => {
      if (!line?.words?.length) return Number.NaN
      // Some line durations end before the final word's own timestamp. Neither
      // a blank LRC marker nor an inferred gap may interrupt that word.
      return Math.max(line.time + (Number(line.duration) || 0),
        ...line.words.map((word) => word.time + (Number(word.duration) || 0)))
    }
    // Blank markers still belong to the original LRC sequence, even if YRC
    // moves that line's start past the marker. Find its owner on that clock.
    const originalOrder = [...lines].sort((a, b) => (a.lrcTime ?? a.time) - (b.lrcTime ?? b.time))
    for (const marker of breaks) {
      const owner = originalOrder.filter((line) => (line.lrcTime ?? line.time) <= marker).at(-1)
      const index = owner ? lines.indexOf(owner) : lineBefore(marker)
      const end = sungUntil(lines[index])
      const value = Number.isFinite(end) ? Math.max(marker, end) : marker
      const next = lines[index + 1]
      if (!next || value < next.time) result.push(value)
    }
    lines.forEach((line, index) => {
      const end = sungUntil(line)
      const next = lines[index + 1]
      if (Number.isFinite(end) && next && next.time - end >= minimumGap) result.push(end)
    })
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

  window.MenoRadioCore = Object.assign(window.MenoRadioCore || {}, {
    lrcStampTime,
    isLyricMetadataLine,
    parseLrcDocument,
    parseLrc,
    parseYrc,
    applyTimedDurations,
    alignLyricBreaks,
    mergeLyrics,
  })
})()
