import { initializeApp } from 'firebase/app'
import { getDatabase } from 'firebase/database'

/**
 * Firebase 設定の一元管理。
 * ここにあるのは公開されるクライアント設定のみ（秘密情報ではない）。
 * アクセス制御は Realtime Database のセキュリティルール側で行う。
 */
const firebaseConfig = {
  apiKey: 'AIzaSyA8nUStbKpLtzidbnxH4ihDVclblnFCl78',
  authDomain: 'pepupepu-native.firebaseapp.com',
  // Realtime Database は asia-southeast1 リージョン（URL 明示が必須）
  databaseURL:
    'https://pepupepu-native-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'pepupepu-native',
  storageBucket: 'pepupepu-native.firebasestorage.app',
  messagingSenderId: '759791250654',
  appId: '1:759791250654:web:b6a8a56d891107b9cda64f',
}

export const firebaseApp = initializeApp(firebaseConfig)
export const db = getDatabase(firebaseApp)
