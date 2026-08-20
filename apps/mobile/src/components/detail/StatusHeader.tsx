import { useRef, useState } from 'react'
import { Dimensions, Modal, Pressable, Text, View, StyleSheet } from 'react-native'
import Ionicons from '@expo/vector-icons/Ionicons'
import type { ApprovalDetail } from '../../types'
import { colors } from '../../theme'
import { PluginMark } from '../inbox/PluginMark'

function formatStatusLabel(status: string, decision?: string | null): string {
  if (status === 'decided' && decision) {
    return `decided: ${decision}`
  }
  if (status === 'failed_resume') {
    return 'failed_resume'
  }
  return status
}

export function StatusHeader({
  detail,
  onForceCancel,
}: {
  detail: ApprovalDetail
  onForceCancel?: () => void
}) {
  const triggerRef = useRef<View>(null)
  const [menu, setMenu] = useState<{ top: number; right: number } | null>(null)
  const showMenu = Boolean(onForceCancel) && detail.canCancel
  const latestDecision = detail.decisions[0]?.decision

  function openMenu() {
    triggerRef.current?.measureInWindow((x, y, width, height) => {
      const screenW = Dimensions.get('window').width
      setMenu({ top: y + height + 4, right: Math.max(8, screenW - (x + width)) })
    })
  }

  return (
    <View style={styles.row}>
      <PluginMark plugin={detail.plugin} />
      <View style={styles.body}>
        <Text style={styles.title}>{detail.actionName}</Text>
        <Text style={styles.meta}>
          {formatStatusLabel(detail.status, latestDecision)} · {detail.projectName}
        </Text>
      </View>
      {showMenu ? (
        <Pressable
          ref={triggerRef}
          onPress={openMenu}
          accessibilityRole="button"
          accessibilityLabel="More actions"
          style={styles.menuHit}
        >
          <Ionicons name="ellipsis-vertical" size={20} color={colors.text} />
        </Pressable>
      ) : null}
      <Modal visible={menu !== null} transparent animationType="fade" onRequestClose={() => setMenu(null)}>
        <View style={styles.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenu(null)} accessibilityLabel="Close menu" />
          {menu ? (
            <View style={[styles.menu, { top: menu.top, right: menu.right }]}>
              <Pressable
                onPress={() => {
                  setMenu(null)
                  onForceCancel?.()
                }}
                style={styles.menuItem}
                accessibilityRole="button"
                accessibilityLabel="Force cancel"
              >
                <Text style={styles.menuDanger}>Force cancel</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </Modal>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  body: { flex: 1 },
  title: { fontSize: 22, fontWeight: '600', color: colors.text },
  meta: { marginTop: 4, fontSize: 13, color: colors.muted, textTransform: 'capitalize' },
  menuHit: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', marginRight: -8 },
  overlay: { flex: 1 },
  menu: {
    position: 'absolute',
    minWidth: 168,
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  menuItem: { paddingHorizontal: 14, paddingVertical: 12 },
  menuDanger: { fontSize: 15, fontWeight: '600', color: colors.danger },
})
