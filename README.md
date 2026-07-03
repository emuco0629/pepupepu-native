# ぺぷぺぷぺぷ（Pepupepu）ネイティブアプリ版

パ行変換SNSアプリのネイティブ版。Vite + React + TypeScript + Capacitor (iOS)。
開発は Windows、iOS ビルドは Codemagic（クラウドMac）で行う。

## コマンド

- `npm run dev` … ローカル開発サーバー
- `npm run build` … `dist/` へビルド（tsc + vite）
- `npx cap sync` … ビルド成果物と設定を `ios/` に同期

## 全コードで厳守する3つのルール

1. **アセットは相対パスで解決する**
   `public/` 配下のアセット（kuromoji 辞書、WAV 音源など）は必ず
   `src/core/assetPath.ts` の `assetPath()` を通して参照する。
   `/dic/` のような絶対パスは Capacitor(WKWebView) で解決できないため禁止。
   （`vite.config.ts` の `base: './'` とセット）

2. **Web Audio は初回ユーザータップでアンロックする**
   AudioContext は `src/core/audio.ts` だけが生成・保持する。
   再生処理は `getAudioContext()` 経由。アンロックは
   `installAudioUnlockHandler()` が最初のユーザー操作にフックする。

3. **safe-area 対応レイアウト**
   `index.html` の viewport に `viewport-fit=cover`。
   背景（夜空）はノッチ・ホームバーの下まで含めた画面全面
   （`.app` = 幅100% × 100dvh）に隙間なく広がり、
   `env(safe-area-inset-*)` の padding は UI 要素側
   （`src/index.css` の `.room-bottom` など）に適用して
   操作要素だけがノッチ・ホームバーを避ける。

## ディレクトリ構成

```
src/
  core/        … UIから独立したロジック層
    assetPath.ts   アセットパス解決（ルール1）
    audio.ts       Web Audioコア・アンロック処理・パ行ボイス再生（ルール2）
    constants.ts   定数（NOROSHI_INTERVAL_MS など）
    noroshi.ts     のろしリズムスケジューラ（220ms間隔発火）
    convert/       パ行変換エンジン（kuromoji）
  components/  … UI コンポーネント
    Papi.tsx       パピ（キャラクター）。design/papi/ の公式SVGが唯一の原典
                   （mouthColor / wingColor / wings / eyes / flapping プロップあり。
                    目の色のみ固定。eyes が false→true で1回まばたきする）
    OnboardingScene.tsx  誕生シーン（起動時に毎回表示。タップでスキップ）
    papiMouth.ts   パ行1文字 → 口の形のマッピング
    WanderingPapi.tsx  画面下部をさまようパピ（rAF・正弦波2つの合成）
  App.tsx      … ルーム画面（Layout B）。夜空・星の蓄積と投稿シーケンス
                 （入力欄内で変身 → 入力欄から一本ののろしとして発射 → 星化）
public/
  dict/        … kuromoji 辞書（.dat.gz、旧プロトタイプから移植）
  voice/       … パ行ボイス np{a,i,u,e,o}.mp4（同上）
design/
  papi/        … パピ公式デザインSVG。変更・削除禁止
                 pa/pi/pu/pe/po × 1/2/3 の15個 ＋ pa0.svg（羽なし50×50、
                 オンボーディングの誕生シーン用）
```

## ハマりどころメモ

- **kuromoji 辞書と Vite dev サーバー**: Vite の dev / preview サーバーは
  `*.gz` に `Content-Encoding: gzip` を付けるため、ブラウザが透過解凍した
  データが kuromoji に渡り、内部の gunzip が黙って失敗して辞書ロードが
  永久に終わらない。`vite.config.ts` の `serveKuromojiDictRaw` プラグインが
  ヘッダを外して gzip のまま配信している。消さないこと。
  （Capacitor 本番はヘッダが付かないので影響なし）
- **kuromoji の import**: 本体エントリは Node 依存で Vite で使えないため、
  自己完結バンドル `kuromoji/build/kuromoji.js` を import する
  （型は `src/core/convert/kuromoji-build.d.ts` のシム経由）。
- **noroshi.ts の onEnd タイミング**: onEnd は最後の文字の発火から
  1拍（NOROSHI_INTERVAL_MS）後に呼ばれる仕様。最後の文字の口パク等が
  1拍ぶん表示されてから終わる。
- **発話開始前は `whenVoicesReady()` を await する**（audio.ts）。
  アンロック直後はボイスのデコードが未完了で最初の数音が欠けるため。
  タイムアウト付きなので音の問題で発話が止まることはない。
- **長音「ー」は変換エンジンが展開する**: 変換結果の「ー」は直前の
  パ行文字の繰り返しに置き換わり、出力に「ー」は残らない
  （例: マーブル → ぱぱぷぷ）。直前にパ行文字がない「ー」
  （文頭や記号の直後）は削除。実装は papipupepo.ts の
  `expandLongVowels`。UI 側に「ー」の特別処理は不要。
