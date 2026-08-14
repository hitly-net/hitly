'use client'

import type { ApprovalAttachment } from '@hitly/core'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
}

export function ContextMarkdown({
  value,
  externalUrls,
  attachments,
}: {
  value?: string
  externalUrls?: string[]
  attachments?: ApprovalAttachment[]
}) {
  const markdown = value?.trim()
  const urls = externalUrls?.filter((url) => url.trim()) ?? []
  const files = attachments?.filter((file) => file.name.trim()) ?? []
  const empty = !markdown && urls.length === 0 && files.length === 0

  return (
    <section className="mt-6 max-w-2xl rounded-md border border-zinc-200 dark:border-zinc-800">
      <h2 className="border-b border-zinc-200 px-4 py-3 text-sm font-semibold dark:border-zinc-800">Context</h2>
      <div className="max-h-[32rem] overflow-auto px-4 py-3">
        {empty ? <p className="text-sm text-zinc-500">No context provided.</p> : null}
        {markdown ? (
          <div className="markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
              {markdown}
            </ReactMarkdown>
          </div>
        ) : null}
        {urls.length > 0 ? (
          <div className={markdown ? 'mt-4' : undefined}>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Links</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {urls.map((url) => (
                <li key={url}>
                  <a href={url} target="_blank" rel="noreferrer" className="break-all underline">
                    {url}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {files.length > 0 ? (
          <div className={markdown || urls.length > 0 ? 'mt-4' : undefined}>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Attachments</h3>
            <p className="mt-1 text-xs text-zinc-500">File preview is not implemented yet.</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {files.map((file) => (
                <li key={`${file.name}:${file.url ?? ''}`}>
                  {file.url ? (
                    <a href={file.url} target="_blank" rel="noreferrer" className="underline">
                      {file.name}
                    </a>
                  ) : (
                    file.name
                  )}
                  {file.contentType ? <span className="text-zinc-500"> · {file.contentType}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  )
}
