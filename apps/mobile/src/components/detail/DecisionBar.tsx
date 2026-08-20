import { useState } from 'react'
import { Pressable, Text, View, StyleSheet } from 'react-native'
import type { AllowedActions, Decision, EditableFieldSpec, EditReasonConfig } from '@hitly/core'
import { colors } from '../../theme'
import { EditArgsSheet } from './EditArgsSheet'
import { RespondSheet } from './RespondSheet'
import { canShowEdit } from './edit-helpers'

export function DecisionBar({
  allowed,
  disabled,
  envelope,
  onDecide,
}: {
  allowed: AllowedActions
  disabled?: boolean
  envelope?: {
    editableFields?: Record<string, EditableFieldSpec>
    editReason?: EditReasonConfig
    action: { args: Record<string, unknown> }
  }
  onDecide: (
    decision: Decision,
    extra?: { editedArgs?: Record<string, unknown>; response?: string; editReason?: string; editReasonText?: string },
  ) => Promise<void>
}) {
  const [editOpen, setEditOpen] = useState(false)
  const [respondOpen, setRespondOpen] = useState(false)
  const [response, setResponse] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const showEdit = canShowEdit(allowed.edit, envelope?.editableFields)

  const actions = (Object.entries({ ...allowed, edit: showEdit }) as [Decision, boolean][]).filter(([, on]) => on)

  async function run(
    decision: Decision,
    extra?: { editedArgs?: Record<string, unknown>; response?: string; editReason?: string; editReasonText?: string },
  ) {
    setPending(true)
    setError(null)
    try {
      await onDecide(decision, extra)
      setEditOpen(false)
      setRespondOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decision failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <View style={styles.bar}>
      {actions.map(([decision]) => (
        <Pressable
          key={decision}
          disabled={disabled || pending}
          onPress={() => {
            if (decision === 'edit') {
              setEditOpen(true)
              return
            }
            if (decision === 'respond') {
              setRespondOpen(true)
              return
            }
            void run(decision)
          }}
          style={[styles.button, (disabled || pending) && styles.disabled]}
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
          onSubmit={(data) => void run('edit', data)}
        />
      ) : null}
      <RespondSheet
        visible={respondOpen}
        value={response}
        onChange={setResponse}
        onClose={() => setRespondOpen(false)}
        onSubmit={() => void run('respond', { response })}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 16 },
  button: { backgroundColor: colors.accent, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  disabled: { opacity: 0.5 },
  label: { color: colors.accentFg, fontWeight: '600', textTransform: 'capitalize' },
  error: { width: '100%', marginTop: 8, fontSize: 13, color: colors.danger },
})
