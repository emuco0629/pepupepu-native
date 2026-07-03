import { assetPath } from './assetPath'

/**
 * Web Audio コア（ルール2）
 *
 * iOS Safari / WKWebView では、AudioContext はユーザー操作を起点に
 * resume しないと音が出ない。この「アンロック」を後付けの修正ではなく
 * コアの設計として持つ:
 *
 *   - AudioContext はこのモジュールだけが生成・保持する（シングルトン）
 *   - installAudioUnlockHandler() をアプリ起動時に一度呼ぶと、
 *     最初のユーザー操作（pointerdown / keydown）で自動的にアンロックされる
 *   - 今後の再生処理はすべて getAudioContext() 経由でコンテキストを取得すること
 *
 * パ行ボイス（public/voice/np*.mp4）の読み込みと再生もここが担う。
 * fetch（ArrayBuffer 取得）はいつでも走らせられるが、decodeAudioData は
 * AudioContext が必要なので、アンロック時にまとめてデコードする二段構え
 * （旧プロトタイプ src/utils/audio.ts と同じ戦略）。
 */

let audioContext: AudioContext | null = null
let unlocked = false

/** AudioContext を返す（未生成なら生成する）。再生処理は必ずここを通す。 */
export function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext()
  }
  return audioContext
}

/** アンロック済み（= 実際に音を出せる状態）かどうか */
export function isAudioUnlocked(): boolean {
  return unlocked && audioContext?.state === 'running'
}

/**
 * AudioContext を生成・resume し、無音バッファを一度再生して
 * iOS のオーディオロックを確実に解除する。
 * 必ずユーザー操作のイベントハンドラ内（同期的な呼び出し経路）から呼ぶこと。
 */
export async function unlockAudio(): Promise<AudioContext> {
  const ctx = getAudioContext()
  if (ctx.state === 'suspended') {
    await ctx.resume()
  }
  if (!unlocked) {
    // 無音の 1 フレームを鳴らすことで WKWebView でも確実にロックが外れる
    const buffer = ctx.createBuffer(1, 1, ctx.sampleRate)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.start(0)
    unlocked = true
  }
  // fetch 済みでまだデコードされていないボイスをここでデコードする
  void decodePendingVoices(ctx)
  return ctx
}

/**
 * 最初のユーザー操作で unlockAudio() が走るリスナーを登録する。
 * アプリ起動時（マウント時）に一度呼ぶ。戻り値はリスナー解除関数。
 */
export function installAudioUnlockHandler(
  onUnlock?: (ctx: AudioContext) => void,
  target: EventTarget = window,
): () => void {
  const events = ['pointerdown', 'keydown'] as const

  const handler = () => {
    remove()
    void unlockAudio().then((ctx) => onUnlock?.(ctx))
  }
  const remove = () => {
    for (const type of events) {
      target.removeEventListener(type, handler)
    }
  }

  for (const type of events) {
    target.addEventListener(type, handler)
  }
  return remove
}

// ── パ行ボイスの読み込みと再生 ──

/** パ行1文字 → ボイスファイル名（public/voice/<name>.mp4） */
const PAGYO_VOICE_FILES: Record<string, string> = {
  'ぱ': 'npa', 'ぴ': 'npi', 'ぷ': 'npu', 'ぺ': 'npe', 'ぽ': 'npo',
  'パ': 'npa', 'ピ': 'npi', 'プ': 'npu', 'ペ': 'npe', 'ポ': 'npo',
}

/** fetch 済みの生データ（デコード前） */
const voiceArrayBuffers = new Map<string, ArrayBuffer>()
/** デコード済みの再生可能バッファ */
const voiceAudioBuffers = new Map<string, AudioBuffer>()

let preloadPromise: Promise<void> | null = null

/**
 * ボイスサンプルを並列 fetch する。アプリ起動時に一度呼ぶ。
 * AudioContext 生成済み（アンロック後）なら到着次第デコードもする。
 */
export function preloadVoiceSamples(): Promise<void> {
  if (preloadPromise) return preloadPromise

  const names = [...new Set(Object.values(PAGYO_VOICE_FILES))]
  preloadPromise = Promise.all(
    names.map(async (name) => {
      try {
        // ルール1: ボイスは assetPath 経由の相対パスで読み込む
        const res = await fetch(assetPath(`voice/${name}.mp4`))
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        voiceArrayBuffers.set(name, await res.arrayBuffer())
        if (audioContext) {
          await decodeVoice(audioContext, name)
        }
      } catch (e) {
        console.warn(`ボイスの取得に失敗: ${name}`, e)
      }
    }),
  ).then(() => undefined)

  return preloadPromise
}

async function decodeVoice(ctx: AudioContext, name: string): Promise<void> {
  if (voiceAudioBuffers.has(name)) return
  const raw = voiceArrayBuffers.get(name)
  if (!raw) return
  try {
    // decodeAudioData はバッファを消費するためコピーを渡す
    voiceAudioBuffers.set(name, await ctx.decodeAudioData(raw.slice(0)))
  } catch (e) {
    console.warn(`ボイスのデコードに失敗: ${name}`, e)
  }
}

async function decodePendingVoices(ctx: AudioContext): Promise<void> {
  await Promise.all(
    [...voiceArrayBuffers.keys()].map((name) => decodeVoice(ctx, name)),
  )
}

/**
 * AudioContext が実際に音を出せる状態（running）になるのを待つ。
 * resume() 自体はアンロック処理がユーザー操作内で呼んでいる前提で、
 * ここではその完了を受動的に待つだけ（新たに resume は呼ばない）。
 */
function waitForRunning(ctx: AudioContext): Promise<void> {
  if (ctx.state === 'running') return Promise.resolve()
  return new Promise((resolve) => {
    const onStateChange = () => {
      if (ctx.state === 'running') {
        ctx.removeEventListener('statechange', onStateChange)
        resolve()
      }
    }
    ctx.addEventListener('statechange', onStateChange)
  })
}

/**
 * 全ボイスの fetch + デコードの完了と、AudioContext が running に
 * なるのを待つ。発話開始前にこれを await すると、初回投稿でも
 * 1音目から正しいタイミングで鳴る（resume 完了前に拍をスケジュール
 * すると currentTime が凍結していて先頭の数音が重なるため）。
 *
 * 音のせいで投稿が止まるのは避けたいので、タイムアウトすると
 * 未完了でも resolve する（fetch/デコードの失敗も内部で握って進む）。
 */
export function whenVoicesReady(timeoutMs = 2000): Promise<void> {
  const ready = (async () => {
    await preloadVoiceSamples()
    const ctx = getAudioContext()
    await decodePendingVoices(ctx)
    await waitForRunning(ctx)
  })()
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  return Promise.race([ready, timeout])
}

export interface PlayVoiceOptions {
  /** 再生開始時刻（AudioContext.currentTime 基準）。省略時は即時 */
  when?: number
  /** 音量（GainNode）。既定値は旧プロトタイプの自分の発言と同じ 3.0 */
  volume?: number
  /** ピッチ（playbackRate）。既定値は旧プロトタイプの自分の発言と同じ 1.1 */
  playbackRate?: number
}

/**
 * パ行1文字に対応するボイスを再生する。
 * 対応するサンプルがない文字（記号など）や未デコード時は false を返す。
 * AudioContext は新たに生成せず、必ず getAudioContext() のシングルトンを使う（ルール2）。
 */
export function playPagyoChar(ch: string, options: PlayVoiceOptions = {}): boolean {
  const name = PAGYO_VOICE_FILES[ch]
  if (!name) return false

  const buffer = voiceAudioBuffers.get(name)
  const ctx = getAudioContext()
  if (!buffer) {
    // 未デコードなら次回に備えてデコードを走らせておく（今回は鳴らせない）
    void decodeVoice(ctx, name)
    return false
  }

  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.playbackRate.value = options.playbackRate ?? 1.1

  const gain = ctx.createGain()
  gain.gain.value = options.volume ?? 3.0

  source.connect(gain)
  gain.connect(ctx.destination)
  source.start(options.when ?? ctx.currentTime)
  return true
}
