import { SiteFooter, SiteHeader } from '@/components/marketing/site-chrome'

export const metadata = { title: 'Privacy' }

export default function PrivacyPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-3xl flex-1 px-6 py-16">
        <h1 className="text-3xl font-semibold">Privacy</h1>
        <p className="mt-4 text-zinc-600 dark:text-zinc-400">
          HITLy stores approval envelopes, decisions, and workspace membership so we can resume origin
          workflows. We do not train models on your payloads. This page will be replaced with a full
          policy before launch.
        </p>
      </main>
      <SiteFooter />
    </>
  )
}
