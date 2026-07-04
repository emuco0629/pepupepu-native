import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { assetPath } from '../core/assetPath'
import { playPagyoChar, whenVoicesReady } from '../core/audio'
import { NOROSHI_INTERVAL_MS } from '../core/constants'
import { safeConvertToPagyo } from '../core/convert/papipupepo'
import { startNoroshi } from '../core/noroshi'
import type { NoroshiHandle } from '../core/noroshi'
import Papi from './Papi'
import { mouthForChar } from './papiMouth'
import type { PapiMouth } from './papiMouth'

/**
 * オンボーディング（誕生シーン）
 * アプリを開いた人が最初に見る演出。すべて220msののろしリズムを基準に進む。
 *
 *   0. タイトル「ぺぷぺぷぺぷ」+「タップしてはじめる」
 *      （タップで音声アンロック（ルール2、App の unlock ハンドラ）と同時に開始）
 *   1. 「こんにちは」が中央に現れる
 *   2. 先頭から220ms間隔でぽぷぴぴぱに化けていく（1文字ごとに音）
 *   3. 最後の「ぱ」以外がゆっくり消える
 *   4. 「ぱ」が画面中央へゆっくり拡大
 *   5. 「ぱ」がフェードアウトし、同じ位置に白い円（体だけのパピ）が現れる
 *   6. 誕生: 目（＋まばたき1回）→ 口ぱ＋音 → 羽 → 羽ばたき＆浮上（各1拍以上あけて）
 *   7. 「ぺぷぺぷぺぷへようこそ」を発話（既存ののろしスケジューラを再利用）
 *   8. ルーム画面のパピの定位置へ降りていき、シームレスに切り替わる
 *
 * 画面のどこをタップしても即スキップして onFinish が呼ばれる。
 * 背景は透過で、背後にマウントされているルーム画面の夜空をそのまま使う。
 */

const BEAT = NOROSHI_INTERVAL_MS
const GREETING = 'こんにちは'
const WELCOME = 'ぺぷぺぷぺぷへようこそ'
/** 誕生時のパピの表示幅 */
const BIRTH_PAPI_SIZE = 166
/** 「ぱ」(pa-0) の拡大率 */
const PA_GROW_SCALE = 3

/**
 * オンボーディング用の公式文字SVG（ルール1: public/onboarding/ から
 * assetPath 経由で読み込む。原典は design/onboarding/ — 変更禁止）。
 * pa-1.svg は「ぱ」の半濁点の丸がキャラクター（体・ぱの口・目）に
 * なった誕生の絵。丸は viewBox(80×93) 内の中心(69,11)・直径22。
 */
const ONB_CHAR_SVG: Record<string, string> = {
  'こ': 'ko',
  'ん': 'n',
  'に': 'ni',
  'ち': 'chi',
  'は': 'ha',
  'ぽ': 'po',
  'ぷ': 'pu-0',
  'ぴ': 'pi-0',
  'ぱ': 'pa-0',
}

const onbSvgPath = (name: string) => assetPath(`onboarding/${name}.svg`)

interface OnboardingSceneProps {
  papiColor: string
  papiMouthColor: string
  papiWingColor?: string
  /** ルーム画面のパピの定位置（降下先）。降下開始時に呼ばれる */
  getLandingRect: () => DOMRect | null
  onFinish: () => void
}

function OnboardingScene({
  papiColor,
  papiMouthColor,
  papiWingColor,
  getLandingRect,
  onFinish,
}: OnboardingSceneProps) {
  const [titleFading, setTitleFading] = useState(false)
  const [titleGone, setTitleGone] = useState(false)
  const [chars, setChars] = useState<string[]>([])
  const [othersFaded, setOthersFaded] = useState(false)
  const [paStyle, setPaStyle] = useState<CSSProperties>()
  const [paFading, setPaFading] = useState(false)
  /** 誕生の絵 pa-1.svg（丸に顔が宿った「ぱ」）の表示位置。拡大後の pa-0 に重ねる */
  const [pa1Rect, setPa1Rect] = useState<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)
  const [pa1Fading, setPa1Fading] = useState(false)
  const [papiPos, setPapiPos] = useState<{ left: number; top: number } | null>(
    null,
  )
  const [papiTransform, setPapiTransform] = useState<string | null>(null)
  const [eyes, setEyes] = useState(false)
  const [wings, setWings] = useState(false)
  const [flapping, setFlapping] = useState(false)
  const [floated, setFloated] = useState(false)
  const [mouth, setMouth] = useState<PapiMouth>('none')
  const [welcomeText, setWelcomeText] = useState('')
  const [welcomeFading, setWelcomeFading] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  const paCharRef = useRef<HTMLImageElement>(null)
  const noroshiRef = useRef<NoroshiHandle | null>(null)
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>())
  const startedRef = useRef(false)

  useEffect(() => {
    // 文字SVGを先読みして、化けの瞬間のちらつきを防ぐ
    for (const name of [...new Set(Object.values(ONB_CHAR_SVG)), 'pa-1']) {
      const img = new Image()
      img.src = onbSvgPath(name)
    }
    const timers = timersRef.current
    return () => {
      noroshiRef.current?.stop()
      for (const t of timers) clearTimeout(t)
    }
  }, [])

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        timersRef.current.delete(t)
        resolve()
      }, ms)
      timersRef.current.add(t)
    })

  const runScript = async () => {
    // 0 → 1: タイトルが消え、「こんにちは」が現れる
    setTitleFading(true)
    void whenVoicesReady() // ボイスのデコードを裏で進めておく
    await wait(BEAT * 3)
    setTitleGone(true)
    setChars(Array.from(GREETING))
    await wait(BEAT * 5)

    // 2: 先頭から220ms間隔でパ行に化けていく（1文字ごとに音）
    const pagyoChars = Array.from(safeConvertToPagyo(GREETING)) // ぽぷぴぴぱ
    for (let i = 0; i < pagyoChars.length; i++) {
      setChars((prev) => prev.map((c, j) => (j === i ? pagyoChars[i] : c)))
      playPagyoChar(pagyoChars[i])
      await wait(BEAT)
    }
    await wait(BEAT * 3)

    // 3: 最後の「ぱ」以外がゆっくり消える
    setOthersFaded(true)
    await wait(BEAT * 5)

    // 4: 「ぱ」(pa-0) が画面中央へゆっくり拡大
    const root = rootRef.current
    const pa = paCharRef.current
    if (!root || !pa) {
      onFinish()
      return
    }
    const rootRect = root.getBoundingClientRect()
    const paRect = pa.getBoundingClientRect()
    const center = {
      x: rootRect.width / 2,
      y: rootRect.height * 0.45,
    }
    const dx = rootRect.left + center.x - (paRect.left + paRect.width / 2)
    const dy = rootRect.top + center.y - (paRect.top + paRect.height / 2)
    setPaStyle({
      transform: `translate(${dx}px, ${dy}px) scale(${PA_GROW_SCALE})`,
    })
    await wait(BEAT * 8)

    // 5: 丸に顔が宿る。拡大した pa-0 の上に pa-1（丸がキャラの「ぱ」）を
    //    重ねてクロスフェードする
    const grown = pa.getBoundingClientRect()
    const rootNow = root.getBoundingClientRect()
    const pa1 = {
      left: grown.left - rootNow.left,
      top: grown.top - rootNow.top,
      width: grown.width,
      height: grown.height,
    }
    setPa1Rect(pa1)
    setPaFading(true)
    await wait(BEAT * 5)

    // 5.5: 丸のキャラクターを既存の Papi コンポーネントへ引き継ぎ、
    //      中央へゆっくり成長させる。顔（目）は丸で誕生済みなのでそのまま。
    //      pa-1 の丸は viewBox(80×93) 内の中心(69,11)・直径22
    const maruCx = pa1.left + pa1.width * (69 / 80)
    const maruCy = pa1.top + pa1.height * (11 / 93)
    const maruD = pa1.width * (22 / 80)
    const pos = {
      left: center.x - BIRTH_PAPI_SIZE / 2, // 体の円の中心は viewBox のちょうど半分
      top: center.y - (BIRTH_PAPI_SIZE * 25) / 92, // 体の中心 y = 25/92 × 幅
    }
    // Papi の体の円（wrapper ローカルで中心 (S/2, S·25/92)・直径 S·50/92）を
    // 丸にぴったり重ねる初期 transform（transform-origin: 0 0）
    const scale0 = maruD / ((BIRTH_PAPI_SIZE * 50) / 92)
    const t0x = maruCx - pos.left - scale0 * (BIRTH_PAPI_SIZE / 2)
    const t0y = maruCy - pos.top - scale0 * ((BIRTH_PAPI_SIZE * 25) / 92)
    setPapiPos(pos)
    setEyes(true)
    setPapiTransform(`translate(${t0x}px, ${t0y}px) scale(${scale0})`)
    setPa1Fading(true)
    await wait(BEAT * 3)
    setPapiTransform('translate(0px, 0px) scale(1)')
    await wait(BEAT * 8)

    // 6: 誕生の続き（各ステップ1拍以上あけて）
    setMouth('pa') // 口が「ぱ」で開き、音が1回鳴る
    playPagyoChar('ぱ')
    await wait(BEAT * 3)
    setMouth('none')
    await wait(BEAT * 2)
    setWings(true) // c. 羽が生える（まだ静止・コマ1）
    await wait(BEAT * 3)
    setFlapping(true) // d. 羽ばたきが始まり、ふわっと浮き上がる
    setFloated(true)
    await wait(BEAT * 5)

    // 7: ようこそ発話（既存ののろしスケジューラを再利用）
    const welcome = safeConvertToPagyo(WELCOME)
    await new Promise<void>((resolve) => {
      noroshiRef.current = startNoroshi(
        welcome,
        ({ char }) => {
          playPagyoChar(char)
          setMouth(mouthForChar(char))
          setWelcomeText((prev) => prev + char)
        },
        () => {
          setMouth('none')
          resolve()
        },
      )
    })
    await wait(BEAT * 4)

    // 8: ルーム画面のパピの定位置へ降りていく
    setWelcomeFading(true)
    const landing = getLandingRect()
    if (landing) {
      const currentRootRect = root.getBoundingClientRect()
      const scale = landing.width / BIRTH_PAPI_SIZE
      const dxLand = landing.left - (currentRootRect.left + pos.left)
      const dyLand = landing.top - (currentRootRect.top + pos.top)
      setFloated(false) // 浮上ぶんを戻して着地位置をぴったり合わせる
      setPapiTransform(
        `translate(${dxLand}px, ${dyLand}px) scale(${scale})`,
      )
    }
    await wait(1700)
    onFinish()
  }

  const handlePointerDown = () => {
    if (!startedRef.current) {
      // 最初のタップ = 開始（同じタップで App の unlock ハンドラが音声を解錠する）
      startedRef.current = true
      void runScript()
    } else {
      // 以降はどこをタップしても即スキップ
      onFinish()
    }
  }

  return (
    <div className="onb-scene" ref={rootRef} onPointerDown={handlePointerDown}>
      {!titleGone && (
        <div className={`onb-title-wrap${titleFading ? ' onb-fade-out' : ''}`}>
          <h1 className="onb-title">ぺぷぺぷぺぷ</h1>
          <p className="onb-tap">タップしてはじめる</p>
        </div>
      )}

      {chars.length > 0 && (
        <div className="onb-greeting">
          {chars.map((ch, i) => {
            const isLast = i === chars.length - 1
            return (
              <img
                key={i}
                ref={isLast ? paCharRef : undefined}
                className={`onb-char${
                  (isLast ? paFading : othersFaded) ? ' onb-fade-out' : ''
                }`}
                style={isLast ? paStyle : undefined}
                src={onbSvgPath(ONB_CHAR_SVG[ch] ?? 'pa-0')}
                alt={ch}
                draggable={false}
              />
            )
          })}
        </div>
      )}

      {pa1Rect && (
        <img
          className={`onb-pa1${pa1Fading ? ' onb-fade-out' : ''}`}
          src={onbSvgPath('pa-1')}
          alt="ぱ"
          draggable={false}
          style={{
            left: pa1Rect.left,
            top: pa1Rect.top,
            width: pa1Rect.width,
            height: pa1Rect.height,
          }}
        />
      )}

      {papiPos && (
        <div
          className="onb-papi"
          style={{
            left: papiPos.left,
            top: papiPos.top,
            transform: papiTransform ?? undefined,
          }}
        >
          <div className={`onb-papi-inner${floated ? ' onb-floated' : ''}`}>
            <Papi
              mouth={mouth}
              color={papiColor}
              mouthColor={papiMouthColor}
              wingColor={papiWingColor}
              wings={wings}
              eyes={eyes}
              flapping={flapping}
              size={BIRTH_PAPI_SIZE}
            />
          </div>
        </div>
      )}

      {welcomeText && papiPos && (
        <p
          className={`onb-welcome${welcomeFading ? ' onb-fade-out' : ''}`}
          style={{
            left: papiPos.left + BIRTH_PAPI_SIZE / 2,
            top: papiPos.top - 48,
          }}
        >
          {welcomeText}
        </p>
      )}
    </div>
  )
}

export default OnboardingScene
