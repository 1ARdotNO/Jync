/**
 * Pure path/name helpers for the sync engine — no Obsidian imports, so they're
 * unit-testable under plain Node. Security-critical: safeSegment guards the pull
 * path against traversal/illegal names (see docs/SECURITY-REVIEW.md F1/F5).
 */

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
