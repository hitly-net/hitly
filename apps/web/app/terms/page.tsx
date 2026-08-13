import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome'

export const metadata = { title: 'Terms' }

export default function TermsPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-3xl flex-1 px-6 py-16">
        <h1 className="text-3xl font-semibold">Terms</h1>
        <p className="mt-4 text-zinc-600 dark:text-zinc-400">
          Hitly Cloud is a hosted approval inbox; you can also self-host the Apache-2.0 server.
          You are responsible for the workflows you connect and the decisions your reviewers make.
          Full terms will ship before paid plans.
        </p>
      </main>
      <SiteFooter />
    </>
  )
}
