/**
 * 【v1 ルーム画面の保全コピー — room-v2 では未使用】
 *
 * 夜空・のろし（S字カーブの糸）・星の蓄積による旧ルーム画面。
 * room-v2（パステルの空・吹き出し）への置き換えにあたり、
 * 「のろし演出と星のコードは削除せず未使用のまま残す」ため、
 * 旧 src/App.tsx をそのままここへ移した（import パスのみ調整）。
 * どこからも import されない。動作する統合は main ブランチにある。
 * 関連する未使用資産: components/HoveringPapi.tsx、
 * index.css の .noroshi-layer / .noroshi-char / .star / @keyframes star-*
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import {
  installAudioUnlockHandler,
  playPagyoChar,
  preloadVoiceSamples,
  whenVoicesReady,
} from '../core/audio'
import type { PlayVoiceOptions } from '../core/audio'
import { PUPE, startBot } from '../core/bots'
import type { BotHandle } from '../core/bots'
import { NOROSHI_INTERVAL_MS } from '../core/constants'
import { initTokenizer, safeConvertToPagyo } from '../core/convert/papipupepo'
import { startNoroshi } from '../core/noroshi'
import type { NoroshiHandle } from '../core/noroshi'
import {
  GUIDE_COLOR,
  getStoredPapiColor,
  mouthColorFor,
  randomPaletteColor,
  storePapiColor,
  wingColorFor,
} from '../core/papiColor'
import { getOrCreateUserId, joinRoom } from '../core/room'
import type { RoomHandle, RoomPost, RoomUser } from '../core/room'
import OnboardingScene from '../components/OnboardingScene'
import HoveringPapi from '../components/HoveringPapi'
import { mouthForChar } from '../components/papiMouth'
import type { PapiMouth } from '../components/papiMouth'

/**
 * ルーム画面（Layout B）
 * 薄紫の夜空に、言葉が「のろし」として立ちのぼり、星になって残る部屋。
 *
 * 投稿シーケンス:
 *   1. 送信した瞬間、入力欄の中で文字が先頭から1文字ずつパ行に化けていく
 *      （ボイスの準備はこの裏で並行して待つ）
 *   2. 全文がパ行になったら、パピはその場に立ち止まり、その頭上から
 *      220msのろしリズムで先頭の文字から順に発射される（入力欄が減っていく）
 *   3. 文字は投稿ごとに1本生成される見えないS字カーブに沿って数珠つなぎに
 *      登っていく。毛糸玉から糸が出るイメージ。文字単位の揺れは付けず、
 *      曲線自体が時間とともにゆっくりたなびく（風に揺れる）
 *   4. 各文字は上昇の頂点で星に変わり、夜空のランダムな位置に定着する
 *   5. 発話が終わるとパピはさまよいを再開する
 */

/** ローカルで動く常駐ボット（presence にも DB にも書き込まない） */
const BOT_USERS: RoomUser[] = [{ id: PUPE.id, color: PUPE.color }]

/** 自分・他ユーザーのパピの表示幅 */
const MY_PAPI_SIZE = 72
const OTHER_PAPI_SIZE = 64

/** 他ユーザーの声（少し高く・控えめ） */
const OTHER_VOICE: PlayVoiceOptions = { volume: 2.0, playbackRate: 1.3 }
/** ボットの声（さらに控えめの音量） */
const BOT_VOICE: PlayVoiceOptions = { volume: 1.1, playbackRate: 1.35 }

/** ユーザーIDから決まる浮遊の位相。パピごとに揺れの周期・タイミングがずれる */
function hoverPhaseFor(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % 60
}

/** HoveringPapi と同じ式で、スロットの中心 x（ストリップ基準・px）を求める */
function slotCenterX(slotFrac: number, size: number, stripWidth: number): number {
  return 8 + size / 2 + slotFrac * Math.max(0, stripWidth - size - 16)
}

/** のろし文字が星に変わるまでの上昇時間（ms）。ゆったり漂う速さ */
const RISE_DURATION_MS = 4800

/** パピの色を ratio ぶん白に寄せた色（星の色 = わずかに色を帯びた白） */
function tintTowardWhite(papiColor: string, whiteRatio: number): string {
  const hex = papiColor.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const mix = (c: number) => Math.round(255 * whiteRatio + c * (1 - whiteRatio))
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`
}

/** 星の色（投稿したパピの色をわずかに帯びた白） */
function starTintFor(papiColor: string): StarTint {
  return {
    color: tintTowardWhite(papiColor, 0.8),
    glow: tintTowardWhite(papiColor, 0.45),
  }
}

/**
 * のろしの上昇経路（見えないS字カーブ）。投稿ごとに1本生成する。
 * u ∈ [0,1]（0 = パピの頭上、1 = 頂点）と時刻 t から座標を返す。
 * 曲線や中心線そのものは描画せず、文字の連なりだけで糸に見せる。
 */
interface NoroshiPath {
  startX: number
  startY: number
  endX: number
  endY: number
  /** 大きなうねり（S字の本体） */
  amp1: number
  freq1: number
  phase1: number
  swaySpeed1: number
  /** 小さなうねり（糸の細かい表情） */
  amp2: number
  freq2: number
  phase2: number
  swaySpeed2: number
}

function makeNoroshiPath(
  startX: number,
  startY: number,
  layerWidth: number,
  layerHeight: number,
): NoroshiPath {
  const endX = Math.min(
    layerWidth - 30,
    Math.max(30, startX + (Math.random() - 0.5) * 120),
  )
  return {
    startX,
    startY,
    endX,
    endY: layerHeight * (0.09 + Math.random() * 0.05),
    amp1: 26 + Math.random() * 26,
    freq1: 0.6 + Math.random() * 0.7,
    phase1: Math.random() * Math.PI * 2,
    swaySpeed1: 0.35 + Math.random() * 0.3,
    amp2: 7 + Math.random() * 9,
    freq2: 1.6 + Math.random() * 1.2,
    phase2: Math.random() * Math.PI * 2,
    swaySpeed2: 0.5 + Math.random() * 0.4,
  }
}

/** 経路上の座標。振幅は sin(uπ) で両端0にし、発射点と頂点で曲線が収束する */
function noroshiPoint(
  path: NoroshiPath,
  u: number,
  timeSec: number,
): { x: number; y: number } {
  const ramp = Math.sin(u * Math.PI)
  const sway =
    path.amp1 *
      Math.sin(
        u * path.freq1 * Math.PI * 2 + path.phase1 + timeSec * path.swaySpeed1,
      ) +
    path.amp2 *
      Math.sin(
        u * path.freq2 * Math.PI * 2 + path.phase2 - timeSec * path.swaySpeed2,
      )
  return {
    x: path.startX + (path.endX - path.startX) * u + ramp * sway,
    y: path.startY + (path.endY - path.startY) * u,
  }
}

interface RisingChar {
  id: number
  char: string
}

/** 飛行中の文字のメタ情報（レンダリングと切り離して rAF から参照する） */
interface FlightMeta {
  born: number
  path: NoroshiPath
}

interface Star {
  id: number
  xPct: number
  yPct: number
  size: number
  opacity: number
  twinkleDuration: number
  twinkleDelay: number
  /** 投稿したパピの色をわずかに帯びた白 */
  color: string
  glow: string
}

interface StarTint {
  color: string
  glow: string
}

function App() {
  // 起動時はオンボーディング（誕生シーン）。ルーム画面は背後にマウントして
  // 夜空を共有し、終了時にパピがシームレスに引き継がれる
  const [scene, setScene] = useState<'onboarding' | 'room'>('onboarding')
  // 自分のパピの色。誕生時にパレットからランダムに決まり localStorage に残る。
  // まだ決まっていない初回は案内役の白で誕生シーンが進む
  const [papiColor, setPapiColor] = useState(
    () => getStoredPapiColor() ?? GUIDE_COLOR,
  )
  const [dictReady, setDictReady] = useState(false)
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<'idle' | 'busy'>('idle')
  const [mouth, setMouth] = useState<PapiMouth>('none')
  const [risingChars, setRisingChars] = useState<RisingChar[]>([])
  const [stars, setStars] = useState<Star[]>([])
  /** 在室中の他ユーザー（自分は含まない） */
  const [others, setOthers] = useState<RoomUser[]>([])
  /** 発話のためだけに現れている不在ユーザー（発話が終わると退場） */
  const [visitors, setVisitors] = useState<RoomUser[]>([])
  const [otherMouths, setOtherMouths] = useState<Record<string, PapiMouth>>({})
  const [otherSpeaking, setOtherSpeaking] = useState<Record<string, boolean>>(
    {},
  )

  const noroshiRef = useRef<NoroshiHandle | null>(null)
  const roomRef = useRef<RoomHandle | null>(null)
  const botRef = useRef<BotHandle | null>(null)
  /** 表示中の他パピの id → スロット割合（発話の発射点計算に使う） */
  const slotMapRef = useRef(new Map<string, number>())
  /** 入室エフェクト（マウント時1回）から最新の色を読むための ref */
  const papiColorRef = useRef(papiColor)
  useEffect(() => {
    papiColorRef.current = papiColor
  }, [papiColor])
  /** 他ユーザーのパピの現在位置（papi-strip 基準・px） */
  const otherXRefs = useRef(new Map<string, { current: number }>())
  /** ユーザーごとの発話キュー（同じ人の投稿が重なったら順番に演じる） */
  const speechChainsRef = useRef(new Map<string, Promise<void>>())
  const activeNoroshiRef = useRef(new Set<NoroshiHandle>())
  /** パピの現在の中心 x（papi-strip 基準・px）。HoveringPapi が毎フレーム更新 */
  const papiXRef = useRef(0)
  const layerRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const nextIdRef = useRef(0)
  const timersRef = useRef(new Set<ReturnType<typeof setInterval>>())
  /** 飛行中の文字: id → メタ / id → DOM 要素 */
  const flightMetaRef = useRef(new Map<number, FlightMeta>())
  const flightElsRef = useRef(new Map<number, HTMLSpanElement>())
  const flightRafRef = useRef(0)

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
    return () => {
      removeUnlockHandler()
      noroshiRef.current?.stop()
      for (const h of activeNoroshi) h.stop()
      for (const t of timers) clearInterval(t)
      cancelAnimationFrame(flightRafRef.current)
    }
  }, [])

  // ルームへの入室（在室登録・他ユーザーの投稿と在室一覧の購読）。
  // 接続に失敗しても・満室でも、ローカルの投稿演出はそのまま動く
  useEffect(() => {
    let cancelled = false
    let handle: RoomHandle | null = null
    joinRoom({
      color: papiColorRef.current,
      onPresence: (users) => setOthers(users),
      onPost: (post) => queueRemotePost(post, OTHER_VOICE),
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

  // ボット「プペ」: ルーム画面に入ったら動き出し、ときどきひとりごとを言う。
  // 完全ルールベース・ローカル動作（DB書き込みなし）
  useEffect(() => {
    if (scene !== 'room') return
    const bot = startBot(PUPE, (b, phrase) => {
      // ボットの台詞も必ず変換エンジンを通す（長音の展開などを揃える）
      queueRemotePost(
        {
          userId: b.id,
          color: b.color,
          pagyo: safeConvertToPagyo(phrase),
          // v3で追加されたフィールド。v1は表情リアクション未対応
          reaction: 'normal',
        },
        BOT_VOICE,
      )
    })
    botRef.current = bot
    return () => {
      botRef.current = null
      bot.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene])

  /** 飛行中の全文字を同じ曲線に沿って進める rAF ループ */
  const ensureFlightLoop = () => {
    if (flightRafRef.current) return
    const step = (now: number) => {
      const timeSec = now / 1000
      for (const [id, meta] of flightMetaRef.current) {
        const el = flightElsRef.current.get(id)
        if (!el) continue
        const progress = Math.min(1, (now - meta.born) / RISE_DURATION_MS)
        // 頂点に近づくほど減速（糸の先端がふわっと止まって星になる）
        const u = 1 - (1 - progress) * (1 - progress)
        const { x, y } = noroshiPoint(meta.path, u, timeSec)
        // 平面のまま上昇しながらゆっくり薄くなって消える（縮小はごくわずか）
        const scale = 1 - 0.06 * u
        el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) scale(${scale})`
        el.style.opacity = String(Math.pow(1 - u, 0.7))
      }
      if (flightMetaRef.current.size > 0) {
        flightRafRef.current = requestAnimationFrame(step)
      } else {
        flightRafRef.current = 0
      }
    }
    flightRafRef.current = requestAnimationFrame(step)
  }

  /** のろし文字を1つ発射し、上昇し終わったら星に変える */
  const spawnRisingChar = (char: string, path: NoroshiPath, tint: StarTint) => {
    if (/^[\s　]$/.test(char)) return
    const id = nextIdRef.current++
    flightMetaRef.current.set(id, { born: performance.now(), path })
    setRisingChars((prev) => [...prev, { id, char }])
    ensureFlightLoop()

    const timer = setTimeout(() => {
      timersRef.current.delete(timer)
      flightMetaRef.current.delete(id)
      setRisingChars((prev) => prev.filter((c) => c.id !== id))
      // 星は夜空のランダムな位置に定着し、消えずに残り続ける
      setStars((prev) => [
        ...prev,
        {
          id,
          xPct: 4 + Math.random() * 92,
          yPct: 4 + Math.random() * 62,
          size: 2 + Math.random() * 2.5,
          opacity: 0.65 + Math.random() * 0.35,
          twinkleDuration: 2.4 + Math.random() * 3,
          twinkleDelay: 0.7 + Math.random() * 3,
          color: tint.color,
          glow: tint.glow,
        },
      ])
    }, RISE_DURATION_MS)
    timersRef.current.add(timer)
  }

  /** 他ユーザーのパピの位置 ref を取得（なければ作る） */
  const otherXRef = (id: string) => {
    let r = otherXRefs.current.get(id)
    if (!r) {
      r = { current: 0 }
      otherXRefs.current.set(id, r)
    }
    return r
  }

  /**
   * 他ユーザーの投稿を演じる: その人のパピが少し浮き上がり、
   * 自分ののろしと同じ演出で発話し、文字は星になって残る。
   */
  const performRemoteSpeech = (post: RoomPost, voice: PlayVoiceOptions) =>
    new Promise<void>((resolve) => {
      // 登場直後は位置が定まっていないことがあるので少し待ってから発話
      const startTimer = setTimeout(() => {
        timersRef.current.delete(startTimer)
        setOtherSpeaking((prev) => ({ ...prev, [post.userId]: true }))

        const layerRect = layerRef.current?.getBoundingClientRect()
        const stripRect = stripRef.current?.getBoundingClientRect()
        // 発射点の x: 実測（xRef）が使えればそれを、まだ動き出していなければ
        // スロットから決定的に求める（登場直後でものろしが左端に出ない）
        const measuredX = otherXRefs.current.get(post.userId)?.current
        const slotX = slotCenterX(
          slotMapRef.current.get(post.userId) ?? 0.5,
          OTHER_PAPI_SIZE,
          stripRect?.width ?? 343,
        )
        const startX =
          (stripRect && layerRect ? stripRect.left - layerRect.left : 0) +
          (measuredX && measuredX > 1 ? measuredX : slotX)
        const path = layerRect
          ? makeNoroshiPath(
              startX,
              // 浮上した頭の少し上から
              (stripRect?.top ?? 0) - layerRect.top - 16,
              layerRect.width,
              layerRect.height,
            )
          : makeNoroshiPath(60, 640, 375, 812)
        const tint: StarTint = {
          color: tintTowardWhite(post.color, 0.8),
          glow: tintTowardWhite(post.color, 0.45),
        }

        const handle = startNoroshi(
          post.pagyo,
          ({ char }) => {
            // 他のパピの声は少し高く・控えめに鳴らす
            playPagyoChar(char, voice)
            setOtherMouths((prev) => ({
              ...prev,
              [post.userId]: mouthForChar(char),
            }))
            spawnRisingChar(char, path, tint)
          },
          () => {
            activeNoroshiRef.current.delete(handle)
            setOtherMouths((prev) => ({ ...prev, [post.userId]: 'none' }))
            setOtherSpeaking((prev) => ({ ...prev, [post.userId]: false }))
            // 発話のためだけに現れていた場合はここで退場
            // （在室中なら presence 側の一覧に残る）
            setVisitors((prev) => prev.filter((v) => v.id !== post.userId))
            resolve()
          },
        )
        activeNoroshiRef.current.add(handle)
      }, NOROSHI_INTERVAL_MS * 2)
      timersRef.current.add(startTimer)
    })

  /** 受信した投稿（またはボットの発話）をユーザーごとの発話キューに積む */
  const queueRemotePost = (post: RoomPost, voice: PlayVoiceOptions) => {
    // 自分の投稿はローカルで演出済み。room.ts でも除外しているが、
    // 万一すり抜けても二重再生にならないよう防御的に遮断する
    if (post.userId === getOrCreateUserId()) return
    // 投稿者を画面に登場させる（不在なら発話の間だけ現れる。常駐ボットは対象外）
    if (!BOT_USERS.some((b) => b.id === post.userId)) {
      setVisitors((prev) =>
        prev.some((v) => v.id === post.userId)
          ? prev
          : [...prev, { id: post.userId, color: post.color }],
      )
    }
    const prevChain =
      speechChainsRef.current.get(post.userId) ?? Promise.resolve()
    speechChainsRef.current.set(
      post.userId,
      prevChain.then(() => performRemoteSpeech(post, voice)),
    )
  }

  /**
   * 入力欄の中で、文字を先頭から1文字ずつパ行に置き換えていく。
   * テンポはパ音のリズム（NOROSHI_INTERVAL_MS）に揃える。
   * 化けの段階は無音（表示のみ）。パ音が鳴るのは、のろしとして
   * 文字が立ちのぼる時（startNoroshi の onTick）だけ。
   * 元の文字列とパ行文字列の長さが違っても、消費位置を比例配分して
   * 「先頭から化けていく」見え方を保つ。
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

  // 表示する他パピの一覧（描画順 = スロット順）。自分は右端のスロットに入る
  const othersDisplayed = [
    ...BOT_USERS,
    ...others,
    ...visitors.filter((v) => !others.some((o) => o.id === v.id)),
  ]

  // 発話の発射点計算用に、id → スロット割合を常に最新へ
  useEffect(() => {
    const map = new Map<string, number>()
    othersDisplayed.forEach((u, i) =>
      map.set(u.id, (i + 0.5) / (othersDisplayed.length + 1)),
    )
    slotMapRef.current = map
  })

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (phase !== 'idle' || !dictReady) return
    const original = text.trim()
    if (!original) return

    setPhase('busy') // パピはここから発話終了まで立ち止まる
    const pagyo = safeConvertToPagyo(original)

    // ルームへ送信するのは変換後のパ行文字列のみ（プライバシー原則:
    // 原文 original は、いかなる形でもネットワークに送らない）
    // v1は表情リアクション未対応のため常に 'normal'
    roomRef.current?.post(pagyo, 'normal')

    // ボイスの準備（デコード完了 + AudioContext running、タイムアウト付き）は
    // 変身アニメーションの裏で並行して待ち、体感の待ち時間をゼロに近づける
    const voicesReady = whenVoicesReady()
    await morphInInput(original, pagyo)
    await voicesReady

    // 発射点 = 立ち止まったパピの頭上。ここから1本の曲線が始まる
    const layerRect = layerRef.current?.getBoundingClientRect()
    const stripRect = stripRef.current?.getBoundingClientRect()
    const path =
      layerRect && stripRect
        ? makeNoroshiPath(
            stripRect.left - layerRect.left + papiXRef.current,
            // 浮上した頭の少し上から
            stripRect.top - layerRect.top - 16,
            layerRect.width,
            layerRect.height,
          )
        : makeNoroshiPath(60, 640, 375, 812)

    noroshiRef.current = startNoroshi(
      pagyo,
      ({ char }) => {
        playPagyoChar(char)
        setMouth(mouthForChar(char))
        spawnRisingChar(char, path, starTintFor(papiColorRef.current))
        // 先頭の文字が飛び立ち、入力欄に残っている文字が減っていく
        setText((prev) => Array.from(prev).slice(1).join(''))
      },
      () => {
        setMouth('none')
        setText('')
        setPhase('idle') // さまよい再開
        // プペに知らせる（かぶらないよう間を空けて、ときどき相槌が返る）
        botRef.current?.notifyUserPost()
      },
    )
  }

  return (
    <div
      className={`app${scene === 'onboarding' ? ' app-onboarding' : ''}`}
      style={
        {
          '--papi-color': papiColor,
          '--star-color': starTintFor(papiColor).color,
          '--star-glow': starTintFor(papiColor).glow,
        } as CSSProperties
      }
    >
      <div className="room-sky">
        {stars.map((s) => (
          <span
            key={`s${s.id}`}
            className="star"
            style={
              {
                left: `${s.xPct}%`,
                top: `${s.yPct}%`,
                width: s.size,
                height: s.size,
                '--star-opacity': s.opacity,
                '--twinkle-duration': `${s.twinkleDuration}s`,
                '--twinkle-delay': `${s.twinkleDelay}s`,
                '--star-color': s.color,
                '--star-glow': s.glow,
              } as CSSProperties
            }
          />
        ))}
      </div>

      <div className="room-bottom">
        <div className="papi-strip" ref={stripRef}>
          {/* 常駐ボット + 在室中の他ユーザー + 発話のために現れた不在ユーザー。
              全員（自分含む）で横方向のスロットを均等に分け合い、
              人数が変わるとゆっくり再配分される */}
          {othersDisplayed.map((u, i) => (
            <HoveringPapi
              key={u.id}
              mouth={otherMouths[u.id] ?? 'none'}
              color={u.color}
              mouthColor={mouthColorFor(u.color)}
              wingColor={wingColorFor(u.color)}
              size={OTHER_PAPI_SIZE}
              slot={(i + 0.5) / (othersDisplayed.length + 1)}
              speaking={!!otherSpeaking[u.id]}
              phase={hoverPhaseFor(u.id)}
              xRef={otherXRef(u.id)}
            />
          ))}
          {/* 自分のパピ（右端のスロット。最後に描画して手前に。
              papi-mine は着地位置の目印） */}
          <span className="papi-mine">
            <HoveringPapi
              mouth={mouth}
              color={papiColor}
              mouthColor={mouthColorFor(papiColor)}
              wingColor={wingColorFor(papiColor)}
              size={MY_PAPI_SIZE}
              slot={(othersDisplayed.length + 0.5) / (othersDisplayed.length + 1)}
              speaking={phase !== 'idle'}
              xRef={papiXRef}
            />
          </span>
        </div>
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

      {/* のろし文字のレイヤー: パピの頭上から夜空まで画面全体を貫く。
          位置は rAF が毎フレーム、共有のS字カーブに沿って更新する */}
      <div className="noroshi-layer" ref={layerRef}>
        {risingChars.map((c) => {
          const meta = flightMetaRef.current.get(c.id)
          const initial = meta
            ? noroshiPoint(meta.path, 0, performance.now() / 1000)
            : { x: 0, y: 0 }
          return (
            <span
              key={`c${c.id}`}
              className="noroshi-char"
              ref={(el) => {
                if (el) flightElsRef.current.set(c.id, el)
                else flightElsRef.current.delete(c.id)
              }}
              style={{
                transform: `translate3d(${initial.x}px, ${initial.y}px, 0) translate(-50%, -50%)`,
              }}
            >
              {c.char}
            </span>
          )
        })}
      </div>

      {scene === 'onboarding' && (
        <OnboardingScene
          chooseFinalColor={ensurePapiColor}
          getLandingRect={() =>
            stripRef.current
              ?.querySelector('.papi-mine .papi-hover')
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
