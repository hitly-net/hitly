import * as Notifications from 'expo-notifications'

export async function setAppBadge(count: number) {
  await Notifications.setBadgeCountAsync(Math.max(0, count))
}
