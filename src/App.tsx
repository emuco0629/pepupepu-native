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
import { getOrCreateUserId, joinRoom } from './core/room'
import type { RoomHandle, RoomPost, RoomUser } from './core/room'
import OnboardingScene from './components/OnboardingScene'
import Papi from './components/Papi'
import { mouthForChar } from './components/papiMouth'
import type { PapiMouth } from './components/papiMouth'

/**
 * ルーム画面 room-v2「終わらない空を、7人で漂う部屋」
 *
 *   - 明るいパステルの空（水色→ピンク）を雲がゆっくり流れる
 *   - 部屋は常に7体（人間＋ローカルボットで7を維持）。
 *     人間が入るとボットが1体その場で薄れて譲り、
 *     新しく来た人は画面下からふわっと昇って自分のレーンに収まる
 *   - 7体は異なる高さのレーンに割り当てられ、個体差の速度で
 *     ゆっくり横方向に漂う（端ではゆるく折り返す）
 *   - 投稿はパ行変換され、話者の少し上の吹き出しに220msのリズムで
 *     1文字ずつ現れる（口パク＋パ音つき）。連投すると古い吹き出しは
 *     上に流れながら消えていく
 *   - のろし演出と星は room-v2 では使わない
 *     （コードは src/legacy/RoomV1Noroshi.tsx に未使用のまま残してある）
 *
 * 位置・透明度は中央1本の rAF が直接 DOM を更新する（React は構造のみ）。
 */

/** 部屋の定員 = レーン数。人間＋ボットで常にこの数を保つ */
const SLOT_COUNT = 7
/** パピの表示幅（原典 92:50 なので高さは自動で約35px） */
const PAPI_W = 64
const PAPI_H = (PAPI_W * 50) / 92
/** 横漂いの速度レンジ（px/秒） */
const DRIFT_MIN = 7
const DRIFT_RANGE = 12
/** 発話終了後、吹き出しがその場にとどまる時間（ms） */
const BUBBLE_HOLD_MS = 1600

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

type CharaState = 'entering' | 'in' | 'leaving' | 'out'

/** 漂うキャラのシミュレーション状態（rAFだけが読み書きする連続量を含む） */
interface CharaSim {
  id: string
  isMe: boolean
  lane: number
  x: number // -1 = 未配置（初回フレームでレーン内のランダム位置に置く）
  y: number
  dir: 1 | -1
  dirEase: number
  speed: number
  bobPhase: number
  bobSpeed: number
  opacity: number
  state: CharaState
}

/** React が描画するキャラの構造情報（連続量は持たない） */
interface CharaView {
  id: string
  color: string
  isMe: boolean
}

interface BubbleView {
  id: number
  charaId: string
  text: string
  shown: number
}

interface BubbleMeta {
  x: number
  y: number
  opacity: number
  /** typing = 話者に追従して1文字ずつ表示中 / floating = 上に流れて消えていく */
  phase: 'typing' | 'floating'
  /** 発話終了後この時刻まではその場にとどまる（0 = 発話中） */
  holdUntil: number
}

const rand = (min: number, range: number) => min + Math.random() * range

/** レーンの中心 y。縦長画面では縦の分散を広めにとる */
const laneY = (lane: number, H: number, W: number) => {
  const portrait = H >= W
  const top = H * (portrait ? 0.07 : 0.1)
  const span = H * (portrait ? 0.62 : 0.52)
  return top + ((lane + 0.5) / SLOT_COUNT) * span
}

function makeSim(id: string, isMe: boolean, lane: number): CharaSim {
  return {
    id,
    isMe,
    lane,
    x: -1,
    y: -1,
    dir: Math.random() < 0.5 ? 1 : -1,
    dirEase: 0,
    speed: rand(DRIFT_MIN, DRIFT_RANGE),
    bobPhase: Math.random() * Math.PI * 2,
    bobSpeed: rand(1.1, 0.9),
    opacity: 0,
    // 自分は登場アニメなし（オンボーディングの降下が登場演出を担う）
    state: isMe ? 'in' : 'entering',
  }
}

function App() {
  // 起動時はオンボーディング（誕生シーン）。ルーム画面は背後にマウントして
  // 空を共有し、終了時にパピがシームレスに引き継がれる
  const [scene, setScene] = useState<'onboarding' | 'room'>('onboarding')
  // 自分のパピの色。誕生時にパレットからランダムに決まり localStorage に残る。
  // まだ決まっていない初回は案内役の白で誕生シーンが進む
  const [papiColor, setPapiColor] = useState(
    () => getStoredPapiColor() ?? GUIDE_COLOR,
  )
  const [dictReady, setDictReady] = useState(false)
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<'idle' | 'busy'>('idle')
  /** 在室中の他ユーザー（自分は含まない） */
  const [others, setOthers] = useState<RoomUser[]>([])
  /** 発話のためだけに現れている不在ユーザー（発話が終わると退場） */
  const [visitors, setVisitors] = useState<RoomUser[]>([])
  /** 画面にいるキャラ（退場アニメ中も含む） */
  const [charaViews, setCharaViews] = useState<CharaView[]>([])
  /** キャラごとの口の形（220ms周期で切り替わる） */
  const [mouths, setMouths] = useState<Record<string, PapiMouth>>({})
  const [bubbles, setBubbles] = useState<BubbleView[]>([])

  const roomRef = useRef<RoomHandle | null>(null)
  /** アクティブなボットのハンドル（id → BotHandle） */
  const botHandlesRef = useRef(new Map<string, BotHandle>())
  /** 入室エフェクト（マウント時1回）から最新の色を読むための ref */
  const papiColorRef = useRef(papiColor)
  useEffect(() => {
    papiColorRef.current = papiColor
  }, [papiColor])
  /** rAF から現在のシーンを読む（オンボーディング中は自分を静止させる） */
  const sceneRef = useRef(scene)
  useEffect(() => {
    sceneRef.current = scene
  }, [scene])

  /** キャラのシミュレーション状態と DOM 要素（rAF が直接更新する） */
  const simsRef = useRef(new Map<string, CharaSim>())
  const charaEls = useRef(new Map<string, HTMLDivElement>())
  /** 吹き出しのメタ情報と DOM 要素（同上） */
  const bubbleEls = useRef(new Map<number, HTMLDivElement>())
  const bubbleMetaRef = useRef(new Map<number, BubbleMeta>())
  /** 話者ごとの最新の吹き出しID（連投時に古いのを切り離す） */
  const lastBubbleOf = useRef(new Map<string, number>())
  const nextBubbleId = useRef(0)
  /** ユーザーごとの発話キュー（同じ人の投稿が重なったら順番に演じる） */
  const speechChainsRef = useRef(new Map<string, Promise<void>>())
  /** 訪問者ごとの未消化の発話数。0になるまで訪問者を退場させない */
  const pendingSpeechRef = useRef(new Map<string, number>())
  const activeNoroshiRef = useRef(new Set<NoroshiHandle>())
  const timersRef = useRef(new Set<ReturnType<typeof setInterval>>())
  const fieldRef = useRef<HTMLDivElement>(null)

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

  // 表示上の訪問者（presence にいる人は presence 側を優先）とボット数
  const visitorsShown = visitors.filter(
    (v) => !others.some((o) => o.id === v.id),
  )
  const botCount = Math.max(
    0,
    SLOT_COUNT - 1 - others.length - visitorsShown.length,
  )

  /**
   * メンバーシップ調停: 望ましい構成（自分＋在室者＋訪問者＋ボット）と
   * 現在のシミュレーション状態の差分から、登場・退場を発火する。
   *   - いなくなった人・譲るボット → その場で薄れて消える（leaving）
   *   - 新しく来た人・補充ボット → 画面下からふわっと昇る（entering）
   *   - 自分だけは登場アニメなし（オンボーディングの降下が担う）
   */
  useEffect(() => {
    const desired: CharaView[] = [
      { id: ME_ID, color: papiColor, isMe: true },
      ...others.map((u) => ({ id: u.id, color: u.color, isMe: false })),
      ...visitorsShown.map((v) => ({ id: v.id, color: v.color, isMe: false })),
      ...BOT_POOL.slice(0, botCount).map((b) => ({
        id: b.id,
        color: b.color,
        isMe: false,
      })),
    ]
    const desiredIds = new Set(desired.map((d) => d.id))
    const sims = simsRef.current

    // 退場: 望ましい構成にいないキャラはその場で薄れて消える
    for (const sim of sims.values()) {
      if (!desiredIds.has(sim.id) && sim.state !== 'leaving' && sim.state !== 'out') {
        sim.state = 'leaving'
      }
    }

    // 登場: 新しい id はレーンを割り当てて画面下から昇らせる。
    // 消えかけの同じ id が戻ってきたらそのまま復帰させる
    for (const d of desired) {
      const existing = sims.get(d.id)
      if (existing) {
        if (existing.state === 'leaving') existing.state = 'in'
        continue
      }
      // レーンは生きているキャラが使っていない最小番号
      // （leaving 中のレーンはそのまま引き継ぐ = 譲られたレーンに入る）。
      // 自分だけは中央のレーンを優先する
      const usedLanes = new Set(
        [...sims.values()]
          .filter((s) => s.state === 'entering' || s.state === 'in')
          .map((s) => s.lane),
      )
      const middle = Math.floor(SLOT_COUNT / 2)
      let lane = -1
      if (d.isMe && !usedLanes.has(middle)) {
        lane = middle
      } else {
        for (let l = 0; l < SLOT_COUNT; l++) {
          if (!usedLanes.has(l)) {
            lane = l
            break
          }
        }
      }
      if (lane < 0) lane = Math.floor(Math.random() * SLOT_COUNT)
      sims.set(d.id, makeSim(d.id, d.isMe, lane))
    }

    // 描画リスト: 望ましい構成 + 退場アニメ中のキャラ（消え終わるまで残す）
    setCharaViews((prev) => [
      ...desired,
      ...prev.filter((v) => {
        const sim = sims.get(v.id)
        return sim && sim.state === 'leaving' && !desiredIds.has(v.id)
      }),
    ])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [others, visitors, papiColor, botCount])

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
            // ボットの台詞も必ず変換エンジンを通す（長音の展開などを揃える）
            queueSpeech(bot.id, safeConvertToPagyo(phrase), BOT_VOICE)
          }),
        )
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, botCount])

  // シミュレーション本体: キャラの漂流と吹き出しの追従・浮上を
  // 中央1本の rAF が直接 DOM に書く（React の再レンダリングは通さない）
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(0.08, (now - last) / 1000)
      last = now
      const field = fieldRef.current
      if (!field) {
        raf = requestAnimationFrame(tick)
        return
      }
      const W = field.clientWidth
      const H = field.clientHeight
      const t = now / 1000

      const gone: string[] = []
      for (const sim of simsRef.current.values()) {
        const el = charaEls.current.get(sim.id)
        if (!el) continue
        if (sim.state === 'out') {
          el.style.opacity = '0'
          continue
        }

        const targetY = laneY(sim.lane, H, W)
        if (sim.x < 0) {
          // 初回配置: レーン内のランダムな横位置。
          // 登場アニメありなら画面下から、なしなら最初からレーンの高さに
          sim.x = rand(50, Math.max(60, W - 100))
          sim.y = sim.state === 'entering' ? H + 60 : targetY
          if (sim.state !== 'entering') sim.opacity = 1
        }

        if (sim.state === 'entering') {
          // ログイン・補充: 画面下からふわっと昇って自分のレーンへ
          sim.opacity = Math.min(1, sim.opacity + dt * 1.4)
          sim.y += (targetY - sim.y) * Math.min(1, dt * 1.6)
          if (Math.abs(sim.y - targetY) < 6) sim.state = 'in'
        } else if (sim.state === 'leaving') {
          // ログアウト・譲り: その場で薄れて消える
          sim.opacity -= dt / 1.4
          if (sim.opacity <= 0) {
            sim.opacity = 0
            sim.state = 'out'
            el.style.opacity = '0'
            gone.push(sim.id)
            continue
          }
        } else {
          sim.opacity = Math.min(1, sim.opacity + dt * 1.4)
          sim.y += (targetY - sim.y) * Math.min(1, dt * 1.2)
        }

        // 横漂い: 個体差の速度で流れ、端に来たらゆるく折り返す。
        // オンボーディング中の自分は静止（降下先の座標がずれないように）
        const frozen = sim.isMe && sceneRef.current === 'onboarding'
        if (!frozen) {
          if (sim.x > W - 44) sim.dir = -1
          else if (sim.x < 44) sim.dir = 1
          sim.dirEase += (sim.dir - sim.dirEase) * Math.min(1, dt * 0.8)
          sim.x += sim.dirEase * sim.speed * dt
        }

        const bob = frozen ? 0 : Math.sin(t * sim.bobSpeed + sim.bobPhase) * 5
        el.style.transform = `translate3d(${sim.x - PAPI_W / 2}px, ${sim.y - PAPI_H / 2 + bob}px, 0)`
        el.style.opacity = String(sim.opacity)
      }
      if (gone.length > 0) {
        for (const id of gone) simsRef.current.delete(id)
        setCharaViews((prev) => prev.filter((v) => !gone.includes(v.id)))
      }

      // 吹き出し: typing 中は話者の少し上に追従、その後は上に流れて消える
      const goneBubbles: number[] = []
      for (const [id, meta] of bubbleMetaRef.current) {
        const el = bubbleEls.current.get(id)
        if (!el) continue
        if (meta.phase === 'typing') {
          const owner = simsRef.current.get(el.dataset.chara ?? '')
          if (owner && owner.x >= 0) {
            meta.x = owner.x
            meta.y = owner.y - PAPI_H / 2 - 12
          }
          if (meta.holdUntil > 0 && now > meta.holdUntil) {
            meta.phase = 'floating'
          }
        } else {
          meta.y -= 22 * dt
          meta.opacity -= dt / 3
          if (meta.opacity <= 0) {
            goneBubbles.push(id)
            continue
          }
        }
        el.style.transform = `translate3d(${meta.x}px, ${meta.y}px, 0) translate(-50%, -100%)`
        el.style.opacity = String(Math.min(1, meta.opacity))
      }
      if (goneBubbles.length > 0) {
        for (const id of goneBubbles) bubbleMetaRef.current.delete(id)
        setBubbles((prev) => prev.filter((b) => !goneBubbles.includes(b.id)))
      }

      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  /**
   * 発話: 話者の頭上に吹き出しを作り、220msののろしリズムで
   * 1文字ずつ表示しながら口パク＋パ音を鳴らす。
   * 同じ話者の前の吹き出しは切り離して上へ流す（連投で次々流れていく）。
   */
  const speak = (
    charaId: string,
    pagyo: string,
    voice?: PlayVoiceOptions,
    onTick?: () => void,
  ): Promise<void> =>
    new Promise((resolve) => {
      const sim = simsRef.current.get(charaId)
      if (!sim || !pagyo || sim.state === 'leaving' || sim.state === 'out') {
        resolve()
        return
      }

      // 古い吹き出しを切り離して上へ
      const prevId = lastBubbleOf.current.get(charaId)
      if (prevId !== undefined) {
        const prev = bubbleMetaRef.current.get(prevId)
        if (prev && prev.phase === 'typing') prev.phase = 'floating'
      }

      const id = nextBubbleId.current++
      lastBubbleOf.current.set(charaId, id)
      bubbleMetaRef.current.set(id, {
        x: sim.x,
        y: sim.y - PAPI_H / 2 - 12,
        opacity: 1,
        phase: 'typing',
        holdUntil: 0,
      })
      setBubbles((prev) => [...prev, { id, charaId, text: pagyo, shown: 0 }])

      const handle = startNoroshi(
        pagyo,
        ({ char, index }) => {
          playPagyoChar(char, voice)
          setMouths((prev) => ({ ...prev, [charaId]: mouthForChar(char) }))
          setBubbles((prev) =>
            prev.map((b) => (b.id === id ? { ...b, shown: index + 1 } : b)),
          )
          onTick?.()
        },
        () => {
          activeNoroshiRef.current.delete(handle)
          setMouths((prev) => ({ ...prev, [charaId]: 'none' }))
          const meta = bubbleMetaRef.current.get(id)
          if (meta) meta.holdUntil = performance.now() + BUBBLE_HOLD_MS
          resolve()
        },
      )
      activeNoroshiRef.current.add(handle)
    })

  /** 発話をユーザーごとのキューに積む（同じ人の投稿が重なったら順番に演じる） */
  const queueSpeech = (
    charaId: string,
    pagyo: string,
    voice?: PlayVoiceOptions,
  ) => {
    const prevChain = speechChainsRef.current.get(charaId) ?? Promise.resolve()
    speechChainsRef.current.set(
      charaId,
      prevChain.then(() => speak(charaId, pagyo, voice)),
    )
  }

  /** 受信した投稿を発話キューに積む（登場の1拍を待ってから話し出す） */
  const queueRemotePost = (post: RoomPost, voice: PlayVoiceOptions) => {
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
              // 登場直後は位置が定まっていないことがあるので少し待つ
              const t = setTimeout(() => {
                timersRef.current.delete(t)
                r()
              }, NOROSHI_INTERVAL_MS * 2)
              timersRef.current.add(t)
            }),
        )
        .then(() => speak(post.userId, post.pagyo, voice))
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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (phase !== 'idle' || !dictReady) return
    const original = text.trim()
    if (!original) return

    setPhase('busy')
    const pagyo = safeConvertToPagyo(original)

    // ルームへ送信するのは変換後のパ行文字列のみ（プライバシー原則:
    // 原文 original は、いかなる形でもネットワークに送らない）
    roomRef.current?.post(pagyo)

    // ボイスの準備（デコード完了 + AudioContext running、タイムアウト付き）は
    // 変身アニメーションの裏で並行して待ち、体感の待ち時間をゼロに近づける
    const voicesReady = whenVoicesReady()
    await morphInInput(original, pagyo)
    await voicesReady

    // 吹き出しに1文字現れるたび、入力欄に残っている文字が1つ減っていく
    await speak(ME_ID, pagyo, undefined, () =>
      setText((prev) => Array.from(prev).slice(1).join('')),
    )
    setText('')
    setPhase('idle')

    // ボットに知らせる（かぶらないよう間を空けて、ときどき相槌が返る）。
    // 全員に知らせると相槌が騒がしいので、最大2体だけ
    const handles = [...botHandlesRef.current.values()]
    handles.sort(() => Math.random() - 0.5)
    for (const h of handles.slice(0, 2)) h.notifyUserPost()
  }

  return (
    <div
      className={`app${scene === 'onboarding' ? ' app-onboarding' : ''}`}
      style={{ '--papi-color': papiColor } as CSSProperties}
    >
      <div className="cloud cloud-1" />
      <div className="cloud cloud-2" />
      <div className="cloud cloud-3" />
      <div className="cloud cloud-4" />

      <div className="field" ref={fieldRef}>
        {charaViews.map((v) => (
          <div
            key={v.id}
            className={`chara${v.isMe ? ' chara-mine' : ''}`}
            // 初回フレームで rAF が配置するまでは見せない（左上に一瞬出る事故防止）
            style={{ opacity: 0 }}
            ref={(el) => {
              if (el) charaEls.current.set(v.id, el)
              else charaEls.current.delete(v.id)
            }}
          >
            <Papi
              mouth={mouths[v.id] ?? 'none'}
              color={v.color}
              mouthColor={mouthColorFor(v.color)}
              wingColor={wingColorFor(v.color)}
              size={PAPI_W}
            />
          </div>
        ))}

        {bubbles.map((b) => {
          const meta = bubbleMetaRef.current.get(b.id)
          return (
            <div
              key={b.id}
              className="bubble"
              data-chara={b.charaId}
              style={
                meta
                  ? {
                      transform: `translate3d(${meta.x}px, ${meta.y}px, 0) translate(-50%, -100%)`,
                      opacity: b.shown > 0 ? 1 : 0,
                    }
                  : { opacity: 0 }
              }
              ref={(el) => {
                if (el) bubbleEls.current.set(b.id, el)
                else bubbleEls.current.delete(b.id)
              }}
            >
              {Array.from(b.text).slice(0, b.shown).join('')}
            </div>
          )
        })}
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
            fieldRef.current
              ?.querySelector('.chara-mine')
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
