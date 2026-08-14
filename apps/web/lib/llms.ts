import { llms } from 'fumadocs-core/source'
import { getNavTree, integrationsSource, source } from '@/lib/source'

const SITE = 'https://hitly.net'

const MARKDOWN_HEADERS = {
  'Content-Type': 'text/markdown; charset=utf-8',
}

type LlmPage = {
  url: string
  data: {
    title: string
    getText: (type: 'raw' | 'processed') => Promise<string>
  }
}

function toAbsoluteMarkdown(markdown: string) {
  return markdown.replace(/\]\((\/[^)]*)\)/g, `](${SITE}$1)`)
}

export function markdownResponse(body: string) {
  return new Response(body, { headers: MARKDOWN_HEADERS })
}

export function buildLlmsIndex(): string {
  const docsLlms = llms(source)
  const integrationsLlms = llms(integrationsSource)

  const sections = getNavTree().children.map((node) => {
    const indexUrl = node.type === 'folder' ? node.index?.url.replace(/\/$/, '') : undefined
    if (indexUrl === '/integrations') return integrationsLlms.indexNode(node)
    return docsLlms.indexNode(node)
  })

  return toAbsoluteMarkdown(
    [
      '# Hitly',
      '',
      '> Hitly is the review inbox for agents and workflows. Origins (Mastra, Hermes, HTTP, LangGraph, Temporal) keep pause/resume; reviewers decide in Hitly. Cloud is waitlist-only; self-host is available now.',
      '',
      ...sections,
      '',
      '## Also',
      '',
      '- [GitHub](https://github.com/hitly-net/hitly): Apache-2.0 source, examples, and plugins',
      '- [AGENT.md](https://github.com/hitly-net/hitly/blob/main/AGENT.md): drop-in recipe for coding agents implementing Hitly in an existing project',
      '- [Cloud waitlist](https://hitly.net/#waitlist): hosted Hitly is not generally available yet',
      '',
    ].join('\n'),
  )
}

export async function getLLMText(page: LlmPage): Promise<string> {
  const processed = await page.data.getText('processed')
  return `# ${page.data.title} (${SITE}${page.url})\n\n${processed}`
}

export async function buildLlmsFull(): Promise<string> {
  const pages = [...source.getPages(), ...integrationsSource.getPages()]
  const scanned = await Promise.all(pages.map(getLLMText))
  return scanned.join('\n\n')
}
