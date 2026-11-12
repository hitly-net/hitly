import { securityTxtResponse } from '@/lib/security-txt'

/**
 * RFC 9116 discovery file. Public: no auth, no workspace context, no
 * cookies. Served as text/plain from lib/security-txt.ts (fields built
 * from SECURITY.md contacts).
 */
export const revalidate = false

export function GET() {
  return securityTxtResponse()
}
