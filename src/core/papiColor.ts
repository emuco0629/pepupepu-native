/**
 * パピの色の一元管理。
 *
 * パレットはパステル8色。白（#FFFFFF）は案内役（オンボーディングの
 * 誕生時など）の色として予約されており、パレットには含めない。
 * ユーザーの色は誕生時にランダムに選ばれ、localStorage に保存される。
 */

export const PAPI_PALETTE = [
  '#C8B0FE', // ラベンダー（公式パピ色）
  '#FFB8D0', // ピンク
  '#FFC9A9', // ピーチ
  '#FFE9A8', // レモン
  '#B5E8C9', // ミント
  '#A9D8FF', // スカイ
  '#A5E5E0', // アクア
  '#E5B8F0', // ライラック
] as const

/** 案内役（誕生前のパピ）の色。パレット外の予約色 */
export const GUIDE_COLOR = '#FFFFFF'

const COLOR_STORAGE_KEY = 'pepupepu-papi-color'

export function getStoredPapiColor(): string | null {
  try {
    return localStorage.getItem(COLOR_STORAGE_KEY)
  } catch {
    return null
  }
}

export function storePapiColor(color: string): void {
  try {
    localStorage.setItem(COLOR_STORAGE_KEY, color)
  } catch {
    // 保存できない環境ではセッション限りの色になる
  }
}

export function randomPaletteColor(): string {
  return PAPI_PALETTE[Math.floor(Math.random() * PAPI_PALETTE.length)]
}

/** 白い体のパピだけ口を薄ピンクにする（白以外の口は白のまま） */
export function mouthColorFor(color: string): string {
  return color.toLowerCase() === '#ffffff' ? '#FFD3DF' : 'white'
}

/** 羽は常に体と同色（白い体も羽まで白。以前はグレーの明度差を付けていた） */
export function wingColorFor(_color: string): string | undefined {
  return undefined
}

/** 2色のあいだを t (0〜1) で線形補間する（誕生時のゆっくりした変色用） */
export function lerpHexColor(from: string, to: string, t: number): string {
  const parse = (hex: string) =>
    [0, 2, 4].map((i) => parseInt(hex.replace('#', '').slice(i, i + 2), 16))
  const [fr, fg, fb] = parse(from)
  const [tr, tg, tb] = parse(to)
  const mix = (a: number, b: number) =>
    Math.round(a + (b - a) * t)
      .toString(16)
      .padStart(2, '0')
  return `#${mix(fr, tr)}${mix(fg, tg)}${mix(fb, tb)}`
}
