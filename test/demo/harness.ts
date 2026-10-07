// Starts the demo app on a free port and records every request URL, response and log line,
// so the tests can scan all of it for keys.
import { createServer, type Server } from "node:http";
import { createApp, type DemoApp } from "../../demo/app.ts";
import { loadConfig, type LoadOptions } from "../../demo/config.ts";

export interface Seen {
  url: string;
  method: string;
  status: number;
  headers: string;
  body: string;
}

export interface Harness {
  base: string;
  app: DemoApp;
  logs: string[];
  seen: Seen[];
  /** Cookie jar with one session cookie. */
  cookie: string;
  get(path: string, init?: RequestInit): Promise<Response & { text_: string }>;
  post(path: string, data: Record<string, unknown> | string, json?: boolean): Promise<Response & { text_: string }>;
  close(): Promise<void>;
}

export async function startDemo(opts: LoadOptions = {}): Promise<Harness> {
  const logs: string[] = [];
  const cfg = loadConfig({ ...opts, argv: [...(opts.argv ?? []), "--port", "0"], log: (l) => logs.push(l) });
  const app = createApp(cfg);
  const server: Server = createServer(app.handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const seen: Seen[] = [];
  const h: Harness = {
    base,
    app,
    logs,
    seen,
    cookie: "",
    async get(path, init = {}) {
      return call("GET", path, init);
    },
    async post(path, data, json = true) {
      const body = typeof data === "string" ? data : json ? JSON.stringify(data) : new URLSearchParams(data as Record<string, string>).toString();
      const type = typeof data === "string" || !json ? "application/x-www-form-urlencoded" : "application/json";
      return call("POST", path, { body, headers: { "content-type": type, accept: json ? "application/json" : "text/html" } });
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  async function call(method: string, path: string, init: RequestInit) {
    const headers = new Headers(init.headers);
    if (h.cookie) headers.set("cookie", h.cookie);
    const res = await fetch(base + path, { ...init, method, headers, redirect: "manual" });
    const text = await res.text();
    const set = res.headers.get("set-cookie");
    if (set) {
      const v = set.split(";")[0];
      h.cookie = v.endsWith("=") ? "" : v;
    }
    seen.push({ url: base + path, method, status: res.status, headers: JSON.stringify([...res.headers]), body: text });
    return Object.assign(res, { text_: text });
  }
  return h;
}
