# バケモンカードバトル（バケカ）

昔つくった手描きのカードゲームを、スマホとパソコンで遊べるようにしたものです。

- CPUと対戦、1台を交代で使うふたり対戦、部屋番号でつなぐオンライン対戦（参加はホストの承認制）
- 遊ぶページ：https://kaisermayor.github.io/bakeka/

## ファイル

- `index.html` 画面とデザイン
- `game.js` ルール処理・画面・CPU
- `cards.js` カードのデータと効果（カードを足すときはここ）
- `online.js` オンライン対戦（PeerJS）
- `cards/` 原画の写真、`cards/draw/` 描きなおした絵
- `tools/build_site.py` 公開用の `docs/` を作る（変更したら実行してからコミット）
