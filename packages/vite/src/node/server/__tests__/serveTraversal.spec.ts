import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { type ViteDevServer, createServer } from '../index'
import { servePublicMiddleware } from '../middlewares/static'
import { type PreviewServer, preview } from '../../preview'

// `out/` is the served directory, `outfile.txt` is a sibling file whose name
// starts with the served directory name (`<root>/out` vs `<root>/outfile.txt`)
const root = fileURLToPath(
  new URL('./fixtures/serve-traversal/', import.meta.url),
)
const insideContent = 'inside the served directory'
const secretContent = 'secret sibling file outside the served directory'

// `http.request` sends the path as-is (unlike `fetch`, it doesn't normalize `..`)
function request(
  server: http.Server,
  path: string,
): Promise<{ status: number; body: string }> {
  const { port } = server.address() as AddressInfo
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        let body = ''
        res.setEncoding('utf-8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

const traversalPaths = ['/../outfile.txt', '/%2e%2e/outfile.txt']

describe('public directory middleware', () => {
  let server: ViteDevServer
  let httpServer: http.Server

  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      root,
      publicDir: 'out',
      logLevel: 'silent',
      appType: 'custom',
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false, watch: null },
    })
    // without the in-memory public files list, which is the case when the
    // public directory contains a symlink, every request reaches sirv
    const middleware = servePublicMiddleware(server)
    httpServer = http.createServer((req, res) => {
      middleware(req, res, () => {
        res.statusCode = 404
        res.end()
      })
    })
    await new Promise<void>((resolve) =>
      httpServer.listen(0, '127.0.0.1', resolve),
    )
  })

  afterAll(async () => {
    await new Promise((resolve) => httpServer.close(resolve))
    await server.close()
  })

  test('serves files inside the public directory', async () => {
    const res = await request(httpServer, '/inside.txt')
    expect(res.status).toBe(200)
    expect(res.body).toContain(insideContent)
  })

  test.each(traversalPaths)(
    'does not serve files starting with the public directory name (%s)',
    async (path) => {
      const res = await request(httpServer, path)
      expect(res.body).not.toContain(secretContent)
      expect(res.status).toBe(404)
    },
  )
})

describe('preview server', () => {
  let server: PreviewServer

  beforeAll(async () => {
    server = await preview({
      configFile: false,
      root,
      logLevel: 'silent',
      appType: 'mpa',
      build: { outDir: 'out' },
      preview: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
    })
  })

  afterAll(async () => {
    await server.close()
  })

  test('serves files inside the output directory', async () => {
    const res = await request(server.httpServer as http.Server, '/inside.txt')
    expect(res.status).toBe(200)
    expect(res.body).toContain(insideContent)
  })

  test.each(traversalPaths)(
    'does not serve files starting with the output directory name (%s)',
    async (path) => {
      const res = await request(server.httpServer as http.Server, path)
      expect(res.body).not.toContain(secretContent)
      expect(res.status).toBe(404)
    },
  )
})
