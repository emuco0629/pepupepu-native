/**
 * アセットパス解決モジュール（ルール1）
 *
 * public 配下のアセット（kuromoji 辞書、WAV 音源など）は、
 * 必ずこのモジュールを通して参照すること。直接 '/dic/...' のような
 * 絶対パスを書くと、Capacitor(WKWebView) の capacitor://localhost 配信や
 * サブパス配信で解決できなくなる。
 *
 * vite.config.ts で base: './' を設定しているため、
 * import.meta.env.BASE_URL は相対基準（'./'）になる。
 */

/**
 * public 配下の相対パスを、実行環境で解決可能な URL に変換する。
 *
 * 例:
 *   assetPath('dic')            → kuromoji の dicPath に渡す
 *   assetPath('sounds/pe.wav')  → fetch / Audio バッファの読み込みに渡す
 */
export function assetPath(relativePath: string): string {
  // 先頭の '/' や './' を除去して public 直下からの相対パスに正規化する
  const normalized = relativePath.replace(/^\.?\/+/, '')
  return `${import.meta.env.BASE_URL}${normalized}`
}
