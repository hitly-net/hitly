import { docs, integrations } from '@/.source/server'
import { loader } from 'fumadocs-core/source'

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
})

export const integrationsSource = loader({
  baseUrl: '/integrations',
  source: integrations.toFumadocsSource(),
})
