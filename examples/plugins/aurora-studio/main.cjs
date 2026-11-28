// Aurora Studio backend entry (runs inside Electron main process).
module.exports = {
  activate(ctx) {
    const readStats = () => ctx.storage.get('playStats', { totalPlays: 0, tracks: {} })

    ctx.events.on('player:track-changed', (payload) => {
      const track = payload?.track
      if (!track?.id) return
      const stats = readStats()
      const id = String(track.id)
      const prev = stats.tracks[id] || { id, name: track.name, artist: track.artist, count: 0 }
      stats.totalPlays += 1
      stats.tracks[id] = {
        id,
        name: track.name || prev.name,
        artist: track.artist || prev.artist,
        count: prev.count + 1,
        lastPlayedAt: Date.now(),
      }
      ctx.storage.set('playStats', stats)
      ctx.ipc.send('stats-updated', { totalPlays: stats.totalPlays, track: stats.tracks[id] })
    })

    ctx.ipc.handle('getStats', () => readStats())

    ctx.ipc.handle('resetStats', () => {
      const empty = { totalPlays: 0, tracks: {} }
      ctx.storage.set('playStats', empty)
      ctx.ipc.send('stats-updated', { totalPlays: 0, track: null })
      return empty
    })

    ctx.services.provide('aurora.stats', {
      getStats: () => readStats(),
    })

    ctx.logger.info('Aurora Studio backend activated')
  },

  deactivate(ctx) {
    ctx.logger.info('Aurora Studio backend deactivated')
  },
}
