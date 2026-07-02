/** Probe: can we update a FileNode's blobId in-place (preserving id)? */
import { JmapClient } from "./jmap.ts";

const client = new JmapClient({
  baseUrl: process.env.JYNC_BASE ?? "http://localhost:8091",
  user: process.env.JYNC_USER ?? "admin",
  pass: process.env.JYNC_PASS ?? "",
});
await client.connect();
const accountId = client.accountId();
const log = (l: string, v: unknown) => console.log(`\n▸ ${l}\n${JSON.stringify(v, null, 2)}`);

// find the existing note under Jync/
const q = await client.call("FileNode/query", { accountId, filter: { name: "welcome.md", hasType: true } });
let noteId = q.ids?.[0];

// (re)create if the prior run destroyed it
if (!noteId) {
  const b = await client.uploadBlob(accountId, "# recreated\n", "text/markdown");
  const folderQ = await client.call("FileNode/query", { accountId, filter: { name: "Jync" } });
  const parentId = folderQ.ids?.[0] ?? null;
  const c = await client.call("FileNode/set", {
    accountId,
    create: { n: { name: "welcome.md", parentId, blobId: b.blobId, type: "text/markdown", size: b.size } },
  });
  noteId = c.created?.n?.id;
  log("recreated note", c);
}
console.log(`  editing noteId=${noteId}`);

const before = (await client.call("FileNode/get", { accountId, ids: [noteId] })).state;

// upload new content and try an IN-PLACE update of blobId/size
const nb = await client.uploadBlob(accountId, `# in-place edit ${before}\n\n- [x] mutated\n`, "text/markdown");
const upd = await client.call("FileNode/set", {
  accountId,
  update: { [noteId]: { blobId: nb.blobId, size: nb.size } },
});
log("FileNode/set update(blobId) result", upd);

const after = await client.call("FileNode/get", { accountId, ids: [noteId] });
log("node after update", after.list?.[0]);

const changes = await client.call("FileNode/changes", { accountId, sinceState: before, maxChanges: 50 });
log("changes since edit", { created: changes.created, updated: changes.updated, destroyed: changes.destroyed });

const inPlace = upd.updated && noteId in (upd.updated ?? {});
console.log(`\n${inPlace ? "✅ in-place blobId update SUPPORTED" : "❌ not updated — check notUpdated"}`);
if (upd.notUpdated) log("notUpdated", upd.notUpdated);
