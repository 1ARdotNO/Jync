/**
 * Pure path/name helpers for the sync engine — no Obsidian imports, so they're
 * unit-testable under plain Node. Security-critical: safeSegment guards the pull
 * path against traversal/illegal names (see docs/SECURITY-REVIEW.md F1/F5).
 */

/** JMAP authentication: HTTP Basic (user/pass) or a bearer token (OAuth / app token). */
export type JmapAuth = { type: "basic"; user: string; pass: string } | { type: "bearer"; token: string };

/** UTF-8 safe base64 (avoids Node Buffer; works in browser and Node). */
export function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

/** Build the Authorization header value for the chosen auth. */
export function buildAuthHeader(auth: JmapAuth): string {
  return auth.type === "bearer" ? `Bearer ${auth.token}` : "Basic " + b64(`${auth.user}:${auth.pass}`);
}

export type ConflictStrategy = "copy" | "prefer-local" | "prefer-remote";

/**
 * What to do with one remote file during a first-run reconcile, given whether a
 * local file exists at the same path and how their content hashes compare.
 *
 *  - "download"       remote-only → write it locally
 *  - "adopt"          both present, identical content → just record state, no transfer
 *  - "conflict-copy"  both present, differ → keep local, save remote as a conflict copy
 *  - "overwrite-local" both differ, prefer-remote → replace local with remote
 *  - "keep-local"     both differ, prefer-local → leave local (push will overwrite remote)
 */
export type ReconcileAction = "download" | "adopt" | "conflict-copy" | "overwrite-local" | "keep-local";

export function reconcileDecision(
  localExists: boolean,
  localHash: string | null,
  remoteHash: string,
  strategy: ConflictStrategy,
): ReconcileAction {
  if (!localExists) return "download";
  if (localHash === remoteHash) return "adopt";
  // divergent content on both sides
  if (strategy === "prefer-remote") return "overwrite-local";
  if (strategy === "prefer-local") return "keep-local";
  return "conflict-copy";
}

const MIME: Record<string, string> = {
  md: "text/markdown", txt: "text/plain", json: "application/json", canvas: "application/json",
  csv: "text/csv", yml: "text/yaml", yaml: "text/yaml", css: "text/css", html: "text/html",
  svg: "image/svg+xml", xml: "application/xml", png: "image/png", jpg: "image/jpeg",
  jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
  mp3: "audio/mpeg", mp4: "video/mp4", zip: "application/zip",
};

export const ext = (p: string): string => (p.includes(".") ? p.slice(p.lastIndexOf(".") + 1).toLowerCase() : "");
export const mimeOf = (p: string): string => MIME[ext(p)] ?? "application/octet-stream";

// Reject server-supplied node names that could escape the sync root or break the OS
// (mirrors Stalwart's advertised forbiddenNameChars / reserved names).
const FORBIDDEN_NAME_CHARS = /[/\\<>:"|?*]/;
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 32) return true;
  return false;
}

export function safeSegment(name: string): boolean {
  return (
    !!name &&
    name.length <= 255 &&
    name !== "." &&
    name !== ".." &&
    !FORBIDDEN_NAME_CHARS.test(name) &&
    !hasControlChar(name) &&
    !RESERVED_NAME.test(name.split(".")[0])
  );
}

/** Compile glob-ish ignore patterns into a matcher over sync-root-relative paths. */
export function makeIgnore(patterns: string[]): (rel: string) => boolean {
  const compiled = patterns
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p0) => {
      const p = p0.replace(/\/+$/, ""); // "foo/" -> "foo" (also matches its contents below)
      const body = p
        .split("/")
        .map((seg) =>
          seg
            .replace(/[.+^${}()|[\]\\]/g, (c) => "\\" + c) // escape regex specials (not *)
            .replace(/\*\*|\*/g, (m) => (m === "**" ? ".*" : "[^/]*")),
        )
        .join("/");
      return new RegExp("^" + body + "(/.*)?$");
    });
  return (rel) => {
    const base = rel.split("/").pop() ?? "";
    return compiled.some((re) => re.test(rel) || re.test(base));
  };
}
