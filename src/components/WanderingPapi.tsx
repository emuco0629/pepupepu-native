import { useEffect, useRef } from 'react'
import Papi from './Papi'
import type { PapiMouth } from './papiMouth'

/**
 * 画面下部をゆっくり左右にさまようパピ。
 * 周期の異なる2つの正弦波を合成して、等速でない少し揺らいだ動きにする。
 * 羽ばたき・まばたき・口パクは Papi 本体のまま。
 *
 * 親要素（position: relative なストリップ）の幅いっぱいを移動範囲とし、
 * xRef に現在の中心 x 座標（親要素基準・px）を毎フレーム書き込む。
 * のろし文字の発生位置はこれを参照する。
 */

interface WanderingPapiProps {
  mouth: PapiMouth
  color?: string
  mouthColor?: string
  wingColor?: string
  size?: number
  /** true の間はその場に立ち止まる（発話中）。解除でさまよい再開 */
  paused?: boolean
  /** 動きの位相オフセット（秒）。複数のパピが同じ動きにならないようにする */
  phase?: number
  /** パピの中心 x 座標（親要素基準・px）の出力先 */
  xRef?: { current: number }
}

function WanderingPapi({
  mouth,
  color,
  mouthColor,
  wingColor,
  size = 72,
  paused = false,
  phase = 0,
  xRef,
}: WanderingPapiProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(paused)

  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return

    let rafId = 0
    // paused 中は内部クロックを止め、再開時に同じ位置から続きが始まる
    let tAccum = 0
    let lastNow = performance.now()

    const tick = (now: number) => {
      if (!pausedRef.current) {
        tAccum += now - lastNow
      }
      lastNow = now
      const t = tAccum / 1000 + phase
      // 可動域はストリップ（最も近い positioned 祖先）の幅。
      // parentElement だと display: contents のラッパで幅0になるため使わない
      const host = (el.offsetParent as HTMLElement | null) ?? el.parentElement
      const parentWidth = host?.clientWidth || window.innerWidth
      const half = size / 2
      const range = Math.max(0, parentWidth / 2 - half - 12)
      // 振幅の合計を 1 に収めて範囲内を保証しつつ、2波の合成でゆらぐ
      const x =
        parentWidth / 2 +
        range * (0.62 * Math.sin(0.31 * t) + 0.38 * Math.sin(0.53 * t + 1.7))
      const y = 5 * Math.sin(0.9 * t + 0.5)
      el.style.transform = `translate3d(${x - half}px, ${y}px, 0)`
      if (xRef) xRef.current = x
      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [size, phase, xRef])

  return (
    <div ref={wrapRef} className="papi-wander">
      <Papi
        mouth={mouth}
        color={color}
        mouthColor={mouthColor}
        wingColor={wingColor}
        size={size}
      />
    </div>
  )
}

export default WanderingPapi
