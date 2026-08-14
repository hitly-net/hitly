import Link from 'next/link'

const features = [
  {
    title: 'Unified review and approval',
    href: '/docs/inbox',
    body: 'Agents and workflows pause in their own runtime. Reviewers decide in Hitly — same inbox, same decisions, web or mobile. You never approve inside Mastra Studio, Hermes CLI, n8n, or LangGraph.',
  },
  {
    title: 'Every agent and workflow platform',
    href: '/integrations',
    body: 'Mastra, Hermes, and HTTP callbacks are available today. n8n Wait is an HTTP recipe. LangGraph and Temporal mappings are documented. Pause primitives stay native; Hitly owns the envelope and the resume.',
  },
  {
    title: 'Governance and org chart',
    href: '/docs/governance',
    body: 'Workspace team, project roles, SLA rules, and an audit trail. Readers watch, users decide, admins own the origin. Membership is the org chart.',
  },
]

export function FeatureBlocks() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <h2 className="text-2xl font-semibold">One surface for human decisions</h2>
      <p className="mt-2 max-w-2xl text-zinc-600 dark:text-zinc-400">
        Hitly is the review layer. Origins keep their pause primitives. Your org keeps the audit trail.
      </p>
      <div className="mt-10 grid gap-4 md:grid-cols-3">
        {features.map((feature) => (
          <Link
            key={feature.href}
            href={feature.href}
            className="rounded-xl border border-zinc-200 p-6 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
          >
            <h3 className="text-lg font-semibold">{feature.title}</h3>
            <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{feature.body}</p>
            <p className="mt-4 text-sm font-medium">Read the docs</p>
          </Link>
        ))}
      </div>
    </section>
  )
}
