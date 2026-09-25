import { createHash } from "node:crypto"

/**
 * A UUID named by `name`: the same name, the same id, every time. SHA-256
 * cut to a version-4 shape (RFC 9562, with its variant bits): Linear accepts
 * only a v4 UUID as a client-chosen issue id, and refuses any other version
 * with "Argument Validation Error: id must be a UUID" (STEP-3323). The
 * callers need only that a retry sends the same one, which the hash gives.
 */
export function stableUuid(name: string): string {
  const h = createHash("sha256").update(name).digest("hex")
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}
