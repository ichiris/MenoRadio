# Third-party notices

MenoRadio is distributed under the MIT License. It also uses the following
third-party components. The exact dependency graph and resolved versions are
recorded in `package-lock.json`.

## Runtime components

### NeteaseCloudMusicApiEnhanced API

- Package: `@neteasecloudmusicapienhanced/api`
- Version currently resolved: 4.37.0
- Project: <https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced>
- License: MIT
- Copyright notice in the distributed license: Copyright (c) 2013-2022 Binaryify

This package provides the local API implementation used to communicate with
NetEase Cloud Music. Its `LICENSE` file is retained with the packaged npm
dependency.

### node-qrcode

- Package: `qrcode`
- Version currently resolved: 1.5.4
- Project: <https://github.com/soldair/node-qrcode>
- License: MIT
- Copyright (c) 2012 Ryan Day

This package generates login QR codes. Its `license` file is retained with the
packaged npm dependency.

### Electron

- Package: `electron`
- Version currently resolved: 37.10.3
- Project: <https://www.electronjs.org/>
- License: MIT
- Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc.

Electron includes Chromium, Node.js, and other third-party software. Packaged
Electron distributions include the detailed upstream notices in
`LICENSES.chromium.html` next to the runtime executable.

### UnblockNeteaseMusic server library

- Package: `@unblockneteasemusic/server`
- Version currently resolved: 0.28.0
- Project: <https://github.com/UnblockNeteaseMusic/server>
- License: LGPL-3.0-only

This is a transitive dependency of the NetEase Cloud Music API package.
MenoRadio does not modify it. Its `COPYING` and `COPYING.LESSER` files are
retained with the packaged dependency; the linked repository provides its
corresponding source code.

### Other runtime dependencies

The resolved runtime tree also contains permissively licensed transitive
packages under MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, and
BlueOak-1.0.0. `node-forge` 1.4.0 is offered under BSD-3-Clause or GPL-2.0;
MenoRadio uses it under the BSD-3-Clause option. `busboy` 1.6.0 and
`streamsearch` 1.1.0 omit a package metadata license field but include MIT
license files. Exact package names and versions are recorded in
`package-lock.json`, and their license files are retained with the packaged
npm dependencies.

## Development tooling

The source project uses `electron-builder` 26.15.3 (MIT, Copyright (c) 2015
Loopline Systems) to create Windows packages. It is a development dependency
and is not part of MenoRadio's application runtime.

Transitive npm packages retain their own package metadata and license files.
When dependencies are updated, this notice and `package-lock.json` should be
reviewed together.

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

## Service and product names

MenoRadio is an independent, unofficial client. It is not affiliated with or
endorsed by NetEase Cloud Music. NetEase Cloud Music names,
service data, cover artwork, and lyrics belong to their respective owners.
