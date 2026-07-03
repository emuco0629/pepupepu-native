import { defineConfig } from 'vite'
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * kuromoji の辞書（public/dict/*.dat.gz）を「gzip ファイルそのもの」として配信する。
 *
 * Vite の dev / preview サーバーは *.gz に Content-Encoding: gzip を付けるため、
 * ブラウザが透過解凍した生データが kuromoji に渡り、kuromoji 内部の gunzip が
 * 失敗して辞書ロードが永久に終わらない。ヘッダを外して gzip のまま渡す。
 * （Capacitor / 静的ホスティングでは元々ヘッダが付かないので影響しない）
 */
function serveKuromojiDictRaw(): Plugin {
  const stripContentEncoding = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use((req, res, next) => {
      if (req.url?.includes('/dict/') && req.url.split('?')[0].endsWith('.dat.gz')) {
        const setHeader = res.setHeader.bind(res)
        res.setHeader = (name, value) => {
          if (String(name).toLowerCase() === 'content-encoding') return res
          return setHeader(name, value)
        }
        // Vite 内蔵の sirv は writeHead(code, headers) でまとめて渡すのでこちらも消す
        const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => typeof res
        res.writeHead = ((...args: unknown[]) => {
          for (const arg of args) {
            if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
              for (const key of Object.keys(arg)) {
                if (key.toLowerCase() === 'content-encoding') {
                  delete (arg as Record<string, unknown>)[key]
                }
              }
            }
          }
          return writeHead(...args)
        }) as typeof res.writeHead
      }
      next()
    })
  }
  return {
    name: 'serve-kuromoji-dict-raw',
    configureServer: stripContentEncoding,
    configurePreviewServer: stripContentEncoding,
  }
}

// https://vite.dev/config/
export default defineConfig({
  // ルール1: Capacitor(capacitor://localhost) でも動くよう、ビルド成果物の
  // アセット参照をすべて相対パスにする。絶対パス('/')は使わない。
  base: './',
  server: {
    // プレビューハーネス等が PORT を指定した場合はそれに従う
    port: Number(process.env.PORT) || 5173,
  },
  plugins: [react(), serveKuromojiDictRaw()],
})
