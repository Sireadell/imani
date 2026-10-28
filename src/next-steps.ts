// Plain advice for a bidder or a seller when a check fails: what it means and what to ask for.
// Printed by `imani check` only on FAIL, above the RESULT line. It explains, it never changes the verdict.
const STEPS: Record<string, string> = {
  "bid-amounts": "A bid amount in the seller's list differs from what the lot key reads on the chain. Ask the seller which payment is meant, and compare with your own wallet's record of what you paid.",
  "bid-count": "The seller's list has a different number of bids than the chain shows. Ask for the missing or extra bid by its transaction id.",
  "clearing-range": "The price the seller states is outside what the bids allow. Ask the seller to show how it was worked out.",
  "close-height": "The close height in the lot's files is not valid for this lot. Ask the seller to publish the right open, close and refund heights.",
  "disclosure-txids-unique": "The same payment is listed twice. Ask the seller for a corrected disclosure.",
  "goal-reached": "The stated outcome of the goal does not match the total paid in. Ask the seller to explain the difference.",
  "key-hygiene": "The lot key also shows payments that are not this lot's, so it was used for something else. The seller should use a fresh key for each lot, and not share this one.",
  "no-duplicate-bids": "One bid is counted twice. Ask the seller to remove the duplicate and republish.",
  "no-late-bids": "A bid that landed after the close was counted. Ask for the late bid to be left out, or refunded.",
  "published-totals-chain": "The totals the seller published do not match the chain. Ask for the numbers to be corrected.",
  "published-totals": "The totals in the seller's own files do not add up. Ask for a corrected result.",
  "refund-receivers": "A refund went to a different address than the one written in the bid memo. If it was yours, tell the seller the address you used, and ask for it to be re-sent.",
  "refund-total": "The refunds add up to the wrong total. Ask the seller for the list of refunds with their transaction ids.",
  "refunds-paid": "A refund is missing, short or late. If you are a bidder, run `imani bidder-check` with your own viewing key to see what reached your wallet, then ask the seller for the difference by the refund's transaction id.",
  "reserve": "A winning price is below the reserve, or a bid under the reserve was counted. Ask the seller to explain.",
  "result-consistent": "The seller's result contradicts itself. Ask for a corrected result.",
  "scan-blocks-read": "Not every block of the auction was read, so the scan proves nothing yet. Run it again with `--fetch`, or with a complete chain file.",
  "scan-heights": "A payment sits in a different block than the files say. Compare its block on a public explorer.",
  "scan-hidden-bids": "The lot key sees a payment the seller left out of their files. This is the strongest warning. Ask the seller why that payment is missing, and ask for the bid to be counted or refunded.",
  "scan-listed-in-range": "A payment the seller listed is outside the auction's block range. Ask the seller to fix the heights.",
  "scan-refund-receivers": "A refund did not reach the bidder who gave their own key. If it was yours, ask the seller for the refund by its transaction id, and run `imani bidder-check` to see what reached your wallet.",
  "scan-unlisted-payments": "There are payments to the lot that the seller's files do not list. Ask the seller to account for each by its transaction id.",
  "seal-deposits": "A sealed bid is missing its deposit. Ask the seller to show the deposit's transaction id.",
  "seal-forfeits": "A seal that paid the penalty is not reported. Ask the seller to list every forfeited seal.",
  "seal-openings": "A sealed bid was opened with a price that does not match its seal. Ask the seller to show the seal and the opening.",
  "txids-match-bytes": "A transaction id in the files does not match the transaction's own bytes. The files were altered or corrupted. Download them again from the seller.",
  "winner-count": "The number of winners is wrong for the number of items. Ask the seller to explain.",
  "winners-and-price": "The winners or the price do not follow from the bids. Ask the seller to show their working, or re-run the lot rules on the bids yourself.",
};

const FALLBACK = "Ask the seller about this check by name and compare the figures with an explorer.";

/** Lines for the terminal: one short piece of advice per failed check. */
export function nextStepsText(failed: string[]): string[] {
  if (!failed.length) return [];
  return ["What to do next", ...failed.map((id) => `  ${id}: ${STEPS[id] ?? FALLBACK}`), ""];
}
