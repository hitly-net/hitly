import { ScrollView, Text, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { colors } from '../../src/theme'
import { useAttention } from '../../src/providers/AttentionProvider'
import { AttentionSummary } from '../../src/components/attention/AttentionSummary'

export default function HomeScreen() {
  const { summary } = useAttention()
  const router = useRouter()

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.title}>Inbox summary</Text>
      <AttentionSummary
        summary={summary}
        onPending={() => router.push('/(tabs)/inbox')}
        onFailed={() => router.push('/(tabs)/inbox')}
      />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { padding: 16, backgroundColor: colors.bg, flexGrow: 1 },
  title: { fontSize: 22, fontWeight: '700', color: colors.text, marginBottom: 12 },
})
