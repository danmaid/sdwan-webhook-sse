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
const PATH = "/v1/webhooks/sdwan/";
const MAX_CACHE = 100;

let nextId = 1;
const cache: StoredEvent[] = [];
const clients = new Set<SseClient>();

function pushCache(e: StoredEvent) {
  cache.push(e);
  while (cache.length > MAX_CACHE) cache.shift();
}

function wantsSse(req: IncomingMessage): boolean {
  return String(req.headers["accept"] ?? "").toLowerCase().includes("text/event-stream");
}

function wantsJson(req: IncomingMessage): boolean {
  return String(req.headers["accept"] ?? "").toLowerCase().includes("application/json");
}

function setNoCache(res: ServerResponse) {
  res.setHeader("Cache-Control", "no-cache, no-transform");
}

function sendJson(res: ServerResponse, obj: unknown, status = 200) {
  const body = Buffer.from(JSON.stringify(obj));
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", body.length);
  setNoCache(res);
  res.end(body);
}

function sendText(res: ServerResponse, text: string, status = 200) {
  const body = Buffer.from(text);
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Length", body.length);
  setNoCache(res);
  res.end(body);
}

function sendSseEvent(res: ServerResponse, event: string, data: unknown, id?: number) {
  // IMPORTANT: ここは必ず \n (バックスラッシュn) を送る。実改行が混入すると壊れる。
  if (id != null) res.write(`id: ${id}\n`);
  res.write(`event: ${event}\n`);
  const s = JSON.stringify(data ?? null);
  for (const line of s.split("\n")) res.write(`data: ${line}\n`);
  res.write("\n");
}

function broadcast(event: string, data: unknown, id: number) {
  for (const c of clients) {
    try { sendSseEvent(c.res, event, data, id); } catch {}
  }
}

function getClientIp(req: IncomingMessage): string {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) return xf.split(",")[0].trim();
  return req.socket.remoteAddress ?? "";
}

async function readBody(req: IncomingMessage, limitBytes = 2 * 1024 * 1024): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) { reject(new Error("Payload too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function guessContentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "application/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    default: return "application/octet-stream";
  }
}

async function serveStatic(res: ServerResponse, urlPath: string) {
  const publicRoot = join(process.cwd(), "public");
  const requested = normalize(urlPath).replace(/^([\/])+/, "");
  const fullPath = join(publicRoot, requested);
  if (!fullPath.startsWith(publicRoot)) return sendText(res, "Not Found", 404);
  try {
    const st = await stat(fullPath);
    if (!st.isFile()) return sendText(res, "Not Found", 404);
    const buf = await readFile(fullPath);
    res.statusCode = 200;
    res.setHeader("Content-Type", guessContentType(fullPath));
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Cache-Control", "public, max-age=60");
    res.end(buf);
  } catch {
    sendText(res, "Not Found", 404);
  }
}

async function serveDemo(res: ServerResponse) {
  const buf = await readFile(join(process.cwd(), "public", "index.html"));
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Length", buf.length);
  setNoCache(res);
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (method === "GET" && url.pathname.startsWith("/static/")) return await serveStatic(res, url.pathname);
  if (method === "GET" && url.pathname === "/") { res.statusCode = 302; res.setHeader("Location", PATH); return res.end(); }

  if (url.pathname === PATH) {
    if (method === "POST") {
      const raw = await readBody(req);
      const ct = String(req.headers["content-type"] ?? "").toLowerCase();
      let body: unknown = raw.toString("utf8");
      if (ct.includes("application/json")) {
        try { body = JSON.parse(raw.toString("utf8") || "null"); }
        catch { body = { _parseError: "invalid json", raw: raw.toString("utf8") }; }
      }
      const id = nextId++;
      const e: StoredEvent = { id, receivedAt: new Date().toISOString(), sourceIp: getClientIp(req), headers: req.headers as any, body };
      pushCache(e);
      broadcast("alarm", e, id);
      res.statusCode = 204;
      return res.end();
    }

    if (method === "GET") {
      if (wantsSse(req)) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        setNoCache(res);
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");

        sendSseEvent(res, "snapshot", { items: cache.slice() });

        const pingTimer = setInterval(() => {
          try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
        }, 25000);

        const client: SseClient = { res, pingTimer };
        clients.add(client);
        req.on("close", () => { clearInterval(pingTimer); clients.delete(client); });
        return;
      }

      if (wantsJson(req)) return sendJson(res, { items: cache.slice() });
      return await serveDemo(res);
    }

    return sendText(res, "Method Not Allowed", 405);
  }

  if (method === "GET" && url.pathname === PATH.slice(0, -1)) { res.statusCode = 308; res.setHeader("Location", PATH); return res.end(); }
  return sendText(res, "Not Found", 404);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on http://0.0.0.0:${PORT}${PATH}`);
});
