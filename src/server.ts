import http, { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

type StoredEvent = {
  id: number;
  receivedAt: string;
  sourceIp: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};

type SseClient = {
  res: ServerResponse;
  pingTimer: NodeJS.Timeout;
};

const PORT = Number(process.env.PORT ?? 3000);
const PATH = "/v1/webhook/sdwan";
const MAX_CACHE = 100;

const BASIC_USER = process.env.BASIC_USER ?? "";
const BASIC_PASS = process.env.BASIC_PASS ?? "";

let nextId = 1;
const cache: StoredEvent[] = [];
const clients = new Set<SseClient>();

function pushCache(e: StoredEvent) {
  cache.push(e);
  while (cache.length > MAX_CACHE) cache.shift();
}

function wantsSse(req: IncomingMessage): boolean {
  const accept = String(req.headers["accept"] ?? "").toLowerCase();
  return accept.includes("text/event-stream");
}

function wantsJson(req: IncomingMessage): boolean {
  const accept = String(req.headers["accept"] ?? "").toLowerCase();
  return accept.includes("application/json");
}

function parseBasicAuth(req: IncomingMessage): { user: string; pass: string } | null {
  const h = String(req.headers["authorization"] ?? "");
  if (!h.toLowerCase().startsWith("basic ")) return null;
  const b64 = h.slice(6).trim();
  try {
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function requireAuthIfConfigured(req: IncomingMessage, res: ServerResponse): boolean {
  if (!BASIC_USER && !BASIC_PASS) return true;
  const cred = parseBasicAuth(req);
  if (!cred || cred.user !== BASIC_USER || cred.pass !== BASIC_PASS) {
    res.statusCode = 401;
    res.setHeader("WWW-Authenticate", 'Basic realm="sdwan-webhook"');
    res.end("Unauthorized");
    return false;
  }
  return true;
}

function setNoCacheHeaders(res: ServerResponse) {
  res.setHeader("Cache-Control", "no-cache, no-transform");
}

function sendJson(res: ServerResponse, obj: unknown, status = 200) {
  const body = Buffer.from(JSON.stringify(obj));
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", body.length);
  setNoCacheHeaders(res);
  res.end(body);
}

function sendText(res: ServerResponse, text: string, status = 200) {
  const body = Buffer.from(text);
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Length", body.length);
  setNoCacheHeaders(res);
  res.end(body);
}

function sendSseEvent(res: ServerResponse, event: string, data: unknown, id?: number) {
  if (id != null) res.write(`id: ${id}\n`);
  res.write(`event: ${event}\n`);
  const s = JSON.stringify(data ?? null);
  for (const line of s.split("\n")) res.write(`data: ${line}\n`);
  res.write("\n");
}

function broadcast(event: string, data: unknown, id: number) {
  for (const c of clients) {
    try {
      sendSseEvent(c.res, event, data, id);
    } catch {
      // ignore
    }
  }
}

function getClientIp(req: IncomingMessage): string {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) return xf.split(",")[0].trim();
  // Node の場合は socket アドレス
  return req.socket.remoteAddress ?? "";
}

async function readBody(req: IncomingMessage, limitBytes = 2 * 1024 * 1024): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function guessContentType(path: string): string {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "application/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".png": return "image/png";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string) {
  // /static/* を public/static にマッピング
  const publicRoot = join(process.cwd(), "public");
  const requested = normalize(urlPath).replace(/^([\\/])+/, "");
  const fullPath = join(publicRoot, requested);

  // ディレクトリトラバーサル簡易対策：publicRoot 配下であること
  if (!fullPath.startsWith(publicRoot)) {
    sendText(res, "Not Found", 404);
    return;
  }

  try {
    const st = await stat(fullPath);
    if (!st.isFile()) {
      sendText(res, "Not Found", 404);
      return;
    }
    const buf = await readFile(fullPath);
    res.statusCode = 200;
    res.setHeader("Content-Type", guessContentType(fullPath));
    res.setHeader("Content-Length", buf.length);
    // 静的ファイルは軽くキャッシュしてOK（必要なら調整）
    res.setHeader("Cache-Control", "public, max-age=60");
    res.end(buf);
  } catch {
    sendText(res, "Not Found", 404);
  }
}

async function serveDemoHtml(res: ServerResponse) {
  const buf = await readFile(join(process.cwd(), "public", "index.html"));
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Length", buf.length);
  setNoCacheHeaders(res);
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  try {
    // Basic Auth（必要時）
    if (!requireAuthIfConfigured(req, res)) return;

    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // 静的ファイル
    if (method === "GET" && url.pathname.startsWith("/static/")) {
      await serveStatic(req, res, url.pathname);
      return;
    }

    // ルートはデモへ
    if (method === "GET" && url.pathname === "/") {
      res.statusCode = 302;
      res.setHeader("Location", PATH);
      res.end();
      return;
    }

    // 本体エンドポイント
    if (url.pathname === PATH) {
      if (method === "POST") {
        const raw = await readBody(req);
        const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
        let body: unknown = raw.toString("utf8");
        if (contentType.includes("application/json")) {
          try {
            body = JSON.parse(raw.toString("utf8") || "null");
          } catch {
            body = { _parseError: "invalid json", raw: raw.toString("utf8") };
          }
        }

        const id = nextId++;
        const e: StoredEvent = {
          id,
          receivedAt: new Date().toISOString(),
          sourceIp: getClientIp(req),
          headers: req.headers as any,
          body,
        };

        pushCache(e);
        broadcast("alarm", e, id);

        res.statusCode = 204;
        res.end();
        return;
      }

      if (method === "GET") {
        if (wantsSse(req)) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
          setNoCacheHeaders(res);
          res.setHeader("Connection", "keep-alive");
          // NGINX などのバッファ無効化（SSE向け）
          res.setHeader("X-Accel-Buffering", "no");

          // 先に snapshot を送る
          sendSseEvent(res, "snapshot", { items: cache.slice() });

          const pingTimer = setInterval(() => {
            try {
              res.write(`: ping ${Date.now()}\n\n`);
            } catch {
              /* ignore */
            }
          }, 25000);

          const client: SseClient = { res, pingTimer };
          clients.add(client);

          req.on("close", () => {
            clearInterval(pingTimer);
            clients.delete(client);
          });

          return;
        }

        if (wantsJson(req)) {
          sendJson(res, { items: cache.slice() });
          return;
        }

        // デモHTML（静的ファイル）
        await serveDemoHtml(res);
        return;
      }

      sendText(res, "Method Not Allowed", 405);
      return;
    }

    // Not Found
    sendText(res, "Not Found", 404);
  } catch (e: any) {
    // エラー
    console.error(e);
    if (!res.headersSent) sendText(res, "Internal Server Error", 500);
    else res.end();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on http://0.0.0.0:${PORT}${PATH}`);
});

process.on("SIGTERM", () => {
  for (const c of clients) {
    try { c.res.end(); } catch {}
    clearInterval(c.pingTimer);
  }
  clients.clear();
  server.close(() => process.exit(0));
});
