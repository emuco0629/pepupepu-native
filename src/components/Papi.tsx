import { useEffect, useRef, useState } from 'react'
import type { PapiMouth } from './papiMouth'

/**
 * パピ（キャラクター）コンポーネント
 *
 * 形・色・座標はすべて design/papi/ の公式SVG（pa/pi/pu/pe/po × 1/2/3）から
 * 読み取った値。変更するときは必ず原典と突き合わせること。
 *
 * レイヤー構成: 羽（後）→ 体 → 口 → 目
 *   - 羽ばたき: コマ1↔2（羽の角度違い）を約400ms周期で常時切り替え
 *   - まばたき: 数秒に1回、目を閉じた顔（コマ3: 楕円 ry=1）を約150msはさむ
 *   - mouth='none' のとき口は完全に消える（休止時は目だけの顔。これが仕様）
 */

/** 羽ばたきの切り替え周期（ms） */
const WING_FLAP_INTERVAL_MS = 400
/** 目を閉じている時間（ms） */
const BLINK_DURATION_MS = 150
/** 次のまばたきまでの間隔（ms）: MIN + 0〜RANGE のゆらぎ */
const BLINK_INTERVAL_MIN_MS = 2000
const BLINK_INTERVAL_RANGE_MS = 3000

const VIEWBOX_WIDTH = 92
const VIEWBOX_HEIGHT = 50

/** 目の色（原典で固定） */
const EYE_COLOR = '#3E3E3E'

interface PapiProps {
  /** 口の形。'none' で口なし（休止時） */
  mouth?: PapiMouth
  /** 体と羽の色。ユーザーごとに変わるためハードコードしない */
  color?: string
  /** 口の色。デフォルトは白（白い体のパピだけ薄ピンク等に変える） */
  mouthColor?: string
  /** 羽の色。省略時は体と同色。白い体で羽との重なりを見せたいときに使う */
  wingColor?: string
  /** 羽を表示するか（誕生シーンの羽なし状態。原典 pa0.svg 相当） */
  wings?: boolean
  /** 目を表示するか（誕生シーンの体だけの状態） */
  eyes?: boolean
  /** 羽ばたくか。false の間はコマ1で静止する */
  flapping?: boolean
  /** 表示幅（px）。高さは原典の縦横比（92:50）で自動決定 */
  size?: number
}

function Papi({
  mouth = 'none',
  color = '#C8B0FE',
  mouthColor = 'white',
  wingColor,
  wings = true,
  eyes = true,
  flapping = true,
  size = 92,
}: PapiProps) {
  const wingFill = wingColor ?? color
  const [wingFrame, setWingFrame] = useState<1 | 2>(1)
  const [eyesClosed, setEyesClosed] = useState(false)
  const flappingRef = useRef(flapping)
  const prevEyesRef = useRef(eyes)

  useEffect(() => {
    flappingRef.current = flapping
  }, [flapping])

  // 羽ばたき（flapping の間、常時）
  useEffect(() => {
    const id = setInterval(() => {
      if (flappingRef.current) {
        setWingFrame((frame) => (frame === 1 ? 2 : 1))
      }
    }, WING_FLAP_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  // 目が現れた直後（eyes: false → true）に一度まばたきする（誕生シーン用）
  useEffect(() => {
    const wasVisible = prevEyesRef.current
    prevEyesRef.current = eyes
    if (eyes && !wasVisible) {
      const closeTimer = setTimeout(() => setEyesClosed(true), 600)
      const openTimer = setTimeout(
        () => setEyesClosed(false),
        600 + BLINK_DURATION_MS,
      )
      return () => {
        clearTimeout(closeTimer)
        clearTimeout(openTimer)
      }
    }
  }, [eyes])

  // まばたき（数秒に1回、ゆらぎ付き）
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const scheduleBlink = () => {
      timer = setTimeout(
        () => {
          setEyesClosed(true)
          timer = setTimeout(() => {
            setEyesClosed(false)
            scheduleBlink()
          }, BLINK_DURATION_MS)
        },
        BLINK_INTERVAL_MIN_MS + Math.random() * BLINK_INTERVAL_RANGE_MS,
      )
    }
    scheduleBlink()
    return () => clearTimeout(timer)
  }, [])

  return (
    <svg
      width={size}
      height={(size * VIEWBOX_HEIGHT) / VIEWBOX_WIDTH}
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="パピ"
    >
      {/* 羽（後）: コマ1↔2 は角度違い（原典 *1.svg / *2.svg）。
          wings=false（原典 pa0.svg 相当）では描画しない */}
      {wings &&
        (wingFrame === 1 ? (
        <>
          <ellipse
            cx="69.5"
            cy="22.1194"
            rx="17.8885"
            ry="17.2792"
            transform="rotate(161.214 69.5 22.1194)"
            fill={wingFill}
          />
          <ellipse
            cx="17.8885"
            cy="17.2792"
            rx="17.8885"
            ry="17.2792"
            transform="matrix(0.946729 0.32203 0.32203 -0.946729 0 32.7174)"
            fill={wingFill}
          />
        </>
      ) : (
        <>
          <ellipse
            cx="17.8885"
            cy="17.2792"
            rx="17.8885"
            ry="17.2792"
            transform="matrix(-0.946729 -0.32203 -0.32203 0.946729 92 16.5211)"
            fill={wingFill}
          />
          <ellipse
            cx="22.5"
            cy="27.1192"
            rx="17.8885"
            ry="17.2792"
            transform="rotate(-18.7857 22.5 27.1192)"
            fill={wingFill}
          />
        </>
      ))}

      {/* 体 */}
      <circle cx="46.0002" cy="25" r="25" fill={color} />

      {/* 口（中心 46,25、色は mouthColor・デフォルト白）: mouth='none' のときは描画しない */}
      {mouth === 'pa' && <circle cx="46" cy="25" r="11" fill={mouthColor} />}
      {mouth === 'pi' && (
        <ellipse cx="46" cy="25" rx="11" ry="3" fill={mouthColor} />
      )}
      {mouth === 'pu' && <circle cx="46" cy="25" r="5" fill={mouthColor} />}
      {mouth === 'pe' && (
        <path
          d="M45.3782 20.4936C45.7424 20.2045 46.2576 20.2045 46.6218 20.4936L54.146 26.4668C54.8879 27.0557 54.4714 28.25 53.5243 28.25H38.4757C37.5286 28.25 37.1121 27.0557 37.854 26.4668L45.3782 20.4936Z"
          fill={mouthColor}
        />
      )}
      {mouth === 'po' && (
        <ellipse cx="46" cy="25" rx="5" ry="11" fill={mouthColor} />
      )}

      {/* 目: 開き目は円 r=3（31,17 / 61,17）、閉じ目は楕円 ry=1（31,16 / 61,16）（原典 *3.svg）。
          eyes=false（誕生シーンの体だけの状態）では描画しない */}
      {eyes &&
        (eyesClosed ? (
          <>
            <ellipse cx="31" cy="16" rx="3" ry="1" fill={EYE_COLOR} />
            <ellipse cx="61" cy="16" rx="3" ry="1" fill={EYE_COLOR} />
          </>
        ) : (
          <>
            <circle cx="31" cy="17" r="3" fill={EYE_COLOR} />
            <circle cx="61" cy="17" r="3" fill={EYE_COLOR} />
          </>
        ))}
    </svg>
  )
}

export default Papi
