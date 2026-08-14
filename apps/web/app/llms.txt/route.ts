import { buildLlmsIndex, markdownResponse } from '@/lib/llms'

export const revalidate = false

export function GET() {
  return markdownResponse(buildLlmsIndex())
}
