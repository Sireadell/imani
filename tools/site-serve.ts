// Serves the built site/ folder on this computer. Run: npm run site:serve
// Plain static files, nothing else. Port 8788, or set IMANI_SITE_PORT.
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite } from "./site-build.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "site");
if (!existsSync(join(dir, "index.html"))) await buildSite(dir);

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
};

const port = Number(process.env.IMANI_SITE_PORT ?? 8788);
createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const name = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const file = resolve(dir, "." + name);
  if (!file.startsWith(dir) || !existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(readFileSync(file));
}).listen(port, "127.0.0.1", () => console.log(`Imani checker page: http://127.0.0.1:${port}/  (Ctrl+C to stop)`));
