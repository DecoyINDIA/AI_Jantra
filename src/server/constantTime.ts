import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function timingSafeStringEqual(a: string | null | undefined, b: string): boolean {
  if (typeof a !== "string" || !b) return false;
  return timingSafeEqual(digest(a), digest(b));
}
