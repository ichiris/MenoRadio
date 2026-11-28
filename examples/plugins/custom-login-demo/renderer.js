// Custom Login Demo renderer entry.

export function activate(api) {
  // Add a custom tab right inside MenoRadio's Login modal!
  api.auth.registerLoginTab({
    id: 'demo-token',
    label: '自定义登录',
    order: 10,
    render: (container, helpers) => {
      container.innerHTML = `<form class="login-form" data-custom-login-form>
        <label class="login-field">
          <span>昵称</span>
          <input name="nickname" type="text" maxlength="30" placeholder="Meno Listener" required>
        </label>
        <div class="modal-actions">
          <button type="submit" class="primary-button">登录</button>
        </div>
      </form>`

      const form = container.querySelector('[data-custom-login-form]')
      form?.addEventListener('submit', async (event) => {
        event.preventDefault()
        const nickname = String(new FormData(form).get('nickname') || '').trim()
        if (!nickname) return
        try {
          const auth = await api.backend.invoke('signInCustom', { nickname })
          await helpers.completeLogin(auth.profile)
          helpers.toast(`欢迎，${auth.profile.nickname}`, '自定义登录成功')
        } catch (error) {
          helpers.toast(error.message || '登录失败', '自定义登录失败', 'error')
        }
      })
    },
  })

  // Customize sidebar profile subtitle when using the custom provider.
  api.hooks.tap('auth:profileUi', ({ loggedIn, profile, hintElement }) => {
    if (loggedIn && profile?.customProvider === 'demo-token' && hintElement) {
      hintElement.textContent = '自定义插件会话'
    }
  })
}
