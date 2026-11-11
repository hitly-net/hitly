import type { ReactElement, ReactNode } from 'react'
import { Link, Section, Text } from '@react-email/components'
import { render } from '@react-email/render'
import { BRAND_COLOR, HITLY_NAME, MUTED_COLOR } from './brand'
import { EMAIL_FONT_STACK, EmailLayout, MetaRow, OpenInHitlyButton } from './layout'
import { extractDecisionEmailContent, type DecisionEmailContent } from './decision-content'

export type RenderedEmail = { subject: string; text: string; html: string }

const TEXT_FOOTER_SEPARATOR = '\n-- \n'

function textFooter(context?: string | null, options?: { noLink?: boolean }): string {
  const lines = [`${HITLY_NAME} — Human decisions for your agents.`]
  if (context) lines.push(context)
  lines.push('You do not need to reply to this email.')
  if (!options?.noLink) lines.push('https://hitly.net')
  return TEXT_FOOTER_SEPARATOR + lines.join('\n') + '\n'
}

function PlainLink({ href }: { href: string }) {
  return (
    <Text style={{ margin: '4px 0 0', fontSize: '13px', lineHeight: '20px', wordBreak: 'break-all' }}>
      or paste this link into your browser:{' '}
      <Link href={href} style={{ color: BRAND_COLOR, textDecoration: 'none' }}>
        {href}
      </Link>
    </Text>
  )
}

function Body({ children }: { children: ReactNode }) {
  return <Section style={{ fontFamily: EMAIL_FONT_STACK }}>{children}</Section>
}

// ---------------------------------------------------------------------------
// Decision needed (ask / approval)
// ---------------------------------------------------------------------------

export type DecisionNeededArgs = {
  appUrl: string
  approvalId: string
  greetingName?: string | null
  projectName?: string | null
  envelope?: Record<string, unknown> | null
  origin?: Record<string, unknown> | null
  requestedByKey?: string | null
  expiresAt?: Date | string | null
  now?: Date
}

function decisionLink(appUrl: string, approvalId: string): string {
  return new URL(`/inbox/${encodeURIComponent(approvalId)}`, appUrl).toString()
}

function headline(content: DecisionEmailContent): string {
  return content.question ?? 'A decision is waiting for you in HITLy.'
}

function DecisionNeededView({
  appUrl,
  link,
  greetingName,
  content,
}: {
  appUrl: string
  link: string
  greetingName?: string | null
  content: DecisionEmailContent
}) {
  return (
    <EmailLayout appUrl={appUrl} preview={headline(content)} footerContext="You are the reviewer we sent this to.">
      <Body>
        <Text style={{ margin: '0 0 14px' }}>Hi{greetingName ? ` ${greetingName}` : ''},</Text>
        <Text style={{ margin: '0 0 16px', fontSize: '17px', lineHeight: '24px', fontWeight: 600 }}>
          {headline(content)}
        </Text>
        <Section>
          {content.projectName ? <MetaRow label="Project" value={content.projectName} /> : null}
          {content.askedBy ? <MetaRow label="Asked by" value={content.askedBy} /> : null}
          {content.deadlineLabel ? <MetaRow label="Deadline" value={content.deadlineLabel} /> : null}
        </Section>
        <OpenInHitlyButton href={link} />
        <PlainLink href={link} />
      </Body>
    </EmailLayout>
  )
}

export async function renderDecisionNeededEmail(args: DecisionNeededArgs): Promise<RenderedEmail> {
  const content = extractDecisionEmailContent(args)
  const link = decisionLink(args.appUrl, args.approvalId)
  const html = await render(
    <DecisionNeededView appUrl={args.appUrl} link={link} greetingName={args.greetingName} content={content} />,
  )
  const lines = [`Hi${args.greetingName ? ` ${args.greetingName}` : ''},`, '', headline(content), '']
  if (content.projectName) lines.push(`Project: ${content.projectName}`)
  if (content.askedBy) lines.push(`Asked by: ${content.askedBy}`)
  if (content.deadlineLabel) lines.push(`Deadline: ${content.deadlineLabel}`)
  lines.push('', 'Open in HITLy:', link, '')
  return { subject: content.subject, text: lines.join('\n') + textFooter(), html }
}

// ---------------------------------------------------------------------------
// Workspace invite
// ---------------------------------------------------------------------------

export type InviteEmailArgs = {
  appUrl: string
  workspaceName: string
  /** One-time accept link (the invite token). The only place a token appears. */
  link: string
  inviteeEmail: string
  ttlDays: number
}

function InviteView({ appUrl, workspaceName, link }: { appUrl: string; workspaceName: string; link: string }) {
  return (
    <EmailLayout appUrl={appUrl} preview={`You're invited to join ${workspaceName} on HITLy.`} footerContext={`You were invited to ${workspaceName}.`}>
      <Body>
        <Text style={{ margin: '0 0 14px' }}>Hi,</Text>
        <Text style={{ margin: '0 0 16px', fontSize: '17px', lineHeight: '24px', fontWeight: 600 }}>
          You've been invited to join {workspaceName} on HITLy.
        </Text>
        <Text style={{ margin: '0 0 8px' }}>
          Accept the invite to create an account for this email address, or sign in if you already have one.
        </Text>
        <OpenInHitlyButton href={link} />
        <PlainLink href={link} />
      </Body>
    </EmailLayout>
  )
}

export async function renderInviteEmail(args: InviteEmailArgs): Promise<RenderedEmail> {
  const html = await render(
    <InviteView appUrl={args.appUrl} workspaceName={args.workspaceName} link={args.link} />,
  )
  const text = [
    'Hi,',
    '',
    `You've been invited to join ${args.workspaceName} on HITLy.`,
    '',
    'Open this link to accept. You can create an account for this email address, or sign in if you already have one:',
    '',
    args.link,
    '',
    `This invite is for ${args.inviteeEmail} only, can be used once, and expires in ${args.ttlDays} days.`,
    'If you were not expecting it, you can ignore this email.',
    '',
  ].join('\n')
  return {
    subject: `You're invited to ${args.workspaceName} on HITLy`,
    text: text + textFooter(`You were invited to ${args.workspaceName}.`),
    html,
  }
}

// ---------------------------------------------------------------------------
// Added to workspace (existing account, no token)
// ---------------------------------------------------------------------------

export type AddedToWorkspaceArgs = { appUrl: string; workspaceName: string }

function AddedToWorkspaceView({ appUrl, workspaceName }: { appUrl: string; workspaceName: string }) {
  return (
    <EmailLayout appUrl={appUrl} preview={`You've been added to ${workspaceName} on HITLy.`} footerContext={`You were added to ${workspaceName}.`}>
      <Body>
        <Text style={{ margin: '0 0 14px' }}>Hi,</Text>
        <Text style={{ margin: '0 0 16px', fontSize: '17px', lineHeight: '24px', fontWeight: 600 }}>
          You've been added to {workspaceName} on HITLy.
        </Text>
        <Text style={{ margin: '0 0 8px' }}>Sign in to see the projects you can work on.</Text>
        <OpenInHitlyButton href={appUrl} />
        <PlainLink href={appUrl} />
      </Body>
    </EmailLayout>
  )
}

export async function renderAddedToWorkspaceEmail(args: AddedToWorkspaceArgs): Promise<RenderedEmail> {
  const html = await render(<AddedToWorkspaceView appUrl={args.appUrl} workspaceName={args.workspaceName} />)
  const text = [
    'Hi,',
    '',
    `You've been added to ${args.workspaceName} on HITLy.`,
    '',
    'Sign in to get started:',
    '',
    args.appUrl,
    '',
  ].join('\n')
  return {
    subject: `You've been added to ${args.workspaceName} on HITLy`,
    text: text + textFooter(`You were added to ${args.workspaceName}.`),
    html,
  }
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

export type PasswordResetArgs = { appUrl: string; link: string; ttlHours?: number }

function PasswordResetView({ appUrl, link, ttlMinutes }: { appUrl: string; link: string; ttlMinutes: number }) {
  return (
    <EmailLayout
      appUrl={appUrl}
      preview="Reset your HITLy password"
      footerContext="You (or someone else) asked to reset the password for your HITLy account."
    >
      <Body>
        <Text style={{ margin: '0 0 14px' }}>Hi,</Text>
        <Text style={{ margin: '0 0 16px', fontSize: '17px', lineHeight: '24px', fontWeight: 600 }}>
          Someone asked to reset the password for your HITLy account.
        </Text>
        <Text style={{ margin: '0 0 8px' }}>
          Choose a new password with the button below. The link expires in {ttlMinutes} minutes. If you did not ask
          for this, you can ignore this email — your password stays unchanged.
        </Text>
        <OpenInHitlyButton href={link} />
        <PlainLink href={link} />
      </Body>
    </EmailLayout>
  )
}

export async function renderPasswordResetEmail(args: PasswordResetArgs): Promise<RenderedEmail> {
  const ttlMinutes = args.ttlHours === undefined ? 60 : Math.round(args.ttlHours * 60)
  const html = await render(<PasswordResetView appUrl={args.appUrl} link={args.link} ttlMinutes={ttlMinutes} />)
  const text = [
    'Someone asked to reset the password for your HITLy account.',
    '',
    `Open this link to choose a new password (it expires in ${ttlMinutes} minutes):`,
    '',
    args.link,
    '',
    'If you did not ask for this, you can ignore this email.',
    '',
  ].join('\n')
  return {
    subject: 'HITLy: Reset your password',
    text: text + textFooter('You (or someone else) asked to reset the password for your HITLy account.'),
    html,
  }
}

// ---------------------------------------------------------------------------
// Email change: verification (new address) + notice (old address)
// ---------------------------------------------------------------------------

export type EmailChangeVerifyArgs = { appUrl: string; link: string; ttlHours: number }

function EmailChangeVerifyView({ appUrl, link, ttlHours }: { appUrl: string; link: string; ttlHours: number }) {
  return (
    <EmailLayout
      appUrl={appUrl}
      preview="Confirm your new email address"
      footerContext="Someone asked to use this address for a HITLy account."
    >
      <Body>
        <Text style={{ margin: '0 0 14px' }}>Hi,</Text>
        <Text style={{ margin: '0 0 16px', fontSize: '17px', lineHeight: '24px', fontWeight: 600 }}>
          Someone asked to use this address for a HITLy account.
        </Text>
        <Text style={{ margin: '0 0 8px' }}>
          Confirm the change with the button below. The link expires in {ttlHours} hours. If you did not ask for
          this, you can ignore this email — your account keeps its current address.
        </Text>
        <OpenInHitlyButton href={link} />
        <PlainLink href={link} />
      </Body>
    </EmailLayout>
  )
}

export async function renderEmailChangeVerificationEmail(args: EmailChangeVerifyArgs): Promise<RenderedEmail> {
  const html = await render(
    <EmailChangeVerifyView appUrl={args.appUrl} link={args.link} ttlHours={args.ttlHours} />,
  )
  const text = [
    'Someone asked to use this address for a HITLy account.',
    '',
    `Open this link to confirm the change (it expires in ${args.ttlHours} hours):`,
    '',
    args.link,
    '',
    'If you did not ask for this, you can ignore this email.',
    '',
  ].join('\n')
  return {
    subject: 'HITLy: Confirm your new email address',
    text: text + textFooter('Someone asked to use this address for a HITLy account.'),
    html,
  }
}

export type SecurityNoticeArgs = { appUrl: string }

function SecurityNoticeView({ appUrl, headlineText, body }: { appUrl: string; headlineText: string; body: ReactNode }) {
  return (
    <EmailLayout
      appUrl={appUrl}
      preview={headlineText}
      footerContext="This is a security notice about your HITLy account."
      linksDisabled
    >
      <Body>
        <Text style={{ margin: '0 0 14px' }}>Hi,</Text>
        <Text style={{ margin: '0 0 16px', fontSize: '17px', lineHeight: '24px', fontWeight: 600 }}>{headlineText}</Text>
        {body}
        <Text style={{ margin: '16px 0 0', fontSize: '13px', color: MUTED_COLOR }}>
          If this was not you, reset your password immediately from the HITLy sign-in page.
        </Text>
      </Body>
    </EmailLayout>
  )
}

export async function renderEmailChangedNoticeEmail(args: SecurityNoticeArgs): Promise<RenderedEmail> {
  const html = await render(
    <SecurityNoticeView
      appUrl={args.appUrl}
      headlineText="The email address for your HITLy account was changed."
      body={
        <Text style={{ margin: 0 }}>
          This is a confirmation email. It carries no link or code — nothing else to do unless this was not you.
        </Text>
      }
    />,
  )
  const text = [
    'The email address for your HITLy account was changed.',
    '',
    'If this was not you, reset your password immediately from the HITLy sign-in page.',
    '',
  ].join('\n')
  return {
    subject: 'HITLy: Your email address was changed',
    // Security notice: no links at all, in the text or the HTML.
    text: text + textFooter('This is a security notice about your HITLy account.', { noLink: true }),
    html,
  }
}

export async function renderPasswordChangedEmail(args: SecurityNoticeArgs): Promise<RenderedEmail> {
  const html = await render(
    <SecurityNoticeView
      appUrl={args.appUrl}
      headlineText="The password for your HITLy account was changed."
      body={
        <Text style={{ margin: 0 }}>
          All other sessions were signed out; this device stays signed in. This email carries no link or code.
        </Text>
      }
    />,
  )
  const text = [
    'The password for your HITLy account was changed.',
    '',
    'All other sessions were signed out; this device stays signed in.',
    '',
    'If this was not you, reset your password immediately from the HITLy sign-in page.',
    '',
  ].join('\n')
  return {
    subject: 'HITLy: Your password was changed',
    // Security notice: no links at all, in the text or the HTML.
    text: text + textFooter('This is a security notice about your HITLy account.', { noLink: true }),
    html,
  }
}
