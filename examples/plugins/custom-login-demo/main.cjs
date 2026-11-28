// Custom Login Demo backend entry.
module.exports = {
  activate(ctx) {
    // Allow custom local profile login stored in plugin storage.
    ctx.ipc.handle('signInCustom', (payload = {}) => {
      const nickname = String(payload.nickname || '').trim()
      if (!nickname) throw new Error('请输入自定义昵称')
      const profile = {
        userId: 900000001,
        nickname,
        avatarUrl: '',
        signature: '通过自定义登录插件接入',
        customProvider: 'demo-token',
      }
      ctx.storage.set('customProfile', profile)
      return { loggedIn: true, profile }
    })

    // Intercept auth:state so if NetEase isn't logged in, fallback to our custom session.
    ctx.ipc.intercept('auth:state', async (payload, next) => {
      const result = await next(payload)
      if (result?.ok && result.data?.loggedIn) return result
      const customProfile = ctx.storage.get('customProfile', null)
      if (customProfile) {
        return { ok: true, data: { loggedIn: true, profile: customProfile, custom: true } }
      }
      return result
    })

    // Clear custom session on logout.
    ctx.ipc.intercept('auth:logout', async (payload, next) => {
      ctx.storage.delete('customProfile')
      return next(payload)
    })

    ctx.logger.info('Custom Login Demo backend activated')
  },
}
