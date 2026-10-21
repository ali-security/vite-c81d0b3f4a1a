import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { normalizePath } from '../../utils'
import { type ViteDevServer, createServer } from '../index'
import { checkLoadingAccess, isFileLoadingAllowed } from '../middlewares/static'

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
})
