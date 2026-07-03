/**
 * kuromoji のブラウザ用ビルド（browserify UMD バンドル）を import するための型シム。
 * 本体の 'kuromoji' エントリは Node 用モジュール（path 等）に依存して
 * Vite でバンドルできないため、自己完結した build/kuromoji.js を使う。
 * （旧プロトタイプが CDN から読んでいたのと同一のファイル）
 */
declare module 'kuromoji/build/kuromoji.js' {
  const kuromoji: typeof import('kuromoji')
  export default kuromoji
}
