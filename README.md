# SimpleYoutubePlayer

高齢者が迷わず使えるようにした、シンプルな YouTube クライアントサイトです。

## 使い方

1. `/home/runner/work/SimpleYoutubePlayer/SimpleYoutubePlayer/index.html` をブラウザーで開きます。
2. もしくはリポジトリ直下で `npm start` を実行し、`http://localhost:4173` を開きます。

## 特徴

- 画面上部 80% に YouTube の再生窓を表示
- 画面下部 20% に大きな操作ボタンを横並びで表示
- 再生 / 停止、音量 0〜9、字幕切替、好み登録、前 / 次 の操作に対応
- 好みを 3 回付けたチャンネルは自動で登録扱いにし、次のおすすめに反映
- 前 / 次の移動前に 2 秒間サムネイルとタイトルを表示
- 視聴傾向や好みをブラウザーに保存し、次のおすすめ選びに利用

## 確認コマンド

```bash
npm test
```
