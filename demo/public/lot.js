// Lot page: build the bid payment link in the browser.
import { paymentLink, parseZec, formatZec, bidWord } from "./imani-login.js";

const $ = (id) => document.getElementById(id);
const box = $("bid");
const mode = box.dataset.mode;
const lotId = box.dataset.lot;
const address = box.dataset.address;
let link = null;
let memo = null;
let amountZat = null;

if (mode !== "sim" && !$("bid-word").value) $("bid-word").value = bidWord();
$("make-bid").hidden = false;

function showError(msg) {
  const e = $("bid-err");
  e.textContent = msg;
  e.hidden = !msg;
}

$("make-bid").onclick = () => {
  showError("");
  amountZat = parseZec($("bid-amount").value);
  const word = $("bid-word").value.trim();
  if (!amountZat || amountZat <= 0) return showError("Type your bid in ZEC, for example 0.02.");
  if (!/^[a-z0-9]{1,16}$/.test(word)) return showError("The memo word can use only small letters and digits, up to 16.");
  memo = `bid:${lotId}:${word}`;
  link = paymentLink(address, amountZat, memo);
  $("bid-open").href = link;
  $("bid-link").value = link;
  $("bid-link-box").hidden = false;
  if (mode === "sim") {
    $("bw-amount").textContent = `${formatZec(amountZat)} ZEC`;
    $("bw-memo").textContent = memo;
  }
};

if (mode === "sim") {
  $("send-bid").onclick = async () => {
    showError("");
    const r = await fetch("/sim/chain/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ uri: link }),
      credentials: "same-origin",
    }).then((x) => x.json());
    if (!r.ok) return showError(r.message);
    $("receipt-id").textContent = r.txid;
    $("receipt").hidden = false;
    $("bid-link-box").hidden = true;
    $("make-bid").hidden = true;
  };
}
