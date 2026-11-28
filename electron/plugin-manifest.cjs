// Manifest discovery, validation and normalization for MenoRadio plugins.
const fs = require('node:fs')
const path = require('node:path')
const { parseVersion, normalizeVersionRange, evaluateCompatibility } = require('./plugin-semver.cjs')

const MANIFEST_FILENAMES = Object.freeze(['plugin.json', 'manifest.json'])
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{1,79}$/i

function findManifestFile(pluginDir) {
  for (const filename of MANIFEST_FILENAMES) {
    const candidate = path.join(pluginDir, filename)
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate
    }
  }
  return ''
}

function locatePluginRoot(extractedDir) {
  if (findManifestFile(extractedDir)) return extractedDir
  // Allow archives that wrap the plugin in a single top-level directory.
  const entries = fs.readdirSync(extractedDir, { withFileTypes: true })
    .filter((entry) => entry.name !== '__MACOSX' && !entry.name.startsWith('.'))
  if (entries.length === 1 && entries[0].isDirectory()) {
    const nested = path.join(extractedDir, entries[0].name)
    if (findManifestFile(nested)) return nested
  }
  return ''
}

function safeRelativePath(pluginDir, relPath, fieldName) {
  if (!relPath) return ''
  const raw = String(relPath).trim().replace(/\\/g, '/')
  if (!raw) return ''
  if (path.isAbsolute(raw) || raw.includes('\0')) {
    throw new Error(`插件清单字段 "${fieldName}" 必须是相对路径`)
  }
  const root = path.resolve(pluginDir)
  const resolved = path.resolve(root, raw)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`插件清单字段 "${fieldName}" 不能跳出插件目录`)
  }
  return path.relative(root, resolved).replace(/\\/g, '/')
}

function normalizeAuthor(authorField) {
  if (typeof authorField === 'string') {
    const trimmed = authorField.trim()
    return { name: trimmed || '未知作者', url: '', email: '' }
  }
  if (authorField && typeof authorField === 'object') {
    return {
      name: String(authorField.name || '').trim() || '未知作者',
      url: /^https?:\/\//i.test(String(authorField.url || '').trim()) ? String(authorField.url).trim() : '',
      email: String(authorField.email || '').trim().slice(0, 120),
    }
  }
  return { name: '未知作者', url: '', email: '' }
}

function slugifyId(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug.length >= 2 ? slug : ''
}

function normalizeSettingsSchema(items) {
  if (!Array.isArray(items)) return []
  const allowedTypes = new Set(['boolean', 'string', 'number', 'select', 'color', 'textarea'])
  const normalized = []
  const seen = new Set()
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const key = String(item.key || '').trim()
    if (!key || seen.has(key) || !/^[\w.-]{1,64}$/.test(key)) continue
    seen.add(key)
    const type = allowedTypes.has(item.type) ? item.type : 'string'
    const options = type === 'select' && Array.isArray(item.options)
      ? item.options.map((option) => (
        typeof option === 'object' && option !== null
          ? { value: String(option.value ?? ''), label: String(option.label ?? option.value ?? '') }
          : { value: String(option), label: String(option) }
      ))
      : []
    normalized.push({
      key,
      type,
      label: String(item.label || key).slice(0, 80),
      description: String(item.description || '').slice(0, 260),
      placeholder: String(item.placeholder || '').slice(0, 120),
      default: item.default !== undefined
        ? item.default
        : type === 'boolean' ? false : type === 'number' ? 0 : type === 'color' ? '#68c7c3' : options[0]?.value ?? '',
      min: Number.isFinite(Number(item.min)) ? Number(item.min) : undefined,
      max: Number.isFinite(Number(item.max)) ? Number(item.max) : undefined,
      step: Number.isFinite(Number(item.step)) ? Number(item.step) : undefined,
      options,
    })
  }
  return normalized
}

function normalizeThemesContribution(items, pluginDir, pluginId) {
  if (!Array.isArray(items)) return []
  const result = []
  const seen = new Set()
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const rawId = String(item.id || '').trim()
    if (!rawId) continue
    const id = rawId.includes(':') ? rawId : `plugin:${pluginId}:${rawId}`
    if (seen.has(id)) continue
    seen.add(id)
    const variables = item.variables && typeof item.variables === 'object' && !Array.isArray(item.variables)
      ? Object.fromEntries(
        Object.entries(item.variables)
          .filter(([k, v]) => typeof k === 'string' && k.startsWith('--') && v != null)
          .map(([k, v]) => [k, String(v)])
      )
      : {}
    result.push({
      id,
      rawId,
      label: String(item.label || item.name || rawId).slice(0, 64),
      colorScheme: item.colorScheme === 'light' ? 'light' : 'dark',
      css: safeRelativePath(pluginDir, item.css || item.style, 'contributes.themes[].css'),
      variables,
    })
  }
  return result
}

function normalizeLocalesContribution(locales) {
  if (!locales || typeof locales !== 'object' || Array.isArray(locales)) return {}
  const output = {}
  for (const [locale, entries] of Object.entries(locales)) {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue
    output[String(locale)] = Object.fromEntries(
      Object.entries(entries).map(([k, v]) => [String(k), String(v ?? '')])
    )
  }
  return output
}

function inferCapabilities(manifest) {
  const explicit = Array.isArray(manifest.capabilities)
    ? manifest.capabilities.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
    : []
  const caps = new Set(explicit)
  if (manifest.main) caps.add('backend')
  if (manifest.renderer) caps.add('frontend')
  if (manifest.floatingLyrics || manifest.floatingStyles.length) caps.add('floating-lyrics')
  if (manifest.styles.length || manifest.contributes.themes.length) caps.add('theme')
  return [...caps]
}

function loadManifestFromDir(pluginDir, appVersion = '0.0.0') {
  const resolvedDir = path.resolve(pluginDir)
  const manifestPath = findManifestFile(resolvedDir)
  if (!manifestPath) {
    throw new Error('所选目录中未找到 plugin.json 或 manifest.json')
  }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`插件清单 JSON 解析失败：${error.message}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('插件清单必须是一个 JSON 对象')
  }

  const name = String(raw.name || '').trim()
  if (!name) throw new Error('插件清单缺少必填字段：name（插件名）')

  const id = String(raw.id || '').trim() || slugifyId(name)
  if (!id || !PLUGIN_ID_RE.test(id)) {
    throw new Error('插件 ID 无效：仅支持 2-80 位字母、数字、点、下划线或连字符')
  }

  const versionStr = String(raw.version || '').trim()
  if (!versionStr || !parseVersion(versionStr, { loose: true })) {
    throw new Error('插件清单缺少有效的 version（插件版本，例如 1.0.0）')
  }

  const authorObj = normalizeAuthor(raw.author)
  const description = String(raw.description || '').trim()

  const rawSupportedVersions = raw.supportedVersions
    ?? raw.compatibleVersions
    ?? raw.menoradioVersion
    ?? raw.engines?.menoradio
    ?? (raw.minAppVersion || raw.maxAppVersion ? { min: raw.minAppVersion, max: raw.maxAppVersion } : '')
  const supportedVersions = normalizeVersionRange(rawSupportedVersions)
  const compatibility = evaluateCompatibility(appVersion, supportedVersions)

  const main = safeRelativePath(resolvedDir, raw.main || raw.backend, 'main')
  const renderer = safeRelativePath(resolvedDir, raw.renderer || raw.frontend, 'renderer')
  const floatingLyrics = safeRelativePath(resolvedDir, raw.floatingLyrics || raw.floating, 'floatingLyrics')
  const icon = safeRelativePath(resolvedDir, raw.icon, 'icon')
  const styles = (Array.isArray(raw.styles) ? raw.styles : raw.style ? [raw.style] : [])
    .map((entry) => safeRelativePath(resolvedDir, entry, 'styles'))
    .filter(Boolean)
  const floatingStyles = (Array.isArray(raw.floatingStyles) ? raw.floatingStyles : [])
    .map((entry) => safeRelativePath(resolvedDir, entry, 'floatingStyles'))
    .filter(Boolean)

  for (const [label, rel] of [
    ['main', main],
    ['renderer', renderer],
    ['floatingLyrics', floatingLyrics],
    ...styles.map((relPath) => ['styles', relPath]),
    ...floatingStyles.map((relPath) => ['floatingStyles', relPath]),
  ]) {
    if (rel && !fs.existsSync(path.join(resolvedDir, rel))) {
      throw new Error(`插件入口文件不存在（${label}）：${rel}`)
    }
  }

  const contributesRaw = raw.contributes && typeof raw.contributes === 'object' ? raw.contributes : {}
  const contributes = {
    themes: normalizeThemesContribution(contributesRaw.themes || raw.themes, resolvedDir, id),
    locales: normalizeLocalesContribution(contributesRaw.locales || raw.locales),
    settings: normalizeSettingsSchema(contributesRaw.settings || raw.settings),
  }

  for (const theme of contributes.themes) {
    if (theme.css && !fs.existsSync(path.join(resolvedDir, theme.css))) {
      throw new Error(`插件主题样式文件不存在：${theme.css}`)
    }
  }

  const manifest = {
    id,
    name: name.slice(0, 80),
    author: authorObj.name.slice(0, 80),
    authorUrl: authorObj.url,
    authorEmail: authorObj.email,
    description: description.slice(0, 500),
    version: versionStr,
    supportedVersions: supportedVersions || '*',
    compatibility,
    homepage: /^https?:\/\//i.test(String(raw.homepage || '').trim()) ? String(raw.homepage).trim() : '',
    license: String(raw.license || '').trim().slice(0, 48),
    keywords: Array.isArray(raw.keywords) ? raw.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 12) : [],
    icon,
    main,
    renderer,
    floatingLyrics,
    styles,
    floatingStyles,
    contributes,
    manifestFile: path.basename(manifestPath),
    raw,
  }
  manifest.capabilities = inferCapabilities(manifest)
  return manifest
}

module.exports = {
  MANIFEST_FILENAMES,
  findManifestFile,
  locatePluginRoot,
  loadManifestFromDir,
  safeRelativePath,
}
