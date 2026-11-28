// Zero-dependency SemVer parser and range evaluator for MenoRadio plugins.

const SEMVER_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseVersion(input, { loose = false } = {}) {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  const match = SEMVER_RE.exec(raw)
  if (!match) return null
  if (!loose && (match[2] == null || match[3] == null)) return null
  const major = Number(match[1])
  const minor = match[2] == null ? 0 : Number(match[2])
  const patch = match[3] == null ? 0 : Number(match[3])
  if (![major, minor, patch].every((n) => Number.isSafeInteger(n) && n >= 0)) return null
  const prerelease = match[4]
    ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : []
  return {
    major,
    minor,
    patch,
    prerelease,
    raw: `${major}.${minor}.${patch}${prerelease.length ? `-${prerelease.join('.')}` : ''}`,
  }
}

function compareIdentifiers(a, b) {
  const aNum = typeof a === 'number'
  const bNum = typeof b === 'number'
  if (aNum && bNum) return a === b ? 0 : a < b ? -1 : 1
  if (aNum && !bNum) return -1
  if (!aNum && bNum) return 1
  return a === b ? 0 : a < b ? -1 : 1
}

function compareVersions(aInput, bInput) {
  const a = typeof aInput === 'object' && aInput !== null ? aInput : parseVersion(aInput, { loose: true })
  const b = typeof bInput === 'object' && bInput !== null ? bInput : parseVersion(bInput, { loose: true })
  if (!a || !b) return Number.NaN
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  const aPre = a.prerelease || []
  const bPre = b.prerelease || []
  if (!aPre.length && !bPre.length) return 0
  if (!aPre.length) return 1
  if (!bPre.length) return -1
  const length = Math.max(aPre.length, bPre.length)
  for (let index = 0; index < length; index += 1) {
    if (index >= aPre.length) return -1
    if (index >= bPre.length) return 1
    const diff = compareIdentifiers(aPre[index], bPre[index])
    if (diff !== 0) return diff
  }
  return 0
}

function isWildcard(token) {
  return token == null || token === '' || token === '*' || token.toLowerCase() === 'x'
}

function parsePartial(token) {
  const cleaned = String(token || '').trim().replace(/^v/i, '')
  if (!cleaned || cleaned === '*' || cleaned.toLowerCase() === 'x') {
    return { major: null, minor: null, patch: null, prerelease: [] }
  }
  const [core, rest = ''] = cleaned.split('-', 2)
  const [prePart = ''] = rest.split('+', 1)
  const parts = core.split('.')
  if (parts.length > 3) return null
  const parsePart = (value) => {
    if (isWildcard(value)) return null
    if (!/^\d+$/.test(value)) return Number.NaN
    return Number(value)
  }
  const major = parsePart(parts[0])
  const minor = parts.length > 1 ? parsePart(parts[1]) : null
  const patch = parts.length > 2 ? parsePart(parts[2]) : null
  if ([major, minor, patch].some((n) => Number.isNaN(n))) return null
  const prerelease = prePart
    ? prePart.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : []
  return { major, minor, patch, prerelease }
}

function makeVersion(major, minor = 0, patch = 0, prerelease = []) {
  return { major, minor, patch, prerelease }
}

function expandComparator(token) {
  const trimmed = String(token || '').trim()
  if (!trimmed || trimmed === '*' || trimmed.toLowerCase() === 'x') {
    return [{ op: '>=', version: makeVersion(0, 0, 0) }]
  }

  // Caret range: ^1.2.3, ^0.17.0, ^0.0.3
  if (trimmed.startsWith('^')) {
    const p = parsePartial(trimmed.slice(1))
    if (!p) return null
    if (p.major === null) return [{ op: '>=', version: makeVersion(0, 0, 0) }]
    const min = makeVersion(p.major, p.minor ?? 0, p.patch ?? 0, p.prerelease)
    let upper
    if (p.major > 0) {
      upper = makeVersion(p.major + 1, 0, 0)
    } else if (p.minor !== null && p.minor > 0) {
      upper = makeVersion(0, p.minor + 1, 0)
    } else if (p.minor === null) {
      upper = makeVersion(1, 0, 0)
    } else if (p.patch !== null) {
      upper = makeVersion(0, 0, p.patch + 1)
    } else {
      upper = makeVersion(0, 1, 0)
    }
    return [
      { op: '>=', version: min },
      { op: '<', version: upper },
    ]
  }

  // Tilde range: ~1.2.3, ~0.17, ~1
  if (trimmed.startsWith('~')) {
    const p = parsePartial(trimmed.slice(1))
    if (!p) return null
    if (p.major === null) return [{ op: '>=', version: makeVersion(0, 0, 0) }]
    const min = makeVersion(p.major, p.minor ?? 0, p.patch ?? 0, p.prerelease)
    const upper = p.minor === null
      ? makeVersion(p.major + 1, 0, 0)
      : makeVersion(p.major, p.minor + 1, 0)
    return [
      { op: '>=', version: min },
      { op: '<', version: upper },
    ]
  }

  // Explicit operator: >=, <=, >, <, =
  const opMatch = /^(>=|<=|>|<|=)\s*(.+)$/.exec(trimmed)
  if (opMatch) {
    const op = opMatch[1]
    const p = parsePartial(opMatch[2])
    if (!p) return null
    if (p.major === null) {
      return op === '>' || op === '<' ? [{ op: '<', version: makeVersion(0, 0, 0) }] : [{ op: '>=', version: makeVersion(0, 0, 0) }]
    }
    if (op === '>' && p.minor === null) return [{ op: '>=', version: makeVersion(p.major + 1, 0, 0) }]
    if (op === '>' && p.patch === null) return [{ op: '>=', version: makeVersion(p.major, p.minor + 1, 0) }]
    if (op === '<=' && p.minor === null) return [{ op: '<', version: makeVersion(p.major + 1, 0, 0) }]
    if (op === '<=' && p.patch === null) return [{ op: '<', version: makeVersion(p.major, p.minor + 1, 0) }]
    if (op === '=' && (p.minor === null || p.patch === null)) {
      const lower = makeVersion(p.major, p.minor ?? 0, 0)
      const upper = p.minor === null
        ? makeVersion(p.major + 1, 0, 0)
        : makeVersion(p.major, p.minor + 1, 0)
      return [{ op: '>=', version: lower }, { op: '<', version: upper }]
    }
    return [{ op, version: makeVersion(p.major, p.minor ?? 0, p.patch ?? 0, p.prerelease) }]
  }

  // Plain version or X-range: 0.17.0, 0.17.x, 0.17, 1.x
  const p = parsePartial(trimmed)
  if (!p) return null
  if (p.major === null) return [{ op: '>=', version: makeVersion(0, 0, 0) }]
  if (p.minor === null) {
    return [
      { op: '>=', version: makeVersion(p.major, 0, 0) },
      { op: '<', version: makeVersion(p.major + 1, 0, 0) },
    ]
  }
  if (p.patch === null) {
    return [
      { op: '>=', version: makeVersion(p.major, p.minor, 0) },
      { op: '<', version: makeVersion(p.major, p.minor + 1, 0) },
    ]
  }
  return [{ op: '=', version: makeVersion(p.major, p.minor, p.patch, p.prerelease) }]
}

function parseComparatorSet(clause) {
  const trimmed = String(clause || '').trim()
  if (!trimmed) return []

  // Hyphen range: 0.17.0 - 0.20.0
  const hyphen = /^([^\s]+)\s+-\s+([^\s]+)$/.exec(trimmed)
  if (hyphen) {
    const low = expandComparator(`>=${hyphen[1]}`)
    const high = expandComparator(`<=${hyphen[2]}`)
    if (!low || !high) return null
    return [...low, ...high]
  }

  // Collapse whitespace after operators: ">= 0.17.0" -> ">=0.17.0"
  const normalized = trimmed.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
  const tokens = normalized.split(/\s+/).filter(Boolean)
  const comparators = []
  for (const token of tokens) {
    const expanded = expandComparator(token)
    if (!expanded) return null
    comparators.push(...expanded)
  }
  return comparators
}

function parseRange(rangeInput) {
  const raw = String(rangeInput ?? '').trim()
  if (!raw) return null
  const clauses = raw.split(/\s*\|\|\s*/)
  const sets = []
  for (const clause of clauses) {
    const parsed = parseComparatorSet(clause)
    if (!parsed || !parsed.length) return null
    sets.push(parsed)
  }
  return sets
}

function testComparator(version, comparator) {
  const diff = compareVersions(version, comparator.version)
  if (Number.isNaN(diff)) return false
  switch (comparator.op) {
    case '=': return diff === 0
    case '>': return diff > 0
    case '>=': return diff >= 0
    case '<': return diff < 0
    case '<=': return diff <= 0
    default: return false
  }
}

function satisfiesRange(versionInput, rangeInput) {
  const version = typeof versionInput === 'object' && versionInput !== null
    ? versionInput
    : parseVersion(versionInput, { loose: true })
  if (!version) return false
  const sets = parseRange(rangeInput)
  if (!sets) return false
  return sets.some((set) => set.every((comparator) => testComparator(version, comparator)))
}

function normalizeVersionRange(input) {
  if (typeof input === 'string') return input.trim()
  if (input && typeof input === 'object') {
    const parts = []
    if (input.min) parts.push(`>=${String(input.min).trim().replace(/^v/i, '')}`)
    if (input.max) parts.push(`<=${String(input.max).trim().replace(/^v/i, '')}`)
    if (parts.length) return parts.join(' ')
  }
  return ''
}

function evaluateCompatibility(appVersion, supportedVersions) {
  const range = normalizeVersionRange(supportedVersions)
  if (!range) {
    return {
      status: 'unspecified',
      compatible: true,
      range: '*',
      appVersion: String(appVersion || ''),
    }
  }
  const parsed = parseRange(range)
  if (!parsed) {
    return {
      status: 'invalid-range',
      compatible: false,
      range,
      appVersion: String(appVersion || ''),
    }
  }
  const compatible = satisfiesRange(appVersion, range)
  return {
    status: compatible ? 'compatible' : 'incompatible',
    compatible,
    range,
    appVersion: String(appVersion || ''),
  }
}

module.exports = {
  parseVersion,
  compareVersions,
  parseRange,
  satisfiesRange,
  normalizeVersionRange,
  evaluateCompatibility,
}
