/**
 * Navigation and window-open policy for the desktop shell, kept free of
 * Electron imports so it can be unit tested.
 *
 * Why this exists: Electron child windows inherit the opener's webPreferences,
 * including the preload that exposes the loopback/admin tokens and the
 * key-writing and backup-restore IPC bridge. Without a policy, clicking a
 * citation link in a report would load an arbitrary site with that bridge.
 */

export type WindowOpenDecision =
  | { action: "deny"; openExternally?: string }
  | { action: "allow-isolated" };

/**
 * The packaged UI is served from this privileged scheme rather than file://:
 * it gives the page a stable origin the local API can allowlist for CORS
 * (file:// sends Origin: null), lets absolute asset paths resolve, and keeps
 * file-system access confined to the bundled web root.
 */
export const APP_SCHEME = "app";
export const APP_HOST = "jantra";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY = `${APP_ORIGIN}/index.html`;

/** CSP for the console, which holds the operator API key in its storage. */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' http://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return CONTENT_TYPES[dot >= 0 ? filePath.slice(dot).toLowerCase() : ""] ?? "application/octet-stream";
}

/**
 * Map an app:// request to a file inside webRoot, or null. Rejects other
 * hosts, encoded separators, NUL bytes and anything that would escape the
 * root after normalization.
 */
export function resolveAppAsset(requestUrl: string, webRoot: string, sep = "/"): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0") || pathname.includes("\\")) return null;
  if (pathname === "/" || pathname === "") pathname = "/index.html";
  const segments: string[] = [];
  for (const part of pathname.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    segments.push(part);
  }
  if (!segments.length) return null;
  const root = webRoot.endsWith(sep) ? webRoot.slice(0, -1) : webRoot;
  return [root, ...segments].join(sep);
}

function originKey(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

/** True for the app's own UI: the bundled index.html or the dev server origin. */
export function isAppUrl(url: string, entry: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  // URL-style entries (app:// in packaged builds, http(s) dev server) match
  // by scheme and host. URL.origin is "null" for custom schemes, so compare
  // protocol and host directly.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry) && !entry.startsWith("file:")) {
    try {
      return originKey(target) === originKey(new URL(entry));
    } catch {
      return false;
    }
  }
  // Packaged build: only the bundled entry file (any hash/query) counts.
  if (target.protocol !== "file:") return false;
  const entryUrl = new URL(`file://${entry.startsWith("/") ? "" : "/"}${entry.replace(/\\/g, "/")}`);
  return decodeURIComponent(target.pathname) === decodeURIComponent(entryUrl.pathname);
}

/**
 * - http(s) links go to the system browser, never an Electron window.
 * - blob: documents (the exported report, created by the app itself) may open,
 *   but only in an isolated window with no preload and no bridge.
 * - everything else (file:, javascript:, data:, custom schemes) is refused.
 */
export function decideWindowOpen(url: string): WindowOpenDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { action: "deny" };
  }
  if (parsed.protocol === "https:" || parsed.protocol === "http:") {
    return { action: "deny", openExternally: parsed.toString() };
  }
  if (parsed.protocol === "blob:") return { action: "allow-isolated" };
  return { action: "deny" };
}

/** In-place navigation of the main window may only stay inside the app. */
export function decideNavigation(url: string, entry: string): WindowOpenDecision {
  if (isAppUrl(url, entry)) return { action: "allow-isolated" };
  const decision = decideWindowOpen(url);
  return decision.action === "deny" ? decision : { action: "deny" };
}
