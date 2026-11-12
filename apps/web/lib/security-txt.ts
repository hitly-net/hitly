/**
 * RFC 9116 security policy discovery file, served publicly at
 * /.well-known/security.txt on the marketing site (hitly.net).
 *
 * The fields are the public contacts from the repo's SECURITY.md: private
 * reporting through GitHub security advisories, the policy document link,
 * and the acknowledgment expectation stated there.
 *
 * `Expires` follows the RFC's guidance to not set horizons far in the
 * future: it is refreshed with the SECURITY.md review (roughly yearly) in
 * the same way the other discovery files are maintained.
 */

const SECURITY_POLICY_URL = 'https://github.com/hitly-net/hitly/blob/main/SECURITY.md'
const ADVISORY_CONTACT_URL = 'https://github.com/hitly-net/hitly/security/advisories/new'
const CANONICAL_URL = 'https://hitly.net/.well-known/security.txt'
/** RFC 9116 §4.4 — refresh before this date (kept ~1 year ahead). */
export const SECURITY_TXT_EXPIRES = '2027-11-12T00:00:00.000Z'

export function buildSecurityTxt(): string {
  return [
    `Contact: ${ADVISORY_CONTACT_URL}`,
    `Expires: ${SECURITY_TXT_EXPIRES}`,
    `Policy: ${SECURITY_POLICY_URL}`,
    'Preferred-Languages: en',
    `Canonical: ${CANONICAL_URL}`,
    '',
  ].join('\r\n')
}

export function securityTxtResponse(): Response {
  return new Response(buildSecurityTxt(), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  })
}
