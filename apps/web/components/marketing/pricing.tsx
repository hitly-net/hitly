import Link from 'next/link'
import { APP_URL } from '@/lib/layout.shared'

const plans = [
  {
    name: 'Solo',
    price: 'Free',
    body: 'Personal hosted inbox, 100 approvals / month, 30 day audit retention.',
  },
  {
    name: 'Pro',
    price: '$29 / month',
    body: 'Higher volume, 5k approvals / month, a year of audit retention.',
  },
  {
    name: 'Team',
    price: '$99 / month',
    body: 'Shared workspace, 5k approvals / month, a year of audit retention.',
  },
  {
    name: 'Enterprise',
    price: 'Contact',
    body: 'Unlimited usage, longer retention, and domain SSO later. Talk to us.',
  },
]

export function PricingTable() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <h2 className="text-2xl font-semibold">Pricing</h2>
      <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {plans.map((plan) => (
          <div key={plan.name} className="rounded-xl border border-zinc-200 p-6 dark:border-zinc-800">
            <p className="text-sm text-zinc-500">{plan.name}</p>
            <p className="mt-2 text-3xl font-semibold">{plan.price}</p>
            <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">{plan.body}</p>
          </div>
        ))}
      </div>
      <Link
        href={`${APP_URL}/signup`}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-8 inline-block text-sm font-medium underline"
      >
        Start on Solo →
      </Link>
      <p className="mt-4 text-sm text-zinc-500">
        Self-host the Apache-2.0 server with no usage caps. Cloud plans above are for hitly.net.
      </p>
    </section>
  )
}

export function CtaBanner() {
  return (
    <section className="border-t border-zinc-200 bg-zinc-900 py-16 text-white dark:border-zinc-800">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-6 md:flex-row md:items-center">
        <div>
          <h2 className="text-2xl font-semibold">Put a human on the risky step.</h2>
          <p className="mt-2 text-zinc-300">Create a workspace and wire Mastra in about ten minutes.</p>
        </div>
        <Link
          href={`${APP_URL}/signup`}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md bg-white px-5 py-2.5 text-sm font-medium text-zinc-900"
        >
          Get started
        </Link>
      </div>
    </section>
  )
}
