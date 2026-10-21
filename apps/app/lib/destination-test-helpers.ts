import * as http from 'node:http'
import type { AddressInfo } from 'node:net'

/** Test helpers for destination check tests: 127.0.0.1 stub servers, env and console capture. */

export const CANARY = 'canary-4b9d2e7f-response-text'

export interface StubServer {
  url: string
  port: number
  hits: Array<{ method?: string; path?: string; host?: string }>
  close(): void
}

export function startStub(handler: http.RequestListener): Promise<StubServer> {
  const hits: StubServer['hits'] = []
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method, path: req.url, host: req.headers.host })
    req.resume()
    req.on('end', () => handler(req, res))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        hits,
        close() {
          server.closeAllConnections()
          server.close()
        },
      })
    })
  })
}

type Env = Record<string, string | undefined>

/** Runs fn with NODE_ENV and the private-destination flag set, then restores them. */
export async function withEnv<T>(values: Env, fn: () => Promise<T>): Promise<T> {
  const env = process.env as Env
  const saved: Env = {}
  for (const key of Object.keys(values)) {
    saved[key] = env[key]
    if (values[key] === undefined) delete env[key]
    else env[key] = values[key]
  }
  try {
    return await fn()
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete env[key]
      else env[key] = saved[key]
    }
  }
}

export const PRODUCTION = { NODE_ENV: 'production', HITLY_ALLOW_PRIVATE_EVIDENCE_SINKS: undefined }
export const PRODUCTION_ALLOWED = { NODE_ENV: 'production', HITLY_ALLOW_PRIVATE_EVIDENCE_SINKS: 'true' }
export const DEVELOPMENT = { NODE_ENV: 'development', HITLY_ALLOW_PRIVATE_EVIDENCE_SINKS: undefined }

/** Captures console output while fn runs. */
export async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T | undefined; error: unknown; output: string }> {
  const lines: string[] = []
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
  const original = methods.map((m) => console[m])
  for (const m of methods) {
    console[m] = (...args: unknown[]) => {
      lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack ?? ''}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    }
  }
  try {
    const result = await fn()
    return { result, error: undefined, output: lines.join('\n') }
  } catch (error) {
    return { result: undefined, error, output: lines.join('\n') }
  } finally {
    methods.forEach((m, i) => {
      console[m] = original[i]
    })
  }
}
