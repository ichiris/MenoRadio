const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

test('the renderer allows the paced playback protocol as a media source', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
  const policy = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] || ''
  const mediaSources = /media-src\s+([^;]+)/.exec(policy)?.[1] || ''
  assert.match(mediaSources, /(?:^|\s)menoradio-media:(?:\s|$)/)
})
