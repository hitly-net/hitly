import Link from 'next/link'
import { HitlyWordmark } from '@hitly/ui'
import { APP_URL } from '@/lib/layout.shared'

export function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <h1 className="mt-4 max-w-3xl text-5xl font-semibold tracking-tight text-balance">
        Pause the agent. Review the action. Resume the run.
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-zinc-600 dark:text-zinc-400">
        <HitlyWordmark className="font-semibold" /> is the inbox agents wait on. Mastra, Hermes, HTTP, LangGraph, and Temporal pause; your team decides; HITLy resumes the origin workflow. Self-host it or use hitly.net.
      </p>
      <div className="mt-8 flex gap-3">
        <Link
          href={`${APP_URL}/signup`}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Open the inbox
        </Link>
        <Link
          href="/integrations/mastra"
          className="rounded-md border border-zinc-200 px-5 py-2.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Integrate Mastra
        </Link>
      </div>
    </section>
  )
}
