interface HitlyConfig {
  apiUrl: string
  apiKey: string
  projectId: string
  temporalAddress: string
  temporalNamespace: string
}

export function getHitlyConfig(): HitlyConfig {
  const apiKey = process.env.HITLY_API_KEY ?? ''
  const projectId = process.env.HITLY_PROJECT_ID ?? ''
  const temporalAddress = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233'
  const temporalNamespace = process.env.TEMPORAL_NAMESPACE ?? 'default'

  if (!apiKey || !projectId) {
    throw new Error(
      'Set HITLY_API_KEY and HITLY_PROJECT_ID in examples/temporal/.env (copy them from the HITLy project page).',
    )
  }

  return {
    apiUrl: process.env.HITLY_API_URL ?? 'http://localhost:3001',
    apiKey,
    projectId,
    temporalAddress,
    temporalNamespace,
  }
}
