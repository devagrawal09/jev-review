// Local-only dashboard server: a fixed list of static assets from ./public
// plus the saved review report as JSON. Binds to loopback only.
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, relative } from "node:path";
import { readReport, reportPath } from "../adapters/report-store.ts";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 4317);
const REPORT = reportPath();
const PUBLIC_DIR = join(import.meta.dirname, "public");
// DNS-rebinding guard: another site can point its hostname at 127.0.0.1, but the
// browser still sends that hostname in the Host header, so only accept our own.
const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);

// Only these files are served; nothing else on disk is reachable.
const assets: Record<string, [file: string, type: string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
};

function send(res: ServerResponse, status: number, type: string, body: string | Buffer) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:",
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}

export async function handle(req: IncomingMessage, res: ServerResponse) {
  if (!ALLOWED_HOSTS.has(req.headers.host?.toLowerCase() ?? "")) {
    return send(res, 403, "text/plain; charset=utf-8", "Forbidden host");
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, "text/plain; charset=utf-8", "Method not allowed");
  }

  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === "/api/review") {
    const source = relative(process.cwd(), REPORT) || REPORT;
    return json(res, 200, { source, ...(await readReport(REPORT)) });
  }

  const asset = assets[pathname];
  if (!asset) return send(res, 404, "text/plain; charset=utf-8", "Not found");

  const [file, type] = asset;
  send(res, 200, type, await readFile(join(PUBLIC_DIR, file)));
}

if (import.meta.main) {
  createServer(handle).listen(PORT, HOST, () => {
    console.log(`Jev review dashboard: http://${HOST}:${PORT}`);
    console.log(`report: ${relative(process.cwd(), REPORT) || REPORT}`);
  });
}
