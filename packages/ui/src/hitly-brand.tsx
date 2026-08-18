import type { SVGProps } from 'react'
import { cn } from './cn'

const SANS = 'var(--font-sans), ui-sans-serif, system-ui, sans-serif'
const SERIF = 'ui-serif, Georgia, "Times New Roman", serif'

export function HitlyWordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-semibold tracking-tight', className)} aria-label="HITLy">
      <span aria-hidden="true">
        HITL<sub className="italic text-[0.65em] leading-none">y</sub>
      </span>
    </span>
  )
}

/** HITLy wordmark icon (square tile, suitable for avatars/favicons). */
export function HitlyIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 800 800"
      role="img"
      aria-label="HITLy"
      className={cn('h-8 w-8 shrink-0', className)}
      {...props}
    >
      <rect width="800" height="800" fill="#18181b" />
      <text
        x="400"
        y="475"
        textAnchor="middle"
        fill="#fafafa"
        style={{ fontFamily: SANS, fontSize: 280, fontWeight: 700, letterSpacing: '-8px' }}
      >
        HITL
        <tspan baselineShift="sub" style={{ fontSize: '0.62em', fontStyle: 'italic', letterSpacing: 0 }}>
          y
        </tspan>
      </text>
    </svg>
  )
}
