;(function (root) {
  const languages = Object.freeze([
    ['zh-CN', '简体中文'],
    ['zh-TW', '繁體中文'],
    ['en', 'English'],
    ['ja', '日本語'],
  ])
  const storageKey = 'menoradio.language'
  const dictionaries = new Map()
  const staticLabels = []
  const valid = (value) => languages.some(([code]) => code === value)
  let locale = 'zh-CN'
  try {
    const saved = root.localStorage?.getItem(storageKey)
    if (valid(saved)) locale = saved
  } catch {}

  function register(code, entries) {
    dictionaries.set(code, new Map(Object.entries(entries)))
  }

  function t(key, params = {}) {
    if (typeof key !== 'string') return key
    const message = dictionaries.get(locale)?.get(key) ?? key
    return message.replace(/\{(\w+)\}/g, (placeholder, name) =>
      Object.hasOwn(params, name) ? String(params[name] ?? '') : placeholder
    )
  }

  // Capture only the shell authored in HTML, before any network content or
  // dynamically generated UI is rendered. Runtime-owned labels keep their
  // current values when the language changes.
  function initializeDocument() {
    const doc = root.document
    const add = (read, write) => {
      const source = read()
      const key = source?.trim()
      if (key && /\p{Script=Han}/u.test(key)) staticLabels.push({ read, write, source, key, last: source })
    }
    const walker = doc.createTreeWalker(doc.body, root.NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest('script, style, svg')) continue
      const text = node
      add(() => text.nodeValue, (value) => { text.nodeValue = value })
    }
    for (const element of doc.querySelectorAll('[title], [aria-label], [alt], [placeholder]')) {
      for (const name of ['title', 'aria-label', 'alt', 'placeholder']) {
        if (element.hasAttribute(name)) add(() => element.getAttribute(name), (value) => element.setAttribute(name, value))
      }
    }
    const title = doc.querySelector('title')
    if (title) add(() => doc.title, (value) => { doc.title = value })
    setLanguage(locale)
  }

  function setLanguage(code, { persist = false } = {}) {
    locale = valid(code) ? code : 'zh-CN'
    if (root.document) root.document.documentElement.lang = locale
    for (const label of staticLabels) {
      if (label.read() !== label.last) continue
      label.last = label.source.replace(label.key, () => t(label.key))
      label.write(label.last)
    }
    if (persist) {
      try { root.localStorage?.setItem(storageKey, locale) } catch {}
    }
  }

  root.MenoRadioI18n = { languages, register, t, setLanguage, initializeDocument, get locale() { return locale } }
})(window)
