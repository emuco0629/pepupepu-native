/**
 * 表情リアクションの判定と獲得記録。
 *
 * プライバシー原則（最重要）:
 *   キーワード判定は端末内のみで行う。引数の原文（original）は
 *   このモジュールから外へ出ず、ネットワークにも保存にも渡らない。
 *   ルームへ送ってよいのは判定結果の ReactionType だけ。
 *
 * 初期リアクション3種:
 *   greeting = 挨拶（おはよう・こんにちは・ただいま など）
 *   joy      = 喜び（うれしい・やった・ありがとう・！ など）
 *   normal   = 上記以外すべて
 * 「おはよう！」のように両方に当たるときは挨拶を優先する。
 */

export type ReactionType = 'greeting' | 'joy' | 'normal'

export const REACTION_TYPES: readonly ReactionType[] = [
  'greeting',
  'joy',
  'normal',
] as const

/** 挨拶のキーワード（原文への部分一致） */
const GREETING_KEYWORDS = [
  'おはよ',
  'こんにちは',
  'こんにちわ',
  'こんばんは',
  'こんばんわ',
  'おやすみ',
  'ただいま',
  'おかえり',
  'よろしく',
  'はじめまして',
  'またね',
  'ばいばい',
  'バイバイ',
  'さようなら',
  'さよなら',
  'やっほ',
  'ハロー',
  'hello',
]

/** 喜びのキーワード（原文への部分一致） */
const JOY_KEYWORDS = [
  'うれし',
  '嬉し',
  'やった',
  'たのし',
  '楽し',
  'すき',
  '好き',
  'だいすき',
  '大好き',
  'ありがと',
  '感謝',
  '最高',
  'さいこう',
  'わーい',
  'わあい',
  'うふふ',
  'えへへ',
  '！',
  '!',
  '♪',
]

/**
 * 原文からリアクションを判定する（端末内のみ。original は外に出さない）。
 * 大文字小文字は無視。挨拶 > 喜び > 通常 の優先順。
 */
export function detectReaction(original: string): ReactionType {
  const text = original.toLowerCase()
  if (GREETING_KEYWORDS.some((k) => text.includes(k))) return 'greeting'
  if (JOY_KEYWORDS.some((k) => text.includes(k))) return 'joy'
  return 'normal'
}

/** 受信した値を既知のリアクションに丸める（旧クライアント・欠落は normal） */
export function normalizeReaction(value: unknown): ReactionType {
  return REACTION_TYPES.includes(value as ReactionType)
    ? (value as ReactionType)
    : 'normal'
}

const EARNED_STORAGE_KEY = 'pepupepu-earned-reactions'

/** 獲得済みリアクションの読み込み（localStorage が使えない環境では空） */
export function loadEarnedReactions(): Set<ReactionType> {
  try {
    const raw = localStorage.getItem(EARNED_STORAGE_KEY)
    if (!raw) return new Set()
    const list = JSON.parse(raw) as unknown[]
    return new Set(
      list.filter((v): v is ReactionType =>
        REACTION_TYPES.includes(v as ReactionType),
      ),
    )
  } catch {
    return new Set()
  }
}

/**
 * リアクションを獲得記録する。初獲得なら true を返す
 * （呼び出し側はそのとき「キラッ」の演出を出す）。
 * 3種とも獲得対象（初投稿の「通常」初獲得は、初投稿のお祝いを兼ねる）
 */
export function markReactionEarned(reaction: ReactionType): boolean {
  const earned = loadEarnedReactions()
  if (earned.has(reaction)) return false
  earned.add(reaction)
  try {
    localStorage.setItem(EARNED_STORAGE_KEY, JSON.stringify([...earned]))
  } catch {
    // 保存できない環境ではセッション限りの獲得になる
  }
  return true
}
