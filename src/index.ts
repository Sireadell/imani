// The public library: what `import ... from "imani"` gives you. Everything here is the same code
// the command line and the checker page run. Nothing here opens a network connection unless you
// call fetchTransactions, fetchBlocks or fetchScan yourself, and no function takes a spending key or a seed phrase.

// Check a finished round from the seller's files, with or without the lot's read-only viewing key.
export {
  checkLot,
  validateFiles,
  assertViewingKey,
  keyFingerprint,
  InputError,
  KeyRefusedError,
  type Check,
  type CheckOptions,
  type SealedSummary,
  type Status,
  type Verdict,
} from "./check.ts";
export type { Disclosure, SellerResult, AuctionRules, PricingRule, SealedRules, PublishedTotals } from "./files.ts";

// Read one Zcash transaction with a viewing key (the librustzcash decoder, compiled to WebAssembly).
export { readTransaction, readTransactionWithId, parseAddress, decoderInfo, type ReadOutput, type ParsedAddress } from "./read.ts";

// Work out the winners, price and refunds of a set of bids.
export { decide, groupBidPayments, type Bid, type Outcome } from "./rules.ts";

// Read every block of a round from a chain file, and fetch blocks and transactions from two independent servers.
export { validateChainFile, blocksInRange, ScanInputError, type ChainFile, type ChainBlock, type ChainTx, type BlockSource } from "./scan/chain.ts";
export { fetchTransactions, DEFAULT_SERVERS, FetchError, type FetchOptions, type FetchResult, type Network } from "./fetch/index.ts";
export { fetchBlocks, BlockFetchError, type FetchBlocksOptions } from "./scan/fetch-blocks.ts";

// Read every block of a round with the lot key, to catch a bid the seller left out (pass the result to checkLot as `scan`).
export { scanRange, DEFAULT_GRACE_BLOCKS, type ScanInput, type ScanRange, type BidderKey } from "./scan/scan.ts";
export { scanFromChain, fetchScan, type ScanFromChainOptions, type FetchScanOptions } from "./scan/input.ts";

// Sealed lots: which seals count once they are opened, the penalties, and what each payment is owed back.
export { openSeals, type SealFact, type OpenFact, type SealedOutcome } from "./sealed.ts";
export { sealHash } from "./files.ts";

// Help a bidder and a seller.
export { makeBidLink, qrSvg, qrText, zatToZec, zecToZat, BidLinkError, type BidLink, type BidLinkInput } from "./bidlink.ts";
export { bidderCheck, type BidderReport } from "./bidder.ts";
export { planLot, settle, settleRange, type LotNewInput, type LotNewFiles, type Settlement } from "./seller-kit.ts";

// Turn a verdict into text or a web page.
export { toText, toHtml } from "./report.ts";
