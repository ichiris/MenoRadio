const bridge = window.floatingLyrics
const surface = document.querySelector('#surface')
const primary = document.querySelector('#primary')
const primaryViewport = document.querySelector('#primaryViewport')
const translation = document.querySelector('#translation')
const translationViewport = document.querySelector('#translationViewport')
const contextMenu = document.querySelector('#contextMenu')
const lockAction = document.querySelector('#lockAction')

let config = {}
let payload = {}
let marqueeAnimations = []
let resizing = false
let moving = false
let activePointerId = null
let hoverTimer = 0

function fontCss(value) {
  if (!value || value === 'system') return '"MenoRadio Sarasa UI SC", "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif'
  // The bundled alias covers missing glyphs without shadowing installed fonts.
  return `"${String(value).replaceAll('"', '\\"')}", "MenoRadio Sarasa UI SC", "Microsoft YaHei UI", sans-serif`
}

function cancelMarquee() {
  marqueeAnimations.forEach((animation) => animation.cancel())
  marqueeAnimations = []
  primary.style.transform = ''
  translation.style.transform = ''
}

function startMarquee(line, viewport, speed = 42) {
  const overflow = Math.max(0, line.scrollWidth - viewport.clientWidth)
  if (overflow < 2) return
  const duration = Math.max(5000, ((overflow + viewport.clientWidth * .4) / speed) * 1000)
  marqueeAnimations.push(line.animate([
    { transform: 'translateX(0)' },
    { transform: `translateX(${-overflow}px)` },
  ], {
    duration,
    delay: 1100,
    endDelay: 900,
    iterations: Infinity,
    direction: 'alternate',
    easing: 'linear',
  }))
}

function layoutMarquee() {
  cancelMarquee()
  requestAnimationFrame(() => {
    startMarquee(primary, primaryViewport)
    if (!translationViewport.hidden) startMarquee(translation, translationViewport, 38)
  })
}

function hideContextMenu() {
  contextMenu.hidden = true
}

function keepSurfaceVisible() {
  clearTimeout(hoverTimer)
  surface.classList.add('hovering')
}

function scheduleSurfaceHide() {
  clearTimeout(hoverTimer)
  hoverTimer = window.setTimeout(() => {
    if (!resizing && !moving && contextMenu.hidden) surface.classList.remove('hovering')
  }, 3000)
}

function applyConfig(next = {}) {
  config = { ...config, ...next }
  document.documentElement.style.setProperty('--font', fontCss(config.fontFamily))
  document.documentElement.style.setProperty('--font-size', `${Number(config.fontSize) || 30}px`)
  document.documentElement.style.setProperty('--lyric-color', config.color || '#f2f2f2')
  document.documentElement.style.setProperty('--lyric-opacity', String(config.opacity ?? 1))
  surface.classList.toggle('locked', Boolean(config.locked))
  surface.classList.toggle('unlocked', !config.locked)
  surface.classList.toggle('italic', Boolean(config.italic))
  surface.classList.toggle('not-bold', !config.bold)
  surface.classList.toggle('shadow', Boolean(config.shadow))
  surface.classList.toggle('stroke', Boolean(config.stroke))
  for (const value of ['left', 'center', 'right']) surface.classList.toggle(`align-${value}`, config.align === value)
  for (const value of ['top', 'center', 'bottom']) {
    surface.classList.toggle(`no-translation-${value}`, config.noTranslationPosition === value)
  }
  if (config.locked) {
    hideContextMenu()
    surface.classList.remove('hovering')
  }
  layoutMarquee()
}

function render(next = {}) {
  payload = { ...payload, ...next }
  primary.textContent = payload.text || ''
  translation.textContent = payload.translation || ''
  translationViewport.hidden = !payload.translation
  surface.classList.toggle('has-translation', Boolean(payload.translation))
  layoutMarquee()
}

surface.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  event.stopPropagation()
  if (config.locked) return
  if (resizing) {
    resizing = false
    bridge.endResize()
  }
  if (moving) {
    moving = false
    bridge.endMove()
  }
  keepSurfaceVisible()
  const margin = 8
  contextMenu.style.left = `${Math.max(margin, Math.min(surface.clientWidth - 98, event.clientX))}px`
  contextMenu.style.top = `${Math.max(margin, Math.min(surface.clientHeight - 48, event.clientY))}px`
  contextMenu.hidden = false
})

lockAction.addEventListener('click', () => {
  hideContextMenu()
  bridge.lock()
})

surface.addEventListener('pointerenter', keepSurfaceVisible)
surface.addEventListener('pointerleave', scheduleSurfaceHide)
surface.addEventListener('pointerdown', (event) => {
  if (config.locked || event.button !== 0) return
  hideContextMenu()
  keepSurfaceVisible()
  const handle = event.target.closest('[data-resize]')
  event.preventDefault()
  event.stopPropagation()
  activePointerId = event.pointerId
  surface.setPointerCapture?.(event.pointerId)
  if (handle) {
    resizing = true
    surface.classList.add('resizing')
    bridge.beginResize(handle.dataset.resize, event.screenX, event.screenY).then((started) => {
      if (!started && activePointerId === event.pointerId) finishPointer()
    }).catch(() => {
      if (activePointerId === event.pointerId) finishPointer()
    })
    return
  }
  moving = true
  surface.classList.add('moving')
  bridge.beginMove(event.screenX, event.screenY).then((started) => {
    if (!started && activePointerId === event.pointerId) finishPointer()
  }).catch(() => {
    if (activePointerId === event.pointerId) finishPointer()
  })
})

surface.addEventListener('pointermove', (event) => {
  if (resizing) bridge.resize(event.screenX, event.screenY)
  else if (moving) bridge.move(event.screenX, event.screenY)
})

function finishPointer(event) {
  if (resizing) bridge.endResize()
  if (moving) bridge.endMove()
  resizing = false
  moving = false
  surface.classList.remove('resizing', 'moving')
  if (activePointerId != null) surface.releasePointerCapture?.(activePointerId)
  activePointerId = null
  if (event?.type === 'pointercancel') scheduleSurfaceHide()
}

surface.addEventListener('pointerup', finishPointer)
surface.addEventListener('pointercancel', finishPointer)
document.addEventListener('pointerdown', (event) => {
  if (!contextMenu.hidden && !event.target.closest('#contextMenu')) {
    hideContextMenu()
    scheduleSurfaceHide()
  }
}, true)
window.addEventListener('blur', () => {
  hideContextMenu()
  scheduleSurfaceHide()
})
window.addEventListener('resize', layoutMarquee)
bridge.onConfig(applyConfig)
bridge.onUpdate(render)
bridge.state().then((value) => applyConfig(value?.config || {})).catch(() => {})
