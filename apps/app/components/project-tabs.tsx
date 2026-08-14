import Link from 'next/link'

const TABS = [
  { href: '', label: 'Items' },
  { href: '/config', label: 'Config' },
  { href: '/people', label: 'People' },
  { href: '/rules', label: 'Rules' },
  { href: '/channels', label: 'Channels' },
  { href: '/logs', label: 'Logs' },
] as const

export function ProjectTabs({ projectId, current }: { projectId: string; current: (typeof TABS)[number]['label'] }) {
  return (
    <nav className="mt-4 flex gap-4 border-b border-zinc-200 text-sm dark:border-zinc-800">
      {TABS.map((tab) => {
        const href = `/projects/${projectId}${tab.href}`
        const active = tab.label === current
        return (
          <Link
            key={tab.label}
            href={href}
            className={
              active
                ? 'border-b-2 border-zinc-900 pb-2 font-medium dark:border-zinc-100'
                : 'pb-2 text-zinc-500 hover:text-zinc-900'
            }
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
