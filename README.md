# sdwan-webhook-sse-no-deps

依存関係なし（Express等なし）で動作する Node.js + TypeScript サーバです。

## エンドポイント
- POST /v1/webhooks/sdwan/
- GET  /v1/webhooks/sdwan/ (SSE / JSON / HTML)

## 起動
```bash
npm i
npm run dev
# -> http://localhost:3000/v1/webhooks/sdwan/
```
