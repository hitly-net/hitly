import { useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, Text, StyleSheet } from 'react-native'
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router'
import { allowedActionsFor } from '@hitly/core'
import { colors } from '../../src/theme'
import { useSession } from '../../src/providers/SessionProvider'
import { StatusHeader } from '../../src/components/detail/StatusHeader'
import { OriginCard } from '../../src/components/detail/OriginCard'
import { ContextMarkdown } from '../../src/components/detail/ContextMarkdown'
import { ArgsBlock } from '../../src/components/detail/ArgsBlock'
import { DecisionHistory } from '../../src/components/detail/DecisionHistory'
import { DecisionBar } from '../../src/components/detail/DecisionBar'
import { RetryResumeButton } from '../../src/components/detail/RetryResumeButton'
import { handleDecideError } from '../../src/components/detail/decide-helpers'
import { useAttention } from '../../src/providers/AttentionProvider'
import type { ApprovalDetail } from '../../src/types'

function isExpired(detail: ApprovalDetail) {
  if (detail.status === 'expired') return true
  if (!detail.expiresAt) return false
  const at = new Date(detail.expiresAt).getTime()
  return Number.isFinite(at) && at < Date.now()
}

export default function WorkItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { client, token, ready } = useSession()
  const { refresh, screenEpoch } = useAttention()
  const router = useRouter()
  const [detail, setDetail] = useState<ApprovalDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!client || !id || !token) return
    let cancelled = false
    void client
      .approval(id)
      .then((next) => {
        if (!cancelled) setDetail(next)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load')
      })
    return () => {
      cancelled = true
    }
  }, [client, id, screenEpoch, token])

  if (!ready) return null
  if (!token) return <Redirect href="/(auth)/login" />
  if (!detail && !error) return <ActivityIndicator style={styles.loader} />
  if (error || !detail) return <Text style={styles.error}>{error ?? 'Not found'}</Text>

  const allowed = allowedActionsFor(detail.envelope.allowedActions)
  const expired = isExpired(detail)

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <StatusHeader
        detail={detail}
        onForceCancel={
          detail.canCancel
            ? () => {
                Alert.alert(
                  'Force cancel',
                  'Close this work item without resuming the origin? Use this when the run is no longer suspended or cannot accept a decision.',
                  [
                    { text: 'Keep open', style: 'cancel' },
                    {
                      text: 'Force cancel',
                      style: 'destructive',
                      onPress: () => {
                        void client
                          ?.cancel(detail.id)
                          .then(async () => {
                            await refresh()
                            const next = await client.approval(detail.id)
                            setDetail(next)
                          })
                          .catch((err) => setError(err instanceof Error ? err.message : 'Cancel failed'))
                      },
                    },
                  ],
                )
              }
            : undefined
        }
      />
      {expired ? <Text style={styles.error}>This work item has expired.</Text> : null}
      <OriginCard fields={detail.originFields} />
      <ContextMarkdown
        value={detail.envelope.contextMarkdown}
        externalUrls={detail.envelope.externalUrls}
        attachments={detail.envelope.attachments}
      />
      <ArgsBlock args={detail.envelope.action.args} />
      <DecisionHistory decisions={detail.decisions} />
      {detail.evidenceReceipt ? (
        <Pressable
          style={styles.receiptLink}
          onPress={() => {
            if (detail.evidenceReceipt) {
              void Linking.openURL(detail.evidenceReceipt.storeUri)
            }
          }}
        >
          <Text style={styles.receiptText}>View evidence receipt</Text>
        </Pressable>
      ) : null}
      {detail.canAct && !expired ? (
        <DecisionBar
          allowed={allowed}
          envelope={detail.envelope}
          onDecide={async (decision, extra) => {
            try {
              await client?.decide(detail.id, { decision, ...extra })
              await refresh()
              router.back()
            } catch (err) {
              const outcome = await handleDecideError(async () => {
                const result = await client?.approval(detail.id).catch(() => null)
                return result ?? null
              })
              if (outcome.action === 'stay') {
                setDetail(outcome.detail)
                await refresh()
              }
              throw err
            }
          }}
        />
      ) : null}
      {detail.status === 'failed_resume' && detail.canAct ? (
        <RetryResumeButton
          onPress={() => {
            void client
              ?.retryResume(detail.id)
              .then(() => client.approval(detail.id).then(setDetail))
              .catch((err) => setError(err instanceof Error ? err.message : 'Retry failed'))
          }}
        />
      ) : null}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { padding: 16, backgroundColor: colors.bg, paddingBottom: 48 },
  loader: { marginTop: 48 },
  error: { padding: 16, color: colors.danger },
  receiptLink: { marginTop: 16, paddingVertical: 8 },
  receiptText: { fontSize: 14, color: colors.accent, textDecorationLine: 'underline' },
})
