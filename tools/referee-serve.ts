// Serves the built site/ folder and the one thing the "check any round" page needs from the
// network: blocks. Run: node tools/referee-serve.ts   (port 8789, or set IMANI_REFEREE_PORT)
//
// The hosted site does the same with api/block.mjs. Both use src/relay/block-api.ts, which asks
// two public block servers run by different operators and takes only a network and a height.
// This program listens on this computer only.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SERVERS } from "../src/fetch/index.ts";
import { answerBlock, CSP, realBlock, type BlockGetter } from "../src/relay/block-api.ts";
import { buildSite } from "./site-build.ts";

export { blockReply, describeBlock, limited, CSP, type BlockAnswer, type BlockReply, type Fetcher, type Describer } from "../src/relay/block-api.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };

export function makeHandler(dir: string, block: BlockGetter = realBlock) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (await answerBlock(req, res, block)) return;
    const send = (code: number, body: string | Buffer, type = "text/plain; charset=utf-8") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
      res.end(body);
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    const name = url.pathname === "/" ? "/check.html" : decodeURIComponent(url.pathname);
    const file = resolve(dir, "." + name);
    if (!file.startsWith(dir) || !existsSync(file)) return send(404, "Not found");
    send(200, readFileSync(file), types[extname(file)] ?? "application/octet-stream");
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = join(root, "site");
  if (!existsSync(join(dir, "check.html"))) await buildSite(dir);
  const port = Number(process.env.IMANI_REFEREE_PORT ?? 8789);
  createServer(makeHandler(dir)).listen(port, "127.0.0.1", () => {
    console.log(`Imani referee page: http://127.0.0.1:${port}/check.html  (Ctrl+C to stop)`);
    console.log(`Block servers it may contact: main ${DEFAULT_SERVERS.main.join(", ")}`);
    console.log(`                              test ${DEFAULT_SERVERS.test.join(", ")}`);
  });
}
