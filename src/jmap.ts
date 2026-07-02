/**
 * Jync — minimal JMAP client (dependency-free, native fetch).
 *
 * Covers exactly what a FileNode sync engine needs:
 *   - session discovery
 *   - batched method calls (`using` + methodCalls)
 *   - blob upload / download
 *
 * Deliberately small: this is the de-risking prototype, not the plugin.
 */

export interface JmapSession {
  apiUrl: string;
  uploadUrl: string;
  downloadUrl: string;
  username: string;
  capabilities: Record<string, unknown>;
  accounts: Record<string, { name: string; isPersonal: boolean; isReadOnly: boolean }>;
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

const CORE = "urn:ietf:params:jmap:core";
const FILENODE = "urn:ietf:params:jmap:filenode";
const BLOB = "urn:ietf:params:jmap:blob";

export class JmapClient {
  private base: string;
  private auth: string;
  session!: JmapSession;

  constructor(opts: { baseUrl: string; user: string; pass: string }) {
    this.base = opts.baseUrl.replace(/\/$/, "");
    this.auth = "Basic " + Buffer.from(`${opts.user}:${opts.pass}`).toString("base64");
  }

  /** Resolve a possibly-relative JMAP URL against the server origin. */
  private abs(url: string): string {
    return url.startsWith("http") ? url : this.base + url;
  }

  async connect(): Promise<JmapSession> {
    const res = await fetch(this.base + "/jmap/session", {
      headers: { Authorization: this.auth },
    });
    if (!res.ok) throw new Error(`session ${res.status}: ${await res.text()}`);
    this.session = (await res.json()) as JmapSession;
    return this.session;
  }

  /** The account id that serves a given capability (defaults to filenode). */
  accountId(capability = FILENODE): string {
    const id = this.session.primaryAccounts[capability];
    if (!id) throw new Error(`no primary account for ${capability}`);
    return id;
  }

  /** Fire a batch of method calls. */
  async request(
    methodCalls: MethodCall[],
    using: string[] = [CORE, FILENODE, BLOB],
  ): Promise<MethodResponse[]> {
    const res = await fetch(this.abs(this.session.apiUrl), {
      method: "POST",
      headers: { Authorization: this.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ using, methodCalls }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`api ${res.status}: ${text}`);
    const body = JSON.parse(text);
    return body.methodResponses as MethodResponse[];
  }

  /** Convenience: single method call, returns just its result object. */
  async call(method: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    const [resp] = await this.request([[method, args, "c0"]]);
    if (resp[0] === "error") throw new Error(`${method} error: ${JSON.stringify(resp[1])}`);
    return resp[1];
  }

  async uploadBlob(accountId: string, data: Uint8Array | string, type = "application/octet-stream"): Promise<BlobUploadResult> {
    const url = this.abs(this.session.uploadUrl.replace("{accountId}", accountId));
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: this.auth, "Content-Type": type },
      body: typeof data === "string" ? data : (data as any),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`upload ${res.status}: ${text}`);
    return JSON.parse(text) as BlobUploadResult;
  }

  async downloadBlob(accountId: string, blobId: string, name = "blob", type = "application/octet-stream"): Promise<string> {
    const url = this.abs(
      this.session.downloadUrl
        .replace("{accountId}", accountId)
        .replace("{blobId}", blobId)
        .replace("{name}", encodeURIComponent(name))
        .replace("{type}", encodeURIComponent(type)),
    );
    const res = await fetch(url, { headers: { Authorization: this.auth } });
    if (!res.ok) throw new Error(`download ${res.status}: ${await res.text()}`);
    return await res.text();
  }

  async downloadBlobBinary(accountId: string, blobId: string, name = "blob", type = "application/octet-stream"): Promise<ArrayBuffer> {
    const url = this.abs(
      this.session.downloadUrl
        .replace("{accountId}", accountId)
        .replace("{blobId}", blobId)
        .replace("{name}", encodeURIComponent(name))
        .replace("{type}", encodeURIComponent(type)),
    );
    const res = await fetch(url, { headers: { Authorization: this.auth } });
    if (!res.ok) throw new Error(`download ${res.status}`);
    return await res.arrayBuffer();
  }
}
