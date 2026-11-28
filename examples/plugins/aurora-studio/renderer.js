// Aurora Studio renderer entry (runs as native ES module in MenoRadio renderer).

export function activate(api) {
  let latestStats = { totalPlays: 0, tracks: {} }
  const badgeNodes = new Set()
  const insightPanels = new Set()

  const syncGlowColor = () => {
    const glow = api.settings.get('accentGlow') || '#5eead4'
    document.documentElement.style.setProperty('--aurora-glow', glow)
  }
  syncGlowColor()
  api.onDispose(() => document.documentElement.style.removeProperty('--aurora-glow'))

  const updateBadges = () => {
    const show = api.settings.get('showMetaBadge') !== false
    const track = api.player.getState().current
    const count = track ? (latestStats.tracks?.[String(track.id)]?.count || 0) : 0
    for (const el of badgeNodes) {
      if (!el.isConnected) {
        badgeNodes.delete(el)
        continue
      }
      el.hidden = !show || !track
      el.textContent = count > 0
        ? `Aurora · 本机播放 ${count} 次`
        : 'Aurora Studio'
    }
  }

  const renderInsightContent = (panel) => {
    const player = api.player.getState()
    const track = player.current
    const stats = track ? latestStats.tracks?.[String(track.id)] : null
    panel.innerHTML = `<div class="aurora-insight-panel">
      <h3>曲目洞察</h3>
      ${track ? `<div class="aurora-insight-grid">
        <div class="aurora-metric"><span>曲目 ID</span><strong>${api.core.escapeHtml(track.id)}</strong></div>
        <div class="aurora-metric"><span>本机累计播放</span><strong>${stats?.count || 0} 次</strong></div>
        <div class="aurora-metric"><span>当前音质策略</span><strong>${api.core.escapeHtml(player.audioQuality)}</strong></div>
        <div class="aurora-metric"><span>播放队列</span><strong>${player.queue.length} 首</strong></div>
      </div>` : '<p class="aurora-muted">暂无正在播放的歌曲</p>'}
    </div>`
  }

  const refreshInsights = () => {
    for (const panel of insightPanels) {
      if (!panel.isConnected) {
        insightPanels.delete(panel)
        continue
      }
      renderInsightContent(panel)
    }
  }

  void api.backend.invoke('getStats').then((stats) => {
    if (stats) latestStats = stats
    updateBadges()
    refreshInsights()
  }).catch(() => {})

  api.backend.on('stats-updated', () => {
    void api.backend.invoke('getStats').then((stats) => {
      if (stats) latestStats = stats
      updateBadges()
      refreshInsights()
    }).catch(() => {})
  })

  api.settings.onChange(() => {
    syncGlowColor()
    updateBadges()
  })

  // 1. Register a custom player page style selectable in Settings -> 播放器样式
  api.player.registerStyle({
    id: 'vinyl-glow',
    label: '黑胶流光 (Aurora)',
    className: 'aurora-vinyl-player',
  })

  // 2. Register a custom Immersive Player view beside Lyrics & Queue
  api.player.registerImmersiveView({
    id: 'insights',
    label: 'Aurora 曲目洞察',
    icon: 'spark',
    order: 20,
    render: (panel) => {
      insightPanels.add(panel)
      renderInsightContent(panel)
      return () => insightPanels.delete(panel)
    },
    onShow: (panel) => renderInsightContent(panel),
  })

  // 3. Mount a badge under the song title inside the immersive player
  api.ui.mountSlot('immersive-meta-extra', (slot) => {
    const badge = document.createElement('span')
    badge.className = 'aurora-meta-badge'
    slot.appendChild(badge)
    badgeNodes.add(badge)
    updateBadges()
    return () => badgeNodes.delete(badge)
  })

  // 4. Register a sidebar nav item + custom overview page
  const routeName = 'plugin:aurora-studio:overview'
  api.ui.registerNavItem({
    id: 'overview',
    label: 'Aurora 统计',
    icon: 'spark',
    route: routeName,
    group: 'plugins',
    order: 10,
  })

  api.ui.registerRoute(routeName, {
    title: 'Aurora Studio',
    render: async (container, _payload, helpers) => {
      const stats = await api.backend.invoke('getStats').catch(() => latestStats)
      latestStats = stats || latestStats
      const topTracks = Object.values(latestStats.tracks || {})
        .sort((a, b) => b.count - a.count)
        .slice(0, 12)
      const banner = api.settings.get('welcomeBanner') || ''
      container.innerHTML = `${helpers.pageTitle(
        'Aurora Studio',
        banner,
        '<button type="button" class="secondary-button" data-aurora-reset>重置统计</button>',
      )}
      <div class="aurora-stat-cards">
        <div class="settings-card"><div><h3>本机累计播放</h3><p class="aurora-big-number">${latestStats.totalPlays || 0}</p></div></div>
        <div class="settings-card"><div><h3>记录曲目数</h3><p class="aurora-big-number">${Object.keys(latestStats.tracks || {}).length}</p></div></div>
      </div>
      <div class="section-title"><h2>常听排行</h2></div>
      <div class="aurora-top-list">
        ${topTracks.length ? topTracks.map((item, idx) => `<div class="settings-card aurora-top-row">
          <div><h3>${idx + 1}. ${helpers.escapeHtml(item.name)}</h3><p>${helpers.escapeHtml(item.artist)}</p></div>
          <span class="aurora-play-count">${item.count} 次</span>
        </div>`).join('') : '<div class="user-playlist-empty">暂无统计数据</div>'}
      </div>`
      container.querySelector('[data-aurora-reset]')?.addEventListener('click', async () => {
        latestStats = await api.backend.invoke('resetStats')
        api.ui.toast('已清空 Aurora 播放统计')
        api.ui.navigate(routeName, { refreshed: Date.now() }, false)
      })
    },
  })

  // 5. Add a Track context menu item
  api.ui.registerTrackMenuItem({
    id: 'aurora-track-info',
    label: '查看歌曲元信息 (Aurora)',
    icon: 'info',
    onClick: (track) => {
      api.ui.showModal({
        title: track.name,
        subtitle: `${track.artist} · ${track.album}`,
        content: `<dl class="plugin-details-grid">
          <dt>Track ID</dt><dd><code>${api.core.escapeHtml(track.id)}</code></dd>
          <dt>时长</dt><dd>${api.core.formatDuration(track.duration)}</dd>
          <dt>本机播放</dt><dd>${latestStats.tracks?.[String(track.id)]?.count || 0} 次</dd>
        </dl>`,
        actions: [{ label: '关闭', primary: true }],
      })
    },
  })

  // 6. Global renderer keyboard shortcut
  api.shortcuts.register('Alt+Shift+A', () => {
    api.ui.navigate(routeName)
  }, { description: '打开 Aurora 统计页' })

  api.events.on('player:track-changed', () => {
    updateBadges()
    refreshInsights()
  })
}
