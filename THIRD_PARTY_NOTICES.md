# Third-party notices

MenoRadio is distributed under the MIT License and uses the following
third-party open-source components.

## Runtime components

### NeteaseCloudMusicApiEnhanced API

- Package: `@neteasecloudmusicapienhanced/api` 4.37.0
- Project: <https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced>
- License: MIT
- Copyright (c) 2013-2022 Binaryify

Provides the local API implementation through which MenoRadio communicates
with NetEase Cloud Music.

### node-qrcode

- Package: `qrcode` 1.5.4
- Project: <https://github.com/soldair/node-qrcode>
- License: MIT
- Copyright (c) 2012 Ryan Day

Generates QR codes used during account sign-in.

### Electron

- Package: `electron` 37.10.3
- Project: <https://www.electronjs.org/>
- License: MIT
- Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc.

Provides the desktop application runtime. Electron includes Chromium,
Node.js, and other third-party software whose upstream notices are included
in `LICENSES.chromium.html` with the packaged runtime.

### UnblockNeteaseMusic server library

- Package: `@unblockneteasemusic/server` 0.28.0
- Project: <https://github.com/UnblockNeteaseMusic/server>
- License: LGPL-3.0-only

Included transitively by the NetEase Cloud Music API package. Its `COPYING`
and `COPYING.LESSER` files accompany the packaged dependency, and its source
code is available from the project link above.

### Other runtime dependencies

The runtime dependency tree also contains packages licensed under MIT, ISC,
BSD-2-Clause, BSD-3-Clause, 0BSD, and BlueOak-1.0.0. `node-forge` 1.4.0 is
used under its BSD-3-Clause option. `busboy` 1.6.0 and `streamsearch` 1.1.0
include MIT license files. Package metadata and applicable license files are
retained with the distributed dependencies.

## Packaging component

### electron-builder

- Package: `electron-builder` 26.15.3
- Project: <https://www.electron.build/>
- License: MIT
- Copyright (c) 2015 Loopline Systems

Creates the Windows application packages and installer. It is used during
packaging and is not part of the MenoRadio application runtime.

## MIT license terms for MIT-licensed components

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The applicable copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
