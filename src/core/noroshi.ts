import { NOROSHI_INTERVAL_MS } from './constants'

/**
 * のろしリズムスケジューラ
 *
 * パ行文字列を1文字ずつ NOROSHI_INTERVAL_MS（220ms）間隔で発火する。
 * 発火ごとに onTick コールバックが呼ばれる。音の再生・文字表示のほか、
 * 今後パピの口パクやのろしアニメーションもこのコールバックに接続する。
 */

export interface NoroshiTick {
  /** 発火した文字 */
  char: string
  /** 文字列先頭からのインデックス */
  index: number
}

export interface NoroshiHandle {
  /** のろしを途中で止める（onEnd は呼ばれない） */
  stop: () => void
}

export function startNoroshi(
  text: string,
  onTick: (tick: NoroshiTick) => void,
  onEnd?: () => void,
): NoroshiHandle {
  // サロゲートペアを壊さないよう code point 単位で分割する
  const chars = Array.from(text)
  let index = 0
  let intervalId: ReturnType<typeof setInterval> | null = null

  const stop = () => {
    if (intervalId !== null) {
      clearInterval(intervalId)
      intervalId = null
    }
  }

  const fire = () => {
    if (index >= chars.length) {
      // 全文字発火済み → 最後の文字も1拍ぶん見せてから終了する
      stop()
      onEnd?.()
      return
    }
    onTick({ char: chars[index], index })
    index += 1
  }

  if (chars.length === 0) {
    queueMicrotask(() => onEnd?.())
    return { stop }
  }

  // 先頭は即時発火し、以降 220ms 間隔で発火する。
  // onEnd は最後の文字の発火からさらに1拍（220ms）後に呼ばれる。
  fire()
  intervalId = setInterval(fire, NOROSHI_INTERVAL_MS)

  return { stop }
}
