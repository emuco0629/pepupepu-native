import { useEffect, useRef } from 'react'
import Papi from './Papi'
import type { PapiMouth } from './papiMouth'

/**
 * 定位置でゆっくり上下に浮遊（ホバリング）するパピ。
 *
 *   - 横位置は App が人数に応じて割り当てるスロット（slot: 0〜1）。
 *     人数が変わって再配分されたときは、ゆっくり新しい定位置へ移動する
 *   - その場で上下にホバリング（周期と位相は phase で個体ごとにずれる。
 *     下端（bottom: 0）より下には行かないので入力欄と重ならない）
 *   - speaking の間は浮遊の高さが上がり（少し空に寄ってのろしを上げる）、
 *     終わるとゆっくり元の高さに戻る
 */

/** ホバリングの上下幅（px）。0〜この値の範囲で揺れる */
const BOB_AMPLITUDE = 7
/** 発話中に上がる高さ（px） */
const SPEAK_LIFT = 26

interface HoveringPapiProps {
  mouth: PapiMouth
  color?: string
  mouthColor?: string
  wingColor?: string
  size?: number
  /** 定位置の中心 x の割合（0〜1）。人数に応じて App が割り当てる */
  slot: number
  /** 発話中は浮遊の高さが上がる */
  speaking?: boolean
  /** 浮遊の位相・周期の個体差（秒相当の値） */
  phase?: number
  /** パピの中心 x 座標（親ストリップ基準・px）の出力先 */
  xRef?: { current: number }
}

function HoveringPapi({
  mouth,
  color,
  mouthColor,
  wingColor,
  size = 72,
  slot,
  speaking = false,
  phase = 0,
  xRef,
}: HoveringPapiProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const slotRef = useRef(slot)
  const speakingRef = useRef(speaking)

  useEffect(() => {
    slotRef.current = slot
  }, [slot])

  useEffect(() => {
    speakingRef.current = speaking
  }, [speaking])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return

    let rafId = 0
    let lastNow = performance.now()
    let x: number | null = null
    let lift = 0
    // 個体差: 揺れの周期（約2.9〜4.5秒）と位相
    const bobSpeed = 1.4 + (phase % 1.7) * 0.45

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - lastNow) / 1000)
      lastNow = now
      // 可動域はストリップ（最も近い positioned 祖先）の幅。
      // parentElement だと display: contents のラッパで幅0になるため使わない
      const host = (el.offsetParent as HTMLElement | null) ?? el.parentElement
      const width = host?.clientWidth || window.innerWidth
      const usable = Math.max(0, width - size - 16)
      const targetX = 8 + size / 2 + slotRef.current * usable

      // 再配分は瞬間移動せず、ゆっくり定位置へ
      x = x === null ? targetX : x + (targetX - x) * Math.min(1, dt * 3)
      // 発話中はゆっくり浮上し、終わるとゆっくり降りる
      const liftTarget = speakingRef.current ? SPEAK_LIFT : 0
      lift += (liftTarget - lift) * Math.min(1, dt * 2.2)
      // ホバリング（0〜BOB_AMPLITUDE。下端より下には行かない）
      const bob =
        (BOB_AMPLITUDE * (1 + Math.sin((now / 1000) * bobSpeed + phase))) / 2

      el.style.transform = `translate3d(${x - size / 2}px, ${-(lift + bob)}px, 0)`
      if (xRef) xRef.current = x
      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [size, phase, xRef])

  return (
    <div ref={wrapRef} className="papi-hover">
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

export default HoveringPapi
