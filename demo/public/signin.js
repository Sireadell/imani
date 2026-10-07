// Sign-in page. The login key is kept in this module's memory only.
import { ed25519Supported, newLoginKey, exportLoginKey, importLoginKey, buildLoginMemo, buildLoginProof, siteKey, paymentLink, formatZec, EXPORT_WARNING } from "./imani-login.js";

const $ = (id) => document.getElementById(id);
const root = $("signin");
const mode = root.dataset.mode;
root.hidden = false;

let loginKey = null; // Uint8Array(32), memory only
let challenge = null;
let link = null;
let firstAccount = null;

function showError(msg) {
  const e = $("err");
  e.textContent = msg;
  e.hidden = !msg;
}

async function postJson(url, data) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(data ?? {}), credentials: "same-origin" });
  return r.json();
}

function keyReady() {
  $("key-ready").hidden = false;
  $("import-box").hidden = true;
  $("backup-warning").textContent = EXPORT_WARNING;
  $("step-code").hidden = false;
  $("make-key").disabled = true;
}

if (!(await ed25519Supported())) {
  $("no-crypto").hidden = false;
  for (const b of root.querySelectorAll("button")) b.disabled = true;
} else {
  $("make-key").onclick = () => {
    loginKey = newLoginKey();
    keyReady();
  };
  $("show-import").onclick = () => {
    $("import-box").hidden = false;
    $("import-text").focus();
  };
  $("do-import").onclick = () => {
    try {
      loginKey = importLoginKey($("import-text").value);
      $("import-text").value = "";
      showError("");
      keyReady();
    } catch (e) {
      showError(e.message);
    }
  };
  $("save-backup").onclick = () => {
    // A blob link has a random name, so the key is never part of a web address.
    const text = `${exportLoginKey(loginKey)}\n\n${EXPORT_WARNING}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "imani-login-key-backup.txt";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $("get-code").onclick = getCode;
  $("copy-link").onclick = () => navigator.clipboard?.writeText(link ?? "");
  if (mode === "sim") {
    $("pay-1").onclick = () => simPay();
    $("pay-2").onclick = () => simPay();
  } else {
    $("check-pay").onclick = () => verify($("txid").value.trim());
  }
  $("again").onclick = async () => {
    await postJson("/logout");
    $("step-done").hidden = true;
    await getCode();
  };
}

async function getCode() {
  showError("");
  // Reserve the code for this page's own account id, so someone who only sees the code cannot use it up.
  const { accountId } = await siteKey(loginKey, root.dataset.site);
  challenge = await postJson("/login/challenge", { accountId });
  if (!challenge.nonce) return showError(challenge.message ?? "Could not get a sign-in code.");
  const { memo } = await buildLoginMemo(loginKey, challenge);
  link = paymentLink(challenge.siteAddress, challenge.minZat, memo);
  $("code").textContent = challenge.nonce;
  $("open-wallet").href = link;
  $("pay-link").value = link;
  $("code-box").hidden = false;
  $("step-pay").hidden = false;
  if (mode === "sim") {
    $("sim-wallet").hidden = false;
    $("w-amount").textContent = `${formatZec(challenge.minZat)} ZEC`;
    $("w-to").textContent = `${challenge.siteAddress.slice(0, 12)}...${challenge.siteAddress.slice(-6)}`;
    $("w-code").textContent = challenge.nonce;
  } else {
    $("live-wallet").hidden = false;
  }
  $("step-code").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function simPay() {
  showError("");
  // The pretend wallet sends only the payment (address, amount, memo). Never which wallet address paid.
  const sent = await postJson("/sim/chain/send", { uri: link });
  if (!sent.ok) return showError(sent.message);
  await verify(sent.txid);
}

async function verify(txid) {
  // The proof stays on this page and goes only to the shop. It is not in the payment link.
  const proof = await buildLoginProof(loginKey, challenge);
  const r = await postJson("/login/verify", { txid, proof });
  if (!r.ok) return showError(r.message);
  $("acct-short").textContent = r.accountId.slice(0, 6);
  $("acct-full").textContent = r.accountId;
  const same = $("same-account");
  if (firstAccount && firstAccount === r.accountId) {
    same.textContent = `Same account as before (${r.accountId.slice(0, 6)}). You paid from a new address and still landed in your account.`;
    same.hidden = false;
  } else {
    same.hidden = true;
  }
  firstAccount = firstAccount ?? r.accountId;
  $("step-pay").hidden = true;
  $("code-box").hidden = true;
  $("step-done").hidden = false;
  // Show the account chip in the header without a reload (which would lose the key in memory).
  const acct = document.querySelector(".account");
  if (acct) acct.replaceChildren(Object.assign(document.createElement("span"), { className: "chip", textContent: `Account ${r.accountId.slice(0, 6)}` }));
  $("step-done").scrollIntoView({ behavior: "smooth", block: "start" });
}
