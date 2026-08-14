const audioQualityLevels = Object.freeze([
  'standard',
  'exhigh',
  'lossless',
  'hires',
  'jyeffect',
  'sky',
  'jymaster',
])

const audioQualitySet = new Set(audioQualityLevels)
const legacyAudioQuality = Object.freeze({
  higher: 'exhigh',
  dolby: 'sky',
})

function normalizeAudioQuality(value) {
  const requested = String(value || 'best').toLowerCase()
  if (requested === 'best') return 'best'
  const migrated = legacyAudioQuality[requested] || requested
  return audioQualitySet.has(migrated) ? migrated : 'best'
}

function requestedApiAudioQuality(value) {
  const normalized = normalizeAudioQuality(value)
  return normalized === 'best' ? 'jymaster' : normalized
}

module.exports = {
  audioQualityLevels,
  normalizeAudioQuality,
  requestedApiAudioQuality,
}
