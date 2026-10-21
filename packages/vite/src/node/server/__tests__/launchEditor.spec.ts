import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'

const _require = createRequire(import.meta.url)

// Load the same copy of `launch-editor` that the bundled
// `launch-editor-middleware` (`/__open-in-editor`) uses
const launchEditorMiddlewarePath = _require.resolve('launch-editor-middleware')
const launchEditorMiddleware = _require(launchEditorMiddlewarePath)
const launchEditor = _require(
  _require.resolve('launch-editor', {
    paths: [path.dirname(launchEditorMiddlewarePath)],
  }),
)
// `launch-editor` holds references to these CJS module objects,
// so stubbing their properties is visible to it
const childProcess = _require('node:child_process')
const fs = _require('node:fs')

const originalPlatform = process.platform

function setPlatform(platform: string) {
  Object.defineProperty(process, 'platform', { value: platform })
}

function fakeChildProcess() {
  return Object.assign(new EventEmitter(), { kill: vi.fn() })
}

// Calls `fn` as if running on `platform`, with the editor process launch and
// the file existence check stubbed, and returns how the editor was launched.
function captureLaunch(platform: string, fn: () => void) {
  const exec = vi
    .spyOn(childProcess, 'exec')
    .mockImplementation(() => fakeChildProcess())
  const spawn = vi
    .spyOn(childProcess, 'spawn')
    .mockImplementation(() => fakeChildProcess())
  const existsSync = vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  try {
    setPlatform(platform)
    fn()
    return {
      exec: [...exec.mock.calls],
      spawn: [...spawn.mock.calls],
    }
  } finally {
    setPlatform(originalPlatform)
    exec.mockRestore()
    spawn.mockRestore()
    existsSync.mockRestore()
  }
}

function openFile(platform: string, file: string) {
  const onError = vi.fn()
  const launched = captureLaunch(platform, () => {
    launchEditor(file, 'code', onError)
  })
  expect(onError).not.toHaveBeenCalled()
  return launched
}

// Minimal model of how cmd.exe parses a command line: returns the special
// characters that would be interpreted as command separators / redirections
// (i.e. not escaped with `^` and not inside a double-quoted string).
function findUnescapedCmdMetachars(command: string): string[] {
  const found: string[] = []
  let quoted = false
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (!quoted && c === '^') {
      i++
      continue
    }
    if (c === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && '&|<>'.includes(c)) {
      found.push(c)
    }
  }
  return found
}

describe('launch-editor on Windows', () => {
  test.each([
    ['C:/foo/a&calc.js', 'code ^"C:/foo/a^&calc.js^"'],
    ['C:/foo/a&&calc.js', 'code ^"C:/foo/a^&^&calc.js^"'],
    ['C:/foo/a|calc.js', 'code ^"C:/foo/a^|calc.js^"'],
    ['C:/foo/a>out.js', 'code ^"C:/foo/a^>out.js^"'],
    ['C:/foo/a<in.js', 'code ^"C:/foo/a^<in.js^"'],
    ['C:/foo/a^b.js', 'code ^"C:/foo/a^^b.js^"'],
    ['C:/foo/a,b;c=d.js', 'code ^"C:/foo/a^,b^;c^=d.js^"'],
    [
      'C:\\Users\\myusername\\Downloads\\& curl 172.21.93.52',
      'code ^"C:\\Users\\myusername\\Downloads\\^& curl 172.21.93.52^"',
    ],
    [
      'C:\\Users\\me\\Downloads\\a" & calc & ".js',
      'code ^"C:\\Users\\me\\Downloads\\a" ^& calc ^& ".js^"',
    ],
  ])('escapes cmd.exe special characters in %s', (file, expected) => {
    const { exec, spawn } = openFile('win32', file)

    expect(spawn).toHaveLength(0)
    expect(exec).toHaveLength(1)
    const [command, options] = exec[0]
    expect(command).toBe(expected)
    expect(options).toEqual({ stdio: 'inherit', shell: true })
    expect(findUnescapedCmdMetachars(command)).toEqual([])
  })

  test('escapes special characters when line and column are given', () => {
    const { exec, spawn } = openFile('win32', 'C:/foo/a&calc.js:10:5')

    expect(spawn).toHaveLength(0)
    expect(exec).toHaveLength(1)
    const [command] = exec[0]
    expect(command).toBe('code -r -g ^"C:/foo/a^&calc.js:10:5^"')
    expect(findUnescapedCmdMetachars(command)).toEqual([])
  })

  test.each([
    ['C:/foo/src/main.ts', 'code C:/foo/src/main.ts'],
    ['C:/my project/src/main.ts', 'code "C:/my project/src/main.ts"'],
    [
      'C:/foo/src/routes/[slug]/+page.svelte',
      'code C:/foo/src/routes/[slug]/+page.svelte',
    ],
    ['C:/foo/app/routes/$id.tsx', 'code C:/foo/app/routes/$id.tsx'],
    [
      'C:/foo/src/app/(group)/@modal/page.ts',
      'code C:/foo/src/app/(group)/@modal/page.ts',
    ],
  ])('opens %s', (file, expected) => {
    const { exec, spawn } = openFile('win32', file)

    expect(spawn).toHaveLength(0)
    expect(exec).toHaveLength(1)
    const [command] = exec[0]
    expect(command).toBe(expected)
  })

  test('escapes the file query of /__open-in-editor', () => {
    const middleware = launchEditorMiddleware('code', path.resolve('/project'))
    const req = {
      url: `/__open-in-editor?file=${encodeURIComponent('a&calc.js')}`,
    }
    const res = { statusCode: 200, end: vi.fn() }
    const { exec, spawn } = captureLaunch('win32', () => {
      middleware(req, res)
    })

    expect(res.statusCode).toBe(200)
    expect(res.end).toHaveBeenCalled()
    expect(spawn).toHaveLength(0)
    expect(exec).toHaveLength(1)
    const [command] = exec[0]
    expect(command.startsWith('code ^"')).toBe(true)
    expect(command.endsWith('a^&calc.js^"')).toBe(true)
    expect(findUnescapedCmdMetachars(command)).toEqual([])
  })
})

describe('launch-editor on other platforms', () => {
  test('spawns the editor without a shell', () => {
    const { exec, spawn } = openFile('linux', '/foo/a&calc.js')

    expect(exec).toHaveLength(0)
    expect(spawn).toHaveLength(1)
    const [command, args, options] = spawn[0]
    expect(command).toBe('code')
    expect(args).toEqual(['/foo/a&calc.js'])
    expect(options).toEqual({ stdio: 'inherit' })
  })
})
