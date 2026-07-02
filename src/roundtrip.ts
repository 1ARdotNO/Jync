/**
 * Jync round-trip — de-risks the JMAP FileNode sync path against Stalwart.
 *
 * Proves, end to end:
 *   1. session + capability discovery (is filenode advertised?)
 *   2. blob upload
 *   3. FileNode/set: create a folder (collection) + a file linked to the blob
 *   4. FileNode/get + FileNode/query: read the tree back
 *   5. FileNode/changes: the incremental-sync primitive — edit a note,
 *      then ask "what changed since state X?" and confirm we get a delta.
 *
 * Run: node src/roundtrip.ts   (Node >=23 strips TS types natively)
 */
import { JmapClient } from "./jmap.ts";

const BASE = process.env.JYNC_BASE ?? "http://localhost:8091";
const USER = process.env.JYNC_USER ?? "admin";
const PASS = process.env.JYNC_PASS ?? "";

if (!PASS) {
  console.error("Set JYNC_PASS (Stalwart admin/user password).");
  process.exit(1);
}

const log = (label: string, v: unknown) =>
  console.log(`\n▸ ${label}\n${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`);

const client = new JmapClient({ baseUrl: BASE, user: USER, pass: PASS });

// ── 1. connect ────────────────────────────────────────────────────────────
const session = await client.connect();
const hasFileNode = "urn:ietf:params:jmap:filenode" in session.capabilities;
log("session", { username: session.username, apiUrl: session.apiUrl, hasFileNode });
if (!hasFileNode) throw new Error("server does not advertise JMAP FileNode");

const accountId = client.accountId(); // filenode primary account
console.log(`  filenode accountId = ${accountId}`);

// ── 2. upload blob (the note body) ──────────────────────────────────────────
const noteV1 = `# Jync test note\n\ncreated by roundtrip at run-time\n\n- [ ] prove sync works\n`;
const blob = await client.uploadBlob(accountId, noteV1, "text/markdown");
log("uploaded blob", blob);

// ── 3. FileNode/set: folder then file (idempotent) ──────────────────────────
// Reuse an existing Jync/ + welcome.md if a prior run created them.
const existingFolder = (await client.call("FileNode/query", { accountId, filter: { name: "Jync" } })).ids?.[0];
const existingNote = (await client.call("FileNode/query", { accountId, filter: { name: "welcome.md", hasType: true } })).ids?.[0];

let folderId = existingFolder;
let noteId = existingNote;

if (!noteId) {
  const setResp = await client.call("FileNode/set", {
    accountId,
    create: {
      ...(folderId ? {} : { folder: { name: "Jync", parentId: null } }), // blobId omitted -> collection
      note: {
        name: "welcome.md",
        parentId: folderId ?? "#folder", // back-reference to folder created in same call
        blobId: blob.blobId,
        type: "text/markdown",
        size: blob.size,
      },
    },
  });
  log("FileNode/set create", setResp);
  folderId ??= setResp.created?.folder?.id;
  noteId = setResp.created?.note?.id;
} else {
  console.log(`  reusing folder=${folderId} note=${noteId}`);
}
if (!noteId) throw new Error("note not created — inspect notCreated above");

// ── 4. read the tree back ────────────────────────────────────────────────────
const got = await client.call("FileNode/get", { accountId, ids: [folderId, noteId] });
log("FileNode/get", got.list);

const queried = await client.call("FileNode/query", {
  accountId,
  filter: { parentId: folderId },
  sort: [{ property: "name" }],
});
log("FileNode/query (children of Jync/)", queried);

const body = await client.downloadBlob(accountId, blob.blobId, "welcome.md", "text/markdown");
log("downloaded blob body", body);

// ── 5. incremental sync: FileNode/changes ────────────────────────────────────
// Capture the current state, make an edit, then ask for the delta.
const before = got.state as string;
console.log(`\n  captured state token: ${before}`);

const blob2 = await client.uploadBlob(accountId, noteV1 + "\n- [x] edited!\n", "text/markdown");
// Stalwart allows IN-PLACE blobId update (mayModifyContent) — keeps the node id
// stable across edits, unlike the destroy+recreate the IETF draft implies.
const editResp = await client.call("FileNode/set", {
  accountId,
  update: { [noteId]: { blobId: blob2.blobId, size: blob2.size } },
});
log("FileNode/set edit (in-place blobId update)", editResp);
if (!editResp.updated || !(noteId in editResp.updated)) log("notUpdated", editResp.notUpdated);

const changes = await client.call("FileNode/changes", { accountId, sinceState: before, maxChanges: 50 });
log("FileNode/changes since captured state", changes);

console.log(
  `\n✅ round-trip complete — created=${!!noteId} delta{created:${changes.created?.length} updated:${changes.updated?.length} destroyed:${changes.destroyed?.length}} newState=${changes.newState}`,
);
