// Local-only dashboard server: a fixed list of static assets from ./public
// plus the saved review report as JSON. Binds to loopback only.
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, relative } from "node:path";
import { readReport, reportPath } from "../adapters/report-store.ts";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const PORT = port();
function port(): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : DEFAULT_PORT;
}
// Accepts "host" or "host:port". Browsers omit the port on default ports,
// so a dashboard bound to 80 must accept a bare Host header.
function isAllowedHost(value: string): boolean {
  const host = value.trim().toLowerCase();
  const [name, portPart] = host.split(":");
  if (name !== HOST && name !== "localhost") return false;
  if (portPart === undefined) return PORT === 80;
  if (portPart === "80" && PORT === 80) return true;
  return portPart === String(PORT);
}
const REPORT = reportPath();
const PUBLIC_DIR = join(import.meta.dirname, "public");

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
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}

export async function handle(req: IncomingMessage, res: ServerResponse) {
  if (!isAllowedHost(req.headers.host ?? "")) {
    return send(res, 403, "text/plain; charset=utf-8", "Forbidden");
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
