// Writes test/login/vectors/login-inputs.json: the memos and payments that
// tools/gen-vectors/gen_login.rs turns into offline transactions.
//   npx tsx test/login/make-offline-inputs.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { HEIGHT_IRONWOOD, HEIGHT_ORCHARD, PAYMENTS, memoFor, siteCodes } from "./offline-plan.ts";

const { codes } = await siteCodes();
const payments = PAYMENTS.map((p, i) => ({
  label: p.label,
  to: p.to,
  wallet: p.wallet,
  pool: p.pool,
  height: (p.pool === "orchard" ? HEIGHT_ORCHARD : HEIGHT_IRONWOOD) + i,
  amountZat: p.amountZat,
  memo: memoFor(p, codes),
}));
const dir = new URL("./vectors/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("login-inputs.json", dir), JSON.stringify({ payments }, null, 2) + "\n");
console.log(`wrote ${payments.length} payments`);
