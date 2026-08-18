import type { SVGProps } from 'react'
import { cn } from './cn'

const SANS = 'var(--font-sans), ui-sans-serif, system-ui, sans-serif'

export function HitlyWordmark({ className, trademark }: { className?: string; trademark?: boolean }) {
  return (
    <span className={cn('font-semibold tracking-tight', className)} aria-label={trademark ? 'HITLy™' : 'HITLy'}>
      <span aria-hidden="true">
        HITL<sub className="italic text-[0.65em] leading-none">y</sub>
        {trademark && <span>™</span>}
      </span>
    </span>
  )
}

/** HITLy H-slash mark (square tile, suitable for avatars/favicons). */
export function HitlyIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      role="img"
      aria-label="HITLy"
      className={cn('h-8 w-8 shrink-0', className)}
      {...props}
    >
      <rect width="512" height="512" fill="#18181b" />
      <path d="M88,56 L168,56 L168,216 L328,216 L328,56 L408,56 L408,456 L328,456 L328,296 L168,296 L168,456 L88,456 Z" fill="#fafafa"/>
      <line x1="318" y1="418" x2="428" y2="318" stroke="#fafafa" strokeWidth="48" strokeLinecap="round"/>
    </svg>
  )
}
