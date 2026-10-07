// "Was my bid counted?" lookup. Runs in the browser against the public result file,
// so the shop never learns which bid is yours.
import { formatZec } from "./imani-login.js";

const $ = (id) => document.getElementById(id);
const zec = (zat) => `${formatZec(zat)} ZEC`;

function line(text, cls) {
  const p = document.createElement("p");
  p.textContent = text;
  if (cls) p.className = cls;
  return p;
}

$("mine-go").onclick = async () => {
  const out = $("mine-out");
  const id = $("mine-id").value.trim().toLowerCase();
  if (!/^[0-9a-f]{10,64}$/.test(id)) {
    out.replaceChildren(line("Paste the transaction id from your bid receipt (at least the first 10 characters).", "notice bad"));
    return;
  }
  const result = await fetch("/lot/files/result.json", { credentials: "same-origin" }).then((r) => r.json());
  const bid = result.bids.find((b) => b.txid.startsWith(id));
  const late = result.refunds.find((f) => f.bidTxid.startsWith(id) && f.reason === "late");
  if (!bid) {
    out.replaceChildren(
      late
        ? line(`Your bid arrived after the close, so it was not counted. It was returned in full: ${zec(late.amountZat)}.`, "notice")
        : line("No counted bid has that receipt. Check that you pasted the right transaction id.", "notice bad"),
    );
    return;
  }
  const won = result.winners.includes(bid.txid);
  const refund = result.refunds.find((f) => f.bidTxid === bid.txid);
  const rows = [
    line(`Counted: yes. Your bid of ${zec(bid.amountZat)} is in the seller's list. The "Each bid amount matches the chain" check below compares it with the payment itself.`, "notice ok"),
    line(won ? `You won one item at ${zec(result.clearingPriceZat)}.` : "Your bid did not win."),
    line(refund ? `Money back to you: ${zec(refund.amountZat)} (${won ? "your bid minus the price" : "your whole bid"}).` : "Nothing is owed back to you."),
  ];
  out.replaceChildren(...rows);
};
