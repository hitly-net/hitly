import { HitlyMark, HitlyWordmark } from '@hitly/ui'
import { WaitlistForm } from './waitlist-form'

export function ComingSoon() {
  return (
    <section className="mx-auto grid max-w-6xl items-start gap-16 px-6 py-20 lg:grid-cols-2 lg:py-28">
      <div>
        <HitlyMark className="h-20 w-20" />
        <p className="mt-6 text-sm font-medium uppercase tracking-widest text-zinc-500">Coming soon</p>
        <h1 className="mt-4 max-w-xl text-5xl font-semibold tracking-tight text-balance">
          Pause the agent. Review the action. Resume the run.
        </h1>
        <p className="mt-6 max-w-lg text-lg text-zinc-600 dark:text-zinc-400">
          <HitlyWordmark className="font-semibold" /> is an approval inbox for Mastra, n8n, LangGraph, and Temporal.
          Frameworks pause; your team decides; HITLy resumes the origin workflow.
        </p>
        <p className="mt-4 max-w-lg text-sm text-zinc-500">
          Hosted hitly.net is not open yet. Join the waitlist and we will email you when it is.
        </p>
      </div>
      <WaitlistForm />
    </section>
  )
}
