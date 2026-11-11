import { View, Text, StyleSheet } from 'react-native'
import { formatTypedAnswer, typedAnswerFromPayload, type AnswerSchema } from '@hitly/core'
import type { DecisionRow } from '../../types'
import { colors } from '../../theme'

export function DecisionHistory({
  decisions,
  answer,
  answerSchema,
}: {
  decisions: DecisionRow[]
  answer?: unknown
  answerSchema?: AnswerSchema | null
}) {
  const latest = decisions[0]
  if (!latest) return null
  const typed = answer !== undefined && answer !== null ? answer : typedAnswerFromPayload(latest.payload)
  const formatted = formatTypedAnswer(typed, answerSchema)
  return (
    <View style={styles.block}>
      <Text style={styles.heading}>Decision</Text>
      <Text style={styles.meta}>
        {latest.decision}
        {latest.resumeError ? ' · resume failed' : ''}
      </Text>
      {formatted?.kind === 'list' ? (
        <View style={styles.answer}>
          {formatted.items.map((item, index) => (
            <Text key={`${index}:${item}`} style={styles.answerText}>
              {`\u2022 ${item}`}
            </Text>
          ))}
        </View>
      ) : formatted ? (
        <Text style={formatted.kind === 'json' ? styles.answerJson : styles.answerText}>{formatted.text}</Text>
      ) : null}
      {latest.resumeError ? <Text style={styles.error}>{latest.resumeError}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  block: { marginTop: 24 },
  heading: { fontSize: 13, fontWeight: '600', color: colors.text },
  meta: { marginTop: 4, fontSize: 14, color: colors.muted, textTransform: 'capitalize' },
  answer: { marginTop: 8, gap: 4 },
  answerText: { marginTop: 8, fontSize: 15, color: colors.text },
  answerJson: {
    marginTop: 8,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    fontSize: 12,
    fontFamily: 'Courier',
    color: colors.text,
  },
  error: { marginTop: 8, fontSize: 13, color: colors.warning },
})
