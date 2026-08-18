import type { MailResult, ResolvedMail } from '../types'

export const sentMail: ResolvedMail[] = []

export function clearSentMail() {
  sentMail.length = 0
}

export async function sendMemory(message: ResolvedMail): Promise<MailResult> {
  sentMail.push({ ...message })
  return { delivered: true }
}
