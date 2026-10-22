import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Start the example the way `yarn dev:mastra` does (`mastra dev`) on a free
// port and wait until the dev server reports it is ready. This catches module
// resolution failures in workspace packages that only show up at runtime.

const exampleDir = dirname(dirname(fileURLToPath(import.meta.url)))
const mastraBin = join(exampleDir, 'node_modules', '.bin', 'mastra')
const READY = /ready in \d+/
const FAILED = /ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED|SyntaxError|Dev server stopped/
const TIMEOUT_MS = 120_000
// CI forces colour output; drop ANSI escapes before matching.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function resolveMastraBin() {
  const { existsSync } = await import('node:fs')
  if (existsSync(mastraBin)) return mastraBin
  const rootBin = join(exampleDir, '..', '..', 'node_modules', '.bin', 'mastra')
  if (existsSync(rootBin)) return rootBin
  throw new Error('mastra CLI not found; run yarn install')
}

test('mastra dev starts without module resolution errors', { timeout: TIMEOUT_MS + 10_000 }, async () => {
  const port = await freePort()
  const bin = await resolveMastraBin()
  const child = spawn(bin, ['dev'], {
    cwd: exampleDir,
    env: { ...process.env, PORT: String(port), NODE_OPTIONS: '', NO_COLOR: '1' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let raw = ''
  let output = ''
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), TIMEOUT_MS)
    const onData = (chunk) => {
      raw += chunk.toString()
      output = raw.replace(ANSI, '')
      if (FAILED.test(output)) {
        clearTimeout(timer)
        resolve('failed')
      } else if (READY.test(output)) {
        clearTimeout(timer)
        resolve('ready')
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(READY.test(output) ? 'ready' : 'failed')
    })
  })

  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {}
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const force = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
      resolve()
    }, 10_000)
    child.on('exit', () => {
      clearTimeout(force)
      resolve()
    })
  })

  assert.equal(outcome, 'ready', `mastra dev did not start:\n${output}`)
})
