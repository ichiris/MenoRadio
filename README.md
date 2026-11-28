# MenoRadio

MenoRadio 是一款非官方网易云音乐客户端，界面播放页设计参考了 LyricEase，基于 Electron 框架开发。
支持扫码登录、账号密码登录、Cookie 登录。拥有与 LyricEase 相近的播放页体验。

MenoRadio is an unofficial NetEase Cloud Music player. It borrows the playback page design from LyricEase and is built with Electron.
Supports QR code login, account & password login, and Cookie login.
Delivers a playback experience similar to LyricEase.

## 插件系统 / Plugin System

MenoRadio 内置全栈插件系统，支持在 **设置 → 插件** 中安装、链接、启用、配置、热重载与管理插件。插件可扩展主题、界面、登录方式、沉浸式播放页、悬浮歌词、音频处理管线及 Electron 主进程后端能力。

- 插件开发文档：[docs/PLUGIN_DEVELOPMENT.md](./docs/PLUGIN_DEVELOPMENT.md)
- 示例插件：[examples/plugins/](./examples/plugins/)

## About MenoRadio
MenoRadio does not include any features to bypass DRM, paid membership benefits or copyright restrictions.

API communication relies on the MIT-licensed repository
[NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced).
Full third-party ownership and license information can be found in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## AIGC Statement
Codex and Claude code were utilized during the development of MenoRadio.

## Service and product names

MenoRadio is an independent, unofficial client. It is not affiliated with or
endorsed by NetEase Cloud Music. NetEase Cloud Music names,
service data, cover artwork, and lyrics belong to their respective owners.
