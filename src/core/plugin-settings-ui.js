// Settings -> Plugins management page and dialogs for MenoRadio.
;((root) => {
  let searchQuery = ''
  let appVersionCache = '0.18.0'
  let settingsRenderGeneration = 0

  function alertBadge(plugin, t) {
    if (plugin.missing) return { cls: 'error', label: t('目录丢失') }
    if (plugin.status === 'error' || plugin.error) return { cls: 'error', label: t('加载出错') }
    const compatStatus = plugin.compatibility?.status
    if (compatStatus === 'incompatible' || compatStatus === 'invalid-range') {
      return { cls: 'warning', label: t('不兼容') }
    }
    return null
  }

  function compatibilityText(plugin, t) {
    const status = plugin.compatibility?.status
    if (status === 'compatible') return t('兼容当前版本')
    if (status === 'unspecified') return t('未限定版本范围')
    if (status === 'invalid-range') return t('版本范围语法无效')
    return t('与当前版本 v{version} 不兼容', { version: plugin.compatibility?.appVersion || appVersionCache })
  }

  function filterPlugins(list) {
    const query = searchQuery.trim().toLocaleLowerCase()
    if (!query) return Array.isArray(list) ? list : []
    return (Array.isArray(list) ? list : []).filter((plugin) => {
      const haystack = [
        plugin.name,
        plugin.id,
        plugin.author,
        plugin.description,
        plugin.version,
        plugin.supportedVersions,
        ...(plugin.keywords || []),
      ].join(' ').toLocaleLowerCase()
      return haystack.includes(query)
    })
  }

  function pluginIconMarkup(plugin, { attr, icon }) {
    if (plugin.iconUrl) {
      return `<span class="plugin-card-icon has-image"><img src="${attr(plugin.iconUrl)}" alt=""></span>`
    }
    return `<span class="plugin-card-icon" aria-hidden="true">${icon('plugin')}</span>`
  }

  function pluginCardMarkup(plugin, ctx) {
    const { escapeHtml, attr, icon, t, pluginsHost } = ctx
    const badge = alertBadge(plugin, t)
    const incompatible = plugin.compatibility?.status === 'incompatible' || plugin.compatibility?.status === 'invalid-range'
    const hasSettings = Boolean(
      (plugin.contributes?.settings?.length || 0) > 0
      || (plugin.enabled && pluginsHost?.getSettingsRenderer?.(plugin.id))
    )
    const authorMarkup = plugin.authorUrl
      ? `<button type="button" class="settings-link" data-external="${attr(plugin.authorUrl)}">${escapeHtml(plugin.author)}</button>`
      : `<span>${escapeHtml(plugin.author || t('未知作者'))}</span>`

    return `<article class="plugin-card ${plugin.error || plugin.missing ? 'has-error' : ''}" data-plugin-id="${attr(plugin.id)}">
      <div class="plugin-card-main">
        ${pluginIconMarkup(plugin, ctx)}
        <div class="plugin-card-body">
          <div class="plugin-card-head">
            <h3 class="plugin-card-name">${escapeHtml(plugin.name)}</h3>
            <span class="plugin-card-version">v${escapeHtml(plugin.version)}</span>
            ${badge ? `<span class="plugin-badge is-${badge.cls}">${escapeHtml(badge.label)}</span>` : ''}
            ${plugin.source === 'linked' ? `<span class="plugin-badge is-linked">${escapeHtml(t('开发'))}</span>` : ''}
          </div>
          ${plugin.description ? `<p class="plugin-card-desc">${escapeHtml(plugin.description)}</p>` : ''}
          <div class="plugin-card-meta">
            ${authorMarkup}
            <span class="plugin-meta-sep" aria-hidden="true">·</span>
            <span class="plugin-version-range ${incompatible ? 'is-incompatible' : ''}" title="${attr(compatibilityText(plugin, t))}">${escapeHtml(t('支持 {range}', { range: plugin.supportedVersions || '*' }))}</span>
          </div>
          ${plugin.error ? `<div class="plugin-error-line" role="alert">${escapeHtml(plugin.error.message)}</div>` : ''}
        </div>
      </div>
      <div class="plugin-card-controls">
        <div class="plugin-card-actions">
          ${hasSettings ? `<button type="button" class="icon-button plugin-icon-action" data-plugin-settings="${attr(plugin.id)}" title="${attr(t('设置'))}" aria-label="${attr(t('插件设置'))}">${icon('sliders')}</button>` : ''}
          <button type="button" class="icon-button plugin-icon-action" data-plugin-reload="${attr(plugin.id)}" title="${attr(t('重载'))}" aria-label="${attr(t('重载插件'))}">${icon('refresh')}</button>
          <button type="button" class="icon-button plugin-icon-action" data-plugin-details="${attr(plugin.id)}" title="${attr(t('详情'))}" aria-label="${attr(t('插件详情'))}">${icon('info')}</button>
          <button type="button" class="icon-button plugin-icon-action is-danger" data-plugin-uninstall="${attr(plugin.id)}" title="${attr(plugin.source === 'linked' ? t('移除链接') : t('卸载'))}" aria-label="${attr(plugin.source === 'linked' ? t('移除链接') : t('卸载插件'))}">${icon('trash')}</button>
        </div>
        <label class="setting-switch" title="${attr(plugin.enabled ? t('禁用插件') : t('启用插件'))}">
          <input type="checkbox" data-plugin-toggle="${attr(plugin.id)}" ${plugin.enabled ? 'checked' : ''} ${plugin.missing ? 'disabled' : ''}>
          <i></i>
        </label>
      </div>
    </article>`
  }

  function showLoadPluginModal(ctx) {
    const { dom, escapeHtml, attr, icon, t, closeModal, bridge, toast, refreshPage } = ctx
    const options = [
      {
        mode: 'folder',
        iconName: 'folder',
        label: t('从文件夹安装'),
        tip: t('将插件目录复制到 MenoRadio 插件目录并启用'),
      },
      {
        mode: 'link',
        iconName: 'plugin',
        label: t('链接本地文件夹'),
        tip: t('开发模式：直接读取本地目录，修改代码后重载即可生效'),
      },
      {
        mode: 'archive',
        iconName: 'package',
        label: t('从插件包安装'),
        tip: t('支持 .mrplugin、.zip 插件包，或直接选择 plugin.json'),
      },
    ]

    dom.modalLayer.innerHTML = `<div class="modal plugin-load-modal" role="dialog" aria-modal="true" aria-labelledby="loadPluginTitle">
      <div class="modal-header">
        <h2 id="loadPluginTitle">${escapeHtml(t('加载插件'))}</h2>
        <button type="button" class="icon-button" data-close-modal aria-label="${escapeHtml(t('关闭'))}">${icon('close')}</button>
      </div>
      <div class="plugin-load-options">
        ${options.map((opt) => `<button type="button" class="plugin-load-option" data-load-mode="${attr(opt.mode)}">
          <span class="plugin-load-option-icon">${icon(opt.iconName)}</span>
          <span class="plugin-load-option-label">${escapeHtml(opt.label)}</span>
          <span class="plugin-info-tip" data-tip="${attr(opt.tip)}" aria-label="${attr(opt.tip)}">${icon('info')}</span>
        </button>`).join('')}
      </div>
      <div class="modal-actions">
        <button type="button" class="secondary-button" data-close-modal>${escapeHtml(t('取消'))}</button>
      </div>
    </div>`
    dom.modalLayer.classList.add('open')
    dom.modalLayer.setAttribute('aria-hidden', 'false')
    dom.modalLayer.querySelectorAll('[data-close-modal]').forEach((btn) => btn.addEventListener('click', closeModal))
    dom.modalLayer.querySelectorAll('.plugin-info-tip').forEach((tip) => {
      tip.addEventListener('click', (event) => event.stopPropagation())
    })
    dom.modalLayer.querySelectorAll('[data-load-mode]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const mode = btn.dataset.loadMode
        btn.disabled = true
        try {
          let result
          if (mode === 'folder') result = await bridge.plugins.installFromFolder({ link: false })
          else if (mode === 'link') result = await bridge.plugins.installFromFolder({ link: true })
          else result = await bridge.plugins.installFromArchive({ link: false })

          if (!result?.ok) throw new Error(result?.error || t('插件加载失败'))
          if (result.data?.canceled) {
            btn.disabled = false
            return
          }
          const installed = result.data?.plugin
          closeModal()
          if (installed && !installed.compatibility?.compatible && installed.compatibility?.status !== 'unspecified') {
            toast(
              t('插件“{name}”已加载，但声明的支持版本（{range}）与当前版本不兼容，已保持禁用。', {
                name: installed.name,
                range: installed.supportedVersions,
              }),
              t('版本不兼容'),
            )
          } else if (installed) {
            toast(t('已加载插件“{name}” v{version}', { name: installed.name, version: installed.version }))
          }
          await refreshPage()
        } catch (error) {
          btn.disabled = false
          toast(error?.message || t('插件加载失败'), t('加载失败'), 'error')
        }
      })
    })
  }

  function showForceEnableModal(plugin, ctx) {
    const { dom, escapeHtml, icon, t, closeModal, bridge, toast, refreshPage } = ctx
    dom.modalLayer.innerHTML = `<div class="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="forceEnableTitle">
      <div class="modal-header">
        <div>
          <h2 id="forceEnableTitle">${escapeHtml(t('强制启用不兼容的插件？'))}</h2>
          <p>${escapeHtml(t('插件“{name}”声明支持的版本范围为 {range}，而当前 MenoRadio 版本为 v{current}。强制启用可能导致功能异常。', {
            name: plugin.name,
            range: plugin.supportedVersions,
            current: plugin.compatibility?.appVersion || appVersionCache,
          }))}</p>
        </div>
        <button type="button" class="icon-button" data-close-modal aria-label="${escapeHtml(t('关闭'))}">${icon('close')}</button>
      </div>
      <div class="modal-actions">
        <button type="button" class="secondary-button" data-close-modal>${escapeHtml(t('取消'))}</button>
        <button type="button" class="primary-button" data-confirm-force-enable>${escapeHtml(t('仍要启用'))}</button>
      </div>
    </div>`
    dom.modalLayer.classList.add('open')
    dom.modalLayer.setAttribute('aria-hidden', 'false')
    dom.modalLayer.querySelectorAll('[data-close-modal]').forEach((btn) => btn.addEventListener('click', closeModal))
    dom.modalLayer.querySelector('[data-confirm-force-enable]')?.addEventListener('click', async (event) => {
      const btn = event.currentTarget
      btn.disabled = true
      try {
        const res = await bridge.plugins.enable(plugin.id, { force: true })
        if (!res?.ok) throw new Error(res?.error || t('插件启用失败'))
        closeModal()
        toast(t('已强制启用插件“{name}”', { name: plugin.name }))
        await refreshPage()
      } catch (error) {
        btn.disabled = false
        toast(error?.message || t('插件启用失败'), t('操作失败'), 'error')
      }
    })
  }

  function showUninstallModal(plugin, ctx) {
    const { dom, escapeHtml, icon, t, closeModal, bridge, toast, refreshPage } = ctx
    const isLinked = plugin.source === 'linked'
    dom.modalLayer.innerHTML = `<div class="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="uninstallPluginTitle">
      <div class="modal-header">
        <div>
          <h2 id="uninstallPluginTitle">${escapeHtml(isLinked ? t('移除本地开发插件链接？') : t('卸载插件？'))}</h2>
          <p>${escapeHtml(isLinked
            ? t('将从 MenoRadio 移除“{name}”的链接并停用它，但不会删除你本地目录中的源代码。', { name: plugin.name })
            : t('将停用并删除“{name}”的插件文件。', { name: plugin.name })
          )}</p>
        </div>
        <button type="button" class="icon-button" data-close-modal aria-label="${escapeHtml(t('关闭'))}">${icon('close')}</button>
      </div>
      <label class="plugin-uninstall-checkbox">
        <input type="checkbox" data-remove-plugin-data>
        <span>${escapeHtml(t('同时清除该插件的配置与本地存储数据'))}</span>
      </label>
      <div class="modal-actions">
        <button type="button" class="secondary-button" data-close-modal>${escapeHtml(t('取消'))}</button>
        <button type="button" class="danger-button" data-confirm-uninstall>${escapeHtml(isLinked ? t('移除链接') : t('卸载'))}</button>
      </div>
    </div>`
    dom.modalLayer.classList.add('open')
    dom.modalLayer.setAttribute('aria-hidden', 'false')
    dom.modalLayer.querySelectorAll('[data-close-modal]').forEach((btn) => btn.addEventListener('click', closeModal))
    dom.modalLayer.querySelector('[data-confirm-uninstall]')?.addEventListener('click', async (event) => {
      const btn = event.currentTarget
      const removeData = Boolean(dom.modalLayer.querySelector('[data-remove-plugin-data]')?.checked)
      btn.disabled = true
      try {
        const res = await bridge.plugins.uninstall(plugin.id, { removeData })
        if (!res?.ok) throw new Error(res?.error || t('插件卸载失败'))
        closeModal()
        toast(isLinked
          ? t('已移除插件链接“{name}”', { name: plugin.name })
          : t('已卸载插件“{name}”', { name: plugin.name }))
        await refreshPage()
      } catch (error) {
        btn.disabled = false
        toast(error?.message || t('插件卸载失败'), t('操作失败'), 'error')
      }
    })
  }

  function showPluginDetailsModal(plugin, ctx) {
    const { dom, escapeHtml, attr, icon, t, closeModal, bridge, toast, refreshPage } = ctx
    const logs = plugin.logs || []
    dom.modalLayer.innerHTML = `<div class="modal plugin-details-modal" role="dialog" aria-modal="true" aria-labelledby="pluginDetailsTitle">
      <div class="modal-header">
        <h2 id="pluginDetailsTitle">${escapeHtml(plugin.name)}</h2>
        <button type="button" class="icon-button" data-close-modal aria-label="${escapeHtml(t('关闭'))}">${icon('close')}</button>
      </div>
      <div class="plugin-details-body">
        ${plugin.description ? `<p class="plugin-details-desc">${escapeHtml(plugin.description)}</p>` : ''}
        <dl class="plugin-details-grid">
          <dt>${escapeHtml(t('作者'))}</dt><dd>${plugin.authorUrl ? `<button type="button" class="settings-link" data-external="${attr(plugin.authorUrl)}">${escapeHtml(plugin.author)}</button>` : escapeHtml(plugin.author)}</dd>
          <dt>${escapeHtml(t('插件版本'))}</dt><dd>v${escapeHtml(plugin.version)}</dd>
          <dt>${escapeHtml(t('支持版本范围'))}</dt><dd title="${attr(compatibilityText(plugin, t))}">${escapeHtml(plugin.supportedVersions || '*')}</dd>
          <dt>ID</dt><dd>${escapeHtml(plugin.id)}</dd>
          ${plugin.license ? `<dt>${escapeHtml(t('许可证'))}</dt><dd>${escapeHtml(plugin.license)}</dd>` : ''}
          ${plugin.homepage ? `<dt>${escapeHtml(t('主页'))}</dt><dd><button type="button" class="settings-link" data-external="${attr(plugin.homepage)}">${escapeHtml(plugin.homepage)}</button></dd>` : ''}
          <dt>${escapeHtml(t('目录路径'))}</dt><dd class="plugin-path-cell">${escapeHtml(plugin.dir)}</dd>
        </dl>
        ${plugin.error ? `<div class="plugin-error-detail">
          <strong>${escapeHtml(t('最近错误'))}</strong>
          <pre>${escapeHtml(plugin.error.stack || plugin.error.message)}</pre>
        </div>` : ''}
        ${logs.length ? `<div class="plugin-logs-section">
          <strong>${escapeHtml(t('运行日志'))}</strong>
          <div class="plugin-logs-list">${logs.slice().reverse().map((entry) => `<div class="plugin-log-row level-${attr(entry.level)}">
            <span class="plugin-log-time">${new Date(entry.timestamp).toLocaleTimeString()}</span>
            <span class="plugin-log-msg">${escapeHtml(entry.message)}</span>
          </div>`).join('')}</div>
        </div>` : ''}
      </div>
      <div class="modal-actions">
        <button type="button" class="secondary-button" data-details-open-dir>${escapeHtml(t('打开目录'))}</button>
        <button type="button" class="secondary-button" data-details-reload>${escapeHtml(t('重载'))}</button>
        <button type="button" class="primary-button" data-close-modal>${escapeHtml(t('关闭'))}</button>
      </div>
    </div>`
    dom.modalLayer.classList.add('open')
    dom.modalLayer.setAttribute('aria-hidden', 'false')
    dom.modalLayer.querySelectorAll('[data-close-modal]').forEach((btn) => btn.addEventListener('click', closeModal))
    dom.modalLayer.querySelectorAll('[data-external]').forEach((btn) => {
      btn.addEventListener('click', () => bridge.app.openExternal(btn.dataset.external))
    })
    dom.modalLayer.querySelector('[data-details-open-dir]')?.addEventListener('click', async () => {
      const res = await bridge.plugins.openDir(plugin.id)
      if (!res?.ok) toast(res?.error || t('无法打开目录'), t('操作失败'), 'error')
    })
    dom.modalLayer.querySelector('[data-details-reload]')?.addEventListener('click', async () => {
      const res = await bridge.plugins.reload(plugin.id)
      if (!res?.ok) toast(res?.error || t('重载失败'), t('操作失败'), 'error')
      else {
        toast(t('已重载插件“{name}”', { name: plugin.name }))
        closeModal()
        await refreshPage()
      }
    })
  }

  function showPluginSettingsModal(plugin, ctx) {
    const { dom, escapeHtml, attr, icon, t, closeModal, bridge, toast, pluginsHost, refreshPage } = ctx
    const customRenderer = plugin.enabled ? pluginsHost?.getSettingsRenderer?.(plugin.id) : null
    const schema = plugin.contributes?.settings || []
    const values = { ...(plugin.settings || {}) }

    dom.modalLayer.innerHTML = `<div class="modal plugin-settings-modal" role="dialog" aria-modal="true" aria-labelledby="pluginSettingsTitle">
      <div class="modal-header">
        <h2 id="pluginSettingsTitle">${escapeHtml(plugin.name)}</h2>
        <button type="button" class="icon-button" data-close-modal aria-label="${escapeHtml(t('关闭'))}">${icon('close')}</button>
      </div>
      <div class="plugin-settings-content" data-plugin-settings-body></div>
    </div>`
    dom.modalLayer.classList.add('open')
    dom.modalLayer.setAttribute('aria-hidden', 'false')
    dom.modalLayer.querySelectorAll('[data-close-modal]').forEach((btn) => btn.addEventListener('click', closeModal))

    const body = dom.modalLayer.querySelector('[data-plugin-settings-body]')
    if (customRenderer) {
      try {
        customRenderer(body, {
          plugin,
          settings: values,
          save: async (patch) => {
            const res = await bridge.plugins.setSettings(plugin.id, patch)
            if (!res?.ok) throw new Error(res?.error || t('保存失败'))
            toast(t('插件设置已保存'))
            return res.data
          },
          close: closeModal,
        })
        return
      } catch (error) {
        console.error(`[plugin:${plugin.id}] Custom settings renderer failed:`, error)
      }
    }

    if (!schema.length) {
      body.innerHTML = `<p class="plugin-settings-empty">${escapeHtml(t('该插件没有可配置的设置项。'))}</p>`
      return
    }

    const fieldMarkup = (item) => {
      const value = values[item.key] !== undefined ? values[item.key] : item.default
      const tipMarkup = item.description
        ? `<span class="plugin-info-tip" data-tip="${attr(item.description)}" aria-label="${attr(item.description)}">${icon('info')}</span>`
        : ''
      if (item.type === 'boolean') {
        return `<div class="plugin-setting-row">
          <div class="plugin-setting-label"><span>${escapeHtml(item.label)}</span>${tipMarkup}</div>
          <label class="setting-switch"><input type="checkbox" name="${attr(item.key)}" ${value ? 'checked' : ''}><i></i></label>
        </div>`
      }
      if (item.type === 'select') {
        return `<div class="plugin-setting-row">
          <div class="plugin-setting-label"><span>${escapeHtml(item.label)}</span>${tipMarkup}</div>
          <select class="setting-select" name="${attr(item.key)}">${(item.options || []).map((opt) =>
            `<option value="${attr(opt.value)}" ${String(value) === String(opt.value) ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`
          ).join('')}</select>
        </div>`
      }
      if (item.type === 'color') {
        return `<div class="plugin-setting-row">
          <div class="plugin-setting-label"><span>${escapeHtml(item.label)}</span>${tipMarkup}</div>
          <input class="setting-color" type="color" name="${attr(item.key)}" value="${attr(/^#[\da-f]{6}$/i.test(String(value)) ? value : '#68c7c3')}">
        </div>`
      }
      if (item.type === 'number') {
        return `<div class="plugin-setting-row">
          <div class="plugin-setting-label"><span>${escapeHtml(item.label)}</span>${tipMarkup}</div>
          <div class="setting-number"><input type="number" name="${attr(item.key)}" value="${attr(value)}" ${item.min != null ? `min="${attr(item.min)}"` : ''} ${item.max != null ? `max="${attr(item.max)}"` : ''} ${item.step != null ? `step="${attr(item.step)}"` : ''}></div>
        </div>`
      }
      if (item.type === 'textarea') {
        return `<label class="login-field plugin-setting-block">
          <span class="plugin-setting-label"><span>${escapeHtml(item.label)}</span>${tipMarkup}</span>
          <textarea name="${attr(item.key)}" rows="3" placeholder="${attr(item.placeholder || '')}">${escapeHtml(value ?? '')}</textarea>
        </label>`
      }
      return `<label class="login-field plugin-setting-block">
        <span class="plugin-setting-label"><span>${escapeHtml(item.label)}</span>${tipMarkup}</span>
        <input type="text" name="${attr(item.key)}" value="${attr(value ?? '')}" placeholder="${attr(item.placeholder || '')}">
      </label>`
    }

    body.innerHTML = `<form class="plugin-settings-form" data-plugin-settings-form>
      <div class="plugin-settings-fields">${schema.map(fieldMarkup).join('')}</div>
      <div class="modal-actions">
        <button type="button" class="secondary-button" data-reset-plugin-settings>${escapeHtml(t('恢复默认'))}</button>
        <button type="button" class="secondary-button" data-close-modal>${escapeHtml(t('取消'))}</button>
        <button type="submit" class="primary-button">${escapeHtml(t('保存'))}</button>
      </div>
    </form>`

    body.querySelectorAll('[data-close-modal]').forEach((btn) => btn.addEventListener('click', closeModal))
    const form = body.querySelector('[data-plugin-settings-form]')
    body.querySelector('[data-reset-plugin-settings]')?.addEventListener('click', async () => {
      const defaults = {}
      for (const item of schema) defaults[item.key] = item.default
      const res = await bridge.plugins.setSettings(plugin.id, defaults)
      if (!res?.ok) return toast(res?.error || t('恢复默认失败'), t('操作失败'), 'error')
      closeModal()
      toast(t('已恢复默认设置'))
      await refreshPage()
    })
    form?.addEventListener('submit', async (event) => {
      event.preventDefault()
      const patch = {}
      for (const item of schema) {
        const input = form.elements.namedItem(item.key)
        if (!input) continue
        if (item.type === 'boolean') patch[item.key] = Boolean(input.checked)
        else if (item.type === 'number') patch[item.key] = Number(input.value)
        else patch[item.key] = String(input.value)
      }
      const res = await bridge.plugins.setSettings(plugin.id, patch)
      if (!res?.ok) return toast(res?.error || t('保存失败'), t('操作失败'), 'error')
      closeModal()
      toast(t('插件设置已保存'))
      await refreshPage()
    })
  }

  async function renderSettingsPage(ctx) {
    const { dom, escapeHtml, attr, icon, t, pageTitle, bridge, toast, pluginsHost } = ctx
    const generation = ++settingsRenderGeneration
    let list = pluginsHost?.getPlugins?.() || []
    try {
      const [ver, listRes] = await Promise.all([
        bridge.app.version().catch(() => appVersionCache),
        bridge.plugins.list(),
      ])
      if (generation !== settingsRenderGeneration) return
      if (ver) appVersionCache = String(ver)
      if (listRes?.ok && Array.isArray(listRes.data)) {
        list = listRes.data
      }
    } catch {}
    if (generation !== settingsRenderGeneration) return

    const refreshPage = () => renderSettingsPage(ctx)
    const actionCtx = { ...ctx, refreshPage }

    const renderListMarkup = () => {
      const filtered = filterPlugins(list)
      if (!list.length) {
        return `<div class="empty-state plugin-empty-state">
          <div class="empty-state-inner">
            <div class="empty-icon">${icon('plugin')}</div>
            <h2>${escapeHtml(t('还没有插件'))}</h2>
            <button type="button" class="primary-button" data-plugin-load>${escapeHtml(t('加载插件'))}</button>
          </div>
        </div>`
      }
      if (!filtered.length) {
        return `<div class="empty-state plugin-empty-state">
          <div class="empty-state-inner">
            <h2>${escapeHtml(t('没有匹配的插件'))}</h2>
          </div>
        </div>`
      }
      return `<div class="plugin-list">${filtered.map((plugin) => pluginCardMarkup(plugin, actionCtx)).join('')}</div>`
    }

    const headerActions = `<div class="plugin-page-actions">
      <button type="button" class="icon-button" data-plugin-rescan title="${attr(t('刷新'))}" aria-label="${attr(t('扫描插件目录'))}">${icon('refresh')}</button>
      <button type="button" class="icon-button" data-plugin-open-dir title="${attr(t('打开插件目录'))}" aria-label="${attr(t('打开插件目录'))}">${icon('folder')}</button>
      <button type="button" class="primary-button" data-plugin-load>${escapeHtml(t('加载插件'))}</button>
    </div>`

    dom.page.innerHTML = `<div class="page-inner plugins-page" data-plugins-dropzone>
      ${pageTitle(t('插件'), '', headerActions)}
      ${list.length > 1 ? `<div class="plugin-toolbar">
        <label class="plugin-search-field">
          ${icon('search')}
          <input type="search" data-plugin-search value="${attr(searchQuery)}" placeholder="${attr(t('搜索插件'))}" autocomplete="off">
        </label>
      </div>` : ''}
      <div id="pluginListContainer">${renderListMarkup()}</div>
      <div class="plugin-drop-overlay" aria-hidden="true">
        <div class="plugin-drop-overlay-inner">
          ${icon('package')}
          <strong>${escapeHtml(t('松开即可安装插件'))}</strong>
        </div>
      </div>
    </div>`

    const pageRoot = dom.page.querySelector('.plugins-page')
    if (!pageRoot) return

    const updateListOnly = () => {
      const container = pageRoot.querySelector('#pluginListContainer')
      if (container) container.innerHTML = renderListMarkup()
    }

    pageRoot.addEventListener('input', (event) => {
      if (event.target.matches('[data-plugin-search]')) {
        searchQuery = event.target.value
        updateListOnly()
      }
    })

    pageRoot.addEventListener('change', async (event) => {
      const toggle = event.target.closest('[data-plugin-toggle]')
      if (!toggle) return
      const id = toggle.dataset.pluginToggle
      const plugin = list.find((item) => item.id === id)
      if (!plugin) return
      const wantEnable = toggle.checked
      toggle.disabled = true
      try {
        const res = wantEnable
          ? await bridge.plugins.enable(id, { force: false })
          : await bridge.plugins.disable(id)
        if (!res?.ok) {
          if (wantEnable && res?.code === 'INCOMPATIBLE_VERSION') {
            toggle.checked = false
            toggle.disabled = false
            showForceEnableModal(plugin, actionCtx)
            return
          }
          throw new Error(res?.error || t('操作失败'))
        }
        toast(wantEnable
          ? t('已启用插件“{name}”', { name: plugin.name })
          : t('已禁用插件“{name}”', { name: plugin.name }))
        await refreshPage()
      } catch (error) {
        toggle.checked = !wantEnable
        toggle.disabled = false
        toast(error?.message || t('操作失败'), t('操作失败'), 'error')
      }
    })

    pageRoot.addEventListener('click', async (event) => {
      if (event.target.closest('[data-plugin-load]')) {
        showLoadPluginModal(actionCtx)
        return
      }
      if (event.target.closest('[data-plugin-rescan]')) {
        const res = await bridge.plugins.rescan()
        if (!res?.ok) toast(res?.error || t('刷新失败'), t('操作失败'), 'error')
        else {
          toast(t('已刷新插件列表'))
          await refreshPage()
        }
        return
      }
      if (event.target.closest('[data-plugin-open-dir]')) {
        const res = await bridge.plugins.openDir('')
        if (!res?.ok) toast(res?.error || t('无法打开插件目录'), t('操作失败'), 'error')
        return
      }
      const settingsBtn = event.target.closest('[data-plugin-settings]')
      if (settingsBtn) {
        const plugin = list.find((item) => item.id === settingsBtn.dataset.pluginSettings)
        if (plugin) showPluginSettingsModal(plugin, actionCtx)
        return
      }
      const reloadBtn = event.target.closest('[data-plugin-reload]')
      if (reloadBtn) {
        const id = reloadBtn.dataset.pluginReload
        const plugin = list.find((item) => item.id === id)
        reloadBtn.disabled = true
        const res = await bridge.plugins.reload(id)
        if (!res?.ok) {
          reloadBtn.disabled = false
          toast(res?.error || t('重载失败'), t('操作失败'), 'error')
        } else {
          toast(t('已重载插件“{name}”', { name: plugin?.name || id }))
          await refreshPage()
        }
        return
      }
      const detailsBtn = event.target.closest('[data-plugin-details]')
      if (detailsBtn) {
        const plugin = list.find((item) => item.id === detailsBtn.dataset.pluginDetails)
        if (plugin) showPluginDetailsModal(plugin, actionCtx)
        return
      }
      const uninstallBtn = event.target.closest('[data-plugin-uninstall]')
      if (uninstallBtn) {
        const plugin = list.find((item) => item.id === uninstallBtn.dataset.pluginUninstall)
        if (plugin) showUninstallModal(plugin, actionCtx)
      }
    })

    // Drag-and-drop install support on Plugins page
    let dragDepth = 0
    pageRoot.addEventListener('dragenter', (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return
      event.preventDefault()
      dragDepth += 1
      pageRoot.classList.add('drag-over')
    })
    pageRoot.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    })
    pageRoot.addEventListener('dragleave', (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return
      dragDepth = Math.max(0, dragDepth - 1)
      if (dragDepth === 0) pageRoot.classList.remove('drag-over')
    })
    pageRoot.addEventListener('drop', async (event) => {
      if (!event.dataTransfer?.files?.length) return
      event.preventDefault()
      dragDepth = 0
      pageRoot.classList.remove('drag-over')
      const files = [...event.dataTransfer.files]
      let installedCount = 0
      for (const file of files) {
        const filePath = bridge.plugins.getPathForFile?.(file) || file.path || ''
        if (!filePath) continue
        const res = await bridge.plugins.installFromPath(filePath, { link: false })
        if (res?.ok && res.data?.plugin) {
          installedCount += 1
        } else {
          toast(res?.error || t('插件安装失败'), file.name, 'error')
        }
      }
      if (installedCount > 0) {
        toast(t('已成功加载 {count} 个插件', { count: installedCount }))
        await refreshPage()
      }
    })
  }

  root.MenoRadioPluginUi = {
    renderSettingsPage,
    showLoadPluginModal,
    showPluginSettingsModal,
    showPluginDetailsModal,
  }
})(window)
