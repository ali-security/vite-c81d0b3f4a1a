import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { normalizePath } from '../../utils'
import { isWindows } from '../../../shared/utils'
import { type ViteDevServer, createServer } from '../index'
import {
  checkLoadingAccess,
  checkServingAccess,
  isFileLoadingAllowed,
} from '../middlewares/static'

const root = normalizePath(
  fileURLToPath(new URL('./fixtures/', import.meta.url)),
)

describe('server.fs.deny', () => {
  let server: ViteDevServer

  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      root,
      logLevel: 'silent',
      appType: 'custom',
      optimizeDeps: { noDiscovery: true },
      server: {
        middlewareMode: true,
        ws: false,
        watch: null,
        fs: { strict: true, allow: [root] },
      },
    })
  })

  afterAll(async () => {
    await server.close()
  })

  test('allows a file inside fs.allow', () => {
    const filePath = path.posix.join(root, 'safe.txt')
    expect(isFileLoadingAllowed(server, filePath)).toBe(true)
  })

  test('denies a denied file', () => {
    const envPath = path.posix.join(root, '.env')
    expect(isFileLoadingAllowed(server, envPath)).toBe(false)
    const crtPath = path.posix.join(root, 'dummy.crt')
    expect(isFileLoadingAllowed(server, crtPath)).toBe(false)
  })

  // `fs.readFile('/foo.png/')` tries to load `'/foo.png'` on Windows
  test('denies a denied file when the path ends with /', () => {
    const envPath = path.posix.join(root, '.env') + '/'
    expect(isFileLoadingAllowed(server, envPath)).toBe(false)
    const crtPath = path.posix.join(root, 'dummy.crt') + '/'
    expect(isFileLoadingAllowed(server, crtPath)).toBe(false)
  })

  // a trailing `\` in the request is normalized to `/` before the check
  test('denies a denied file when the path ends with \\', () => {
    const envPath = path.join(root, '.env') + '\\'
    expect(checkLoadingAccess(server, envPath)).not.toBe('allowed')
    const crtPath = path.join(root, 'dummy.crt') + '\\'
    expect(checkLoadingAccess(server, crtPath)).not.toBe('allowed')
  })

  // On NTFS, `.env::$DATA` is the default data stream of `.env` and
  // resolves to the same content as `.env`
  test('denies a file with NTFS ADS suffix', () => {
    const envPath = path.posix.join(root, '.env::$DATA')
    expect(isFileLoadingAllowed(server, envPath)).toBe(false)
    const crtPath = path.posix.join(root, 'dummy.crt::$DATA')
    expect(isFileLoadingAllowed(server, crtPath)).toBe(false)
    const pemPath = path.posix.join(root, 'tls.pem::$DATA')
    expect(isFileLoadingAllowed(server, pemPath)).toBe(false)
    const namedStreamPath = path.posix.join(root, '.env:stream:$DATA')
    expect(isFileLoadingAllowed(server, namedStreamPath)).toBe(false)
  })

  test('denies a file with NTFS ADS suffix when served by sirv', () => {
    const envPath = path.join(root, '.env::$DATA')
    expect(checkLoadingAccess(server, envPath)).not.toBe('allowed')
  })

  // e.g. `/.env::$DATA?raw`
  test('denies a file with NTFS ADS suffix requested with ?raw', () => {
    const envUrl = path.posix.join(root, '.env::$DATA') + '?raw'
    expect(checkServingAccess(envUrl, server)).not.toBe('allowed')
    const pemUrl = path.posix.join(root, 'tls.pem::$DATA') + '?raw'
    expect(checkServingAccess(pemUrl, server)).not.toBe('allowed')
  })

  // On Windows, a file can be accessed through its 8.3 short name
  // e.g. `.env` can be accessed as `ENV~1`
  test.runIf(isWindows)('denies a file with Windows 8.3 short name', () => {
    const envPath = path.posix.join(root, 'ENV~1')
    expect(isFileLoadingAllowed(server, envPath)).toBe(false)
    const envLocalPath = path.posix.join(root, 'ENV~1.LOC')
    expect(isFileLoadingAllowed(server, envLocalPath)).toBe(false)
    const crtPath = path.posix.join(root, 'DUMMY~1.CRT')
    expect(isFileLoadingAllowed(server, crtPath)).toBe(false)
    const envUrl = path.posix.join(root, 'ENV~1') + '?raw'
    expect(checkServingAccess(envUrl, server)).not.toBe('allowed')
  })

  test('allows a file inside fs.allow whose name contains a tilde', () => {
    const filePath = path.posix.join(root, '0~rslib-runtime.js')
    expect(isFileLoadingAllowed(server, filePath)).toBe(true)
  })
})
