import { Platform } from 'react-native'
import Constants, { ExecutionEnvironment } from 'expo-constants'

export const isExpoGo =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient ||
  (Constants.appOwnership === 'expo' && Platform.OS !== 'web')
