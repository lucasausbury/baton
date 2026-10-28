import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Helpers shared by the two pages this server renders -- the OAuth consent
 * screen and the read-only session page. Both escape untrusted text into HTML,
 * and both check the one login password.
 */

export const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** Compares digests so neither length nor content leaks through timing. */
export function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(sha256(given), "hex");
  const b = Buffer.from(sha256(expected), "hex");
  return timingSafeEqual(a, b);
}

export const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
