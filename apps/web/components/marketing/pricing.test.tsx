/**
 * Render test for the marketing pricing component.
 *
 * Every displayed value (prices in both currencies and both intervals,
 * decisions, seats, retention, SSO, CTA per tier, and the "Free" display
 * label for plan id `solo`) is pinned to the shared pricing config in
 * @hitly/core. Expected strings are computed from the config, and the
 * component source is scanned for hard-coded price/limit literals, so
 * re-introducing a hard-coded value into this component fails this test.
 *
 * Run with: yarn workspace @hitly/web test
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
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
} from '@hitly/core'
import { APP_URL } from '@/lib/layout.shared'
import { PricingCard, PricingCards, PricingTable } from './pricing'

// Components under @hitly/core consumers are compiled outside this app's
// tsconfig when run under tsx, with the classic JSX runtime.
Object.assign(globalThis, { React })

function renderCards(currency: 'gbp' | 'usd', interval: 'monthly' | 'annual') {
  return renderToStaticMarkup(
    React.createElement(PricingCards, { currency, interval }),
  )
}

function renderCard(
  tier: (typeof PRICING_TIERS)[number],
  currency: 'gbp' | 'usd',
  interval: 'monthly' | 'annual',
) {
  return renderToStaticMarkup(
    React.createElement(PricingCard, { tier, currency, interval }),
  )
}

function reEscape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

for (const currency of PRICING_CURRENCIES) {
  for (const interval of PRICING_INTERVALS) {
    test(`pricing cards render every config value (${currency}, ${interval})`, () => {
      const markup = renderCards(currency, interval)
      for (const tier of PRICING_TIERS) {
        const price = priceDisplay(tier.id, interval, currency)
        const suffix = priceSuffixFor(tier.id, interval)
        const note = priceNoteFor(tier.id, interval)
        const expected = [
          tier.label,
          price,
          ...(suffix ? [suffix] : []),
          ...(note ? [note] : []),
          tier.tagline,
          decisionsLabel(tier.limits),
          seatsLabel(tier.limits),
          retentionDisplayFor(tier),
          tier.ssoLabel,
          tier.cta,
        ]
        for (const value of expected) {
          assert.ok(
            markup.includes(value),
            `expected ${currency}/${interval} markup to contain "${value}" for tier ${tier.id}`,
          )
        }
      }
    })
  }
}

test('each card pins its labelled Seats, Decisions and Retention cells (per card)', () => {
  // Cell-level pins scoped to a single card: a wrong field, a constant, a
  // missing cell, or another tier's value in a cell fails the regex for
  // that card (a whole-page includes() of "10"/"3"/etc. matches elsewhere).
  for (const currency of PRICING_CURRENCIES) {
    for (const interval of PRICING_INTERVALS) {
      for (const tier of PRICING_TIERS) {
        const card = renderCard(tier, currency, interval)
        const cells: Array<[string, string]> = [
          ['Decisions / month', decisionsLabel(tier.limits)],
          ['Seats', seatsLabel(tier.limits)],
          ['Retention', retentionDisplayFor(tier)],
        ]
        for (const [label, value] of cells) {
          const pattern = new RegExp(
            `>${reEscape(label)}</dt><dd[^>]*>${reEscape(value)}</dd>`,
          )
          assert.ok(
            pattern.test(card),
            `${tier.id} card (${currency}/${interval}) must render <dt>${label}</dt><dd>${value}</dd>`,
          )
        }
      }
    }
  }
})

test('CTA destinations: Free/Pro go to signup, Team/Enterprise go to the contact mailto', () => {
  for (const tier of PRICING_TIERS) {
    const card = renderCard(tier, 'gbp', 'monthly')
    if (tier.id === 'solo' || tier.id === 'pro') {
      // Self-serve tiers link to signup, never to the contact mailbox.
      assert.ok(
        card.includes(`href="${APP_URL}/signup"`),
        `${tier.id} CTA must link to ${APP_URL}/signup`,
      )
      assert.ok(
        !card.includes('mailto:'),
        `${tier.id} CTA must not be a contact mailto`,
      )
    } else {
      // Contact-only tiers link to the shared contact address with the
      // tier's subject, never to signup.
      assert.ok(
        card.includes(`href="mailto:${PRICING_CONTACT_EMAIL}?subject=`),
        `${tier.id} CTA must be a mailto to ${PRICING_CONTACT_EMAIL}`,
      )
      assert.ok(
        card.includes(encodeURIComponent(`HITLy ${tier.label}`)),
        `${tier.id} mailto subject must name the tier`,
      )
      assert.ok(
        !card.includes(`${APP_URL}/signup`),
        `${tier.id} CTA must not link to signup`,
      )
    }
    // The CTA label is inside the linked element.
    assert.ok(
      /<a [^>]*href="[^"]+"[^>]*>[^<]*</.test(card) && card.includes(`>${tier.cta}</a>`),
      `${tier.id} CTA text "${tier.cta}" must be the link label`,
    )
  }
})

test('pricing cards show "Free" for plan id solo and never label a plan Solo', () => {
  const markup = renderCards('gbp', 'monthly')
  assert.ok(markup.includes('>Free<'), 'Free label must be displayed')
  // The Pro tagline legitimately mentions "Solo builders"; no plan may be
  // *labelled* Solo.
  assert.ok(!/>Solo</.test(markup), 'no plan may be labelled Solo')
})

test('pricing table renders toggles, the VAT note and the default view', () => {
  const markup = renderToStaticMarkup(React.createElement(PricingTable))
  assert.ok(markup.includes('GBP'))
  assert.ok(markup.includes('USD'))
  assert.ok(markup.includes('Monthly'))
  assert.ok(markup.includes('Annual'))
  assert.ok(markup.includes(PRICING_VAT_NOTE))
  // Default toggle state is GBP + monthly, so the Pro monthly GBP price shows.
  assert.ok(markup.includes(priceDisplay('pro', 'monthly', 'gbp')))
})

test('component source contains no hard-coded prices or limits', () => {
  const source = readFileSync(join(import.meta.dirname, 'pricing.tsx'), 'utf-8')
  const forbidden = [
    '£15', '£19', '$15', '$19',
    '£144', '$180',
    '£65', '£79', '£624', '$756',
    '£750', '$950',
    '£29', '$29', '£99', '$99',
    '2,500', '20,000', '2500', '20000',
    '300 decisions', '5k approvals', '100 approvals',
  ]
  for (const literal of forbidden) {
    assert.ok(
      !source.includes(literal),
      `pricing.tsx must not hard-code "${literal}" — read it from @hitly/core pricing config`,
    )
  }
})
