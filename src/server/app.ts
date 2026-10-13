// Node adapter: serves the UI from public/ and bridges /api/* to the Web-standard handler. The Cloudflare
// deploy (worker/) serves the same handler from a Durable Object and the UI from static assets.

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { createHandler, HttpError, jsonResponse, SECURITY_HEADERS, type HandlerOptions } from "./handler.js";

export interface AppOptions extends HandlerOptions {
  publicDir: string;
  /** Use the proxy's client-IP header for rate limiting (Fly/Render). Off when not behind a proxy. */
  trustProxy?: boolean;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Sends a Web Response through Node's ServerResponse, stopping the stream if the client goes away. */
async function send(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return void res.end();
  const reader = response.body.getReader();
  res.on("close", () => void reader.cancel().catch(() => {}));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || res.destroyed) break;
      res.write(value);
    }
  } finally {
    res.end();
  }
}

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(`http://localhost${req.url ?? "/"}`, {
    method: req.method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" } : {}),
  } as RequestInit);
}

export function createApp(opts: AppOptions): Server {
  const api = createHandler(opts);
  const publicDir = resolve(opts.publicDir);

  const clientKey = (req: IncomingMessage): string => {
    if (opts.trustProxy) {
      const fwd = (req.headers["fly-client-ip"] ?? req.headers["x-forwarded-for"]) as string | undefined;
      if (fwd) return fwd.split(",")[0]!.trim();
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  async function serveStatic(urlPath: string): Promise<Response> {
    const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
    const file = resolve(join(publicDir, rel));
    if (file !== publicDir && !file.startsWith(publicDir + sep)) throw new HttpError(404, "Not found");
    try {
      const data = await readFile(file);
      return new Response(new Uint8Array(data), { headers: { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", ...SECURITY_HEADERS } });
    } catch {
      throw new HttpError(404, "Not found");
    }
  }

  return createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    let response: Response;
    try {
      if (path.startsWith("/api/")) response = await api(toRequest(req), clientKey(req));
      else if (req.method === "GET" || req.method === "HEAD") response = await serveStatic(path);
      else throw new HttpError(405, "Method not allowed");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      response = jsonResponse(status, { error: err instanceof HttpError ? err.message : "Internal error" });
    }
    await send(res, response).catch(() => res.destroy());
  });
}
