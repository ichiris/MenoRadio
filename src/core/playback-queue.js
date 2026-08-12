(() => {
  function uniqueTracks(tracks = []) {
    const seen = new Set()
    return tracks.filter((track) => {
      const id = String(track?.id ?? '')
      if (!id || seen.has(id)) return false
      seen.add(id)
      return true
    })
  }

  function shuffleTracks(tracks = []) {
    const shuffled = [...tracks]
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1))
      ;[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]]
    }
    return shuffled
  }

  function rotateTracks(tracks, startIndex) {
    if (!tracks.length) return []
    const index = ((startIndex % tracks.length) + tracks.length) % tracks.length
    return [...tracks.slice(index), ...tracks.slice(0, index)]
  }

  function buildPlaybackQueue(source, mode, anchorTrack = null, keepAnchorFirst = false) {
    const tracks = uniqueTracks(source)
    if (!tracks.length) return []
    const anchorIndex = anchorTrack
      ? tracks.findIndex((track) => String(track.id) === String(anchorTrack.id))
      : -1
    const anchor = anchorIndex >= 0 ? tracks[anchorIndex] : null
    if (mode === 'repeat-one') return [anchor || tracks[0]]
    if (mode === 'shuffle') {
      if (!anchor || !keepAnchorFirst) return shuffleTracks(tracks)
      return [anchor, ...shuffleTracks(tracks.filter((_, index) => index !== anchorIndex))]
    }
    return tracks
  }

  window.MenoRadioCore = Object.assign(window.MenoRadioCore || {}, {
    uniqueTracks,
    shuffleTracks,
    rotateTracks,
    buildPlaybackQueue,
  })
})()
