/**
 * ルールベースのボット（AI・API接続なし）。
 *
 * ボットは presence に書き込まず、各クライアントのローカルで動く。
 * DB にボットの投稿も書き込まない（通信コストゼロ・無人でも動く）。
 * ネットワーク送信自体がないため、プライバシー原則にも抵触しない。
 *
 * 台詞は旧Webプロジェクト（pepupepupepu/src/App.tsx）のボット定義から移植:
 *   - ひとりごと: CONVERSATION_PATTERNS のプペ（speaker 1）まわりの台詞
 *   - 相槌: 投稿への短い反応フレーズ（"ぷぷ" "ぽぷぱぺ" "ぱぷぽぽ" "ぺー" "ぺぷぺぷ"）
 * いずれも既にパ行だが、長音の展開等のため発話時に変換エンジンを通すこと。
 */

export interface BotDef {
  id: string
  /** 体の色 */
  color: string
  /** ときどき言うひとりごと */
  monologues: string[]
  /** ユーザーの投稿への短い相槌 */
  reactions: string[]
}

/** プペ: ピンクのパピ。ルームに常駐する */
export const PUPE: BotDef = {
  id: 'bot_pupe',
  color: '#FFD3DF',
  monologues: [
    'ぽぱぽぷー',
    'ぽぷぴぱぽ',
    'ぺー',
    'ぽぴぽぴ',
    'ぽぽ！',
    'ぴぱぱぱー',
    'ぷぱぺぱ',
    'ぱーぴ',
    'ぽーぽぷぷ',
    'ぴぴぺ',
    'ぱぱぷ',
    'ぷぷ',
  ],
  reactions: ['ぷぷ', 'ぽぷぱぺ', 'ぱぷぽぽ', 'ぺー', 'ぺぷぺぷ'],
}

/** ひとりごとの間隔: 45〜120秒のランダム */
const MONOLOGUE_MIN_MS = 45_000
const MONOLOGUE_RANGE_MS = 75_000
/** ユーザーの投稿に相槌を返す確率（毎回は反応しない） */
const REACTION_CHANCE = 0.4
/** 相槌までの間（ユーザーののろしとかぶらないように空ける） */
const REACTION_DELAY_MIN_MS = 3_000
const REACTION_DELAY_RANGE_MS = 3_000

export interface BotHandle {
  /**
   * ユーザーがのろしを上げ終わったときに呼ぶ。
   * ひとりごとの予定を仕切り直し（かぶり回避）、
   * ときどき少し間を空けて短い相槌を返す
   */
  notifyUserPost: () => void
  stop: () => void
}

export function startBot(
  bot: BotDef,
  onSpeak: (bot: BotDef, phrase: string) => void,
): BotHandle {
  let monologueTimer: ReturnType<typeof setTimeout> | undefined
  let reactionTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const pick = (phrases: string[]) =>
    phrases[Math.floor(Math.random() * phrases.length)]

  const scheduleMonologue = () => {
    clearTimeout(monologueTimer)
    monologueTimer = setTimeout(
      () => {
        if (stopped) return
        onSpeak(bot, pick(bot.monologues))
        scheduleMonologue()
      },
      MONOLOGUE_MIN_MS + Math.random() * MONOLOGUE_RANGE_MS,
    )
  }
  scheduleMonologue()

  const notifyUserPost = () => {
    if (stopped) return
    scheduleMonologue() // ひとりごとを先送りして、直後にかぶらないようにする
    if (reactionTimer) return // 相槌の多重予約はしない
    if (Math.random() >= REACTION_CHANCE) return
    reactionTimer = setTimeout(
      () => {
        reactionTimer = undefined
        if (stopped) return
        onSpeak(bot, pick(bot.reactions))
      },
      REACTION_DELAY_MIN_MS + Math.random() * REACTION_DELAY_RANGE_MS,
    )
  }

  return {
    notifyUserPost,
    stop: () => {
      stopped = true
      clearTimeout(monologueTimer)
      clearTimeout(reactionTimer)
    },
  }
}
