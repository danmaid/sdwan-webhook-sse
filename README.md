# sdwan-webhook-sse-no-deps

依存関係なし（Express等なし）で動作する Node.js + TypeScript サーバです。
Cisco SD-WAN Manager (vManage) の Webhook を受信し、同一エンドポイントで SSE 配信・直近100件の JSON 取得を提供します。

## エンドポイント

- `POST /v1/webhook/sdwan` : Webhook 受信（JSON推奨）
- `GET  /v1/webhook/sdwan` :
  - `Accept: text/event-stream` -> SSE
  - `Accept: application/json` -> 直近100件を JSON
  - それ以外 -> デモ HTML（静的ファイルを配信）

デモHTMLは `public/index.html` と `public/app.js` の静的コンテンツとして分離しています。

## 起動

```bash
npm i
npm run dev
# -> http://localhost:3000/v1/webhook/sdwan
```

## Basic 認証（任意）

```bash
export BASIC_USER=webhookuser
export BASIC_PASS=webhookpass
npm run dev
```

## 動作確認 (curl)

```bash
curl -X POST http://localhost:3000/v1/webhook/sdwan   -H 'Content-Type: application/json'   -d '{"headline":"BFD TLOC down","severity":"critical","system-ip":"10.0.0.1"}' -i
```

## リバプロ（例: NGINX）

SSE を使う場合、バッファリング無効化・read timeout 延長が必要です。

```nginx
location /v1/webhook/sdwan {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;

  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;

  proxy_buffering off;
  proxy_cache off;
  proxy_read_timeout 3600s;
}
```
