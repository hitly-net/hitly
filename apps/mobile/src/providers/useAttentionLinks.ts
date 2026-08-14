import { useCallback, useEffect } from 'react'
import * as Linking from 'expo-linking'
import { useRouter } from 'expo-router'
import { parseAttentionLink } from '../linking'
import { useSession } from './SessionProvider'

export function useAttentionLinks() {
  const { resolveAttentionLink } = useSession()
  const router = useRouter()

  const openLink = useCallback(
    async (approvalId: string, instanceUrl?: string) => {
      const result = await resolveAttentionLink({ approvalId, instanceUrl })
      if (result === 'open') router.push(`/inbox/${approvalId}`)
      if (result === 'login') router.replace('/(auth)/login')
    },
    [resolveAttentionLink, router],
  )

  useEffect(() => {
    let mounted = true
    void Linking.getInitialURL().then((initial) => {
      if (!mounted) return
      const link = parseAttentionLink(initial)
      if (link) void openLink(link.approvalId, link.instanceUrl)
    })
    const sub = Linking.addEventListener('url', (event) => {
      const next = parseAttentionLink(event.url)
      if (next) void openLink(next.approvalId, next.instanceUrl)
    })
    return () => {
      mounted = false
      sub.remove()
    }
  }, [openLink])

  return { openLink }
}
