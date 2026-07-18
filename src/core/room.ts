import {
  onChildAdded,
  onDisconnect,
  onValue,
  orderByChild,
  push,
  query,
  ref,
  runTransaction,
  serverTimestamp,
  set,
  startAt,
} from 'firebase/database'
import { db } from './firebase'
import { normalizeReaction } from './reaction'
import type { ReactionType } from './reaction'

/**
 * ルームのリアルタイム同期（Firebase Realtime Database）
 *
 * プライバシー原則（最重要）:
 *   データベースに保存するのは変換後のパ行文字列（pagyo）と、
 *   端末内のキーワード判定で決まったリアクション種別のみ。
 *   変換前の原文は、いかなる形でも送信・保存しない。
 *   このモジュールの post() が受け取るのは pagyo と reaction だけであり、
 *   原文がここへ到達する経路をコード上作らないこと。
 *
 * データ構造:
 *   rooms/lobby/presence/{userId}: { color, lastActive } … 在室管理
 *   rooms/lobby/posts/{postId}:    { userId, color, pagyo, reaction, createdAt } … 投稿
 *
 * 仕様:
 *   - 部屋は固定の1部屋（rooms/lobby）、最大 MAX_ROOM_USERS 人
 *   - ユーザーは匿名。ランダムIDを localStorage に保存して識別
 *   - 入室後に流れてきた投稿だけを配信する（過去の投稿は再生しない）
 *   - 自分の投稿は配信しない（ローカルで演出済みのため）
 */

const ROOM_PATH = 'rooms/lobby'
export const MAX_ROOM_USERS = 7

const USER_ID_STORAGE_KEY = 'pepupepu-user-id'
/** 在室の生存確認を更新する間隔（ms） */
const PRESENCE_HEARTBEAT_MS = 60_000

export interface RoomPost {
  userId: string
  color: string
  pagyo: string
  /** 表情リアクション（旧クライアントの投稿は 'normal' に丸められる） */
  reaction: ReactionType
}

export interface RoomUser {
  id: string
  color: string
}

export interface RoomHandle {
  /** 満室で入れなかった場合 true（その場合はローカルのみで動作する） */
  readonly full: boolean
  /** 変換後のパ行文字列とリアクション種別を投稿する（原文は絶対に渡さないこと） */
  post: (pagyo: string, reaction: ReactionType) => void
  /** 自分の色を変更する（誕生時の色決定・将来の色変え機能用） */
  setColor: (color: string) => void
  leave: () => void
}

/** 匿名ユーザーID。初回起動時に生成して localStorage に保存する */
export function getOrCreateUserId(): string {
  try {
    const saved = localStorage.getItem(USER_ID_STORAGE_KEY)
    if (saved) return saved
    const id = `u_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
    localStorage.setItem(USER_ID_STORAGE_KEY, id)
    return id
  } catch {
    // localStorage が使えない環境ではセッション限りのIDで動く
    return `u_${Math.random().toString(36).slice(2, 12)}`
  }
}

interface JoinRoomOptions {
  color: string
  /** 他ユーザーの投稿を受信したとき（自分の投稿・入室前の投稿は来ない） */
  onPost: (post: RoomPost) => void
  /** 在室中の他ユーザー一覧が変わったとき（自分は含まない） */
  onPresence: (users: RoomUser[]) => void
}

export async function joinRoom(options: JoinRoomOptions): Promise<RoomHandle> {
  const userId = getOrCreateUserId()
  const presenceRef = ref(db, `${ROOM_PATH}/presence`)
  const myPresenceRef = ref(db, `${ROOM_PATH}/presence/${userId}`)
  const postsRef = ref(db, `${ROOM_PATH}/posts`)

  // この join の所有権ID。古い join（React StrictMode の二重マウント等）の
  // leave() が、新しい join の在室エントリを消してしまわないようにする
  const sessionId = `s_${Math.random().toString(36).slice(2, 10)}`
  let currentColor = options.color
  const presenceValue = () => ({
    color: currentColor,
    lastActive: Date.now(),
    sessionId,
  })

  // 満室（MAX_ROOM_USERS）チェックつきで在室登録する
  const result = await runTransaction(presenceRef, (current) => {
    const users = (current ?? {}) as Record<string, unknown>
    if (!users[userId] && Object.keys(users).length >= MAX_ROOM_USERS) {
      return // 満室 → トランザクション中止
    }
    users[userId] = presenceValue()
    return users
  })

  if (!result.committed) {
    // 満室: ローカルのみで動作（投稿の送受信はしない）
    return { full: true, post: () => {}, setColor: () => {}, leave: () => {} }
  }

  // 切断時（タブを閉じる等）に在室から自動削除
  const disconnect = onDisconnect(myPresenceRef)
  void disconnect.remove()

  // 生存確認の定期更新（常に完全なエントリを書き、部分的な復活を防ぐ）
  const heartbeat = setInterval(() => {
    void set(myPresenceRef, presenceValue())
  }, PRESENCE_HEARTBEAT_MS)

  // 在室一覧の購読（自分を除く）
  const unsubscribePresence = onValue(presenceRef, (snap) => {
    const users: RoomUser[] = []
    snap.forEach((child) => {
      if (child.key && child.key !== userId) {
        const value = child.val() as { color?: string }
        users.push({ id: child.key, color: value.color ?? '#C8B0FE' })
      }
    })
    options.onPresence(users)
  })

  // 入室以降の投稿だけを購読する。サーバー時刻とのずれを補正した
  // 入室時刻を基準に、createdAt がそれ以降のものだけ受け取る
  const offsetSnap = await new Promise<number>((resolve) => {
    onValue(
      ref(db, '.info/serverTimeOffset'),
      (snap) => resolve((snap.val() as number) ?? 0),
      { onlyOnce: true },
    )
  })
  const joinedAt = Date.now() + offsetSnap

  const unsubscribePosts = onChildAdded(
    query(postsRef, orderByChild('createdAt'), startAt(joinedAt)),
    (snap) => {
      const value = snap.val() as {
        userId?: string
        color?: string
        pagyo?: string
        reaction?: string
      }
      if (!value?.pagyo || !value.userId) return
      if (value.userId === userId) return // 自分の投稿はローカルで演出済み
      options.onPost({
        userId: value.userId,
        color: value.color ?? '#C8B0FE',
        pagyo: value.pagyo,
        reaction: normalizeReaction(value.reaction),
      })
    },
  )

  const leave = () => {
    clearInterval(heartbeat)
    unsubscribePresence()
    unsubscribePosts()
    void disconnect.cancel()
    // 自分のセッションが書いたエントリのときだけ削除する
    // （新しい join に取って代わられていたら触らない）
    void runTransaction(myPresenceRef, (current) => {
      if (current && (current as { sessionId?: string }).sessionId !== sessionId) {
        return current
      }
      return null
    })
  }

  const post = (pagyo: string, reaction: ReactionType) => {
    void push(postsRef, {
      userId,
      color: currentColor,
      pagyo,
      reaction,
      createdAt: serverTimestamp(),
    })
    void set(myPresenceRef, presenceValue())
  }

  const setColor = (color: string) => {
    currentColor = color
    void set(myPresenceRef, presenceValue())
  }

  return { full: false, post, setColor, leave }
}
