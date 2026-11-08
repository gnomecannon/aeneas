export interface IndexEntry {
  path: string;
  hash: string;
  mtime: string;
  size: number;
}

export interface PutResult {
  path: string;
  hash: string;
  mtime: string;
}

export class HubError extends Error {
  constructor(
    public status: number,
    public route: string,
    public body: string,
  ) {
    super(`hub ${route} returned ${status}: ${body.slice(0, 200)}`);
  }
}

/** Thin client for the four /vault routes in CONTRACT.md section 3. */
export class HubClient {
  constructor(
    private baseUrl: string,
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(method: string, route: string, body?: string): Promise<Response> {
    const res = await this.fetchImpl(this.baseUrl + route, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "Content-Type": "text/markdown; charset=utf-8" } : {}),
      },
      body,
    });
    return res;
  }

  async index(): Promise<IndexEntry[]> {
    const res = await this.call("GET", "/vault/index");
    if (!res.ok) throw new HubError(res.status, "GET /vault/index", await res.text());
    const data = (await res.json()) as IndexEntry[];
    return data.filter((e) => e.path.endsWith(".md"));
  }

  /** Returns null when the hub has no file at that path. */
  async get(filePath: string): Promise<string | null> {
    const res = await this.call("GET", `/vault/file?path=${encodeURIComponent(filePath)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new HubError(res.status, "GET /vault/file", await res.text());
    return res.text();
  }

  async put(filePath: string, content: string, mtimeIso: string): Promise<PutResult> {
    const res = await this.call(
      "PUT",
      `/vault/file?path=${encodeURIComponent(filePath)}&mtime=${encodeURIComponent(mtimeIso)}`,
      content,
    );
    if (!res.ok) throw new HubError(res.status, "PUT /vault/file", await res.text());
    return (await res.json()) as PutResult;
  }

  async delete(filePath: string): Promise<void> {
    const res = await this.call("DELETE", `/vault/file?path=${encodeURIComponent(filePath)}`);
    if (res.status === 404) return;
    if (!res.ok) throw new HubError(res.status, "DELETE /vault/file", await res.text());
  }
}
