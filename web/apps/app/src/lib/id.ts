/**
 * A random ID in the form of a UUID. `crypto.randomUUID` exists only where
 * the page is served over HTTPS or from localhost; a server reached over
 * plain HTTP by its address has `crypto.getRandomValues` alone, which is as
 * random. See the reverse proxy section of the operations page: HTTPS is
 * advised, not required.
 */
export function randomId(): string {
  // eslint-disable-next-line no-restricted-properties -- the one place that may ask, and does without
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  // Version 4, variant 1, as RFC 9562 writes a random UUID.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
