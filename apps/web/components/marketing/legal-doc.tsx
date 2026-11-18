import * as React from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import GithubSlugger from 'github-slugger'
import { loadLegalDoc, type LegalDocFile } from '@/lib/legal'

function textOf(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (React.isValidElement(node)) return textOf((node.props as { children?: React.ReactNode }).children)
  return ''
}

/** Heading component factory: adds a GitHub-compatible anchor id. */
function heading(Tag: 'h1' | 'h2' | 'h3', slugger: GithubSlugger) {
  return function Heading({ children }: { children?: React.ReactNode }) {
    const id = slugger.slug(textOf(children))
    const className =
      Tag === 'h1'
        ? 'text-3xl font-semibold tracking-tight'
        : Tag === 'h2'
          ? 'mt-10 text-xl font-semibold'
          : 'mt-6 text-lg font-semibold'
    return React.createElement(Tag, { id, className }, children)
  }
}

/**
 * Renders one Legal-approved markdown document verbatim, with anchor ids on
 * headings so deep links (e.g. /terms#6-billing-terms) resolve.
 */
export function LegalDoc({ file }: { file: LegalDocFile }) {
  const doc = loadLegalDoc(file)
  const slugger = new GithubSlugger()
  const components: Components = {
    h1: heading('h1', slugger),
    h2: heading('h2', slugger),
    h3: heading('h3', slugger),
    p: ({ children }) => <p className="mt-4 leading-relaxed text-zinc-700 dark:text-zinc-300">{children}</p>,
    ul: ({ children }) => (
      <ul className="mt-4 list-disc space-y-1 pl-6 text-zinc-700 dark:text-zinc-300">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="mt-4 list-decimal space-y-1 pl-6 text-zinc-700 dark:text-zinc-300">{children}</ol>
    ),
    blockquote: ({ children }) => (
      <blockquote className="mt-4 border-l-2 border-zinc-300 pl-4 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
        {children}
      </blockquote>
    ),
    table: ({ children }) => (
      <div className="mt-4 overflow-x-auto">
        <table className="w-full border-collapse text-sm text-zinc-700 dark:text-zinc-300">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-zinc-50 dark:bg-zinc-900">{children}</thead>,
    th: ({ children }) => (
      <th className="border border-zinc-200 px-3 py-2 text-left font-semibold dark:border-zinc-800">{children}</th>
    ),
    td: ({ children }) => (
      <td className="border border-zinc-200 px-3 py-2 align-top dark:border-zinc-800">{children}</td>
    ),
    hr: () => <hr className="my-8 border-zinc-200 dark:border-zinc-800" />,
    a: ({ href, children }) => (
      <a href={href} className="underline hover:text-zinc-900 dark:hover:text-zinc-50">
        {children}
      </a>
    ),
    code: ({ children }) => (
      <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.9em] dark:bg-zinc-800">{children}</code>
    ),
  }
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {doc.body}
      </Markdown>
      {doc.version || doc.effective ? (
        <p className="mt-10 text-xs text-zinc-500">
          {[doc.version ? `Version ${doc.version}` : null, doc.effective ? `Effective ${doc.effective}` : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
    </main>
  )
}
