import { useEffect, useState } from 'react'
import { Modal, Pressable, Text, TextInput, View, StyleSheet } from 'react-native'
import type { AnswerSchema } from '@hitly/core'
import { colors } from '../../theme'
import { buildRespondPayload, initialRespondValue, respondErrors, type RespondPayload } from './respond-helpers'

/**
 * Respond sheet for one ask_user request. hitl/v0: ONE widget for the ONE
 * question, chosen by the request's stored answerSchema (text input, radios,
 * checkboxes, number input). Without a stored schema (asks created before
 * answerSchema persisted) it keeps the legacy single free-text "Response".
 *
 * Invalid submits are refused here and the reviewer's input is kept
 * (hitl-spec 7); the host re-validates against the stored schema anyway.
 */
export function RespondSheet({
  visible,
  schema,
  value,
  onChange,
  onSubmit,
  onClose,
}: {
  visible: boolean
  /** Stored envelope schema; absent = legacy free-text response. */
  schema?: AnswerSchema
  /** Legacy free-text value (no-schema path only). */
  value: string
  onChange: (value: string) => void
  onSubmit: (payload: RespondPayload) => void
  onClose: () => void
}) {
  // The typed answer lives with the sheet; it resets each time the sheet
  // opens and survives a failed send while it stays open.
  const [typed, setTyped] = useState<unknown>(() => initialRespondValue(schema))
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (visible) {
      setTyped(initialRespondValue(schema))
      setError(null)
    }
  }, [visible, schema])

  function send() {
    const payload = buildRespondPayload(schema, typed)
    if (!payload) {
      setError(respondErrors(schema, typed)[0] ?? 'Your answer is not valid yet.')
      return
    }
    onSubmit(payload)
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <Text style={styles.title}>Response</Text>
        {!schema ? (
          <TextInput value={value} onChangeText={onChange} style={styles.input} />
        ) : (
          <SchemaFields schema={schema} value={typed} onChange={setTyped} />
        )}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable style={styles.button} onPress={schema ? send : () => onSubmit({ response: value })}>
          <Text style={styles.label}>Send</Text>
        </Pressable>
        <Pressable onPress={onClose}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  )
}

function SchemaFields({
  schema,
  value,
  onChange,
}: {
  schema: AnswerSchema
  value: unknown
  onChange: (value: unknown) => void
}) {
  switch (schema.type) {
    case 'text':
      return (
        <TextInput
          value={typeof value === 'string' ? value : ''}
          onChangeText={onChange}
          style={styles.input}
          testID="answer-widget"
        />
      )
    case 'single':
      return (
        <View testID="answer-widget">
          {(schema.options ?? []).map((option) => (
            <Pressable key={option.value} style={styles.optionRow} onPress={() => onChange(option.value)}>
              <Text style={[styles.radio, value === option.value && styles.radioOn]}>
                {value === option.value ? '◉ ' : '○ '}
                {option.label}
              </Text>
              {option.description ? <Text style={styles.description}>{option.description}</Text> : null}
            </Pressable>
          ))}
        </View>
      )
    case 'multi': {
      const selected = Array.isArray(value) ? (value as string[]) : []
      return (
        <View testID="answer-widget">
          {(schema.options ?? []).map((option) => {
            const on = selected.includes(option.value)
            return (
              <Pressable
                key={option.value}
                style={styles.optionRow}
                onPress={() =>
                  onChange(on ? selected.filter((item) => item !== option.value) : [...new Set([...selected, option.value])])
                }
              >
                <Text style={[styles.radio, on && styles.radioOn]}>
                  {on ? '☑ ' : '☐ '}
                  {option.label}
                </Text>
                {option.description ? <Text style={styles.description}>{option.description}</Text> : null}
              </Pressable>
            )
          })}
        </View>
      )
    }
    case 'number': {
      const bounds = schema.bounds ?? {}
      const label =
        bounds.min !== undefined || bounds.max !== undefined
          ? `Accepted: ${bounds.min ?? '-∞'} … ${bounds.max ?? '∞'}${bounds.unit ? ` ${bounds.unit}` : ''}`
          : bounds.unit
            ? `Unit: ${bounds.unit}`
            : null
      return (
        <View testID="answer-widget">
          <TextInput
            value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
            onChangeText={onChange}
            keyboardType="numeric"
            style={styles.input}
          />
          {label ? <Text style={styles.description}>{label}</Text> : null}
        </View>
      )
    }
    default:
      // binary/secret are not offered by ask_user v0; approvals use
      // request_approval and secret needs encryption.
      return null
  }
}

const styles = StyleSheet.create({
  sheet: {
    marginTop: 'auto',
    backgroundColor: colors.card,
    padding: 24,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 12, color: colors.text },
  input: {
    height: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    marginBottom: 12,
    color: colors.text,
  },
  optionRow: { paddingVertical: 8 },
  radio: { color: colors.text, fontSize: 15 },
  radioOn: { fontWeight: '600' },
  description: { color: colors.muted, fontSize: 12, marginTop: 2 },
  error: { color: colors.danger, marginBottom: 8 },
  button: { backgroundColor: colors.accent, paddingVertical: 12, borderRadius: 8 },
  label: { color: colors.accentFg, fontWeight: '600', textAlign: 'center' },
  cancel: { marginTop: 12, textAlign: 'center', color: colors.muted },
})
