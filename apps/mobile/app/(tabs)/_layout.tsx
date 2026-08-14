import Ionicons from '@expo/vector-icons/Ionicons'
import { Redirect, Tabs } from 'expo-router'
import { colors } from '../../src/theme'
import { useSession } from '../../src/providers/SessionProvider'

function TabIcon({
  name,
  focusedName,
  color,
  size,
  focused,
}: {
  name: keyof typeof Ionicons.glyphMap
  focusedName: keyof typeof Ionicons.glyphMap
  color: string
  size: number
  focused: boolean
}) {
  return <Ionicons name={focused ? focusedName : name} size={size} color={color} />
}

export default function TabsLayout() {
  const { ready, token } = useSession()
  if (!ready) return null
  if (!token) return <Redirect href="/(auth)" />
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size, focused }) => (
            <TabIcon name="home-outline" focusedName="home" color={color} size={size} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="inbox"
        options={{
          title: 'Inbox',
          tabBarIcon: ({ color, size, focused }) => (
            <TabIcon name="file-tray-outline" focusedName="file-tray" color={color} size={size} focused={focused} />
          ),
        }}
      />
    </Tabs>
  )
}
