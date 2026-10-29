import { useState } from 'react'
import { Pressable, Text, View, StyleSheet } from 'react-native'
import {
  mustOpenItems,
  requiresReason,
  type AllowedActions,
  type ApprovalEnvelope,
  type ContextItemRef,
  type Decision,
} from '@hitly/core'
import { colors } from '../../theme'
import { EditArgsSheet } from './EditArgsSheet'
import { ReasonSheet } from './ReasonSheet'
import { RespondSheet } from './RespondSheet'
import { canShowEdit } from './edit-helpers'

export type DecideExtra = {
  editedArgs?: Record<string, unknown>
  response?: string
  editReason?: string
  editReasonText?: string
  /** Reviewer reason for the answer (hitl-spec 3.6). Sent as `reason` in the decide body. */
  reason?: string
}

/**
 * Decision controls for one approval. Client-side mirror of the host gating
 * (same rules as `validateAnswerSubmission` in @hitly/core, which the host
 * re-runs on submit):
 *
 * - A decision that lists `reasonRequired` (or the binary default) opens the
 *   reason sheet first; the submit is refused until a non-blank reason is typed.
 * - `mustOpen` context items stay locked until the reviewer opens them. A tap
 *   opens the URL and reports the open via `onOpen` (the opens API) so the
 *   host records the audit trail and the buttons unlock.
 */
export function DecisionBar({
  allowed,
  disabled,
  envelope,
  openedRefs = [],
  onOpen,
  onDecide,
}: {
  allowed: AllowedActions
  disabled?: boolean
  envelope?: ApprovalEnvelope
  /** Gating refs this reviewer has already opened (hitl-spec 3.7, per reviewer). */
  openedRefs?: string[]
  /** Report an opened context item so the host records the `opened` audit event. */
  onOpen?: (item: ContextItemRef) => void
  onDecide: (decision: Decision, extra?: DecideExtra) => Promise<void>
}) {
  const [editOpen, setEditOpen] = useState(false)
  const [respondOpen, setRespondOpen] = useState(false)
  const [response, setResponse] = useState('')
  const [reasonFlow, setReasonFlow] = useState<{ decision: Decision; extra?: DecideExtra; reason: string } | null>(
    null,
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const showEdit = canShowEdit(allowed.edit, envelope?.editableFields)

  const actions = (Object.entries({ ...allowed, edit: showEdit }) as [Decision, boolean][]).filter(([, on]) => on)

  const gateItems = envelope ? mustOpenItems(envelope) : []
  const unopened = gateItems.filter((item) => !openedRefs.includes(item.ref))
  const locked = unopened.length > 0

  async function run(decision: Decision, extra?: DecideExtra) {
    setPending(true)
    setError(null)
    try {
      await onDecide(decision, extra)
      setEditOpen(false)
      setRespondOpen(false)
      setReasonFlow(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decision failed')
    } finally {
      setPending(false)
    }
  }

  /** Gate one submit the same way the host would: opens first, then a required reason. */
  function gate(decision: Decision, extra?: DecideExtra) {
    if (locked) {
      setError('Open the required context items before you answer.')
      return
    }
    if (envelope && requiresReason(envelope, decision)) {
      setReasonFlow({ decision, extra, reason: '' })
      return
    }
    void run(decision, extra)
  }

  return (
    <View>
      {gateItems.length > 0 ? (
        <View style={styles.checklist}>
          <Text style={styles.checklistTitle}>Open before answering</Text>
          {gateItems.map((item) => (
            <Pressable key={item.ref} disabled={pending} onPress={() => onOpen?.(item)}>
              <Text style={styles.checklistItem}>
                {item.label} · {openedRefs.includes(item.ref) ? 'opened' : 'open before answering'}
              </Text>
            </Pressable>
          ))}
          <Text style={styles.hint}>
            {locked
              ? 'The answer buttons unlock once every must-open item has been opened. Your opens are recorded (item and time) for the audit trail.'
              : 'All required context items have been opened.'}
          </Text>
        </View>
      ) : null}
      <View style={styles.bar}>
        {actions.map(([decision]) => (
          <Pressable
            key={decision}
            disabled={disabled || pending || locked}
            onPress={() => {
              if (decision === 'edit') {
                setEditOpen(true)
                return
              }
              if (decision === 'respond') {
                setRespondOpen(true)
                return
              }
              gate(decision)
            }}
            style={[styles.button, (disabled || pending || locked) && styles.disabled]}
          >
            <Text style={styles.label}>{decision}</Text>
          </Pressable>
        ))}
        {showEdit && envelope ? (
          <EditArgsSheet
            visible={editOpen}
            fields={envelope.editableFields!}
            originalArgs={envelope.action.args}
            editReasonConfig={envelope.editReason}
            onClose={() => setEditOpen(false)}
            onSubmit={(data) => gate('edit', data)}
          />
        ) : null}
        <RespondSheet
          visible={respondOpen}
          value={response}
          onChange={setResponse}
          onClose={() => setRespondOpen(false)}
          onSubmit={() => gate('respond', { response })}
        />
        <ReasonSheet
          visible={reasonFlow !== null}
          decision={reasonFlow?.decision}
          value={reasonFlow?.reason ?? ''}
          onChange={(text) => setReasonFlow((flow) => (flow ? { ...flow, reason: text } : flow))}
          onSubmit={() => {
            if (!reasonFlow) return
            const reason = reasonFlow.reason.trim()
            if (!reason) return
            const { decision, extra } = reasonFlow
            setReasonFlow(null)
            void run(decision, { ...extra, reason })
          }}
          onClose={() => setReasonFlow(null)}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  checklist: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 12,
    backgroundColor: colors.card,
  },
  checklistTitle: { fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 6 },
  checklistItem: { fontSize: 13, color: colors.text, marginBottom: 4 },
  hint: { marginTop: 6, fontSize: 11, color: colors.muted },
  bar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 16 },
  button: { backgroundColor: colors.accent, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  disabled: { opacity: 0.5 },
  label: { color: colors.accentFg, fontWeight: '600', textTransform: 'capitalize' },
  error: { width: '100%', marginTop: 8, fontSize: 13, color: colors.danger },
})
