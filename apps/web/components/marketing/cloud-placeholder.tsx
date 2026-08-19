import { HitlyWordmark } from '@hitly/ui'
import { WaitlistForm } from './waitlist-form'

export function CloudPlaceholder() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto max-w-6xl px-6 py-6">
          <HitlyWordmark className="text-2xl" trademark />
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center">
            <h1 className="text-3xl font-semibold tracking-tight">HITLy Cloud is not open yet</h1>
            <p className="mt-3 text-zinc-600 dark:text-zinc-400">
              Join the waitlist to be notified when the hosted inbox is ready.
            </p>
          </div>
          <WaitlistForm />
          <p className="text-center text-sm text-zinc-500">
            <a
              href="https://hitly.net"
              className="underline underline-offset-2 hover:text-zinc-800 dark:hover:text-zinc-300"
            >
              Learn more about HITLy
            </a>
          </p>
        </div>
      </main>
    </div>
  )
}
