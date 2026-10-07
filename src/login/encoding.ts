// base64url without padding (RFC 4648 section 5), as ZIP 321 asks for memos.

const B64URL = /^[A-Za-z0-9_-]*$/;

export function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Strict decode: rejects padding, other alphabets, and inputs that do not round trip. */
export function b64urlDecode(text: string): Buffer {
  if (!B64URL.test(text) || text.length % 4 === 1) throw new Error("not base64url");
  const out = Buffer.from(text, "base64url");
  if (out.toString("base64url") !== text) throw new Error("not canonical base64url");
  return out;
}
