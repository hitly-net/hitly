import type { ReactNode } from 'react'
import { Body, Button, Column, Container, Head, Hr, Html, Img, Link, Preview, Row, Section, Text } from '@react-email/components'
import {
  BORDER_COLOR,
  BRAND_COLOR,
  FOOTER_SENT_BY,
  HITLY_NAME,
  HITLY_SITE_URL,
  HITLY_TAGLINE,
  INK_COLOR,
  LOGO_ALT,
  MUTED_COLOR,
  SURFACE_COLOR,
  logoUrl,
} from './brand'

export const EMAIL_FONT_STACK =
  '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif'

export type EmailLayoutProps = {
  /** Public app origin, e.g. https://hitly.net — used for the logo and footer links. */
  appUrl: string
  /** Inbox preview text (hidden in the email body). */
  preview: string
  /** One-line reason the recipient got this email, e.g. "You are a reviewer in this project." */
  footerContext?: string | null
  /**
   * Security notices render fully link-free (no logo image, no footer URL):
   * the same "no links at all" guarantee the old plain-text notices carried,
   * asserted by tests, so a notice can never be used to lure a click.
   */
  linksDisabled?: boolean
  children: ReactNode
}

/**
 * Shared HITLy email shell: logo header (hosted from the app's own origin,
 * no third-party assets), a single-column card, one brand colour, and a
 * footer. Everything is table-based via React Email so Gmail, Outlook
 * (desktop + web) and Apple Mail render the same layout.
 */
export function EmailLayout(props: EmailLayoutProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{props.preview}</Preview>
      <Body style={{ backgroundColor: SURFACE_COLOR, margin: 0, padding: '24px 12px', fontFamily: EMAIL_FONT_STACK }}>
        <Container
          style={{
            maxWidth: '560px',
            margin: '0 auto',
            backgroundColor: '#ffffff',
            border: `1px solid ${BORDER_COLOR}`,
            borderRadius: '10px',
            overflow: 'hidden',
          }}
        >
          <Section style={{ padding: '20px 32px' }}>
            <Row>
              <Column align="left">
                {props.linksDisabled ? (
                  <Text
                    style={{
                      margin: 0,
                      fontSize: '18px',
                      fontWeight: 700,
                      color: BRAND_COLOR,
                      fontFamily: EMAIL_FONT_STACK,
                    }}
                  >
                    {LOGO_ALT}
                  </Text>
                ) : (
                  <Link href={props.appUrl} style={{ textDecoration: 'none' }}>
                    <Img
                      src={logoUrl(props.appUrl)}
                      alt={LOGO_ALT}
                      title={HITLY_NAME}
                      width={32}
                      height={32}
                      style={{ display: 'block', borderRadius: '6px' }}
                    />
                  </Link>
                )}
              </Column>
            </Row>
          </Section>
          <Hr style={{ borderColor: BORDER_COLOR, margin: '0 32px' }} />
          <Section style={{ padding: '24px 32px', color: INK_COLOR, fontSize: '15px', lineHeight: '22px' }}>
            {props.children}
          </Section>
          <Hr style={{ borderColor: BORDER_COLOR, margin: '0 32px' }} />
          <Section style={{ padding: '20px 32px 28px' }}>
            <Text style={{ margin: '0 0 6px', fontSize: '12px', lineHeight: '18px', color: MUTED_COLOR }}>
              {HITLY_NAME} — {HITLY_TAGLINE}
              {props.footerContext ? ` ${props.footerContext}` : ''}
            </Text>
            <Text style={{ margin: 0, fontSize: '12px', lineHeight: '18px', color: MUTED_COLOR }}>
              {FOOTER_SENT_BY}{' '}
              {props.linksDisabled ? (
                HITLY_SITE_URL.replace('https://', '')
              ) : (
                <Link href={HITLY_SITE_URL} style={{ color: BRAND_COLOR, textDecoration: 'none' }}>
                  {HITLY_SITE_URL.replace('https://', '')}
                </Link>
              )}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

/** The primary call-to-action, plus (in each template) a plain-text link. */
export function OpenInHitlyButton({ href }: { href: string }) {
  return (
    <Section style={{ margin: '24px 0 12px' }}>
      <Button
        href={href}
        style={{
          backgroundColor: BRAND_COLOR,
          borderRadius: '8px',
          color: '#ffffff',
          display: 'inline-block',
          fontSize: '15px',
          fontWeight: 600,
          lineHeight: '20px',
          padding: '12px 22px',
          textDecoration: 'none',
        }}
      >
        Open in HITLy
      </Button>
    </Section>
  )
}

/** Meta row label (Project / Asked by / Deadline …). */
export function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <Row>
      <Column width={110} style={{ color: MUTED_COLOR, fontSize: '14px', paddingBottom: '6px' }}>
        {label}
      </Column>
      <Column style={{ color: INK_COLOR, fontSize: '14px', fontWeight: 600, paddingBottom: '6px' }}>{value}</Column>
    </Row>
  )
}
