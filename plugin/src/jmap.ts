/**
 * Browser-safe JMAP client for the Jync Obsidian plugin.
 *
 * Uses Obsidian's `requestUrl` (proxied by ignis, CORS-free on desktop) instead
 * of `fetch`, and web-standard base64 instead of Node `Buffer`. Mirrors the
 * de-risked Node prototype in ../../src/jmap.ts.
 */
import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { JmapAuth, buildAuthHeader } from "./paths.ts";

const CORE = "urn:ietf:params:jmap:core";
const FILENODE = "urn:ietf:params:jmap:filenode";
const BLOB = "urn:ietf:params:jmap:blob";

export interface JmapSession {
  apiUrl: string;
  uploadUrl: string;
  downloadUrl: string;
  username: string;
  capabilities: Record<string, unknown>;
  primaryAccounts: Record<string, string>;
  state: string;
}

export interface BlobUploadResult {
  accountId: string;
  blobId: string;
  type: string;
  size: number;
}

export type MethodCall = [method: string, args: Record<string, unknown>, callId: string];
export type MethodResponse = [method: string, result: Record<string, any>, callId: string];

export class JmapClient {
  private base: string;
  private auth: string;
  private retries: number;
  private baseDelay: number;
  session!: JmapSession;

  constructor(opts: { baseUrl: string; auth: JmapAuth; retries?: number; baseDelay?: number }) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.auth = buildAuthHeader(opts.auth);
    this.retries = opts.retries ?? 3;
    this.baseDelay = opts.baseDelay ?? 400;
  }

  private abs(url: string): string {
    return url.startsWith("http") ? url : this.base + url;
  }

  /** requestUrl with retry + backoff on transient failures (network error, 429, 5xx). */
  private async req(params: RequestUrlParam): Promise<RequestUrlResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await requestUrl({ ...params, throw: false });
        const transient = res.status === 429 || (res.status >= 500 && res.status <= 599);
        if (transient && attempt < this.retries) {
          await this.backoff(attempt, res);
          continue;
        }
        return res;
      } catch (e) {
        // network-level failure (offline, DNS, reset) — retry, then surface.
        if (attempt < this.retries) {
          await this.backoff(attempt);
          continue;
        }
        throw e;
      }
    }
  }

  /** Exponential backoff with jitter; honors Retry-After when the server sends it. */
  private backoff(attempt: number, res?: RequestUrlResponse): Promise<void> {
    let ms = this.baseDelay * 2 ** attempt;
    const ra = res?.headers?.["retry-after"] ?? res?.headers?.["Retry-After"];
    if (ra) {
      const s = parseInt(ra, 10);
      if (!Number.isNaN(s)) ms = s * 1000;
    }
    ms += Math.floor(Math.random() * 200);
    return new Promise((r) => setTimeout(r, ms));
  }

  async connect(): Promise<JmapSession> {
    const res = await this.req({
      url: this.base + "/jmap/session",
      headers: { Authorization: this.auth },
    });
    if (res.status !== 200) throw new Error(`session ${res.status}: ${res.text?.slice(0, 200)}`);
    const s = res.json as JmapSession;
    // Never send credentials cross-origin: pin the advertised endpoints to baseUrl's origin (F2).
    const baseOrigin = new URL(this.base).origin;
    for (const [k, u] of Object.entries({ apiUrl: s.apiUrl, uploadUrl: s.uploadUrl, downloadUrl: s.downloadUrl })) {
      if (!u) continue;
      const probe = u.replace(/\{[^}]+\}/g, "x"); // strip {accountId}/{blobId}/… templates
      const absUrl = probe.startsWith("http") ? probe : this.base + probe;
      if (new URL(absUrl).origin !== baseOrigin) {
        throw new Error(`JMAP ${k} origin differs from ${baseOrigin}; refusing to send credentials cross-origin`);
      }
    }
    this.session = s;
    return this.session;
  }

  accountId(capability = FILENODE): string {
    const id = this.session.primaryAccounts[capability];
    if (!id) throw new Error(`no primary account for ${capability}`);
    return id;
  }

  hasFileNode(): boolean {
    return FILENODE in (this.session?.capabilities ?? {});
  }

  async request(methodCalls: MethodCall[], using: string[] = [CORE, FILENODE, BLOB]): Promise<MethodResponse[]> {
    const res = await this.req({
      url: this.abs(this.session.apiUrl),
      method: "POST",
      headers: { Authorization: this.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ using, methodCalls }),
    } as RequestUrlParam);
    if (res.status !== 200) throw new Error(`api ${res.status}: ${res.text?.slice(0, 300)}`);
    return res.json.methodResponses as MethodResponse[];
  }

  /** Single method call; throws on a JMAP method-level error. */
  async call(method: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    const [resp] = await this.request([[method, args, "c0"]]);
    if (resp[0] === "error") throw new Error(`${method} error: ${JSON.stringify(resp[1])}`);
    return resp[1];
  }

  async uploadBlob(accountId: string, data: ArrayBuffer | string, type: string): Promise<BlobUploadResult> {
    const url = this.abs(this.session.uploadUrl.replace("{accountId}", accountId));
    const res = await this.req({
      url,
      method: "POST",
      headers: { Authorization: this.auth, "Content-Type": type },
      body: typeof data === "string" ? new TextEncoder().encode(data).buffer : data,
    } as RequestUrlParam);
    if (res.status !== 200 && res.status !== 201) throw new Error(`upload ${res.status}: ${res.text?.slice(0, 200)}`);
    return res.json as BlobUploadResult;
  }

  async downloadBlobBinary(accountId: string, blobId: string, name = "blob", type = "application/octet-stream"): Promise<ArrayBuffer> {
    const url = this.abs(
      this.session.downloadUrl
        .replace("{accountId}", accountId)
        .replace("{blobId}", blobId)
        .replace("{name}", encodeURIComponent(name))
        .replace("{type}", encodeURIComponent(type)),
    );
    const res = await this.req({ url, headers: { Authorization: this.auth } });
    if (res.status !== 200) throw new Error(`download ${res.status}`);
    return res.arrayBuffer;
  }
}
