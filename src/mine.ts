import type { Verdict } from "./check.ts";
import { InputError } from "./check.ts";

/**
 * "Was my bid counted?" Looks one transaction id up in the seller's result and says, in plain
 * words, whether the bid is counted, whether it won, and what should come back. The answer is
 * only as good as the checks, so it always ends with what the checks found about that part.
 * Runs on the two files already read. Contacts nothing.
 */
export function lookupBid(r: any, v: Verdict, query: string): string {
  const id = String(query).trim().toLowerCase();
  if (!/^[0-9a-f]{10,64}$/.test(id)) {
    throw new InputError("Input error: the bid's transaction id needs at least 10 characters, using 0 to 9 and a to f.");
  }
  const zat = (n: number) => (v.discreet ? "[hidden]" : `${n.toLocaleString("en-US")} zat`);
  const bids: any[] = Array.isArray(r.bids) ? r.bids : [];
  const refunds: any[] = Array.isArray(r.refunds) ? r.refunds : [];
  const matches = bids.filter((b) => b.txid.startsWith(id));
  if (matches.length > 1) {
    return `Your bid: ${matches.length} counted bids start with ${id}. Paste more of the transaction id.`;
  }
  const status = (checkId: string) => v.checks.find((c) => c.id === checkId)?.status;
  const lines: string[] = [];

  if (!matches.length) {
    const late = refunds.find((f) => f.bidTxid.startsWith(id) && f.reason === "late");
    if (late) {
      lines.push(`Your bid: not counted. It arrived after the close. It should be returned in full: ${zat(late.amountZat)}.`);
      lines.push(`The checks say the late-bid rule was ${status("no-late-bids") === "PASS" ? "followed" : "NOT followed"} and refunds were ${status("refunds-paid") === "PASS" ? "paid" : "NOT all paid correctly"}.`);
    } else {
      lines.push("Your bid: NOT in the seller's list of counted bids.");
      const hidden = v.checks.find((c) => c.id === "scan-hidden-bids");
      if (!hidden) {
        lines.push("This run did not read the chain, so it cannot tell whether your bid was left out. Run the scan level (a saved chain file, or --scan on the command line) to read every block.");
      } else if (hidden.status === "FAIL") {
        const yours = hidden.reason.includes(`hidden bid: ${id.slice(0, 10)}`);
        lines.push(
          yours
            ? `That is your bid: it is on the chain but the seller left it out. ${hidden.reason}`
            : `The scan found a bid on the chain that the seller left out. Check whether it is yours: ${hidden.reason}`,
        );
      } else {
        lines.push("The scan found no bid on the chain that the seller left out, so the id may be mistyped or the bid may not belong to this lot.");
      }
    }
  } else {
    const bid = matches[0];
    const won = Array.isArray(r.winners) && r.winners.includes(bid.txid);
    const refund = refunds.find((f) => f.bidTxid === bid.txid);
    lines.push(`Your bid: counted, ${zat(bid.amountZat)}.`);
    const goal = r.rules?.kind === "goal";
    if (goal) {
      lines.push(won ? "Result: the goal was reached and your payment counts towards it and is kept." : "Result: the goal was not reached.");
    } else {
      lines.push(won ? `Result: you won one item at ${zat(r.clearingPriceZat)}.` : "Result: your bid did not win.");
    }
    lines.push(
      refund
        ? `Should come back to you: ${zat(refund.amountZat)} (${won ? "your bid minus the price" : "your whole bid"}).`
        : "Should come back to you: nothing.",
    );
    const parts: string[] = [];
    if (status("bid-amounts")) parts.push(`amount matches the chain: ${status("bid-amounts")}`);
    if (status("refunds-paid")) parts.push(`refunds paid: ${status("refunds-paid")}`);
    if (status("refund-receivers")) parts.push(`refund went to your address: ${status("refund-receivers")}`);
    if (parts.length) lines.push(`What the checks found about it: ${parts.join(", ")}.`);
  }
  lines.push(`Whole auction: ${v.result}${v.result === "FAIL" ? ` (${v.failed.join(", ")})` : ""}. A bid is only safe if the auction passes.`);
  return lines.join("\n");
}
