import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import {
  installAudioUnlockHandler,
  playPagyoChar,
  preloadVoiceSamples,
  whenVoicesReady,
} from './core/audio'
import type { PlayVoiceOptions } from './core/audio'
import { PUPE, startBot } from './core/bots'
import type { BotDef, BotHandle } from './core/bots'
import { NOROSHI_INTERVAL_MS } from './core/constants'
import { initTokenizer, safeConvertToPagyo } from './core/convert/papipupepo'
import { startNoroshi } from './core/noroshi'
import type { NoroshiHandle } from './core/noroshi'
import {
  GUIDE_COLOR,
  getStoredPapiColor,
  mouthColorFor,
  randomPaletteColor,
  storePapiColor,
  wingColorFor,
} from './core/papiColor'
import { detectReaction, markReactionEarned } from './core/reaction'
import type { ReactionType } from './core/reaction'
import { getOrCreateUserId, joinRoom } from './core/room'
import type { RoomHandle, RoomPost, RoomUser } from './core/room'
import OnboardingScene from './components/OnboardingScene'
import Papi from './components/Papi'
import WanderingPapi from './components/WanderingPapi'
import { mouthForChar } from './components/papiMouth'
import type { PapiMouth } from './components/papiMouth'

/**
 * ルーム画面 room-v3「LINE型の空の下で、7人がうろうろ待つ部屋」
 *
 *   - パステルの空と雲は room-v2 のまま。レイアウトを LINE のトーク画面型に変更
 *   - 下部ストリップ: 在室キャラ全員（自分＋他ユーザー＋ボット）が
 *     小さくうろうろして待機する（WanderingPapi）。自分は大きめ・右寄りの
 *     固定エリア（.my-zone）内でうろうろ
 *   - 発話フィード: 発話ごとに「ミニキャラ＋吹き出し」の行が下から積まれ、
 *     古い行は押し上げられ、しばらくすると薄れて消える。
 *     自分の行は右寄せ、他ユーザー・ボットは左寄せ
 *   - 吹き出しの文字は220msのろしリズムで1文字ずつ現れ、口パク＋パ音と同期。
 *     発話中は下部ストリップのその子もうろうろを止めて口パクする
 *   - 表情リアクション: 投稿の原文を端末内でキーワード判定（挨拶/喜び/通常）。
 *     DB へ送るのは pagyo とリアクション種別のみ（原文は送らない）。
 *     挨拶=おじぎ、喜び=弾む。初獲得時は自分がキラッと光る（ローカル永続化）
 *   - のろし・星（v1）とパステル空レーン漂流（v2）のコードは
 *     src/legacy/ に未使用のまま残してある
 */

/** 部屋の定員 = 自分＋他ユーザー＋ボットの合計 */
const SLOT_COUNT = 7
/** 自分・他キャラ・フィードのミニキャラの表示幅 */
const MY_PAPI_SIZE = 72
const OTHER_PAPI_SIZE = 56
const FEED_AVATAR_SIZE = 34

/** 発話終了からフィード行が薄れ始めるまでの時間（ms） */
const FEED_HOLD_MS = 7_000
/** フィード行のフェードアウト時間（ms）。CSS の .feed-fading と合わせる */
const FEED_FADE_MS = 900
/** フィードに同時に置ける行数。超えたら最古から薄れる */
const FEED_MAX_ROWS = 8
/** キラッ演出の長さ（ms）。CSS の .sparkle と合わせる */
const SPARKLE_MS = 1_000

/** 自分のキャラID（ルーム同期のuserIdとは別のローカル表示用ID） */
const ME_ID = 'me'

/** 他ユーザーの声（少し高く・控えめ） */
const OTHER_VOICE: PlayVoiceOptions = { volume: 2.0, playbackRate: 1.3 }
/** ボットの声（さらに控えめの音量） */
const BOT_VOICE: PlayVoiceOptions = { volume: 1.1, playbackRate: 1.35 }

/**
 * スロット埋め用のローカルボット群。先頭は常駐のプペ。
 * 残りはプペの実装（台詞・相槌・タイマー挙動）を流用した色違い。
 * ボットは presence にも DB にも一切書き込まない（既存ルールのまま）。
 */
const BOT_POOL: BotDef[] = [
  PUPE,
  { ...PUPE, id: 'bot_f2', color: '#A9D8FF' }, // スカイ
  { ...PUPE, id: 'bot_f3', color: '#FFE9A8' }, // レモン
  { ...PUPE, id: 'bot_f4', color: '#B5E8C9' }, // ミント
  { ...PUPE, id: 'bot_f5', color: '#E5B8F0' }, // ライラック
  { ...PUPE, id: 'bot_f6', color: '#FFC9A9' }, // ピーチ
  { ...PUPE, id: 'bot_f7', color: '#C8B0FE' }, // ラベンダー
]

/** ユーザーIDから決まるうろうろの位相。キャラごとに動きがずれる */
function wanderPhaseFor(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % 60
}

/** リアクション → キャラの動きのCSSクラス（通常は動きなし） */
function reactionClassFor(reaction: ReactionType | undefined): string {
  if (reaction === 'joy') return 'react-joy'
  if (reaction === 'greeting') return 'react-greeting'
  return ''
}

/** 下部ストリップに表示するキャラ（退場フェード中も含む） */
interface StripView {
  id: string
  color: string
  leaving: boolean
}

/** 発話フィードの1行（ミニキャラ＋吹き出し） */
interface FeedRow {
  id: number
  charaId: string
  color: string
  isMe: boolean
  text: string
  shown: number
  stage: 'typing' | 'held' | 'fading'
}

/** speak() に渡す発話の属性 */
interface SpeakOptions {
  color: string
  isMe?: boolean
  voice?: PlayVoiceOptions
  reaction: ReactionType
}

function App() {
  // 起動時はオンボーディング（誕生シーン）。ルーム画面は背後にマウントして
  // 空を共有し、終了時にパピがシームレスに引き継がれる
  const [scene, setScene] = useState<'onboarding' | 'room'>('onboarding')
  const [papiColor, setPapiColor] = useState(
    () => getStoredPapiColor() ?? GUIDE_COLOR,
  )
  const [dictReady, setDictReady] = useState(false)
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<'idle' | 'busy'>('idle')
  /** 在室中の他ユーザー（自分は含まない） */
  const [others, setOthers] = useState<RoomUser[]>([])
  /** 発話のためだけに現れている不在ユーザー（発話が全部終わると退場） */
  const [visitors, setVisitors] = useState<RoomUser[]>([])
  /** 下部ストリップのキャラ一覧（自分以外。退場フェード中も含む） */
  const [stripViews, setStripViews] = useState<StripView[]>([])
  /** キャラごとの口の形（220ms周期で切り替わる） */
  const [mouths, setMouths] = useState<Record<string, PapiMouth>>({})
  /** 発話中フラグ（うろうろ停止に使う） */
  const [speaking, setSpeaking] = useState<Record<string, boolean>>({})
  /** 発話中の表情リアクション（挨拶=おじぎ・喜び=弾む） */
  const [reactions, setReactions] = useState<
    Record<string, ReactionType | undefined>
  >({})
  const [feed, setFeed] = useState<FeedRow[]>([])
  /** 初獲得のキラッ演出中か（自分のキャラ） */
  const [sparkling, setSparkling] = useState(false)

  const roomRef = useRef<RoomHandle | null>(null)
  const botHandlesRef = useRef(new Map<string, BotHandle>())
  const papiColorRef = useRef(papiColor)
  useEffect(() => {
    papiColorRef.current = papiColor
  }, [papiColor])

  /** ストリップの現在表示（差分計算用。state と同期） */
  const stripViewsRef = useRef<StripView[]>([])
  const nextRowIdRef = useRef(0)
  /** ユーザーごとの発話キュー（同じ人の投稿が重なったら順番に演じる） */
  const speechChainsRef = useRef(new Map<string, Promise<void>>())
  /** 訪問者ごとの未消化の発話数。0になるまで訪問者を退場させない */
  const pendingSpeechRef = useRef(new Map<string, number>())
  const activeNoroshiRef = useRef(new Set<NoroshiHandle>())
  const timersRef = useRef(new Set<ReturnType<typeof setInterval>>())
  const myZoneRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // ルール2: 最初のユーザー操作で Web Audio をアンロックする
    const removeUnlockHandler = installAudioUnlockHandler()
    void preloadVoiceSamples()
    initTokenizer()
      .then(() => {
        // 初回の tokenize は JIT ウォームアップで数百ms かかるため、
        // ここで一度空振りさせて初回投稿の変身開始をゼロ遅延にする
        safeConvertToPagyo('ぺぷ')
        setDictReady(true)
      })
      .catch((e) => console.error('辞書ロード失敗', e))

    const timers = timersRef.current
    const activeNoroshi = activeNoroshiRef.current
    const botHandles = botHandlesRef.current
    return () => {
      removeUnlockHandler()
      for (const h of activeNoroshi) h.stop()
      for (const t of timers) clearInterval(t)
      for (const h of botHandles.values()) h.stop()
      botHandles.clear()
    }
  }, [])

  // ルームへの入室（在室登録・他ユーザーの投稿と在室一覧の購読）。
  // 接続に失敗しても・満室でも、ローカルの投稿演出とボットはそのまま動く
  useEffect(() => {
    let cancelled = false
    let handle: RoomHandle | null = null
    joinRoom({
      color: papiColorRef.current,
      onPresence: (users) => setOthers(users),
      onPost: (post) => queueRemotePost(post),
    })
      .then((h) => {
        if (cancelled) {
          h.leave()
          return
        }
        handle = h
        roomRef.current = h
        if (h.full) {
          console.info('部屋が満室のため、ローカルのみで動作します')
        }
      })
      .catch((e) => console.error('ルーム接続に失敗（ローカルで続行）', e))
    return () => {
      cancelled = true
      handle?.leave()
      roomRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 汎用のワンショットタイマー（アンマウント時にまとめて掃除される） */
  const after = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timersRef.current.delete(t)
      fn()
    }, ms)
    timersRef.current.add(t)
  }

  // 表示上の訪問者（presence にいる人は presence 側を優先）とボット数
  const visitorsShown = visitors.filter(
    (v) => !others.some((o) => o.id === v.id),
  )
  const botCount = Math.max(
    0,
    SLOT_COUNT - 1 - others.length - visitorsShown.length,
  )

  /**
   * ストリップのメンバーシップ調停:
   * 望ましい構成（在室者＋訪問者＋ボット。自分は .my-zone で別枠）との差分で
   * 登場（CSSフェードイン）と退場（leaving → 1秒後に除去）を発火する
   */
  useEffect(() => {
    const desired: RoomUser[] = [
      ...others,
      ...visitorsShown,
      ...BOT_POOL.slice(0, botCount).map((b) => ({ id: b.id, color: b.color })),
    ]
    const desiredIds = new Set(desired.map((d) => d.id))
    const prev = stripViewsRef.current
    const next: StripView[] = desired.map((d) => ({
      id: d.id,
      color: d.color,
      leaving: false,
    }))
    for (const v of prev) {
      if (desiredIds.has(v.id)) continue
      next.push({ ...v, leaving: true })
      if (!v.leaving) {
        // 新たに退場が始まったキャラは、フェードが終わったころに除去する
        after(1_000, () => {
          stripViewsRef.current = stripViewsRef.current.filter(
            (x) => !(x.id === v.id && x.leaving),
          )
          setStripViews(stripViewsRef.current)
        })
      }
    }
    stripViewsRef.current = next
    setStripViews(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [others, visitors, botCount])

  // ボットの起動・停止: ルーム画面に入ったら、アクティブな数だけ動かす。
  // 完全ルールベース・ローカル動作（DB書き込みなし）
  useEffect(() => {
    if (scene !== 'room') return
    const active = BOT_POOL.slice(0, botCount)
    const handles = botHandlesRef.current
    for (const [id, h] of handles) {
      if (!active.some((b) => b.id === id)) {
        h.stop()
        handles.delete(id)
      }
    }
    for (const b of active) {
      if (!handles.has(b.id)) {
        handles.set(
          b.id,
          startBot(b, (bot, phrase) => {
            // ボットの台詞も必ず変換エンジンを通す（長音の展開などを揃える）。
            // リアクションは台詞の原文で判定（「ぽぽ！」は喜びになる）
            queueSpeech(bot.id, safeConvertToPagyo(phrase), {
              color: bot.color,
              voice: BOT_VOICE,
              reaction: detectReaction(phrase),
            })
          }),
        )
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, botCount])

  /** フィード行を薄れさせて、フェード完了後に取り除く */
  const fadeOutRow = (rowId: number) => {
    setFeed((prev) =>
      prev.map((r) => (r.id === rowId ? { ...r, stage: 'fading' } : r)),
    )
    after(FEED_FADE_MS, () =>
      setFeed((prev) => prev.filter((r) => r.id !== rowId)),
    )
  }

  // 行数が上限を超えたら、最古の行から薄れさせる
  useEffect(() => {
    const alive = feed.filter((r) => r.stage !== 'fading')
    if (alive.length > FEED_MAX_ROWS) {
      for (const r of alive.slice(0, alive.length - FEED_MAX_ROWS)) {
        fadeOutRow(r.id)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed])

  /**
   * 発話: フィードの下端に「ミニキャラ＋吹き出し」の行を積み、
   * 220msののろしリズムで1文字ずつ表示しながら口パク＋パ音を鳴らす。
   * 発話中は下部ストリップのその子がうろうろを止め、
   * リアクション（挨拶=おじぎ・喜び=弾む）の動きをする。
   */
  const speak = (
    charaId: string,
    pagyo: string,
    options: SpeakOptions,
  ): Promise<void> =>
    new Promise((resolve) => {
      if (!pagyo) {
        resolve()
        return
      }

      const rowId = nextRowIdRef.current++
      setFeed((prev) => [
        ...prev,
        {
          id: rowId,
          charaId,
          color: options.color,
          isMe: options.isMe ?? false,
          text: pagyo,
          shown: 0,
          stage: 'typing',
        },
      ])
      setSpeaking((prev) => ({ ...prev, [charaId]: true }))
      setReactions((prev) => ({ ...prev, [charaId]: options.reaction }))

      const handle = startNoroshi(
        pagyo,
        ({ char, index }) => {
          playPagyoChar(char, options.voice)
          setMouths((prev) => ({ ...prev, [charaId]: mouthForChar(char) }))
          setFeed((prev) =>
            prev.map((r) => (r.id === rowId ? { ...r, shown: index + 1 } : r)),
          )
        },
        () => {
          activeNoroshiRef.current.delete(handle)
          setMouths((prev) => ({ ...prev, [charaId]: 'none' }))
          setSpeaking((prev) => ({ ...prev, [charaId]: false }))
          setReactions((prev) => ({ ...prev, [charaId]: undefined }))
          setFeed((prev) =>
            prev.map((r) =>
              r.id === rowId && r.stage === 'typing'
                ? { ...r, stage: 'held', shown: Array.from(r.text).length }
                : r,
            ),
          )
          after(FEED_HOLD_MS, () => fadeOutRow(rowId))
          resolve()
        },
      )
      activeNoroshiRef.current.add(handle)
    })

  /** 発話をユーザーごとのキューに積む（同じ人の投稿が重なったら順番に演じる） */
  const queueSpeech = (
    charaId: string,
    pagyo: string,
    options: SpeakOptions,
  ) => {
    const prevChain = speechChainsRef.current.get(charaId) ?? Promise.resolve()
    speechChainsRef.current.set(
      charaId,
      prevChain.then(() => speak(charaId, pagyo, options)),
    )
  }

  /** 受信した投稿を発話キューに積む（登場の1拍を待ってから話し出す） */
  const queueRemotePost = (post: RoomPost) => {
    // 自分の投稿はローカルで演出済み。room.ts でも除外しているが、
    // 万一すり抜けても二重再生にならないよう防御的に遮断する
    if (post.userId === getOrCreateUserId()) return
    // 投稿者を画面に登場させる（不在なら発話が全部終わるまでの間だけ現れる）
    setVisitors((prev) =>
      prev.some((v) => v.id === post.userId)
        ? prev
        : [...prev, { id: post.userId, color: post.color }],
    )
    const pending = pendingSpeechRef.current
    pending.set(post.userId, (pending.get(post.userId) ?? 0) + 1)
    const prevChain =
      speechChainsRef.current.get(post.userId) ?? Promise.resolve()
    speechChainsRef.current.set(
      post.userId,
      prevChain
        .then(
          () =>
            new Promise<void>((r) => {
              // 登場直後は姿が定まっていないことがあるので少し待つ
              after(NOROSHI_INTERVAL_MS * 2, r)
            }),
        )
        .then(() =>
          speak(post.userId, post.pagyo, {
            color: post.color,
            voice: OTHER_VOICE,
            reaction: post.reaction,
          }),
        )
        .then(() => {
          // 連投がすべて終わったら、発話のためだけに現れていた場合は退場
          // （在室中なら presence 側の一覧に残る）
          const left = (pending.get(post.userId) ?? 1) - 1
          if (left <= 0) {
            pending.delete(post.userId)
            setVisitors((prev) => prev.filter((v) => v.id !== post.userId))
          } else {
            pending.set(post.userId, left)
          }
        }),
    )
  }

  /**
   * 入力欄の中で、文字を先頭から1文字ずつパ行に置き換えていく。
   * テンポはパ音のリズム（NOROSHI_INTERVAL_MS）に揃える。
   * 化けの段階は無音（表示のみ）。パ音が鳴るのは、吹き出しに
   * 文字が現れる時（startNoroshi の onTick）だけ。
   */
  const morphInInput = (original: string, pagyo: string): Promise<void> => {
    const origChars = Array.from(original)
    const pagyoChars = Array.from(pagyo)
    const total = pagyoChars.length
    if (total === 0) {
      setText('')
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      let k = 0
      const step = () => {
        k += 1
        const consumed = Math.min(
          origChars.length,
          Math.round((k * origChars.length) / total),
        )
        setText(
          pagyoChars.slice(0, k).join('') + origChars.slice(consumed).join(''),
        )
        if (k >= total) {
          clearInterval(timer)
          timersRef.current.delete(timer)
          resolve()
        }
      }
      const timer = setInterval(step, NOROSHI_INTERVAL_MS)
      timersRef.current.add(timer)
      step() // 押した瞬間に1文字目が化ける（待ち時間ゼロ）
    })
  }

  /**
   * ユーザーの色を確定して返す。初回はパレットからランダムに選んで
   * localStorage に保存、以降は保存済みの色。ルームの在室情報にも反映する
   */
  const ensurePapiColor = () => {
    const color = getStoredPapiColor() ?? randomPaletteColor()
    storePapiColor(color)
    setPapiColor(color)
    roomRef.current?.setColor(color)
    return color
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (phase !== 'idle' || !dictReady) return
    const original = text.trim()
    if (!original) return

    setPhase('busy')
    // リアクションは原文のキーワードから端末内で判定する。
    // 判定結果（種別のみ）が投稿と一緒に送られる。投稿前には表示しない
    const reaction = detectReaction(original)
    const pagyo = safeConvertToPagyo(original)

    // ルームへ送信するのは変換後のパ行文字列とリアクション種別のみ
    // （プライバシー原則: 原文 original は、いかなる形でもネットワークに送らない）
    roomRef.current?.post(pagyo, reaction)

    // ボイスの準備（デコード完了 + AudioContext running、タイムアウト付き）は
    // 変身アニメーションの裏で並行して待ち、体感の待ち時間をゼロに近づける
    const voicesReady = whenVoicesReady()
    await morphInInput(original, pagyo)
    await voicesReady

    // 変身（無音）はここで終わり。入力欄を空にして一拍おいてから発話に移る。
    // パ音が鳴るのは、この先の吹き出しに文字が現れる時だけ
    setText('')
    await new Promise<void>((r) => after(NOROSHI_INTERVAL_MS, r))

    // 新しいリアクションを初めて獲得したときだけ、自分がキラッと光る
    if (markReactionEarned(reaction)) {
      setSparkling(true)
      after(SPARKLE_MS, () => setSparkling(false))
    }

    await speak(ME_ID, pagyo, {
      color: papiColorRef.current,
      isMe: true,
      reaction,
    })
    setPhase('idle') // うろうろ再開

    // ボットに知らせる（かぶらないよう間を空けて、ときどき相槌が返る）。
    // 全員に知らせると相槌が騒がしいので、最大2体だけ
    const handles = [...botHandlesRef.current.values()]
    handles.sort(() => Math.random() - 0.5)
    for (const h of handles.slice(0, 2)) h.notifyUserPost()
  }

  const myAnimClass = [
    reactionClassFor(reactions[ME_ID]),
    sparkling ? 'sparkle' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={`app${scene === 'onboarding' ? ' app-onboarding' : ''}`}
      style={{ '--papi-color': papiColor } as CSSProperties}
    >
      <div className="cloud cloud-1" />
      <div className="cloud cloud-2" />
      <div className="cloud cloud-3" />
      <div className="cloud cloud-4" />

      {/* 発話フィード: 新しい行が下、古い行は押し上げられて薄れて消える */}
      <div className="feed">
        {feed.map((row) => (
          <div
            key={row.id}
            className={`feed-row ${row.isMe ? 'feed-right' : 'feed-left'}${
              row.stage === 'fading' ? ' feed-fading' : ''
            }`}
          >
            <span className="feed-avatar">
              <Papi
                mouth={
                  row.stage === 'typing'
                    ? (mouths[row.charaId] ?? 'none')
                    : 'none'
                }
                color={row.color}
                mouthColor={mouthColorFor(row.color)}
                wingColor={wingColorFor(row.color)}
                size={FEED_AVATAR_SIZE}
              />
            </span>
            <span className="feed-bubble">
              {Array.from(row.text).slice(0, row.shown).join('')}
            </span>
          </div>
        ))}
      </div>

      {/* 下部ストリップ: 在室キャラ全員がうろうろして待機。
          発話中の子はうろうろを止めて口パク＋リアクションの動き */}
      <div className="papi-strip3">
        {stripViews.map((v) => (
          <WanderingPapi
            key={v.id}
            mouth={mouths[v.id] ?? 'none'}
            color={v.color}
            mouthColor={mouthColorFor(v.color)}
            wingColor={wingColorFor(v.color)}
            size={OTHER_PAPI_SIZE}
            paused={!!speaking[v.id] || v.leaving}
            phase={wanderPhaseFor(v.id)}
            animClass={
              v.leaving ? 'strip-out' : reactionClassFor(reactions[v.id])
            }
          />
        ))}
        {/* 自分の固定エリア（右寄り）。この中だけを小さくうろうろする */}
        <div className="my-zone" ref={myZoneRef}>
          <WanderingPapi
            mouth={mouths[ME_ID] ?? 'none'}
            color={papiColor}
            mouthColor={mouthColorFor(papiColor)}
            wingColor={wingColorFor(papiColor)}
            size={MY_PAPI_SIZE}
            paused={scene === 'onboarding' || !!speaking[ME_ID]}
            animClass={myAnimClass}
          />
        </div>
      </div>

      <div className="room-bottom">
        <form className="room-form" onSubmit={handleSubmit}>
          <input
            className="room-input"
            type="text"
            value={text}
            onChange={(e) => phase === 'idle' && setText(e.target.value)}
            readOnly={phase !== 'idle'}
            placeholder="きょうのひとこと"
            aria-label="投稿する言葉"
            enterKeyHint="send"
          />
          <button
            className="room-send"
            type="submit"
            disabled={!dictReady || phase !== 'idle'}
            aria-label="送信"
          >
            ↑
          </button>
        </form>
      </div>

      {scene === 'onboarding' && (
        <OnboardingScene
          chooseFinalColor={ensurePapiColor}
          getLandingRect={() =>
            myZoneRef.current
              ?.querySelector('.papi-wander')
              ?.getBoundingClientRect() ?? null
          }
          onFinish={() => {
            // 降下前にスキップされても色は必ず確定させる
            // （白は案内役の予約色なのでユーザーの色にはしない）
            ensurePapiColor()
            setScene('room')
          }}
        />
      )}
    </div>
  )
}

export default App
