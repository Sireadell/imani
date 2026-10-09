// Types for the browser login module, so the Node tests can check it against src/login.
export const MEMO_TAG: string;
export const EXPORT_PREFIX: string;
export const EXPORT_WARNING: string;
export function b64url(bytes: Uint8Array): string;
export function fromB64url(text: string): Uint8Array;
export function ed25519Supported(): Promise<boolean>;
export function newLoginKey(): Uint8Array;
export function exportLoginKey(seed: Uint8Array): string;
export function importLoginKey(text: string): Uint8Array;
export function siteKey(loginKey: Uint8Array, siteId: string): Promise<{ privateKey: CryptoKey; accountId: string }>;
export function signedText(m: { siteId: string; network: string; nonce: string; expiresAt: number; accountId: string }): string;
export function buildLoginMemo(
  loginKey: Uint8Array,
  challenge: { siteId: string; network: string; nonce: string; expiresAt: number },
): Promise<{ memo: string; accountId: string }>;
export function proofText(siteId: string, nonce: string): string;
export function buildLoginProof(loginKey: Uint8Array, challenge: { siteId: string; nonce: string }): Promise<string>;
export function formatZec(zat: number): string;
export function parseZec(text: string): number | null;
export function paymentLink(address: string, zat: number, memo: string): string;
export function bidWord(): string;
