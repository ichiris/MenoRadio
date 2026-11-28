# MenoRadio 插件开发文档

MenoRadio 提供了一套覆盖**后端（Electron 主进程）**、**前端（渲染进程）**与**悬浮歌词独立窗口**的全栈插件架构。插件几乎可以扩展或改造软件的任意层面——包括**登录认证、主题配色、侧边栏与页面界面、沉浸式播放页、音频处理管线、歌词系统、数据与音源后端、系统托盘与全局快捷键**等，同时具备**版本兼容性校验、崩溃隔离、热重载与自动资源回收**能力。

---

## 目录

1. [架构总览](#1-架构总览)
2. [快速开始（5 分钟编写第一个插件）](#2-快速开始5-分钟编写第一个插件)
3. [插件清单 `plugin.json` 规范](#3-插件清单-pluginjson-规范)
4. [后端插件开发（`main.cjs`）](#4-后端插件开发maincjs)
5. [前端插件开发（`renderer.js`）](#5-前端插件开发rendererjs)
6. [悬浮歌词插件开发（`floating.js`）](#6-悬浮歌词插件开发floatingjs)
7. [全量 UI 插槽与钩子速查表](#7-全量-ui-插槽与钩子速查表)
8. [常见场景实战示例](#8-常见场景实战示例)
9. [调试、热重载与打包分发](#9-调试热重载与打包分发)
10. [生命周期与开发最佳实践](#10-生命周期与开发最佳实践)

---

## 1. 架构总览

MenoRadio 插件以目录形式存在，运行时由三个协同宿主加载：

```text
my-plugin/
├── plugin.json         # 插件清单（元数据、版本范围、入口、声明式主题/设置/多语言）
├── icon.svg            # 可选：插件图标
├── main.cjs            # 可选：后端入口（Node.js / Electron 主进程，CommonJS）
├── renderer.js         # 可选：前端入口（主窗口渲染进程，原生 ES Module）
├── styles.css          # 可选：全局注入样式表
├── floating.js         # 可选：悬浮歌词窗口入口（原生 ES Module）
└── floating.css        # 可选：悬浮歌词窗口样式表
```

### 核心机制

- **`menoradio-plugin://` 特权协议**：前端脚本、样式、字体、图标和媒体资源均通过 `menoradio-plugin://<pluginId>/<相对路径>?rev=<版本号>` 安全加载，无需 `eval`，原生支持 ES Module 相对导入（`import './helper.js'`）和 HTTP `Range` 音频流读取。
- **自动资源回收（Disposable Tracking）**：通过插件 API 注册的所有钩子、IPC 拦截器、样式、主题、导航、路由、快捷键、菜单项、UI 插槽与子窗口，都会在插件**禁用 / 重载 / 卸载**时自动释放，避免内存或事件泄漏。
- **独立数据目录**：每个插件拥有独立的配置与持久化存储目录 `<userData>/plugin-data/<pluginId>/`（`settings.json` 与 `storage.json`）。
- **错误隔离与诊断**：单个插件加载或运行异常不会阻塞 MenoRadio 主程序启动，所有错误栈与运行日志均可在 **设置 → 插件 → 详情** 中查看。

---

## 2. 快速开始（5 分钟编写第一个插件）

### 第一步：创建插件目录

在任意本地目录创建一个文件夹，例如 `hello-menoradio/`，新建两个文件：

**`hello-menoradio/plugin.json`**

```json
{
  "id": "com.example.hello-menoradio",
  "name": "Hello MenoRadio",
  "author": "Your Name",
  "description": "我的第一个 MenoRadio 插件：新增一套渐变主题和一条顶部快捷按钮。",
  "version": "1.0.0",
  "supportedVersions": ">=0.17.0 <1.0.0",
  "capabilities": ["theme", "ui", "frontend"],
  "renderer": "renderer.js",
  "contributes": {
    "themes": [
      {
        "id": "sunset-ember",
        "label": "落日余晖",
        "colorScheme": "dark",
        "variables": {
          "--bg": "#1b141a",
          "--accent": "#f59e6c",
          "--accent-rgb": "245, 158, 108",
          "--accent-strong": "#fdb98f"
        }
      }
    ]
  }
}
```

**`hello-menoradio/renderer.js`**

```js
export function activate(api) {
  // 在顶部工具栏挂载一个按钮
  api.ui.mountSlot('toolbar-actions', (slot) => {
    const btn = document.createElement('button')
    btn.className = 'secondary-button'
    btn.textContent = '打招呼'
    btn.addEventListener('click', () => {
      const track = api.player.getState().current
      api.ui.toast(track ? `正在播放：${track.name}` : '欢迎开发 MenoRadio 插件！', 'Hello')
    })
    slot.appendChild(btn)
  })
}

export function deactivate() {
  // 通过 api 注册的插槽与主题会自动清理，这里只需处理手动创建的外部资源
}
```

### 第二步：在 MenoRadio 中以开发模式加载

1. 打开 MenoRadio，进入 **设置 → 扩展 → 插件**。
2. 点击右上角 **加载插件** → 选择 **链接本地文件夹**，选中 `hello-menoradio/`。
3. 插件将立即启用！你可以在 **设置 → 外观 → 配色方案** 中看到“落日余晖”，在顶部工具栏看到“打招呼”按钮。
4. 后续修改代码后，只需在插件卡片上点击 **重载** 即可热更新生效。

> 仓库内自带两个可直接链接体验的完整示例插件：
> - `examples/plugins/aurora-studio`（全栈示例：主题 + 播放器样式 + 沉浸视图 + 侧边栏统计页 + 后端计数服务）
> - `examples/plugins/custom-login-demo`（登录扩展示例：自定义登录选项卡 + 后端会话拦截）

---

## 3. 插件清单 `plugin.json` 规范

插件根目录必须包含 `plugin.json`（也兼容 `manifest.json`）。

### 3.1 基础展示字段（设置页核心展示项）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | `string` | 是 | **插件名**（最长 80 字符） |
| `author` | `string \| { name, url?, email? }` | 推荐 | **作者**，对象形式带 `url` 时在设置页可点击跳转 |
| `description` | `string` | 推荐 | **描述**（最长 500 字符） |
| `version` | `string` | 是 | **插件版本**（SemVer，例如 `1.0.0`、`0.2.1-beta.1`） |
| `supportedVersions` | `string \| { min?, max? }` | 推荐 | **支持的版本范围**（SemVer 范围，如 `>=0.17.0 <1.0.0`、`^0.17.0`、`*`） |

> `supportedVersions` 也兼容 `compatibleVersions`、`engines.menoradio` 或 `minAppVersion` / `maxAppVersion` 写法。

#### 支持的版本范围（SemVer Range）语法

| 表达式 | 含义 | 示例匹配（主程序 `0.17.0`） |
| --- | --- | --- |
| `*` 或 `0.17.x` | 任意版本 / 通配段 | 匹配 |
| `>=0.17.0 <1.0.0` | 空格分隔表示“且（AND）” | 匹配 |
| `^0.17.0` | 兼容次版本（`0.y.z` 规则为 `>=0.17.0 <0.18.0`） | 匹配 |
| `~0.17.0` | 兼容修订版本（`>=0.17.0 <0.18.0`） | 匹配 |
| `0.17.0 - 0.25.0` | 连字符闭区间 | 匹配 |
| `^0.17.0 \|\| ^0.18.0` | `\|\|` 表示“或（OR）” | 匹配 |

若插件声明的 `supportedVersions` 与当前 MenoRadio 版本不匹配：
- 安装时会保留为**禁用**状态，并显示 **版本不兼容** 警告徽章；
- 用户如确认需要，可在启用开关弹窗中选择 **仍要启用** 强制开启。

### 3.2 其他元数据与入口字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | 唯一标识（建议反向域名如 `com.author.plugin-name`，2-80 位 `[a-z0-9._-]`；省略时由 `name` 自动生成） |
| `icon` | `string` | 图标相对路径（支持 `.svg` / `.png` / `.webp`） |
| `homepage` | `string` | 项目主页 URL（`http://` 或 `https://`） |
| `license` | `string` | 开源协议标识（如 `MIT`） |
| `keywords` | `string[]` | 搜索关键词 |
| `capabilities` | `string[]` | 能力标签（如 `theme`、`ui`、`player`、`login`、`lyrics`、`audio`、`data`、`backend`、`frontend`、`floating-lyrics`） |
| `main` | `string` | 后端主进程入口（CommonJS，如 `main.cjs`） |
| `renderer` | `string` | 主窗口渲染进程入口（ES Module，如 `renderer.js`） |
| `floatingLyrics` | `string` | 悬浮歌词窗口入口（ES Module，如 `floating.js`） |
| `styles` | `string[]` | 自动注入主窗口的 CSS 文件列表 |
| `floatingStyles` | `string[]` | 自动注入悬浮歌词窗口的 CSS 文件列表 |

### 3.3 声明式贡献（`contributes`）

#### 1) 声明式主题 `contributes.themes`

```json
"contributes": {
  "themes": [
    {
      "id": "midnight-rose",
      "label": "午夜玫瑰",
      "colorScheme": "dark",
      "css": "themes/midnight-rose.css",
      "variables": {
        "--bg": "#1a1118",
        "--accent": "#f472b6",
        "--accent-rgb": "244, 114, 182",
        "--accent-strong": "#f9a8d4"
      }
    }
  ]
}
```

- 声明后会自动出现在 **设置 → 外观 → 配色方案** 下拉列表中。
- 当 `colorScheme` 为 `"light"` 时，MenoRadio 会自动补全浅色系表面对比度规则。

#### 2) 声明式设置项 `contributes.settings`

```json
"contributes": {
  "settings": [
    {
      "key": "enableSpectrum",
      "type": "boolean",
      "label": "启用音频频谱",
      "description": "在沉浸播放页底部绘制实时频谱",
      "default": true
    },
    {
      "key": "mode",
      "type": "select",
      "label": "渲染模式",
      "default": "bars",
      "options": [
        { "value": "bars", "label": "柱状频谱" },
        { "value": "wave", "label": "柔和波形" }
      ]
    },
    {
      "key": "gain",
      "type": "number",
      "label": "灵敏度",
      "min": 1,
      "max": 10,
      "step": 1,
      "default": 5
    },
    {
      "key": "barColor",
      "type": "color",
      "label": "频谱颜色",
      "default": "#68c7c3"
    },
    {
      "key": "apiUrl",
      "type": "string",
      "label": "自定义接口地址",
      "placeholder": "https://api.example.com",
      "default": ""
    },
    {
      "key": "customCss",
      "type": "textarea",
      "label": "附加样式",
      "default": ""
    }
  ]
}
```

- 声明后插件卡片自动出现 **设置** 按钮，保存的设置会实时同步到后端 `ctx.settings` 与前端 `api.settings`。

#### 3) 声明式多语言 `contributes.locales`

```json
"contributes": {
  "locales": {
    "zh-CN": { "myPlugin.title": "我的扩展" },
    "en": { "myPlugin.title": "My Extension" },
    "ja": { "myPlugin.title": "マイ拡張機能" }
  }
}
```

---

## 4. 后端插件开发（`main.cjs`）

后端模块运行在 Electron 主进程中，拥有完整的 Node.js 能力与受控的 Electron / MenoRadio 宿主上下文 `ctx`。

```js
module.exports = {
  async activate(ctx) {
    // 初始化逻辑；返回函数可作为额外清理回调
    return () => {
      // 可选 dispose
    }
  },
  async deactivate(ctx) {
    // 停用前回调
  },
}
```

### 4.1 宿主上下文 `ctx` API 完整参考

#### 基础属性与日志

- `ctx.id` / `ctx.manifest` / `ctx.dir` / `ctx.dataDir` / `ctx.appVersion` / `ctx.baseUrl`
- `ctx.resolvePath(...segments)`：解析插件目录内路径
- `ctx.onDispose(fn)`：注册停用时的清理回调
- `ctx.logger.info(msg)` / `warn(msg)` / `error(msg, err)` / `debug(msg)`（同时写入插件详情页运行日志）

#### 持久化存储与配置

- `ctx.settings.get(key)` / `getAll()` / `set(keyOrPatch, value)` / `onChange(fn)`
- `ctx.storage.get(key, defaultValue)` / `set(key, value)` / `delete(key)` / `all()` / `clear()` / `dataDir`

#### IPC 中间件拦截（影响几乎所有前后端数据流）

```js
ctx.ipc.intercept(channel, async (payload, next, meta) => {
  // 1. 可以在调用原生处理器前修改 payload
  // 2. 可以直接返回自定义结果（短路原生逻辑）
  // 3. 也可以先调用 await next(payload)，再加工返回结果
  const result = await next(payload)
  return result
}, priority = 0)
```

可拦截的全部内置 IPC 通道包括：
- **认证登录**：`auth:state`、`auth:create-qr`、`auth:check-qr`、`auth:login-password`、`auth:import-cookie`、`auth:logout`
- **音乐数据**：`data:home`、`data:search`、`data:daily`、`data:daily-refresh`、`data:personal-fm`、`data:playlist`、`data:artist`、`data:artist-songs`、`data:album`、`data:user-detail`、`data:user-playlists`、`data:user-connections`、`data:lyrics`、`data:song-url`、`data:like`、`data:like-list`、`data:playlist-subscribe`、`data:playlist-create`、`data:playlist-update`、`data:playlist-delete`、`data:playlist-track`、`data:playlist-reorder`
- **媒体与图片**：`media:playback-url`、`media:preload-next`、`image:thumbnail`
- **悬浮歌词**：`floating-lyrics:state`、`floating-lyrics:configure`、`floating-lyrics:update`、`floating-lyrics:reset`
- **应用与窗口**：`window:*`、`app:*`、`*`（通配监听全部通道）

#### 插件自定义前后端通信

- `ctx.ipc.handle(method, async (payload) => result)`：注册专属后端方法，供前端通过 `api.backend.invoke(method, payload)` 调用
- `ctx.ipc.send(event, payload)`：主动向前端与悬浮歌词窗口推送事件，前端通过 `api.backend.on(event, fn)` 监听

#### 网易云底层 API 钩子与直接调用

- `ctx.api.call(name, params, includeCookie)`：直接调用任意 `@neteasecloudmusicapienhanced/api` 接口
- `ctx.api.raw()`：获取底层 API 模块对象
- `ctx.hooks.beforeApi(async (req) => ...)`：参数 `{ name, params, includeCookie, handled, cancel }`；返回 `{ handled: true, result }` 可短路返回
- `ctx.hooks.afterApi(async (res) => ...)`：参数 `{ name, params, result }`；返回 `{ result: modified }` 可修改响应
- `ctx.hooks.onApiError(async (errCtx) => ...)`：参数 `{ name, params, error, handled }`；返回 `{ handled: true, result }` 可故障兜底

#### 认证与会话控制

- `ctx.auth.getSession()` -> `{ loggedIn, profile, cookie }`
- `ctx.auth.setSession(cookie, profile)`：写入并加密持久化登录态
- `ctx.auth.clearSession()`：清除登录态

#### 自定义音源流、缩略图与网络白名单

- `ctx.media.allowHost(hostname | RegExp | (url) => boolean)`：将第三方音源/封面域名加入 MenoRadio 的媒体与缩略图代理白名单（支持 `https:` 与显式允许的 `http:`，如 `localhost`）
- `ctx.media.registerStreamProvider(matcher, handler, priority)`：接管匹配 URL 的音频流；可返回：
  - `{ directUrl: '...' }`：直接返回流地址
  - `{ url: '...' }`：重定向到新的上游地址
  - `{ contentType, size, readRange(start, end, source) }`：自定义分片读取（如本地文件 / 解密音频）
  - `{ response(request, source) }`：完全自定义返回 Web `Response` 对象
- `ctx.media.registerThumbnailProvider(matcher, handler, priority)`：返回 `{ mimeType, bytes: Uint8Array }` 提供自定义封面缩略图
- `ctx.protocol.registerRoute(prefix, handler)`：拦截 `menoradio-plugin://<id>/<prefix>/...` 请求，可直接返回 `Response` 或 JSON 对象
- `ctx.network.fetch(url, options)`：使用 Electron `net.fetch` 发起网络请求

#### 窗口、悬浮歌词、Electron 系统能力与跨插件服务

- `ctx.windows.getMain()` / `ctx.windows.getFloatingLyrics()` / `ctx.windows.create(BrowserWindowOptions)`（插件创建的子窗口会在停用时自动销毁）
- `ctx.floatingLyrics.getState()` / `configure(patch)` / `update(payload)`
- `ctx.electron`：提供 `app`、`BrowserWindow`、`Tray`、`Menu`、`globalShortcut`、`Notification`、`dialog`、`shell`、`clipboard`、`nativeTheme`、`nativeImage`、`screen`、`net`、`session`
- `ctx.services.provide(name, impl)` / `ctx.services.get(name)`：向其他插件（及前端 `api.backend.invokeService`）暴露共享服务
- `ctx.events.on(eventName, handler)`：监听主进程及前端镜像事件（如 `app:ready`、`window:main-created`、`auth:login`、`auth:logout`、`player:track-changed`、`player:play`、`player:pause`、`player:immersive-toggle`、`route:changed`、`theme:changed`）

---

## 5. 前端插件开发（`renderer.js`）

前端入口以**原生 ES Module** 方式在渲染进程中运行，可导出 `activate(api)` 与 `deactivate(api)`（或 `export default { activate, deactivate }`）：

```js
export async function activate(api) {
  // ...
}

export async function deactivate(api) {
  // ...
}
```

### 5.1 主题与样式（`api.theme` & `api.styles`）

- `api.theme.register({ id, label, colorScheme, variables, css, cssFile })`
- `api.theme.list()` / `api.theme.getCurrent()` / `api.theme.apply(themeId)`
- `api.theme.setVariables({ '--accent': '#ff6b9d' })`（动态覆写 CSS 变量，停用时自动恢复）
- `api.theme.onChange(({ theme }) => ...)`
- `api.styles.inject(cssText, id)` / `api.styles.injectFile(relPath)`
- `await api.styles.registerFont({ family, label, src, descriptors })`（加载插件自带字体并注册到字体选择器）

### 5.2 登录系统扩展（`api.auth`）

- `api.auth.registerLoginTab({ id, label, order, render(container, helpers), unmount })`：在登录弹窗中新增选项卡；`helpers` 提供 `{ completeLogin(profile), closeModal, reloadAccount, toast, auth }`
- `api.auth.replaceLoginModal((helpers) => ...)`：完全接管并自定义整个登录弹窗
- `api.auth.getState()` / `showLogin()` / `logout()` / `reloadAccount()` / `completeLogin(profile)`
- 钩子：`auth:beforeShowLogin`、`auth:profileUi`、`auth:beforeLogout`；事件：`auth:login`、`auth:logout`

### 5.3 界面、导航、路由、菜单与设置（`api.ui`）

- `api.ui.mountSlot(slotName, (slotEl, hostEl) => cleanup?, { id, order })`：在任意内置 UI 插槽挂载内容（页面切换重绘后自动保持）
- `api.ui.registerNavItem({ id, label, icon, route, group: 'discover' | 'library' | 'plugins', order, badge, onClick })`
- `api.ui.registerRoute(routeName, { title, render(container, payload, helpers), unmount })`
- `api.ui.registerTrackMenuItem({ id, label, icon, danger, order, when(track, ctx), onClick(track, ctx) })`
- `api.ui.registerPlaylistMenuItem({ id, label, icon, danger, order, when(playlist, ctx), onClick(playlist, ctx) })`
- `api.ui.registerSettingsCard({ id, order, render(cardEl) })`：直接向主设置页注入自定义卡片
- `api.ui.registerSettingsRenderer((bodyEl, { plugin, settings, save, close }) => ...)`：完全自定义该插件在设置页的专属配置界面
- `api.ui.showModal({ title, subtitle, content, render, width, actions, onMount, onClose })` / `closeModal()`
- `api.ui.toast(message, title, type)` / `navigate(route, payload)`
- `api.ui.registerIcon(name, innerSvgMarkup, viewBox)`：注册可复用的 SVG 图标符号（供 `icon` 字段使用）
- `api.ui.getDom()`：获取核心 DOM 节点引用

### 5.4 播放器页面与音频管线（`api.player`）

- **状态与控制**：
  - `api.player.getState()`
  - `play()` / `pause()` / `togglePlay()` / `next()` / `previous()` / `seek(seconds)` / `setVolume(0..1)` / `toggleMute()`
  - `playTracks(tracks, index, options)` / `queueNext(track)` / `insertQueue(track, index)` / `removeQueue(index)` / `clearQueue()`
  - `openImmersive(boolean)` / `setImmersiveView(viewId)`
- **自定义播放器页面样式**：
  - `api.player.registerStyle({ id, label, className, css, cssFile, onActivate(immersiveEl), onDeactivate(immersiveEl) })`
  - 自动加入 **设置 → 外观 → 播放器样式** 选项！
- **自定义沉浸播放页视图**：
  - `api.player.registerImmersiveView({ id, label, icon, order, render(panelEl), onShow(panelEl), onHide(panelEl), unmount })`
  - 自动在播放页底部视图切换栏（歌词 / 全屏 / 队列旁）新增切换按钮，并与歌词面板平滑切换！
- **Web Audio API 共享音效与频谱图（`api.player.audio`）**：
  - `api.player.audio.getElement()`：获取 `<audio>` 元素
  - `api.player.audio.getGraph()` -> `{ context, analyser }`（多个插件可安全共享同一个 `AudioContext` 与 `AnalyserNode`）
  - `api.player.audio.connectNode((audioContext) => audioNode | { input, output, dispose })`：向播放链路串入自定义音效节点（如多段均衡器 `BiquadFilterNode`、混响、声场增强），停用插件时自动旁路重连！

> 提示：使用 Web Audio API 分析或处理音频时，建议保持设置中的 **媒体加载优化** 开启（`menoradio-media:` 协议默认支持 CORS），或由自定义音源返回允许跨域的流响应。

### 5.5 歌词管线（`api.lyrics`）

- `api.lyrics.getCurrent()` -> `{ lines, breaks, activeIndex, rawBody }`
- `api.lyrics.refresh()`：触发当前歌曲歌词重新解析与渲染
- `api.lyrics.setLyrics(lines, breaks)`：直接替换当前歌词列表
- 钩子：`lyrics:beforeFetch`、`lyrics:afterFetch`、`lyrics:transformDocument`、`lyrics:renderLine`、`lyrics:floatingPayload`

### 5.6 快捷键、国际化、存储、通信与深度可逆补丁

- `api.shortcuts.register('Ctrl+Shift+P', (event) => ..., { allowInInput, description })`
- `api.i18n.t(key, params)` / `getLocale()` / `register(locale, dict)` / `onChange(fn)`
- `api.settings.get/getAll/set/onChange`
- `api.storage.get/set/delete/all`（与主进程持久同步）及 `api.storage.local.get/set/remove`
- `api.backend.invoke(method, payload)` / `api.backend.invokeService(service, method, payload)` / `api.backend.on(event, fn)`
- `api.services.provide(name, impl)` / `api.services.get(name)`
- `api.app.state` / `api.app.dom` / `api.app.actions` / `api.app.patch(actionName, (next, ...args) => ...)`（自动可逆的方法包装，插件停用时按栈还原）

---

## 6. 悬浮歌词插件开发（`floating.js`）

当插件在 `plugin.json` 中声明 `floatingLyrics` 或 `floatingStyles` 时，独立的透明悬浮歌词窗口也会自动加载该插件：

```js
// floating.js
export function activate(api) {
  // 注入悬浮歌词自定义样式
  api.styles.inject(`
    .line.primary { letter-spacing: 0.04em; }
  `)

  // 拦截悬浮歌词渲染内容
  api.hooks.tap('lyrics:render', ({ payload }) => {
    if (payload.text) {
      return { payload: { ...payload, text: `♪ ${payload.text}` } }
    }
  })

  // 拦截悬浮歌词外观配置
  api.hooks.tap('config:apply', ({ config }) => {
    return { config }
  })
}
```

悬浮歌词 `api` 同时支持 `api.dom`、`api.config`、`api.payload`、`api.settings`、`api.backend.invoke/on`、`api.styles`、`api.onDispose`。

---

## 7. 全量 UI 插槽与钩子速查表

### 7.1 UI 插槽（`api.ui.mountSlot(name, factory)`）

| 插槽名 | 所在位置 | 典型用途 |
| --- | --- | --- |
| `titlebar-left` | 顶部标题栏左侧（Logo 旁） | 状态徽标、在线指示灯 |
| `titlebar-right` | 顶部标题栏右侧（窗口按钮前） | 快捷模式开关、迷你工具按钮 |
| `sidebar-top` | 侧边栏导航最上方 | 账号切换器、快捷入口卡片 |
| `sidebar-bottom` | 侧边栏歌单列表下方 | 状态面板、下载进度条 |
| `sidebar-footer` | 侧边栏底部设置按钮旁 | 快捷图标按钮 |
| `toolbar-center` | 主内容顶部工具栏中间 | 全局快捷搜索框、实时提示 |
| `toolbar-actions` | 主内容顶部工具栏右侧 | 全局操作按钮 |
| `page-top` | 页面滚动区上方 | 公告横幅、筛选条 |
| `page-bottom` | 页面滚动区下方 | 底部状态栏 |
| `player-bar-left` | 底部播放条歌曲信息右侧 | 音质/格式标签、收藏扩展按钮 |
| `player-bar-center` | 底部播放条控制区右侧 | 倍速/AB 循环/音效开关 |
| `player-bar-extra` | 底部播放条时间标签左侧 | 均衡器开关、睡眠定时器 |
| `player-bar-right` | 底部播放条队列按钮右侧 | 快捷工具按钮 |
| `immersive-header` | 沉浸播放页顶部左侧 | 返回外的额外工具按钮 |
| `immersive-panel-overlay` | 沉浸播放页全屏背景上层 | Canvas/WebGL 音频可视化粒子 |
| `immersive-cover-overlay` | 沉浸播放页专辑封面覆盖层 | 黑胶唱针、频谱光环、徽章 |
| `immersive-meta-extra` | 沉浸播放页歌名与歌手下方 | 码率/采样率标签、播放计数 |
| `immersive-controls-extra` | 沉浸播放页播控栏右侧 | 额外播放控制按钮 |
| `immersive-view-controls` | 沉浸播放页底部视图栏 | 额外玻璃按钮 |
| `immersive-lyric-options` | 沉浸播放页右下角歌词选项区 | 罗马音开关、歌词偏移微调 |
| `queue-header` | 播放队列抽屉标题栏 | 保存队列为歌单、去重按钮 |
| `settings-top` / `settings-bottom` | 设置页顶部 / 底部 | 全局横幅或诊断信息 |
| `app-overlay` | 全局浮层容器 | 悬浮迷你播放器、快捷命令面板 |

### 7.2 前端钩子（`api.hooks.tap(name, fn)`）

| 钩子名 | 时机 | 可修改 / 拦截行为 |
| --- | --- | --- |
| `route:beforeRender` | 页面路由渲染前 | 返回 `{ handled: true }` 完全接管任意内置或自定义页面 |
| `route:afterRender` | 页面路由渲染后 | 异步获取 `{ route, payload, page }` 增强 DOM |
| `page:rendered` | `#page` DOM 变更完成时（同步） | 异步页面数据渲染完成后自动触发，适合注入页面内组件 |
| `theme:apply` | 应用主题后（同步） | 监听或同步修改 CSS 变量 |
| `auth:beforeShowLogin` | 打开登录弹窗前（同步） | 返回 `{ handled: true }` 拦截登录弹窗 |
| `auth:profileUi` | 渲染侧边栏用户信息后（同步） | 自定义头像、用户名与副标题 |
| `auth:beforeLogout` | 退出登录前（异步） | 返回 `{ cancel: true }` 可中止退出 |
| `track:normalize` | 标准化歌曲对象时（同步） | 附加自定义字段或修正歌曲信息 |
| `playlist:normalize` | 标准化歌单对象时（同步） | 附加自定义字段或修正歌单信息 |
| `player:beforeLoadTrack` | 加载曲目前（异步） | 修改 `{ track, autoplay }` 或返回 `{ cancel: true }` |
| `player:resolveAudioSource` | 解析播放音频源前（异步） | 返回 `{ handled: true, url, audioSource, useProxy }` 接管音频源 |
| `player:nowPlayingRender` | 更新当前播放 UI 后（同步） | 增强底部播控条与沉浸页元数据 |
| `player:backdropBeforeRender` | 渲染沉浸页背景前（同步） | 替换背景图 URL 或返回 `{ handled: true }` 自绘背景 |
| `lyrics:beforeFetch` | 请求歌词前（异步） | 返回 `{ handled: true, body }` 注入第三方/本地歌词 |
| `lyrics:afterFetch` | 请求歌词后（异步） | 修改或补充原始歌词 `body` |
| `lyrics:transformDocument` | 解析歌词文档后（异步） | 修改 `{ lines, breaks }`（如批量平移时间轴、补充翻译） |
| `lyrics:renderLine` | 渲染单行歌词 HTML 时（同步） | 修改单行 `{ html }`（如追加罗马音、注音） |
| `lyrics:floatingPayload` | 发送给悬浮歌词前（同步） | 修改 `{ payload }` 文本或翻译 |

---

## 8. 常见场景实战示例

### 8.1 后端拦截音源实现灰歌兜底 / 自定义曲库

```js
// main.cjs
module.exports = {
  activate(ctx) {
    // 1. 允许自定义音源域名通过媒体代理
    ctx.media.allowHost('audio.my-server.example')

    // 2. 拦截 data:song-url IPC 通道
    ctx.ipc.intercept('data:song-url', async (payload, next) => {
      const response = await next(payload)
      const hasUrl = response?.ok && response.data?.data?.[0]?.url
      if (hasUrl) return response

      // 原生接口未返回可用音源时，由插件提供兜底音频 URL
      const fallbackUrl = `https://audio.my-server.example/stream/${encodeURIComponent(payload.id)}.flac`
      return {
        ok: true,
        data: {
          code: 200,
          data: [{ id: payload.id, url: fallbackUrl, level: 'lossless' }],
          requestedLevel: payload.level,
          resolvedLevel: 'lossless',
        },
      }
    })
  },
}
```

### 8.2 在沉浸播放页添加 3 段均衡器（Web Audio API）

```js
// renderer.js
export function activate(api) {
  api.player.audio.connectNode((audioCtx) => {
    const low = audioCtx.createBiquadFilter()
    low.type = 'lowshelf'
    low.frequency.value = 120
    low.gain.value = Number(api.settings.get('bassBoost') || 0)

    api.settings.onChange((settings) => {
      low.gain.value = Number(settings.bassBoost || 0)
    })

    return { input: low, output: low }
  })
}
```

### 8.3 在沉浸播放页显示歌词罗马音

```js
// renderer.js
export function activate(api) {
  api.hooks.tap('lyrics:renderLine', ({ line, html }) => {
    if (!line.romanization) return
    const romajiHtml = `<div class="lyric-translation lyric-romaji">${api.core.escapeHtml(line.romanization)}</div>`
    return { html: html.replace('</div></div>', `${romajiHtml}</div></div>`) }
  })
  api.lyrics.refresh()
}
```

### 8.4 注册系统托盘与全局快捷键（后端）

```js
// main.cjs
module.exports = {
  activate(ctx) {
    const { globalShortcut } = ctx.electron
    if (!globalShortcut) return
    globalShortcut.register('CommandOrControl+Alt+Right', () => {
      ctx.ipc.send('shortcut:next')
    })
    ctx.onDispose(() => {
      globalShortcut.unregister('CommandOrControl+Alt+Right')
    })
  },
}
```

---

## 9. 调试、热重载与打包分发

### 9.1 开发调试工作流

1. 使用 `npm run dev` 启动 MenoRadio（会自动打开渲染进程 DevTools）。
2. 在 **设置 → 插件 → 加载插件 → 以开发模式链接本地文件夹** 中选择你的开发目录。
3. 修改 `main.cjs` / `renderer.js` / `styles.css` / `plugin.json` 后，点击插件卡片的 **重载**：
   - 后端会自动清理 `require.cache` 并重新执行 `activate(ctx)`；
   - 前端会自动停用旧实例、移除旧样式与注册项，并以递增 `?rev=` 重新动态导入 ES Module。
4. 点击 **详情** 可随时查看最近的错误堆栈与运行日志。

### 9.2 打包为 `.mrplugin` 或 `.zip`

将插件根目录（或包含单层顶层目录的插件文件夹）打包为标准 ZIP 文件即可，扩展名可命名为 `.mrplugin` 或 `.zip`：

```text
my-plugin-1.0.0.mrplugin
├── plugin.json
├── icon.svg
├── main.cjs
├── renderer.js
└── styles.css
```

用户可通过 **设置 → 插件 → 加载插件 → 从压缩包安装**，或直接将 `.mrplugin` / `.zip` 拖放到插件管理页面完成一键安装。

---

## 10. 生命周期与开发最佳实践

1. **准确填写基础信息与版本范围**：务必填写清晰的 `name`、`author`、`description`、`version` 与合理的 `supportedVersions`（例如 `>=0.17.0 <1.0.0`），确保用户在设置页获得直观透明的兼容性提示。
2. **清理外部副作用**：通过 `api.*` / `ctx.*` 注册的所有扩展点会自动清理；若手动创建了 `setInterval`、全局 `window` 事件监听、第三方 HTTP 服务器或自定义 DOM，请务必通过 `api.onDispose(() => ...)` 或 `ctx.onDispose(() => ...)` 释放。
3. **样式命名空间**：建议为插件添加的 CSS 类名与变量加上独特前缀（如 `.aurora-*`、`--aurora-*`），避免污染主程序样式或其他插件。
4. **避免硬编码绝对路径**：前端加载插件内图片/字体请使用 `api.assetUrl('assets/foo.png')`，后端读写文件请使用 `ctx.resolvePath(...)` 或 `ctx.storage.dataDir`。
5. **妥善处理异常**：异步网络请求和 DOM 查寻请做好判空与容错，利用 `api.ui.toast` 和 `ctx.logger` 给出清晰的错误提示。
