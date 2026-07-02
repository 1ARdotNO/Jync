/**
 * Jync sync engine — mirror a vault subtree <-> a JMAP FileNode tree.
 *
 * Directions per sync():
 *   1. PULL  remote -> local via FileNode/changes since a stored state token
 *   2. PUSH  local  -> remote (create / in-place edit / delete) with hash diffing
 *
 * Safety:
 *   - operates ONLY under `syncRoot` (a vault-relative folder)
 *   - local deletes are gated behind `allowLocalDeletes` (default off)
 *   - remote-vs-local double edits produce a conflict COPY, never data loss
 */
import { DataAdapter, normalizePath } from "obsidian";
import { JmapClient } from "./jmap.ts";

export interface JyncConfig {
  syncRoot: string; // vault-relative folder, e.g. "Jync"
  remoteRootName: string; // top-level FileNode folder name, e.g. "Jync"
  allowLocalDeletes: boolean;
}

export interface SyncState {
  rootNodeId?: string;
  changesState?: string;
  folders: Record<string, string>; // relDir ("" = root) -> nodeId
  files: Record<string, { nodeId: string; hash: string; size: number }>; // relPath -> record
}

export interface SyncReport {
  pulled: number;
  pushedNew: number;
  pushedEdit: number;
  deletedRemote: number;
  deletedLocal: number;
  conflicts: number;
  errors: string[];
}

const MIME: Record<string, string> = {
  md: "text/markdown", txt: "text/plain", json: "application/json", canvas: "application/json",
  csv: "text/csv", yml: "text/yaml", yaml: "text/yaml", css: "text/css", html: "text/html",
  svg: "image/svg+xml", xml: "application/xml", png: "image/png", jpg: "image/jpeg",
  jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
  mp3: "audio/mpeg", mp4: "video/mp4", zip: "application/zip",
};

const log = (...a: unknown[]) => console.log("[jync]", ...a);
const ext = (p: string) => (p.includes(".") ? p.slice(p.lastIndexOf(".") + 1).toLowerCase() : "");
const mimeOf = (p: string) => MIME[ext(p)] ?? "application/octet-stream";

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class SyncEngine {
  private running = false; // single-flight guard

  constructor(
    private adapter: DataAdapter,
    private client: JmapClient,
    private cfg: JyncConfig,
    private state: SyncState,
    private saveState: (s: SyncState) => Promise<void>,
  ) {}

  private accountId(): string {
    return this.client.accountId();
  }

  /** Recursively list every file (relative to syncRoot) plus every folder. */
  private async scanLocal(): Promise<{ files: string[]; dirs: string[] }> {
    const root = normalizePath(this.cfg.syncRoot);
    const files: string[] = [];
    const dirs: string[] = [];
    const walk = async (dir: string) => {
      const listing = await this.adapter.list(dir);
      for (const f of listing.files) files.push(f);
      for (const d of listing.folders) {
        if (d.split("/").pop()?.startsWith(".")) continue; // skip .obsidian etc.
        dirs.push(d);
        await walk(d);
      }
    };
    if (await this.adapter.exists(root)) await walk(root);
    const rel = (p: string) => p.slice(root.length + 1);
    return { files: files.map(rel), dirs: dirs.map(rel) };
  }

  /** Ensure the top-level remote root folder exists; returns its node id. */
  private async ensureRoot(): Promise<string> {
    if (this.state.rootNodeId) {
      const got = await this.client.call("FileNode/get", { accountId: this.accountId(), ids: [this.state.rootNodeId] });
      if (got.list?.length) return this.state.rootNodeId;
    }
    const q = await this.client.call("FileNode/query", {
      accountId: this.accountId(),
      filter: { name: this.cfg.remoteRootName, isTopLevel: true },
    });
    let id = q.ids?.[0];
    if (!id) {
      const set = await this.client.call("FileNode/set", {
        accountId: this.accountId(),
        create: { root: { name: this.cfg.remoteRootName, parentId: null } },
      });
      id = set.created?.root?.id;
      if (!id) throw new Error("could not create remote root: " + JSON.stringify(set.notCreated));
    }
    this.state.rootNodeId = id;
    this.state.folders[""] = id;
    return id;
  }

  /** Ensure a folder node exists for relDir (creating ancestors); returns node id. */
  private async ensureDir(relDir: string): Promise<string> {
    if (relDir === "" ) return this.state.rootNodeId!;
    if (this.state.folders[relDir]) return this.state.folders[relDir];
    const parts = relDir.split("/");
    const parentRel = parts.slice(0, -1).join("/");
    const parentId = await this.ensureDir(parentRel);
    const name = parts[parts.length - 1];
    // reuse if already present remotely
    const q = await this.client.call("FileNode/query", { accountId: this.accountId(), filter: { parentId, name } });
    let id = q.ids?.[0];
    if (!id) {
      const set = await this.client.call("FileNode/set", {
        accountId: this.accountId(),
        create: { d: { name, parentId } },
      });
      id = set.created?.d?.id;
      if (!id) throw new Error(`mkdir ${relDir}: ${JSON.stringify(set.notCreated)}`);
    }
    this.state.folders[relDir] = id;
    return id;
  }

  private async readLocal(rel: string): Promise<ArrayBuffer> {
    const abs = normalizePath(this.cfg.syncRoot + "/" + rel);
    return await this.adapter.readBinary(abs);
  }

  private async writeLocal(rel: string, buf: ArrayBuffer): Promise<void> {
    const abs = normalizePath(this.cfg.syncRoot + "/" + rel);
    const dir = abs.slice(0, abs.lastIndexOf("/"));
    if (dir && !(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
    await this.adapter.writeBinary(abs, buf);
  }

  /** Build the vault-relative path of a remote node by walking parentIds up to root. */
  private async remotePath(nodeId: string, cache: Map<string, any>): Promise<string | null> {
    const parts: string[] = [];
    let cur = nodeId;
    for (let i = 0; i < 64; i++) {
      if (cur === this.state.rootNodeId) return parts.reverse().join("/");
      let node = cache.get(cur);
      if (!node) {
        const got = await this.client.call("FileNode/get", { accountId: this.accountId(), ids: [cur] });
        node = got.list?.[0];
        if (!node) return null;
        cache.set(cur, node);
      }
      parts.push(node.name);
      if (!node.parentId) return null; // reached a different top-level tree
      cur = node.parentId;
    }
    return null;
  }

  /** PULL: apply remote changes since the stored state token. */
  private async pull(report: SyncReport): Promise<void> {
    if (!this.state.changesState) return; // first run: nothing to pull
    const acc = this.accountId();
    const cache = new Map<string, any>();
    let since = this.state.changesState;
    const changedIds = new Set<string>();
    const destroyedIds = new Set<string>();
    for (let guard = 0; guard < 50; guard++) {
      const ch = await this.client.call("FileNode/changes", { accountId: acc, sinceState: since, maxChanges: 200 });
      (ch.created ?? []).forEach((i: string) => changedIds.add(i));
      (ch.updated ?? []).forEach((i: string) => changedIds.add(i));
      (ch.destroyed ?? []).forEach((i: string) => { destroyedIds.add(i); changedIds.delete(i); });
      since = ch.newState;
      if (!ch.hasMoreChanges) break;
    }

    // build reverse map nodeId->relPath from state for destroy handling
    const byNode = new Map<string, string>();
    for (const [rel, rec] of Object.entries(this.state.files)) byNode.set(rec.nodeId, rel);

    // destroyed remotely -> delete locally (guarded)
    for (const id of destroyedIds) {
      const rel = byNode.get(id);
      if (!rel) continue;
      delete this.state.files[rel];
      if (this.cfg.allowLocalDeletes) {
        const abs = normalizePath(this.cfg.syncRoot + "/" + rel);
        if (await this.adapter.exists(abs)) { await this.adapter.remove(abs); report.deletedLocal++; log("pull delete", rel); }
      } else {
        log("pull: remote deleted (local kept, deletes disabled):", rel);
      }
    }

    if (changedIds.size === 0) return;
    const got = await this.client.call("FileNode/get", { accountId: acc, ids: [...changedIds] });
    for (const node of got.list ?? []) cache.set(node.id, node);

    for (const node of got.list ?? []) {
      if (node.nodeType === "directory") continue; // folders created implicitly on write
      const rel = await this.remotePath(node.id, cache);
      if (rel === null) continue; // not under our root
      const prev = this.state.files[rel];
      // skip if this is our own push echoed back (same blob we already have)
      if (prev && prev.nodeId === node.id) {
        // remote blobId changed by someone else?
        const buf = await this.client.downloadBlobBinary(acc, node.blobId, node.name, node.type ?? "application/octet-stream");
        const h = await sha256Hex(buf);
        if (h === prev.hash) continue; // unchanged content
        // remote edit — check for local concurrent edit -> conflict
        const localExists = await this.adapter.exists(normalizePath(this.cfg.syncRoot + "/" + rel));
        let localChanged = false;
        if (localExists) {
          const lh = await sha256Hex(await this.readLocal(rel));
          localChanged = lh !== prev.hash;
        }
        if (localChanged) {
          const cpath = rel.replace(/(\.[^.]+)?$/, (m) => ` (remote conflict)${m || ""}`);
          await this.writeLocal(cpath, buf);
          report.conflicts++;
          log("CONFLICT — wrote remote copy to", cpath);
          continue;
        }
        await this.writeLocal(rel, buf);
        this.state.files[rel] = { nodeId: node.id, hash: h, size: buf.byteLength };
        report.pulled++;
        log("pull update", rel);
      } else {
        // new remote file
        const buf = await this.client.downloadBlobBinary(acc, node.blobId, node.name, node.type ?? "application/octet-stream");
        await this.writeLocal(rel, buf);
        this.state.files[rel] = { nodeId: node.id, hash: await sha256Hex(buf), size: buf.byteLength };
        report.pulled++;
        log("pull new", rel);
      }
    }
  }

  /** PUSH: create/edit/delete remote to match local. */
  private async push(report: SyncReport): Promise<void> {
    const acc = this.accountId();
    const { files, dirs } = await this.scanLocal();

    // ensure folders (shallow-first)
    for (const d of dirs.sort((a, b) => a.split("/").length - b.split("/").length)) await this.ensureDir(d);

    const seen = new Set<string>();
    for (const rel of files) {
      seen.add(rel);
      try {
        const buf = await this.readLocal(rel);
        const hash = await sha256Hex(buf);
        const prev = this.state.files[rel];
        if (prev && prev.hash === hash) continue; // unchanged
        const parentRel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
        const parentId = await this.ensureDir(parentRel);
        const name = rel.split("/").pop()!;
        const blob = await this.client.uploadBlob(acc, buf, mimeOf(rel));
        if (prev) {
          await this.client.call("FileNode/set", { accountId: acc, update: { [prev.nodeId]: { blobId: blob.blobId, size: blob.size } } });
          this.state.files[rel] = { nodeId: prev.nodeId, hash, size: blob.size };
          report.pushedEdit++;
          log("push edit", rel);
        } else {
          const set = await this.client.call("FileNode/set", {
            accountId: acc,
            create: { f: { name, parentId, blobId: blob.blobId, type: mimeOf(rel), size: blob.size } },
          });
          let id = set.created?.f?.id;
          if (!id) {
            // Adopt a pre-existing remote node at this path (makes sync idempotent),
            // then overwrite its content with our local version.
            const nc = set.notCreated?.f;
            if (nc?.type === "alreadyExists" && nc.existingId) {
              id = nc.existingId as string;
              await this.client.call("FileNode/set", { accountId: acc, update: { [id]: { blobId: blob.blobId, size: blob.size } } });
              log("push adopt+overwrite", rel);
            } else {
              throw new Error(`create ${rel}: ${JSON.stringify(set.notCreated)}`);
            }
          } else {
            report.pushedNew++;
            log("push new", rel);
          }
          this.state.files[rel] = { nodeId: id, hash, size: blob.size };
        }
      } catch (e: any) {
        report.errors.push(`push ${rel}: ${e.message}`);
        log("push ERROR", rel, e.message);
      }
    }

    // local deletions -> remote destroy
    for (const rel of Object.keys(this.state.files)) {
      if (seen.has(rel)) continue;
      const rec = this.state.files[rel];
      try {
        await this.client.call("FileNode/set", { accountId: acc, destroy: [rec.nodeId] });
        delete this.state.files[rel];
        report.deletedRemote++;
        log("push delete", rel);
      } catch (e: any) {
        report.errors.push(`destroy ${rel}: ${e.message}`);
      }
    }
  }

  /** Run one full bidirectional sync. */
  async sync(): Promise<SyncReport> {
    if (this.running) throw new Error("sync already running");
    this.running = true;
    const report: SyncReport = { pulled: 0, pushedNew: 0, pushedEdit: 0, deletedRemote: 0, deletedLocal: 0, conflicts: 0, errors: [] };
    try {
      if (!this.client.session) await this.client.connect();
      if (!this.client.hasFileNode()) throw new Error("server does not advertise JMAP FileNode");
      await this.ensureRoot();
      await this.pull(report);
      await this.push(report);
      // set the pull baseline to the current state so our own pushes aren't re-pulled next time
      const st = await this.client.call("FileNode/get", { accountId: this.accountId(), ids: [this.state.rootNodeId!] });
      this.state.changesState = st.state;
      await this.saveState(this.state);
      log("sync done", report);
      return report;
    } finally {
      this.running = false;
    }
  }
}
