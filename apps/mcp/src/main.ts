import { loadConfig } from './config.ts'
import { createLogger } from './logger.ts'
import { createMcpHttpServer } from './server.ts'

const config = loadConfig()
const logger = createLogger()
const server = createMcpHttpServer(config, { logger })
server.listen(config.port, config.listenHost, () => {
  const address = server.address()
  logger.log({ event: 'listen', port: typeof address === 'object' && address ? address.port : config.port })
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
