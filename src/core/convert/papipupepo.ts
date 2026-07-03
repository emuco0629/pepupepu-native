import kuromoji from 'kuromoji/build/kuromoji.js'
import type { IpadicFeatures, Tokenizer } from 'kuromoji'
import { assetPath } from '../assetPath'

/**
 * パ行変換エンジン（旧プロトタイプ src/utils/papipupepo.ts から移植）
 *
 * UIに依存しない純粋なモジュール:
 *   入力（日本語文字列）→ 出力（パ行文字列）
 *
 * 旧版からの変更点:
 *   - kuromoji を CDN のグローバル読み込みから、npm パッケージの
 *     ブラウザ用ビルドの直接 import に変更（オフラインでも動く）
 *   - 辞書パスを '/dict/' 固定から assetPath('dict') に変更（ルール1）
 *   - any だった tokenizer に @types/kuromoji の型を付与
 */

let tokenizer: Tokenizer<IpadicFeatures> | null = null
let initPromise: Promise<void> | null = null

/**
 * kuromoji トークナイザーを初期化する。
 * 辞書（public/dict/ の .dat.gz）のロードには数秒かかるため非同期。
 * 未初期化でも convertToPagyo は文字単位フォールバックで動作する。
 */
export function initTokenizer(): Promise<void> {
  if (tokenizer) return Promise.resolve()
  if (initPromise) return initPromise

  initPromise = new Promise<void>((resolve, reject) => {
    // ルール1: 辞書は assetPath 経由の相対パスで読み込む
    kuromoji.builder({ dicPath: assetPath('dict') }).build((err, _tokenizer) => {
      if (err) {
        initPromise = null
        reject(err)
      } else {
        tokenizer = _tokenizer
        resolve()
      }
    })
  })

  return initPromise
}

/** トークナイザー（辞書）がロード済みかどうか */
export function isTokenizerReady(): boolean {
  return tokenizer !== null
}

// ── カタカナ → ひらがなパ行 変換マップ ──

const katakanaVowelMap: Record<string, string> = {
  'ア': 'a', 'イ': 'i', 'ウ': 'u', 'エ': 'e', 'オ': 'o',
  'カ': 'a', 'キ': 'i', 'ク': 'u', 'ケ': 'e', 'コ': 'o',
  'サ': 'a', 'シ': 'i', 'ス': 'u', 'セ': 'e', 'ソ': 'o',
  'タ': 'a', 'チ': 'i', 'ツ': 'u', 'テ': 'e', 'ト': 'o',
  'ナ': 'a', 'ニ': 'i', 'ヌ': 'u', 'ネ': 'e', 'ノ': 'o',
  'ハ': 'a', 'ヒ': 'i', 'フ': 'u', 'ヘ': 'e', 'ホ': 'o',
  'マ': 'a', 'ミ': 'i', 'ム': 'u', 'メ': 'e', 'モ': 'o',
  'ヤ': 'a', 'ユ': 'u', 'ヨ': 'o',
  'ラ': 'a', 'リ': 'i', 'ル': 'u', 'レ': 'e', 'ロ': 'o',
  'ワ': 'a', 'ヲ': 'o', 'ン': 'u',
  'ガ': 'a', 'ギ': 'i', 'グ': 'u', 'ゲ': 'e', 'ゴ': 'o',
  'ザ': 'a', 'ジ': 'i', 'ズ': 'u', 'ゼ': 'e', 'ゾ': 'o',
  'ダ': 'a', 'ヂ': 'i', 'ヅ': 'u', 'デ': 'e', 'ド': 'o',
  'バ': 'a', 'ビ': 'i', 'ブ': 'u', 'ベ': 'e', 'ボ': 'o',
  'パ': 'a', 'ピ': 'i', 'プ': 'u', 'ペ': 'e', 'ポ': 'o',
  // 小さいカタカナ
  'ァ': 'a', 'ィ': 'i', 'ゥ': 'u', 'ェ': 'e', 'ォ': 'o',
  'ャ': 'a', 'ュ': 'u', 'ョ': 'o', 'ッ': 'u',
}

const vowelToPagyo: Record<string, string> = {
  'a': 'ぱ', 'i': 'ぴ', 'u': 'ぷ', 'e': 'ぺ', 'o': 'ぽ',
}

/** カタカナ1文字 → ひらがなパ行1文字 */
function katakanaToPagyo(ch: string): string {
  const vowel = katakanaVowelMap[ch]
  if (vowel) return vowelToPagyo[vowel]
  if (ch === 'ー') return 'ー'
  return ch
}

// ── ひらがな → パ行 変換マップ ──

const hiraganaVowelMap: Record<string, number> = {
  'あ': 0, 'い': 1, 'う': 2, 'え': 3, 'お': 4,
  'か': 0, 'き': 1, 'く': 2, 'け': 3, 'こ': 4,
  'さ': 0, 'し': 1, 'す': 2, 'せ': 3, 'そ': 4,
  'た': 0, 'ち': 1, 'つ': 2, 'て': 3, 'と': 4,
  'な': 0, 'に': 1, 'ぬ': 2, 'ね': 3, 'の': 4,
  'は': 0, 'ひ': 1, 'ふ': 2, 'へ': 3, 'ほ': 4,
  'ま': 0, 'み': 1, 'む': 2, 'め': 3, 'も': 4,
  'や': 0, 'ゆ': 2, 'よ': 4,
  'ら': 0, 'り': 1, 'る': 2, 'れ': 3, 'ろ': 4,
  'わ': 0, 'を': 4, 'ん': 2,
  'が': 0, 'ぎ': 1, 'ぐ': 2, 'げ': 3, 'ご': 4,
  'ざ': 0, 'じ': 1, 'ず': 2, 'ぜ': 3, 'ぞ': 4,
  'だ': 0, 'ぢ': 1, 'づ': 2, 'で': 3, 'ど': 4,
  'ば': 0, 'び': 1, 'ぶ': 2, 'べ': 3, 'ぼ': 4,
  'ぱ': 0, 'ぴ': 1, 'ぷ': 2, 'ぺ': 3, 'ぽ': 4,
  // 小さいひらがな
  'ぁ': 0, 'ぃ': 1, 'ぅ': 2, 'ぇ': 3, 'ぉ': 4,
  'ゃ': 0, 'ゅ': 2, 'ょ': 4, 'っ': 2,
}

const pagyoHiragana = ['ぱ', 'ぴ', 'ぷ', 'ぺ', 'ぽ']
const pagyoCharSet = new Set(pagyoHiragana)

/**
 * 変換結果中の長音「ー」を直前のパ行文字の繰り返しに置き換える。
 * 例: ぱーぷぷ → ぱぱぷぷ（出力に「ー」は残さない）
 * 直前にパ行文字がない「ー」（文頭や記号の直後）は削除する。
 */
function expandLongVowels(text: string): string {
  let result = ''
  let lastPagyo: string | null = null
  for (const ch of text) {
    if (ch === 'ー') {
      if (lastPagyo) result += lastPagyo
    } else {
      result += ch
      lastPagyo = pagyoCharSet.has(ch) ? ch : null
    }
  }
  return result
}

function isPunctuation(ch: string) {
  return /^[ー〜~！？!?、。,.\s　]$/.test(ch)
}

function englishVowelToPagyo(char: string): string {
  const c = char.toLowerCase()
  if (c === 'a') return 'ぱ'
  if (c === 'i') return 'ぴ'
  if (c === 'u') return 'ぷ'
  if (c === 'e') return 'ぺ'
  if (c === 'o') return 'ぽ'
  return '' // 子音はスキップ
}

function hangulToVowel(char: string): string | null {
  const code = char.charCodeAt(0) - 0xAC00
  if (code < 0 || code > 11171) return null
  const vowelIndex = Math.floor((code % 588) / 28)
  const vowelMap = ['ぱ', 'ぱ', 'ぴ', 'ぱ', 'ぺ', 'ぺ', 'ぺ', 'ぽ', 'ぽ', 'ぽ', 'ぽ', 'ぽ', 'ぷ', 'ぷ', 'ぷ', 'ぷ', 'ぷ', 'ぴ', 'ぴ', 'ぴ', 'ぴ']
  return vowelMap[vowelIndex]
}

/** 任意1文字のフォールバック変換（ひらがな・カタカナ・英語・ハングル、それ以外は文字コード基準） */
function charToPagyo(ch: string): string {
  // 再生制御用の記号類はそのまま返す
  if (isPunctuation(ch)) return ch

  // 1. ひらがな
  const hIdx = hiraganaVowelMap[ch]
  if (hIdx !== undefined) return pagyoHiragana[hIdx]

  // 2. カタカナ
  const kVowel = katakanaVowelMap[ch]
  if (kVowel) return vowelToPagyo[kVowel]

  // 3. 英語 (a-z, A-Z)
  if (/[a-zA-Z]/.test(ch)) {
    return englishVowelToPagyo(ch)
  }

  // 4. 韓国語 (ハングル)
  const hangul = hangulToVowel(ch)
  if (hangul) return hangul

  // 5. その他の文字（漢字含む）→ 文字コード % 5
  const code = ch.charCodeAt(0)
  return pagyoHiragana[code % 5]
}

// ── メイン変換関数 ──

/**
 * テキストをパ行に変換する。
 * tokenizer がロード済みなら形態素解析で漢字の読みも取得して変換。
 * 未ロードなら文字単位でフォールバック変換。
 */
export function convertToPagyo(text: string): string {
  if (!tokenizer) {
    // フォールバック: 文字単位変換（漢字は文字コード基準になる）
    return expandLongVowels(text.split('').map(charToPagyo).join(''))
  }

  const tokens = tokenizer.tokenize(text)
  let result = ''

  for (const token of tokens) {
    const reading = token.reading // カタカナで返る（例: 味噌汁 → ミソシル）

    if (reading && reading !== '*') {
      // 読みがある → カタカナ読みをパ行ひらがなに変換
      for (const ch of reading) {
        result += katakanaToPagyo(ch)
      }
    } else {
      // 読みがない（記号・数字・英語など）→ 文字ごとにフォールバック
      for (const ch of token.surface_form) {
        result += charToPagyo(ch)
      }
    }
  }

  return expandLongVowels(result)
}

/**
 * 安全なパ行変換。変換後に漢字が残っていたら強制的に「ぱ」に置換する最終防御。
 */
export function safeConvertToPagyo(text: string): string {
  let result = convertToPagyo(text)

  // 最終チェック: 漢字が残っていたら強制的にぱに置換
  if (/[一-鿿]/.test(result)) {
    result = result.replace(/[一-鿿]/g, 'ぱ')
  }
  return result
}
