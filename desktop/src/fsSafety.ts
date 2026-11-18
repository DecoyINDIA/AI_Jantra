import { lstat } from "node:fs/promises";

/**
 * Run or client IDs become file names. Restrict them to a plain token so an
 * ID like "../../x" cannot read other files or write outside the export dir.
 */
export function assertSafeFileId(id: string): string {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error("Invalid run or client id.");
  }
  return id;
}

/**
 * fs.cp filter for restoring backups: skip symlinks. A planted backup could
 * otherwise place a link in the project or audit directory that redirects
 * later writes anywhere the user can write.
 */
export async function skipSymlinks(source: string): Promise<boolean> {
  const info = await lstat(source);
  return !info.isSymbolicLink();
}
