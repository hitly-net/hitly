import { Pressable, Text, View, StyleSheet } from 'react-native'
import { usePathname, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { colors } from '../../theme'
import { useSession } from '../../providers/SessionProvider'
import { useAttention } from '../../providers/AttentionProvider'
import { HitlyWordmark } from '../brand/HitlyBrand'
import { BackButton } from './BackButton'
import { HamburgerButton } from './HamburgerButton'

function isWorkItemPath(pathname: string) {
  return /^\/inbox\/[^/]+$/.test(pathname)
}

function isProjectDetailPath(pathname: string) {
  return /^\/projects\/[^/]+/.test(pathname)
}

export function SystemBar() {
  const { token } = useSession()
  const { alertCount, refreshScreen } = useAttention()
  const router = useRouter()
  const pathname = usePathname()
  const showBack = isWorkItemPath(pathname) || isProjectDetailPath(pathname)
  if (!token) return null

  return (
    <SafeAreaView edges={['top']} style={styles.safe}>
      <View style={styles.bar}>
        {showBack ? (
          <BackButton
            onPress={() => {
              if (router.canGoBack()) router.back()
              else if (isProjectDetailPath(pathname)) router.replace('/projects')
              else router.replace('/inbox')
            }}
          />
        ) : (
          <HamburgerButton />
        )}
        <View style={styles.brand} accessibilityRole="header">
          <Pressable onPress={() => router.push('/')} style={styles.brandPress} accessibilityLabel="Hitly home">
            <HitlyWordmark size={18} />
          </Pressable>
        </View>
        {alertCount > 0 ? (
          <Pressable
            onPress={() => void refreshScreen()}
            accessibilityRole="button"
            accessibilityLabel={`Refresh. ${alertCount} work ${alertCount === 1 ? 'item' : 'items'} to approve`}
            style={styles.alertHit}
          >
            <View style={styles.alertIcon}>
              <Text style={styles.alertBang}>!</Text>
            </View>
            <View style={styles.badge}>
              <Text style={styles.badgeLabel}>{alertCount > 99 ? '99+' : String(alertCount)}</Text>
            </View>
          </Pressable>
        ) : (
          <View style={styles.alertHit} />
        )}
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { backgroundColor: colors.card, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  bar: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 8,
  },
  brand: { flex: 1 },
  brandPress: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start' },
  alertHit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  alertIcon: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.warning,
    alignItems: 'center',
    justifyContent: 'center',
  },
  alertBang: { color: colors.accentFg, fontSize: 16, fontWeight: '800', marginTop: -1 },
  badge: {
    position: 'absolute',
    top: 4,
    right: 2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeLabel: { color: colors.accentFg, fontSize: 10, fontWeight: '700' },
})
