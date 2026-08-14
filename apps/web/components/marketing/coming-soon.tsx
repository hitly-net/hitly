import { HitlyMark } from '@hitly/ui'
import { HeroChat } from './hero-chat'
import { WaitlistForm } from './waitlist-form'

export function ComingSoon() {
  return (
    <section className="mx-auto grid max-w-6xl items-start gap-16 px-6 py-8 lg:grid-cols-2 lg:py-10">
      <div>
        <HitlyMark className="h-20 w-20" />
        <h1 className="sr-only">Pause the agent. Review the action. Resume the run.</h1>
        <div className="mt-6">
          <HeroChat />
        </div>
        <div className="mt-6 max-w-lg space-y-1 text-sm text-zinc-500">
          <p>Cloud — Join the waitlist</p>
          <p>
            Local — open source (alpha) is available on{' '}
            <a
              href="https://github.com/hitly-net/hitly"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-zinc-800 dark:hover:text-zinc-300"
            >
              GitHub
            </a>
            .
          </p>
        </div>
      </div>
      <WaitlistForm />
    </section>
  )
}
