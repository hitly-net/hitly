import 'react-native-gesture-handler'
import { View, StyleSheet } from 'react-native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SessionProvider } from '../src/providers/SessionProvider'
import { NotificationProvider } from '../src/providers/NotificationProvider'
import { MenuProvider } from '../src/providers/MenuProvider'
import { AttentionProvider } from '../src/providers/AttentionProvider'
import { AppMenu } from '../src/components/nav/AppMenu'
import { SystemBar } from '../src/components/nav/SystemBar'
import { InstanceMismatchSheet } from '../src/components/nav/InstanceMismatchSheet'
import { colors } from '../src/theme'

export default function RootLayout() {
  return (
    <SessionProvider>
      <NotificationProvider>
        <MenuProvider>
          <AttentionProvider>
            <View style={styles.root}>
              <StatusBar style="dark" />
              <SystemBar />
              <View style={styles.body}>
                <Stack screenOptions={{ headerShown: false }}>
                  <Stack.Screen name="(auth)" />
                  <Stack.Screen name="(tabs)" />
                  <Stack.Screen name="inbox/[id]" />
                  <Stack.Screen name="workspace" />
                  <Stack.Screen name="projects" />
                  <Stack.Screen name="settings" />
                </Stack>
              </View>
              <AppMenu />
              <InstanceMismatchSheet />
            </View>
          </AttentionProvider>
        </MenuProvider>
      </NotificationProvider>
    </SessionProvider>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.card },
  body: { flex: 1, backgroundColor: colors.bg },
})
