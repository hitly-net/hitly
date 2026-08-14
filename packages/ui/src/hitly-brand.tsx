import type { SVGProps } from 'react'
import { cn } from './cn'

const SANS = 'var(--font-sans), ui-sans-serif, system-ui, sans-serif'
const SERIF = 'ui-serif, Georgia, "Times New Roman", serif'

export function HitlyWordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-semibold tracking-tight', className)} aria-label="Hitly">
      <span aria-hidden="true">
        HITL<sub className="italic text-[0.65em] leading-none">y</sub>
      </span>
    </span>
  )
}

/** Square lockup: HUMAN / in the / LOOP, widths forced so the block fills a square. */
export function HitlyMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      role="img"
      aria-label="Hitly"
      className={cn('h-8 w-8 shrink-0', className)}
      {...props}
    >
      <rect width="64" height="64" rx="12" fill="#18181b" />
      <text
        x="32"
        y="23"
        textAnchor="middle"
        textLength="50"
        lengthAdjust="spacingAndGlyphs"
        fill="#fafafa"
        style={{ fontFamily: SANS, fontSize: 12, fontWeight: 800, fontStretch: 'condensed' }}
      >
        HUMAN
      </text>
      <text
        x="32"
        y="36"
        textAnchor="middle"
        fill="#fafafa"
        style={{ fontFamily: SERIF, fontSize: 9, fontStyle: 'italic', fontWeight: 500 }}
      >
        in the
      </text>
      <text
        x="32"
        y="53"
        textAnchor="middle"
        textLength="50"
        lengthAdjust="spacingAndGlyphs"
        fill="#fafafa"
        style={{ fontFamily: SANS, fontSize: 16, fontWeight: 800, fontStretch: 'condensed' }}
      >
        LOOP
      </text>
    </svg>
  )
}

/** Favicon-scale H in a rounded square. */
export function HitlyH({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      role="img"
      aria-label="Hitly"
      className={cn('h-8 w-8 shrink-0', className)}
      {...props}
    >
      <rect width="32" height="32" rx="7" fill="#18181b" />
      <path fill="#fafafa" d="M8.5 7h3.6v7.2h7.8V7h3.6v18h-3.6v-7.2h-7.8V25H8.5V7z" />
    </svg>
  )
}

export function HitlyLockup({
  className,
  markClassName,
  wordmarkClassName,
}: {
  className?: string
  markClassName?: string
  wordmarkClassName?: string
}) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <HitlyMark className={markClassName} />
      <HitlyWordmark className={wordmarkClassName} />
    </span>
  )
}
