import { buildAgentsMarkdown } from '@/lib/agents'
import { markdownResponse } from '@/lib/llms'

export const revalidate = false

export function GET() {
  return markdownResponse(buildAgentsMarkdown())
}
