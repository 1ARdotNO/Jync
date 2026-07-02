/**
 * Browser-safe JMAP client for the Jync Obsidian plugin.
 *
 * Uses Obsidian's `requestUrl` (proxied by ignis, CORS-free on desktop) instead
 * of `fetch`, and web-standard base64 instead of Node `Buffer`. Mirrors the
 * de-risked Node prototype in ../../src/jmap.ts.
 */
import { requestUrl, RequestUrlParam } from "obsidian";

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

/** UTF-8 safe base64 for Basic auth (avoids Node Buffer). */
function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export class JmapClient {
  private base: string;
  private auth: string;
  session!: JmapSession;

  constructor(opts: { baseUrl: string; user: string; pass: string }) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.auth = "Basic " + b64(`${opts.user}:${opts.pass}`);
  }

  private abs(url: string): string {
    return url.startsWith("http") ? url : this.base + url;
  }

  async connect(): Promise<JmapSession> {
    const res = await requestUrl({
      url: this.base + "/jmap/session",
      headers: { Authorization: this.auth },
      throw: false,
    });
    if (res.status !== 200) throw new Error(`session ${res.status}: ${res.text?.slice(0, 200)}`);
    this.session = res.json as JmapSession;
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
    const res = await requestUrl({
      url: this.abs(this.session.apiUrl),
      method: "POST",
      headers: { Authorization: this.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ using, methodCalls }),
      throw: false,
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
    const res = await requestUrl({
      url,
      method: "POST",
      headers: { Authorization: this.auth, "Content-Type": type },
      body: typeof data === "string" ? new TextEncoder().encode(data).buffer : data,
      throw: false,
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
    const res = await requestUrl({ url, headers: { Authorization: this.auth }, throw: false });
    if (res.status !== 200) throw new Error(`download ${res.status}`);
    return res.arrayBuffer;
  }
}
