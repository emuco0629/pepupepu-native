import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import {
  installAudioUnlockHandler,
  playPagyoChar,
  preloadVoiceSamples,
  whenVoicesReady,
} from './core/audio'
import { NOROSHI_INTERVAL_MS } from './core/constants'
import { initTokenizer, safeConvertToPagyo } from './core/convert/papipupepo'
import { startNoroshi } from './core/noroshi'
import type { NoroshiHandle } from './core/noroshi'
import OnboardingScene from './components/OnboardingScene'
import WanderingPapi from './components/WanderingPapi'
import { mouthForChar } from './components/papiMouth'
import type { PapiMouth } from './components/papiMouth'

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

/** 現在のユーザーのパピの色（ユーザーごとに変わる想定。参照元はここだけ） */
const PAPI_COLOR = '#FFFFFF'

/**
 * 白い体のパピは、口を背景（夜空）色でくり抜いたように見せる。
 * ルームのパピは最下段バンドの上にいるので、その色に合わせる
 * （index.css の夜空グラデーション最下段 #9a89c7 と同期）。
 * 白以外の体の口は白のまま。
 */
const PAPI_MOUTH_COLOR =
  PAPI_COLOR.toLowerCase() === '#ffffff' ? '#9A89C7' : 'white'

/**
 * オンボーディング中のパピは画面中央（夜空の2段目バンドの上）にいるため、
 * 口のくり抜き色はそのバンド色に合わせる（index.css の #4e4379 と同期。
 * public/onboarding/pa-1.svg の丸キャラの口も同色）。
 */
const ONB_PAPI_MOUTH_COLOR =
  PAPI_COLOR.toLowerCase() === '#ffffff' ? '#4E4379' : 'white'

/** 白い体のとき、羽にごく薄い明度差をつけて体との重なりを見せる */
const PAPI_WING_COLOR =
  PAPI_COLOR.toLowerCase() === '#ffffff' ? '#EFEAF7' : undefined

/** のろし文字が星に変わるまでの上昇時間（ms）。ゆったり漂う速さ */
const RISE_DURATION_MS = 4800

/** パピの色を ratio ぶん白に寄せた色（星の色 = わずかに色を帯びた白） */
function tintTowardWhite(papiColor: string, whiteRatio: number): string {
  const hex = papiColor.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const mix = (c: number) => Math.round(255 * whiteRatio + c * (1 - whiteRatio))
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`
}

const STAR_COLOR = tintTowardWhite(PAPI_COLOR, 0.8)
const STAR_GLOW = tintTowardWhite(PAPI_COLOR, 0.45)

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
}

function App() {
  // 起動時はオンボーディング（誕生シーン）。ルーム画面は背後にマウントして
  // 夜空を共有し、終了時にパピがシームレスに引き継がれる
  const [scene, setScene] = useState<'onboarding' | 'room'>('onboarding')
  const [dictReady, setDictReady] = useState(false)
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<'idle' | 'busy'>('idle')
  const [mouth, setMouth] = useState<PapiMouth>('none')
  const [risingChars, setRisingChars] = useState<RisingChar[]>([])
  const [stars, setStars] = useState<Star[]>([])

  const noroshiRef = useRef<NoroshiHandle | null>(null)
  /** パピの現在の中心 x（papi-strip 基準・px）。WanderingPapi が毎フレーム更新 */
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
    return () => {
      removeUnlockHandler()
      noroshiRef.current?.stop()
      for (const t of timers) clearInterval(t)
      cancelAnimationFrame(flightRafRef.current)
    }
  }, [])

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
  const spawnRisingChar = (char: string, path: NoroshiPath) => {
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
        },
      ])
    }, RISE_DURATION_MS)
    timersRef.current.add(timer)
  }

  /**
   * 入力欄の中で、文字を先頭から1文字ずつパ行に置き換えていく。
   * テンポはパ音のリズム（NOROSHI_INTERVAL_MS）に揃え、化けるたびに
   * その文字の音を鳴らす（ボイス未準備なら黙って進む）。
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
        playPagyoChar(pagyoChars[k - 1])
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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (phase !== 'idle' || !dictReady) return
    const original = text.trim()
    if (!original) return

    setPhase('busy') // パピはここから発話終了まで立ち止まる
    const pagyo = safeConvertToPagyo(original)

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
            stripRect.top - layerRect.top + 4,
            layerRect.width,
            layerRect.height,
          )
        : makeNoroshiPath(60, 640, 375, 812)

    noroshiRef.current = startNoroshi(
      pagyo,
      ({ char }) => {
        playPagyoChar(char)
        setMouth(mouthForChar(char))
        spawnRisingChar(char, path)
        // 先頭の文字が飛び立ち、入力欄に残っている文字が減っていく
        setText((prev) => Array.from(prev).slice(1).join(''))
      },
      () => {
        setMouth('none')
        setText('')
        setPhase('idle') // さまよい再開
      },
    )
  }

  return (
    <div
      className={`app${scene === 'onboarding' ? ' app-onboarding' : ''}`}
      style={
        {
          '--papi-color': PAPI_COLOR,
          '--star-color': STAR_COLOR,
          '--star-glow': STAR_GLOW,
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
              } as CSSProperties
            }
          />
        ))}
      </div>

      <div className="room-bottom">
        <div className="papi-strip" ref={stripRef}>
          <WanderingPapi
            mouth={mouth}
            color={PAPI_COLOR}
            mouthColor={PAPI_MOUTH_COLOR}
            wingColor={PAPI_WING_COLOR}
            size={72}
            paused={phase !== 'idle' || scene !== 'room'}
            xRef={papiXRef}
          />
        </div>
        <form className="room-form" onSubmit={handleSubmit}>
          <input
            className="room-input"
            type="text"
            value={text}
            onChange={(e) => phase === 'idle' && setText(e.target.value)}
            readOnly={phase !== 'idle'}
            placeholder="ことばをのろしに"
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
          papiColor={PAPI_COLOR}
          papiMouthColor={ONB_PAPI_MOUTH_COLOR}
          papiWingColor={PAPI_WING_COLOR}
          getLandingRect={() =>
            stripRef.current
              ?.querySelector('.papi-wander')
              ?.getBoundingClientRect() ?? null
          }
          onFinish={() => setScene('room')}
        />
      )}
    </div>
  )
}

export default App
