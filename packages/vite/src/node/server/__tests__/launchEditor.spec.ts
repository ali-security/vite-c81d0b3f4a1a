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
const nodePath = _require('node:path')
const os = _require('node:os')

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
      existsSync: [...existsSync.mock.calls],
    }
  } finally {
    setPlatform(originalPlatform)
    exec.mockRestore()
    spawn.mockRestore()
    existsSync.mockRestore()
  }
}

function openFile(platform: string, file: string, editor = 'code') {
  const onError = vi.fn()
  const launched = captureLaunch(platform, () => {
    launchEditor(file, editor, onError)
  })
  expect(onError).not.toHaveBeenCalled()
  return launched
}

const WSL_RELEASE = '4.4.0-43-Microsoft'
const LINUX_RELEASE = '6.8.0-generic'

// Calls `fn` with `cwd` as the working directory and `release` as the kernel
// release (WSL is detected by a release such as `WSL_RELEASE`)
function withCwd<T>(cwd: string, release: string, fn: () => T): T {
  const processCwd = vi.spyOn(process, 'cwd').mockReturnValue(cwd)
  const osRelease = vi.spyOn(os, 'release').mockReturnValue(release)
  try {
    return fn()
  } finally {
    processCwd.mockRestore()
    osRelease.mockRestore()
  }
}

// Opens `file` as if running in WSL and returns the editor arguments
function openFileInWSL(cwd: string, file: string, editor = 'vim') {
  const launch = () => openFile('linux', file, editor)
  const { spawn } = withCwd(cwd, WSL_RELEASE, launch)
  expect(spawn).toHaveLength(1)
  return spawn[0][1]
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
    ['C:\\foo\\a&calc.js', 'code ^"C:\\foo\\a^&calc.js^"'],
    ['C:\\foo\\a&&calc.js', 'code ^"C:\\foo\\a^&^&calc.js^"'],
    ['C:\\foo\\a|calc.js', 'code ^"C:\\foo\\a^|calc.js^"'],
    ['C:\\foo\\a>out.js', 'code ^"C:\\foo\\a^>out.js^"'],
    ['C:\\foo\\a<in.js', 'code ^"C:\\foo\\a^<in.js^"'],
    ['C:\\foo\\a^b.js', 'code ^"C:\\foo\\a^^b.js^"'],
    ['C:\\foo\\a,b;c=d.js', 'code ^"C:\\foo\\a^,b^;c^=d.js^"'],
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
    const { exec, spawn } = openFile('win32', 'C:\\foo\\a&calc.js:10:5')

    expect(spawn).toHaveLength(0)
    expect(exec).toHaveLength(1)
    const [command] = exec[0]
    expect(command).toBe('code -r -g ^"C:\\foo\\a^&calc.js:10:5^"')
    expect(findUnescapedCmdMetachars(command)).toEqual([])
  })

  test.each([
    ['C:\\foo\\src\\main.ts', 'code C:\\foo\\src\\main.ts'],
    ['C:\\my project\\src\\main.ts', 'code "C:\\my project\\src\\main.ts"'],
    [
      'C:\\foo\\src\\routes\\[slug]\\+page.svelte',
      'code C:\\foo\\src\\routes\\[slug]\\+page.svelte',
    ],
    ['C:\\foo\\app\\routes\\$id.tsx', 'code C:\\foo\\app\\routes\\$id.tsx'],
    [
      'C:\\foo\\src\\app\\(group)\\@modal\\page.ts',
      'code C:\\foo\\src\\app\\(group)\\@modal\\page.ts',
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

const UNC_ERROR =
  'UNC paths are not supported on Windows to avoid security issues.'

// Accessing a UNC path makes Windows send the user's NTLMv2 hash to the remote
// host, so it must be rejected before the file system is touched
describe('launch-editor UNC paths on Windows', () => {
  test.each([
    '\\\\server\\share\\file.js',
    '\\\\127.0.0.1\\share\\test.txt',
    '//server/share/file.js',
    '\\\\server/share/file.js',
    '/\\server\\share\\file.js',
    '\\\\?\\UNC\\server\\share\\file.js',
    '\\\\.\\UNC\\server\\share\\file.js',
  ])('rejects %s without accessing it', (file) => {
    const onError = vi.fn()
    const { exec, spawn, existsSync } = captureLaunch('win32', () => {
      launchEditor(file, 'code', onError)
    })

    expect(existsSync).toHaveLength(0)
    expect(exec).toHaveLength(0)
    expect(spawn).toHaveLength(0)
    expect(onError).toHaveBeenCalledTimes(1)
    const [fileName, message] = onError.mock.calls[0]
    expect(fileName).toBe(nodePath.win32.resolve(file))
    expect(message).toContain(UNC_ERROR)
  })

  test('strips the position suffix before reporting the rejected UNC path', () => {
    const onError = vi.fn()
    const { exec, spawn, existsSync } = captureLaunch('win32', () => {
      launchEditor('\\\\server\\share\\file.js:10:5', 'code', onError)
    })

    expect(existsSync).toHaveLength(0)
    expect(exec).toHaveLength(0)
    expect(spawn).toHaveLength(0)
    expect(onError).toHaveBeenCalledTimes(1)
    const [fileName, message] = onError.mock.calls[0]
    expect(fileName).toBe('\\\\server\\share\\file.js')
    expect(message).toContain(UNC_ERROR)
  })

  test('reports to the error callback passed as the second argument', () => {
    const onError = vi.fn()
    const { exec, spawn, existsSync } = captureLaunch('win32', () => {
      launchEditor('\\\\server\\share\\file.js', onError)
    })

    expect(existsSync).toHaveLength(0)
    expect(exec).toHaveLength(0)
    expect(spawn).toHaveLength(0)
    expect(onError).toHaveBeenCalledTimes(1)
    const [fileName, message] = onError.mock.calls[0]
    expect(fileName).toBe('\\\\server\\share\\file.js')
    expect(message).toContain(UNC_ERROR)
  })

  test('rejects without an error callback', () => {
    const { exec, spawn, existsSync } = captureLaunch('win32', () => {
      launchEditor('\\\\server\\share\\file.js', 'code')
    })

    expect(existsSync).toHaveLength(0)
    expect(exec).toHaveLength(0)
    expect(spawn).toHaveLength(0)
  })

  test('rejects a UNC path requested via /__open-in-editor', () => {
    // vite uses the middleware without an error callback
    const middleware = launchEditorMiddleware('code', path.resolve('/project'))
    const req = {
      url: '/__open-in-editor?file=%5c%5c127.0.0.1%5cshare%5ctest.txt',
    }
    const res = { statusCode: 200, end: vi.fn() }
    // The middleware resolves the file with `path.resolve`, which keeps a UNC
    // path as is on Windows
    const win32Resolve = nodePath.win32.resolve
    const { exec, spawn, existsSync } = captureLaunch('win32', () => {
      const resolve = vi
        .spyOn(nodePath, 'resolve')
        .mockImplementation(win32Resolve)
      try {
        middleware(req, res)
      } finally {
        resolve.mockRestore()
      }
    })

    expect(res.statusCode).toBe(200)
    expect(res.end).toHaveBeenCalled()
    expect(existsSync).toHaveLength(0)
    expect(exec).toHaveLength(0)
    expect(spawn).toHaveLength(0)
  })

  test.each([
    'C:\\Users\\me\\project\\src\\main.ts',
    'C:/Users/me/project/src/main.ts',
    'src\\main.ts',
  ])('still opens %s', (file) => {
    const { exec, spawn, existsSync } = openFile('win32', file)

    expect(existsSync).toEqual([[nodePath.win32.resolve(file)]])
    expect(spawn).toHaveLength(0)
    expect(exec).toHaveLength(1)
  })
})

const PERCENT_ERROR = /argument containing "%"/
const LINE_BREAK_ERROR = /argument containing a line break/

// CMD treats line breaks as command separators and expands `%VAR%` (and
// `%VAR:old=new%`) before consuming `^` escapes, so an argument containing
// them could run the value of an environment variable as a command
describe('launch-editor CMD expansion on Windows', () => {
  test.each([
    ['a percent sign', 'C:\\project\\100%\\file.js', PERCENT_ERROR],
    ['a variable', 'C:\\project\\%COMSPEC%.js', PERCENT_ERROR],
    ['a variable modifier', 'C:\\project\\%VAR:old=new%', PERCENT_ERROR],
    ['a carriage return', 'C:\\project\\a.js\rcalc.exe', LINE_BREAK_ERROR],
    ['a line feed', 'C:\\project\\a.js\ncalc.exe', LINE_BREAK_ERROR],
  ])('rejects %s in the file name', (_, file, error) => {
    const onError = vi.fn()
    const { exec, spawn } = captureLaunch('win32', () => {
      launchEditor(file, 'code', onError)
    })

    expect(exec).toHaveLength(0)
    expect(spawn).toHaveLength(0)
    expect(onError).toHaveBeenCalledTimes(1)
    const [fileName, message] = onError.mock.calls[0]
    expect(fileName).toBe(nodePath.win32.resolve(file))
    expect(message).toMatch(error)
  })

  test('rejects a percent sign when line and column are given', () => {
    const onError = vi.fn()
    const { exec, spawn } = captureLaunch('win32', () => {
      launchEditor('C:\\project\\%COMSPEC%.js:10:5', 'code', onError)
    })

    expect(exec).toHaveLength(0)
    expect(spawn).toHaveLength(0)
    expect(onError).toHaveBeenCalledTimes(1)
    const [fileName, message] = onError.mock.calls[0]
    expect(fileName).toBe('C:\\project\\%COMSPEC%.js')
    expect(message).toMatch(PERCENT_ERROR)
  })

  test('rejects a percent sign in the editor arguments', () => {
    const onError = vi.fn()
    const { exec, spawn } = captureLaunch('win32', () => {
      launchEditor('C:\\project\\a.js', 'code --profile %VAR%', onError)
    })

    expect(exec).toHaveLength(0)
    expect(spawn).toHaveLength(0)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][1]).toMatch(PERCENT_ERROR)
  })

  test('rejects a percent sign requested via /__open-in-editor', () => {
    // vite uses the middleware without an error callback
    const middleware = launchEditorMiddleware('code', path.resolve('/project'))
    const req = { url: '/__open-in-editor?file=%25COMSPEC%25.js' }
    const res = { statusCode: 200, end: vi.fn() }
    const { exec, spawn } = captureLaunch('win32', () => {
      middleware(req, res)
    })

    expect(res.statusCode).toBe(200)
    expect(res.end).toHaveBeenCalled()
    expect(exec).toHaveLength(0)
    expect(spawn).toHaveLength(0)
  })
})

describe('launch-editor on other platforms', () => {
  test('does not apply the Windows CMD checks', () => {
    const { exec, spawn } = openFile('linux', '/foo/100%/%VAR%.js')

    expect(exec).toHaveLength(0)
    expect(spawn).toHaveLength(1)
    const [, args] = spawn[0]
    expect(args).toEqual(['/foo/100%/%VAR%.js'])
  })

  test('spawns the editor without a shell', () => {
    const { exec, spawn } = openFile('linux', '/foo/a&calc.js')

    expect(exec).toHaveLength(0)
    expect(spawn).toHaveLength(1)
    const [command, args, options] = spawn[0]
    expect(command).toBe('code')
    expect(args).toEqual(['/foo/a&calc.js'])
    expect(options).toEqual({ stdio: 'inherit' })
  })

  test.each([
    '\\\\server\\share\\file.js',
    '//server/share/file.js',
    '\\\\?\\UNC\\server\\share\\file.js',
  ])('does not apply the Windows UNC path check to %s', (file) => {
    const { exec, spawn, existsSync } = openFile('linux', file)

    const fileName = nodePath.posix.resolve(file)
    expect(existsSync).toEqual([[fileName]])
    expect(exec).toHaveLength(0)
    expect(spawn).toHaveLength(1)
    const [, args] = spawn[0]
    expect(args).toEqual([fileName])
  })
})

// The position suffix must be removed before the file name is resolved,
// otherwise `dir/..:1:1` passes the existence check as `dir/..` (an existing
// parent directory) while a different, attacker-controlled path is opened
describe('launch-editor position suffix', () => {
  test('resolves `..` left by the position suffix on Windows', () => {
    const file = 'C:\\project\\attacker-controlled\\..:1:1'
    const { exec, spawn, existsSync } = openFile('win32', file)

    expect(existsSync).toEqual([['C:\\project']])
    expect(spawn).toHaveLength(0)
    expect(exec).toHaveLength(1)
    const [command] = exec[0]
    expect(command).toBe('code -r -g C:\\project:1:1')
  })

  test('resolves `..` left by the position suffix on other platforms', () => {
    const file = '/project/attacker-controlled/..:1:1'
    const { exec, spawn, existsSync } = openFile('linux', file)

    expect(existsSync).toEqual([['/project']])
    expect(exec).toHaveLength(0)
    expect(spawn).toHaveLength(1)
    const [, args] = spawn[0]
    expect(args).toEqual(['-r', '-g', '/project:1:1'])
  })

  test('resolves `..` requested via /__open-in-editor', () => {
    const middleware = launchEditorMiddleware('code', 'C:\\project')
    const file = encodeURIComponent('attacker-controlled\\..:1:1')
    const req = { url: `/__open-in-editor?file=${file}` }
    const res = { statusCode: 200, end: vi.fn() }
    // The middleware resolves the file with `path.resolve`, which treats
    // `..:1:1` as a regular segment name on Windows
    const win32Resolve = nodePath.win32.resolve
    const { exec, spawn, existsSync } = captureLaunch('win32', () => {
      const resolve = vi
        .spyOn(nodePath, 'resolve')
        .mockImplementation(win32Resolve)
      try {
        middleware(req, res)
      } finally {
        resolve.mockRestore()
      }
    })

    expect(res.statusCode).toBe(200)
    expect(res.end).toHaveBeenCalled()
    expect(existsSync).toEqual([['C:\\project']])
    expect(spawn).toHaveLength(0)
    expect(exec).toHaveLength(1)
    const [command] = exec[0]
    expect(command).toBe('code -r -g C:\\project:1:1')
  })

  test.each(['win32', 'linux'])('keeps an empty name on %s', (platform) => {
    const { existsSync } = captureLaunch(platform, () => {
      launchEditor(':1:1', 'code', vi.fn())
    })

    expect(existsSync).toEqual([['']])
  })
})

// Editors parse an argument starting with `+` or `-` as an option (e.g. Vim
// runs `+cmd` as a command), so a file name must never be passed in that form,
// not even after it is converted to a relative path for WSL
const OPTION_LIKE_FILES = [
  ['vim', '+call writefile(["marker"], "LAUNCH_EDITOR_MARKER")|qa!'],
  ['mvim', '-ccall writefile(["marker"], "LAUNCH_EDITOR_MARKER")|qa!'],
  ['gvim', '+call writefile(["marker"], "LAUNCH_EDITOR_MARKER")|qa!'],
  ['emacs', '--eval=(write-region "marker" nil "LAUNCH_EDITOR_MARKER")'],
  ['emacsclient', '-eatouch LAUNCH_EDITOR_MARKER'],
  ['notepad++', '-pluginMessage=LAUNCH_EDITOR_MARKER'],
]

describe('launch-editor file names that look like editor options', () => {
  test.each(OPTION_LIKE_FILES)('%s gets an absolute path', (editor, file) => {
    const cwd = '/home/user/project'
    for (const position of ['', ':10:5']) {
      const launch = () => openFile('linux', file + position, editor)
      const { spawn } = withCwd(cwd, LINUX_RELEASE, launch)

      expect(spawn).toHaveLength(1)
      const [, args] = spawn[0]
      expect(args[args.length - 1]).toBe(`${cwd}/${file}`)
    }
  })
})

// In WSL, a file on a Windows drive is opened with a path relative to the
// working directory. These tests are skipped on Windows, where the `path`
// module used for that conversion is `path.win32`.
describe.skipIf(originalPlatform === 'win32')('launch-editor in WSL', () => {
  test('uses a relative path for a file on a Windows drive', () => {
    const args = openFileInWSL('/home/user/project', '/mnt/c/project/file.js')
    expect(args).toEqual(['./../../../mnt/c/project/file.js'])
  })

  test('resolves a relative path before converting it', () => {
    expect(openFileInWSL('/mnt/c/project', 'file.js')).toEqual(['./file.js'])
  })

  test('prefixes an option-like relative path', () => {
    const file = '+call system("touch LAUNCH_EDITOR_MARKER")'
    expect(openFileInWSL('/mnt/c/project', file)).toEqual([`./${file}`])
  })

  test('prefixes an option-like relative path with a position', () => {
    const file = '+call system("touch LAUNCH_EDITOR_MARKER")'
    const args = openFileInWSL('/mnt/c/project', `${file}:10:5`)
    expect(args).toEqual(['+call cursor(10, 5)', `./${file}`])
  })

  test.each(OPTION_LIKE_FILES)('%s gets a prefixed path', (editor, file) => {
    for (const position of ['', ':10:5']) {
      const args = openFileInWSL('/mnt/c/project', file + position, editor)
      expect(args[args.length - 1]).toBe(`./${file}`)
    }
  })

  test('prefixes an option-like path requested via /__open-in-editor', () => {
    const file = '+call system("touch LAUNCH_EDITOR_MARKER")'
    const req = { url: `/__open-in-editor?file=${encodeURIComponent(file)}` }
    const res = { statusCode: 200, end: vi.fn() }
    const { spawn } = withCwd('/mnt/c/project', WSL_RELEASE, () => {
      // vite creates the middleware without `srcRoot`, which defaults to the
      // working directory
      const middleware = launchEditorMiddleware('vim')
      return captureLaunch('linux', () => {
        middleware(req, res)
      })
    })

    expect(res.statusCode).toBe(200)
    expect(res.end).toHaveBeenCalled()
    expect(spawn).toHaveLength(1)
    const [command, args] = spawn[0]
    expect(command).toBe('vim')
    expect(args).toEqual([`./${file}`])
  })
})
