// Sign in with a private Zcash wallet. Not a wallet: it never holds money or spending keys.
// Servers contacted: none. Every function works on data the caller passes in.
export { AccountKey, SiteKey, exportAccountKey, importAccountKey, verifySignature, EXPORT_WARNING } from "./key.ts";
export {
  createChallenge,
  makeNonce,
  MemoryChallengeStore,
  networkOfViewingKey,
  type Challenge,
  type StoredChallenge,
  type ChallengeStore,
  type ChallengeOptions,
  type Network,
} from "./challenge.ts";
export { buildLoginMemo, buildLoginProof, proofText, PROOF_TAG, parseLoginMemo, signedText, looksLikeKey, MEMO_TAG, MEMO_LIMIT, type LoginMemo } from "./memo.ts";
export { buildPaymentUri, checkSinglePayee, formatZec } from "./uri.ts";
export { verifyLoginPayment, checkLoginMemo, FAILURES, type FailureReason, type Failure, type LoginSuccess, type TxReader } from "./verify.ts";
export { SignedSessions, MemorySessions, type Session, type SessionIssuer } from "./session.ts";
export { LoginKit, type LoginKitOptions, type PublicChallenge } from "./kit.ts";
export { buildReceipt, receiptText, receiptClean, type Receipt, type ReceiptField, type ReceiptProbe, type HeldValue } from "./receipt.ts";
export { zcashLogin, requireZcashLogin } from "./express.ts";
export { zcashCredentials, zcashChallengeRoute, zcashReservedChallengeRoute } from "./authjs.ts";
