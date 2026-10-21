import type { OpenAICompatibleConfig } from '@mastra/core/llm'

export function localModel(): OpenAICompatibleConfig {
  const modelId = process.env.MASTRA_MODEL ?? 'qwen3.6-35b-a3b-mtp'
  return {
    id: `lmstudio/${modelId}`,
    url: process.env.OPENAI_BASE_URL ?? 'http://localhost:1234/v1',
    apiKey: process.env.LMSTUDIO_API_KEY ?? process.env.OPENAI_API_KEY ?? 'x',
  }
}
