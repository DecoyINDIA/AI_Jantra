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

/** True for the app's own UI: the bundled index.html or the dev server origin. */
export function isAppUrl(url: string, entry: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (/^https?:\/\//.test(entry)) {
    try {
      return target.origin === new URL(entry).origin;
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
