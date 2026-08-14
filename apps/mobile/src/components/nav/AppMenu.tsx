import { Modal, Pressable, Text, View, StyleSheet } from 'react-native'
import { usePathname, useRouter, type Href } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { colors } from '../../theme'
import { useSession } from '../../providers/SessionProvider'
import { useMenu } from '../../providers/MenuProvider'
import { HitlyMark, HitlyWordmark } from '../brand/HitlyBrand'

const ITEMS = [
  { href: '/', label: 'Home' },
  { href: '/inbox', label: 'Inbox' },
  { href: '/workspace', label: 'Workspace' },
  { href: '/projects', label: 'Projects' },
  { href: '/settings', label: 'Config' },
] as const

function isActive(pathname: string, href: string) {
  if (href === '/') return pathname === '/' || pathname === '/index' || pathname === '/(tabs)' || pathname === '/(tabs)/index'
  if (href === '/projects') return pathname === '/projects' || pathname.startsWith('/projects/')
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function AppMenu() {
  const { open, hide } = useMenu()
  const { user, workspaces, workspaceId, token } = useSession()
  const router = useRouter()
  const pathname = usePathname()
  const current = workspaces.find((item) => item.id === workspaceId)

  if (!token) return null

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={hide}>
      <View style={styles.wrap}>
        <SafeAreaView style={styles.panel} edges={['top', 'bottom', 'left']}>
          <View style={styles.brand}>
            <HitlyMark size={48} />
            <HitlyWordmark size={20} />
          </View>
          {ITEMS.map((item) => {
            const active = isActive(pathname, item.href)
            return (
              <Pressable
                key={item.href}
                onPress={() => {
                  hide()
                  router.push(item.href as Href)
                }}
                style={[styles.item, active && styles.itemActive]}
              >
                <Text style={[styles.itemLabel, active && styles.itemLabelActive]}>{item.label}</Text>
              </Pressable>
            )
          })}
          <View style={styles.footer}>
            {current ? <Text style={styles.meta}>{current.name}</Text> : null}
            {user ? <Text style={styles.meta}>{user.email}</Text> : null}
          </View>
        </SafeAreaView>
        <Pressable style={styles.backdrop} onPress={hide} accessibilityLabel="Close menu" />
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  wrap: { flex: 1, flexDirection: 'row' },
  panel: { width: 280, height: '100%', backgroundColor: colors.card, paddingHorizontal: 16, paddingTop: 8 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 20, marginTop: 8 },
  item: { borderRadius: 8, paddingVertical: 12, paddingHorizontal: 10, marginBottom: 4 },
  itemActive: { backgroundColor: colors.bg },
  itemLabel: { fontSize: 16, color: colors.text },
  itemLabelActive: { fontWeight: '600' },
  footer: { marginTop: 'auto', paddingVertical: 16, gap: 4 },
  meta: { fontSize: 13, color: colors.muted },
})
