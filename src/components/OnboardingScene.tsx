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
/** 誕生後（画面中央〜ようこそ発話時）のパピの表示幅 */
const BIRTH_PAPI_SIZE = 166
/** 「ぱ」(pa-0) の拡大率。半濁点の丸が主役になる程度の寄り */
const PA_GROW_SCALE = 6

/**
 * オンボーディング用の公式文字SVG（ルール1: public/onboarding/ から
 * assetPath 経由で読み込む。原典は design/onboarding/ — 変更禁止）。
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
  const [papiPos, setPapiPos] = useState<{ left: number; top: number } | null>(
    null,
  )
  const [papiTransform, setPapiTransform] = useState<string | null>(null)
  const [eyes, setEyes] = useState(false)
  const [wings, setWings] = useState(false)
  const [flapping, setFlapping] = useState(false)
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
    for (const name of new Set(Object.values(ONB_CHAR_SVG))) {
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

    // 4: 「ぱ」(pa-0) を、半濁点の丸が主役になる程度に軽く寄せて拡大
    //    （文字全体は画面にとどまったまま）
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

    // 5: 誕生は「ぱ」の半濁点の丸の位置で起きる。
    //    丸（リング）の上に Papi の体をぴったり重ね、文字の一部が
    //    生き物になっていく。pa-0 の丸: viewBox(33×38) 内の
    //    中心(27.94, 4.55)・外径9.06
    const grown = pa.getBoundingClientRect()
    const rootNow = root.getBoundingClientRect()
    const maruCx = grown.left - rootNow.left + grown.width * (27.94 / 33)
    const maruCy = grown.top - rootNow.top + grown.height * (4.55 / 38)
    const maruD = grown.width * (9.06 / 33)
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
    setPapiTransform(`translate(${t0x}px, ${t0y}px) scale(${scale0})`)
    await wait(BEAT * 3)

    // 6: 誕生（各1拍以上あけて、すべて半濁点の丸の位置で）
    setEyes(true) // a. 丸に目が現れる（Papi 内で1回まばたきする）
    await wait(BEAT * 4)
    setMouth('pa') // b. 口（薄ピンク）が「ぱ」の形で現れ、ぱの音が1回鳴る
    playPagyoChar('ぱ')
    await wait(BEAT * 3)
    setMouth('none')
    await wait(BEAT * 2)
    setWings(true) // c. 羽が生える（まだ半濁点の位置のまま）
    await wait(BEAT * 3)
    // d-e. 羽ばたいて文字から飛び立ち、画面中央へ。
    //      文字本体はゆっくりフェードアウトする
    setFlapping(true)
    setPaFading(true)
    setPapiTransform('translate(0px, 0px) scale(1)')
    await wait(BEAT * 8)

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

      {papiPos && (
        <div
          className="onb-papi"
          style={{
            left: papiPos.left,
            top: papiPos.top,
            transform: papiTransform ?? undefined,
          }}
        >
          <div className="onb-papi-inner">
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
