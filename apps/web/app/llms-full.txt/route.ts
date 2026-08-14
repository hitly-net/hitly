import { buildLlmsFull, markdownResponse } from '@/lib/llms'

export const revalidate = false

export async function GET() {
  return markdownResponse(await buildLlmsFull())
}
