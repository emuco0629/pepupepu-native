import { initializeApp } from 'firebase/app'
import { getDatabase } from 'firebase/database'

/**
 * Firebase 設定の一元管理。
 * 値は Vite の環境変数から読む（.env.example をコピーして .env.local を作る）。
 * Web の apiKey は公開前提の識別子でありアクセス制御は Realtime Database の
 * セキュリティルール側で行うが、リポジトリには値を置かない方針。
 */
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  // Realtime Database は asia-southeast1 リージョン（URL 明示が必須）
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

if (!firebaseConfig.apiKey || !firebaseConfig.databaseURL) {
  console.warn(
    'Firebase の環境変数が未設定です。.env.example をコピーして .env.local を作成してください。',
  )
}

export const firebaseApp = initializeApp(firebaseConfig)
export const db = getDatabase(firebaseApp)
