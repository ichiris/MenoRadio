const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 256,
    height: 256,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { sandbox: true },
  })
  await window.loadFile(path.join(__dirname, '..', 'src', 'assets', 'icon-export.html'))
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 })
  const outputDir = path.join(__dirname, '..', 'build')
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(path.join(outputDir, 'icon.png'), image.toPNG())
  app.quit()
})

