// Pure-Node ZIP / .mrplugin archive reader and safe extractor (zero external dependencies).
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIR_SIGNATURE = 0x02014b50
const LOCAL_FILE_SIGNATURE = 0x04034b50
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
const MAX_ENTRY_COUNT = 4096
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 65557)
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      const commentLength = buffer.readUInt16LE(offset + 20)
      if (offset + 22 + commentLength === buffer.length) return offset
    }
  }
  return -1
}

function decodeEntryName(nameBytes, generalPurposeFlag) {
  const utf8 = (generalPurposeFlag & 0x0800) !== 0
  return nameBytes.toString(utf8 ? 'utf8' : 'utf8').replace(/\\/g, '/')
}

function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('无效的插件压缩包文件')
  }
  if (buffer.length > MAX_ARCHIVE_BYTES) {
    throw new Error('插件压缩包过大（超过 128MB）')
  }
  const eocdOffset = findEndOfCentralDirectory(buffer)
  if (eocdOffset < 0) {
    throw new Error('无法识别的压缩包格式（仅支持标准 ZIP / .mrplugin）')
  }
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10)
  const centralDirSize = buffer.readUInt32LE(eocdOffset + 12)
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16)
  if (totalEntries > MAX_ENTRY_COUNT) {
    throw new Error('插件压缩包包含过多文件')
  }
  if (centralDirOffset + centralDirSize > buffer.length) {
    throw new Error('插件压缩包结构已损坏')
  }

  const entries = []
  let cursor = centralDirOffset
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error('插件压缩包目录表已损坏')
    }
    const flags = buffer.readUInt16LE(cursor + 8)
    const compressionMethod = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42)
    const nameStart = cursor + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > buffer.length) throw new Error('插件压缩包文件名越界')
    const name = decodeEntryName(buffer.subarray(nameStart, nameEnd), flags)
    cursor = nameEnd + extraLength + commentLength

    if ((flags & 0x0001) !== 0) {
      throw new Error('不支持受密码加密的插件压缩包')
    }
    if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_SIGNATURE) {
      throw new Error('插件压缩包本地文件头已损坏')
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28)
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataOffset + compressedSize
    if (dataEnd > buffer.length) throw new Error('插件压缩包数据区越界')

    entries.push({
      name,
      isDirectory: name.endsWith('/'),
      compressionMethod,
      compressedSize,
      uncompressedSize,
      compressedData: buffer.subarray(dataOffset, dataEnd),
    })
  }
  return entries
}

function inflateEntry(entry) {
  if (entry.isDirectory) return Buffer.alloc(0)
  if (entry.compressionMethod === 0) return Buffer.from(entry.compressedData)
  if (entry.compressionMethod === 8) return zlib.inflateRawSync(entry.compressedData)
  throw new Error(`不支持的压缩方式（method ${entry.compressionMethod}）`)
}

function sanitizeZipPath(entryName) {
  const normalized = String(entryName || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const segments = normalized.split('/').filter((segment) => segment && segment !== '.')
  if (!segments.length) return ''
  if (segments.some((segment) => segment === '..' || /^[a-zA-Z]:$/.test(segment) || segment.includes('\0'))) {
    throw new Error(`压缩包包含不安全的路径：${entryName}`)
  }
  return segments.join('/')
}

function extractZipArchive(archivePath, targetDir) {
  const buffer = fs.readFileSync(archivePath)
  const entries = readZipEntries(buffer)
  const root = path.resolve(targetDir)
  fs.mkdirSync(root, { recursive: true })

  let totalBytes = 0
  for (const entry of entries) {
    const safeRel = sanitizeZipPath(entry.name)
    if (!safeRel) continue
    const destination = path.resolve(root, safeRel)
    if (destination !== root && !destination.startsWith(root + path.sep)) {
      throw new Error(`压缩包路径越界：${entry.name}`)
    }
    if (entry.isDirectory) {
      fs.mkdirSync(destination, { recursive: true })
      continue
    }
    const data = inflateEntry(entry)
    totalBytes += data.length
    if (totalBytes > MAX_EXTRACTED_BYTES) {
      throw new Error('插件解压体积过大（超过 256MB）')
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, data)
  }
  return root
}

// Helper for building standard uncompressed ZIP buffers (used by tests and tooling).
function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index]
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function createZipBuffer(files = []) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const file of files) {
    const name = String(file.name || '').replace(/\\/g, '/')
    const nameBuf = Buffer.from(name, 'utf8')
    const rawData = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content ?? ''), 'utf8')
    const compress = file.compress === true && rawData.length > 0
    const data = compress ? zlib.deflateRawSync(rawData) : rawData
    const method = compress ? 8 : 0
    const checksum = crc32(rawData)

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(LOCAL_FILE_SIGNATURE, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0x0800, 6)
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0, 12)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(data.length, 18)
    localHeader.writeUInt32LE(rawData.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28)
    localParts.push(localHeader, nameBuf, data)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(CENTRAL_DIR_SIGNATURE, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(data.length, 20)
    centralHeader.writeUInt32LE(rawData.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    centralParts.push(centralHeader, nameBuf)

    offset += localHeader.length + nameBuf.length + data.length
  }

  const centralBuffer = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralBuffer, eocd])
}

module.exports = {
  readZipEntries,
  extractZipArchive,
  createZipBuffer,
}
