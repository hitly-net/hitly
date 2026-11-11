import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  deadlineLabel,
  extractDecisionEmailContent,
  renderAddedToWorkspaceEmail,
  renderDecisionNeededEmail,
  renderEmailChangedNoticeEmail,
  renderEmailChangeVerificationEmail,
  renderInviteEmail,
  renderPasswordChangedEmail,
  renderPasswordResetEmail,
  safeText,
  type RenderedEmail,
} from '../index'

/**
 * Branded email templates: every template renders HTML + plain text, the
 * subject wording is human (never a raw tool name), and planted secrets in
 * the approval envelope/origin must never reach the output.
 */

const APP_URL = 'https://hitly.net'
const NOW = new Date('2026-11-11T12:00:00Z')

/** Values planted into inputs; their appearance in any output is a leak. */
const PLANTED = {
  cbToken: 'cb-super-secret-token-DO-NOT-LEAK',
  resumeHandle: 'resume-handle-secret-DO-NOT-LEAK',
  payloadSecret: 'payload-secret-DO-NOT-LEAK',
  apiKey: 'hitly_live_PLANTED-KEY-DO-NOT-LEAK',
  callbackUrl: 'https://callback.example.internal/cb-DO-NOT-LEAK',
}

const RAW_TOOL_NAMES = ['ask_user', 'request_approval', 'get_decision', 'list_pending']

function allText(mail: RenderedEmail): string {
  return `${mail.subject}\n${mail.text}\n${mail.html}`
}

function expectWellFormed(mail: RenderedEmail, label: string) {
  assert.ok(mail.subject.length > 0, `${label}: subject`)
  assert.ok(mail.text.includes('\n'), `${label}: multi-line text alternative`)
  assert.ok(mail.html.startsWith('<!DOCTYPE'), `${label}: full HTML document`)
  assert.ok(mail.html.includes('</html>'), `${label}: closed HTML`)
  assert.ok(mail.html.toLowerCase().includes('<table'), `${label}: table-based layout`)
  assert.ok(mail.html.includes('HITLy'), `${label}: brand name in HTML`)
  assert.ok(!RAW_TOOL_NAMES.some((name) => allText(mail).includes(name)), `${label}: no raw tool names`)
  assert.ok(!allText(mail).includes(PLANTED.cbToken), `${label}: cb_auth_token leaked`)
  assert.ok(!allText(mail).includes(PLANTED.resumeHandle), `${label}: resume handle leaked`)
  assert.ok(!allText(mail).includes(PLANTED.payloadSecret), `${label}: payload secret leaked`)
  assert.ok(!allText(mail).includes(PLANTED.apiKey), `${label}: API key leaked`)
  assert.ok(!allText(mail).includes(PLANTED.callbackUrl), `${label}: callback URL leaked`)
}

function expectBranding(html: string, label: string) {
  assert.ok(html.includes('#2563eb'), `${label}: brand colour`)
  assert.ok(html.includes('hitly.net'), `${label}: hitly.net in footer`)
  assert.ok(html.includes('you do not need to reply to this email'), `${label}: footer no-reply note`)
}

function expectButtonAndLink(mail: RenderedEmail, href: string, label: string) {
  expectBranding(mail.html, label)
  assert.ok(mail.html.includes('Open in HITLy'), `${label}: primary button`)
  assert.ok(mail.html.includes(`href="${href}"`), `${label}: button href`)
  assert.ok(mail.text.includes(href), `${label}: plain link in text alternative`)
  // Soft-pin the HTML plain-text fallback: some clients strip button styling,
  // so the raw URL must also appear as text in the HTML body (button + plain
  // link = the href appears at least twice, plus the "paste this link" hint).
  const hrefOccurrences = mail.html.split(`href="${href}"`).length - 1
  assert.ok(hrefOccurrences >= 2, `${label}: HTML must carry a plain link besides the button`)
  assert.ok(mail.html.includes('paste this link'), `${label}: plain-link hint missing from HTML`)
}

describe('decision-needed email', () => {
  const sample = {
    appUrl: APP_URL,
    approvalId: 'item-42',
    greetingName: 'Derek Colley',
    projectName: 'Website relaunch',
    envelope: {
      prompt: 'Which venue should we book for the launch?',
      // Secret-shaped fields a stored envelope may legitimately carry: the
      // renderer must never read them.
      cb_auth_token: PLANTED.cbToken,
      action: { name: 'ask_user', args: { payload: PLANTED.payloadSecret } },
      metadata: { apiKey: PLANTED.apiKey },
    },
    origin: {
      plugin: 'mcp',
      agentName: 'Weekend planner',
      cbAuthToken: PLANTED.cbToken,
      resumeHandle: { token: PLANTED.resumeHandle },
      callbackUrl: PLANTED.callbackUrl,
    },
    requestedByKey: 'Release bot key',
    expiresAt: '2026-11-11T15:00:00.000Z',
    now: NOW,
  }

  it('renders HTML + text with question, project, who asked and deadline', async () => {
    const mail = await renderDecisionNeededEmail(sample)
    expectWellFormed(mail, 'decision')
    assert.equal(mail.subject, 'HITLy: Which venue should we book for the launch?')
    assert.ok(mail.text.includes('Which venue should we book for the launch?'), 'question in text')
    assert.ok(mail.text.includes('Project: Website relaunch'), 'project in text')
    assert.ok(mail.text.includes('Asked by: Weekend planner'), 'who asked in text')
    assert.ok(mail.text.includes('Deadline: Wednesday 11 November 2026 at 15:00 UTC (in about 3 hours)'), 'readable deadline')
    assert.ok(mail.html.includes('Which venue should we book for the launch?'), 'question in HTML')
    expectButtonAndLink(mail, 'https://hitly.net/inbox/item-42', 'decision')
  })

  it('falls back to the project subject when there is no question', async () => {
    const mail = await renderDecisionNeededEmail({ ...sample, envelope: {} })
    expectWellFormed(mail, 'decision-approval')
    assert.equal(mail.subject, 'HITLy: Website relaunch needs your decision')
    assert.ok(mail.text.includes('A decision is waiting for you in HITLy.'))
  })

  it('uses the project subject when the question is too long for a subject line', async () => {
    const long = `Should we go ahead? ${'explain'.repeat(30)}`
    const mail = await renderDecisionNeededEmail({ ...sample, envelope: { prompt: long } })
    expectWellFormed(mail, 'decision-long-question')
    assert.equal(mail.subject, 'HITLy: Website relaunch needs your decision')
  })

  it('escapes markup in the question instead of embedding it', async () => {
    const mail = await renderDecisionNeededEmail({
      ...sample,
      envelope: { prompt: '<script>alert(1)</script> ship it?' },
    })
    expectWellFormed(mail, 'decision-escape')
    assert.ok(!mail.html.includes('<script>alert(1)'), 'script payload escaped')
    assert.ok(mail.html.includes('&lt;script&gt;'), 'escaped markup present')
  })

  it('never renders a raw tool name even when it is the only identifier', async () => {
    const mail = await renderDecisionNeededEmail({ ...sample, projectName: null, envelope: {} })
    expectWellFormed(mail, 'decision-no-name')
    assert.equal(mail.subject, 'HITLy: a decision is waiting for you')
    assert.ok(!allText(mail).includes('ask_user'))
  })
})

describe('invite email', () => {
  const link = `${APP_URL}/invite/${'t'.repeat(43)}`

  it('renders HTML + text, keeps the one-time token only in the link', async () => {
    const mail = await renderInviteEmail({
      appUrl: APP_URL,
      workspaceName: 'Acme Studio',
      link,
      inviteeEmail: 'new.person@example.com',
      ttlDays: 7,
    })
    expectWellFormed(mail, 'invite')
    assert.equal(mail.subject, "You're invited to Acme Studio on HITLy")
    expectButtonAndLink(mail, link, 'invite')
    assert.ok(mail.text.includes('new.person@example.com'), 'invitee-scoped note')
  })
})

describe('added-to-workspace email', () => {
  it('renders HTML + text with app link', async () => {
    const mail = await renderAddedToWorkspaceEmail({ appUrl: APP_URL, workspaceName: 'Acme Studio' })
    expectWellFormed(mail, 'added')
    assert.equal(mail.subject, "You've been added to Acme Studio on HITLy")
    expectButtonAndLink(mail, APP_URL, 'added')
  })
})

describe('password-reset email', () => {
  const link = `${APP_URL}/reset-password?token=${'a'.repeat(32)}`

  it('renders HTML + text; the one-time link is the intended token carrier', async () => {
    const mail = await renderPasswordResetEmail({ appUrl: APP_URL, link })
    expectWellFormed(mail, 'reset')
    assert.equal(mail.subject, 'HITLy: Reset your password')
    expectButtonAndLink(mail, link, 'reset')
  })
})

describe('email-change verification + notice', () => {
  const link = `${APP_URL}/verify-email-change?token=${'b'.repeat(32)}`

  it('verification email carries the intended one-time link', async () => {
    const mail = await renderEmailChangeVerificationEmail({ appUrl: APP_URL, link, ttlHours: 24 })
    expectWellFormed(mail, 'email-change-verify')
    assert.equal(mail.subject, 'HITLy: Confirm your new email address')
    expectButtonAndLink(mail, link, 'email-change-verify')
    assert.ok(mail.text.includes('24 hours'))
  })

  it('changed notice is link-free (no token, no URL)', async () => {
    const mail = await renderEmailChangedNoticeEmail({ appUrl: APP_URL })
    expectWellFormed(mail, 'email-changed-notice')
    assert.equal(mail.subject, 'HITLy: Your email address was changed')
    assert.ok(!/https?:\/\//.test(mail.text), 'no link in the notice text')
    assert.ok(!/href=/.test(mail.html), 'no link in the notice HTML')
  })
})

describe('password-changed notice', () => {
  it('is link-free and mentions the session sign-out', async () => {
    const mail = await renderPasswordChangedEmail({ appUrl: APP_URL })
    expectWellFormed(mail, 'password-changed')
    assert.equal(mail.subject, 'HITLy: Your password was changed')
    assert.ok(mail.text.includes('All other sessions were signed out'))
    assert.ok(!/https?:\/\//.test(mail.text), 'no link in the notice text')
    assert.ok(!/href=/.test(mail.html), 'no link in the notice HTML')
  })
})

describe('decision content sanitiser', () => {
  it('reads only allowlisted fields from the raw bags', () => {
    const content = extractDecisionEmailContent({
      projectName: 'Website relaunch',
      envelope: {
        prompt: 'Ship now?',
        cb_auth_token: PLANTED.cbToken,
        resumeSchema: { hidden: PLANTED.payloadSecret },
      },
      origin: {
        kind: 'agent',
        cb_auth_token: PLANTED.cbToken,
        resumeHandle: { token: PLANTED.resumeHandle },
        agentName: 'Release bot',
      },
      now: NOW,
    })
    assert.equal(content.question, 'Ship now?')
    assert.equal(content.askedBy, 'Release bot')
    const bag = JSON.stringify(content)
    assert.ok(!bag.includes(PLANTED.cbToken) && !bag.includes(PLANTED.resumeHandle))
  })

  it('falls back to the project API key display name for "asked by"', () => {
    const content = extractDecisionEmailContent({
      projectName: 'P',
      envelope: {},
      origin: { plugin: 'mcp', cbAuthToken: PLANTED.cbToken },
      requestedByKey: 'CI key',
      now: NOW,
    })
    assert.equal(content.askedBy, 'CI key')
  })

  it('caps and normalises free text', () => {
    assert.equal(safeText('  a\u0000b\n\u0009c  '), 'a b c')
    assert.equal(safeText('x'.repeat(300), 10)!.length, 10)
    assert.equal(safeText('   '), null)
    assert.equal(safeText(42), null)
  })

  it('formats deadlines readably in UTC with a relative hint', () => {
    assert.equal(
      deadlineLabel('2026-11-11T15:00:00.000Z', NOW),
      'Wednesday 11 November 2026 at 15:00 UTC (in about 3 hours)',
    )
    assert.equal(deadlineLabel('2026-11-11T12:25:00.000Z', NOW), 'Wednesday 11 November 2026 at 12:25 UTC (in about 25 min)')
    assert.match(deadlineLabel('2026-11-09T12:00:00.000Z', NOW) ?? '', /may have expired$/)
    assert.equal(deadlineLabel(null, NOW), null)
    assert.equal(deadlineLabel('not-a-date', NOW), null)
  })
})
