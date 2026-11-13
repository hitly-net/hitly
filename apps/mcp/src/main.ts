import { loadConfig } from './config.ts'
import { createLogger } from './logger.ts'
import { createDbBackedRateLimiter, type McpRateAcquire } from './rate-limit.ts'
import { createMcpHttpServer } from './server.ts'

const config = loadConfig()
const logger = createLogger()

// Shared-database rate limiting when HITLY_MCP_DATABASE_URL points at the
// HITLy database (same rate_limit_buckets table the app uses); otherwise the
// per-process limiter. A pool that never answers degrades to per-process
// counting inside the shared limiter, with one log line.
let rateAcquire: McpRateAcquire | undefined
let closeRateLimiter: (() => Promise<void>) | undefined
if (config.rateDatabaseUrl && config.rateLimit > 0) {
  try {
    const shared = await createDbBackedRateLimiter({
      databaseUrl: config.rateDatabaseUrl,
      limit: config.rateLimit,
      windowMs: config.rateWindowMs,
      log: (line) => logger.log({ event: 'rate_limit', status: `db_fallback ${line}` }),
    })
    rateAcquire = shared.acquire
    closeRateLimiter = shared.close
  } catch (error) {
    logger.log({ event: 'rate_limit', status: `db_unavailable ${error instanceof Error ? error.name : 'error'}` })
  }
}

const server = createMcpHttpServer(config, { logger, ...(rateAcquire ? { rateAcquire } : {}) })
server.listen(config.port, config.listenHost, () => {
  const address = server.address()
  logger.log({ event: 'listen', port: typeof address === 'object' && address ? address.port : config.port })
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void (closeRateLimiter?.() ?? Promise.resolve()).finally(() => process.exit(0))
    })
  })
}
