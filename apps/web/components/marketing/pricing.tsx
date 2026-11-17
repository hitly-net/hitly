'use client'

import Link from 'next/link'
import { useState } from 'react'
import { APP_URL } from '@/lib/layout.shared'
import {
  PRICING_CONTACT_EMAIL,
  PRICING_CURRENCIES,
  PRICING_INTERVALS,
  PRICING_TIERS,
  PRICING_VAT_NOTE,
  decisionsLabel,
  priceDisplay,
  priceNoteFor,
  priceSuffixFor,
  retentionDisplayFor,
  seatsLabel,
  type PricingCurrency,
  type PricingInterval,
  type PricingTier,
} from '@hitly/core'

/**
 * One pricing card. Every displayed value is derived from the shared pricing
 * config (@hitly/core pricing.ts) — nothing here may be hard-coded; the
 * render test pins each card to the config.
 */
export function PricingCard({
  tier,
  currency,
  interval,
}: {
  tier: PricingTier
  currency: PricingCurrency
  interval: PricingInterval
}) {
  const contactHref = `mailto:${PRICING_CONTACT_EMAIL}?subject=${encodeURIComponent(
    `HITLy ${tier.label}`,
  )}`
  const note = priceNoteFor(tier.id, interval)
  return (
    <div className="flex flex-col rounded-xl border border-zinc-200 p-6 dark:border-zinc-800">
      <p className="text-sm text-zinc-500">{tier.label}</p>
      <p className="mt-2 text-3xl font-semibold">
        {priceDisplay(tier.id, interval, currency)}
        {priceSuffixFor(tier.id, interval) ? (
          <span className="text-base font-normal text-zinc-500">
            {' '}
            {priceSuffixFor(tier.id, interval)}
          </span>
        ) : null}
      </p>
      {note ? <p className="mt-1 text-xs text-zinc-500">{note}</p> : null}
      <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">{tier.tagline}</p>
      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-zinc-500">Decisions / month</dt>
          <dd className="font-medium">{decisionsLabel(tier.limits)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-zinc-500">Seats</dt>
          <dd className="font-medium">{seatsLabel(tier.limits)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-zinc-500">Retention</dt>
          <dd className="font-medium">{retentionDisplayFor(tier)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-zinc-500">SSO</dt>
          <dd className="font-medium">{tier.ssoLabel}</dd>
        </div>
      </dl>
      <div className="mt-6">
        {tier.id === 'solo' || tier.purchasable ? (
          <Link
            href={`${APP_URL}/signup`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            {tier.cta}
          </Link>
        ) : (
          <a
            href={contactHref}
            className="inline-block rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-700"
          >
            {tier.cta}
          </a>
        )}
      </div>
    </div>
  )
}

/** The four pricing cards for one currency + interval combination. */
export function PricingCards({
  currency,
  interval,
}: {
  currency: PricingCurrency
  interval: PricingInterval
}) {
  return (
    <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {PRICING_TIERS.map((tier) => (
        <PricingCard key={tier.id} tier={tier} currency={currency} interval={interval} />
      ))}
    </div>
  )
}

export function PricingTable() {
  const [currency, setCurrency] = useState<PricingCurrency>('gbp')
  const [interval, setInterval] = useState<PricingInterval>('monthly')

  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <h2 className="text-2xl font-semibold">Pricing</h2>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div
          role="group"
          aria-label="Currency"
          className="inline-flex overflow-hidden rounded-md border border-zinc-300 text-sm dark:border-zinc-700"
        >
          {PRICING_CURRENCIES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={currency === option}
              onClick={() => setCurrency(option)}
              className={`px-3 py-1.5 font-medium ${
                currency === option
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'text-zinc-600 dark:text-zinc-400'
              }`}
            >
              {option.toUpperCase()}
            </button>
          ))}
        </div>
        <div
          role="group"
          aria-label="Billing period"
          className="inline-flex overflow-hidden rounded-md border border-zinc-300 text-sm dark:border-zinc-700"
        >
          {PRICING_INTERVALS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={interval === option}
              onClick={() => setInterval(option)}
              className={`px-3 py-1.5 font-medium ${
                interval === option
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'text-zinc-600 dark:text-zinc-400'
              }`}
            >
              {option === 'monthly' ? 'Monthly' : 'Annual'}
            </button>
          ))}
        </div>
      </div>
      <PricingCards currency={currency} interval={interval} />
      <p className="mt-4 text-sm text-zinc-500">{PRICING_VAT_NOTE}</p>
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
