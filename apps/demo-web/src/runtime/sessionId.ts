/**
 * Create a UUID v4 even when the page is served from an insecure HTTP IP.
 * crypto.randomUUID is restricted to secure contexts, while getRandomValues
 * remains available in browsers that support this demo's other APIs.
 */
export function createSessionId(): string {
  const browserCrypto = globalThis.crypto;
  if (typeof browserCrypto?.randomUUID === "function") return browserCrypto.randomUUID();
  if (typeof browserCrypto?.getRandomValues !== "function") {
    throw new Error("SECURE_RANDOM_UNAVAILABLE");
  }

  const bytes = browserCrypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
