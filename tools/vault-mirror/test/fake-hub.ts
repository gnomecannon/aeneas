/**
 * In-memory stand-in for the hub's four /vault routes (CONTRACT.md section 3, Vault).
 * Used by the unit tests and by scripts/fake-hub.ts for manual dry runs.
 * The hub's hash is deliberately computed over the raw bytes so the tests prove
 * the mirror never compares its own hash with the hub's.
 */
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface HubFile {
  content: string;
  mtime: string;
}

export class FakeHub {
  files = new Map<string, HubFile>();
  calls: string[] = [];
  private server?: http.Server;
  url = "";

  constructor(public token = "test-token") {}

  static hashOf(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
  }

  set(path: string, content: string, mtime = new Date().toISOString()): void {
    this.files.set(path, { content, mtime });
  }

  index(): { path: string; hash: string; mtime: string; size: number }[] {
    return [...this.files.entries()].map(([path, f]) => ({
      path,
      hash: FakeHub.hashOf(f.content),
      mtime: f.mtime,
      size: Buffer.byteLength(f.content, "utf8"),
    }));
  }

  async listen(port = 0): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    const addr = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${addr.port}`;
    return this.url;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server?.close((e) => (e ? reject(e) : resolve())));
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    this.calls.push(`${req.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/health") return this.json(res, 200, { ok: true, version: "fake", time: new Date().toISOString(), db_seq: 0 });
    if (req.headers.authorization !== `Bearer ${this.token}`) return this.json(res, 401, { error: "unauthorized" });

    if (req.method === "GET" && url.pathname === "/vault/index") return this.json(res, 200, this.index());

    if (url.pathname === "/vault/file") {
      const path = url.searchParams.get("path");
      if (!path) return this.json(res, 400, { error: "path required" });
      if (req.method === "GET") {
        const f = this.files.get(path);
        if (!f) return this.json(res, 404, { error: "not found" });
        res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
        res.end(f.content);
        return;
      }
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const content = Buffer.concat(chunks).toString("utf8");
        const mtime = url.searchParams.get("mtime") || new Date().toISOString();
        this.files.set(path, { content, mtime });
        return this.json(res, 200, { path, hash: FakeHub.hashOf(content), mtime });
      }
      if (req.method === "DELETE") {
        if (!this.files.delete(path)) return this.json(res, 404, { error: "not found" });
        return this.json(res, 200, { ok: true });
      }
    }
    this.json(res, 404, { error: "no route" });
  }
}
