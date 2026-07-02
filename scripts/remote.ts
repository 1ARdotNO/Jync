/**
 * Remote helper for the Jync test loop — inspect / reset / verify the Stalwart side.
 *   node scripts/remote.ts list
 *   node scripts/remote.ts reset          (destroy the Jync root folder + children)
 *   node scripts/remote.ts verify         (recursively list with size/type/sha256)
 */
import { JmapClient } from "../src/jmap.ts";
import { createHash } from "node:crypto";

const BASE = process.env.JYNC_BASE ?? "http://localhost:8091";
const USER = process.env.JYNC_USER ?? "admin";
const PASS = process.env.JYNC_PASS ?? "";
const ROOT = process.env.JYNC_ROOT ?? "Jync";
const cmd = process.argv[2] ?? "list";

const c = new JmapClient({ baseUrl: BASE, user: USER, pass: PASS });
await c.connect();
const acc = c.accountId();

const rootQ = await c.call("FileNode/query", { accountId: acc, filter: { name: ROOT, isTopLevel: true } });
const rootId = rootQ.ids?.[0];

if (cmd === "reset") {
  if (!rootId) { console.log("no remote root to reset"); process.exit(0); }
  await c.call("FileNode/set", { accountId: acc, destroy: [rootId], onDestroyRemoveChildren: true });
  console.log("reset: destroyed remote root", ROOT, rootId);
  process.exit(0);
}

// mutate the remote side (for pull / conflict testing): edit or add a top-level file
if (cmd === "edit" || cmd === "add") {
  if (!rootId) { console.log(`remote root "${ROOT}" not found`); process.exit(1); }
  const rel = process.argv[3];
  const text = process.argv[4] ?? "";
  const blob = await c.uploadBlob(acc, text, "text/markdown");
  const childQ = await c.call("FileNode/query", { accountId: acc, filter: { parentId: rootId, name: rel } });
  const existing = childQ.ids?.[0];
  if (existing && cmd === "edit") {
    await c.call("FileNode/set", { accountId: acc, update: { [existing]: { blobId: blob.blobId, size: blob.size } } });
    console.log(`remote edit ${rel} (${existing}) -> ${blob.size}b`);
  } else {
    const set = await c.call("FileNode/set", { accountId: acc, create: { f: { name: rel, parentId: rootId, blobId: blob.blobId, type: "text/markdown", size: blob.size } } });
    console.log(`remote add ${rel} -> ${set.created?.f?.id ?? JSON.stringify(set.notCreated)}`);
  }
  process.exit(0);
}

if (!rootId) { console.log(`remote root "${ROOT}" not found`); process.exit(0); }

// all descendants
const q = await c.call("FileNode/query", { accountId: acc, filter: { ancestorId: rootId } });
const got = await c.call("FileNode/get", { accountId: acc, ids: q.ids ?? [] });
const nodes = new Map<string, any>();
for (const n of got.list ?? []) nodes.set(n.id, n);

const pathOf = (n: any): string => {
  const parts = [n.name];
  let p = n.parentId;
  while (p && p !== rootId) { const pn = nodes.get(p); if (!pn) break; parts.unshift(pn.name); p = pn.parentId; }
  return parts.join("/");
};

const rows = [...nodes.values()].map((n) => ({ path: pathOf(n), type: n.nodeType, size: n.size, mime: n.type, blobId: n.blobId, id: n.id }))
  .sort((a, b) => a.path.localeCompare(b.path));

console.log(`remote root ${ROOT} (${rootId}) — ${rows.length} nodes`);
for (const r of rows) {
  let extra = "";
  if (cmd === "verify" && r.type === "file" && r.blobId) {
    const buf = await c.downloadBlobBinary(acc, r.blobId, r.path.split("/").pop(), r.mime ?? "application/octet-stream");
    const sha = createHash("sha256").update(Buffer.from(buf)).digest("hex").slice(0, 12);
    extra = `  sha256=${sha} dl=${buf.byteLength}b`;
  }
  console.log(`  ${r.type === "directory" ? "DIR " : "file"}  ${r.path.padEnd(22)} ${String(r.size ?? "").padStart(6)}  id=${r.id} blob=${(r.blobId ?? "").slice(-8)}  ${r.mime ?? ""}${extra}`);
}
