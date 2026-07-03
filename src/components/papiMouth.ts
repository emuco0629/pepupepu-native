/** パピの口の形。'none' で口なし（休止時は目だけの顔） */
export type PapiMouth = 'pa' | 'pi' | 'pu' | 'pe' | 'po' | 'none'

/** パ行1文字 → 口の形。対応しない文字（記号など）は 'none' */
export function mouthForChar(ch: string): PapiMouth {
  switch (ch) {
    case 'ぱ': case 'パ': return 'pa'
    case 'ぴ': case 'ピ': return 'pi'
    case 'ぷ': case 'プ': return 'pu'
    case 'ぺ': case 'ペ': return 'pe'
    case 'ぽ': case 'ポ': return 'po'
    default: return 'none'
  }
}
