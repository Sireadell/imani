import { LoginKit } from "@sireadell/imani/login";
import party from "./sim-party.json";
import { simReader } from "./sim-chain";

export const SITE_ID = process.env.LOGIN_SITE_ID ?? "next-example.test";

// One kit for the whole server: it holds the one-time codes. In dev, Next reloads modules, so the
// kit is kept on globalThis.
const g = globalThis as unknown as { __loginKit?: LoginKit };
export const kit =
  (g.__loginKit ??= new LoginKit({
    siteId: SITE_ID,
    siteAddress: process.env.LOGIN_ADDRESS ?? party.address,
    viewingKey: process.env.LOGIN_UFVK ?? party.ufvk,
    // The pretend network. Delete this line for a real site: the kit then reads real transactions.
    readTx: process.env.LOGIN_UFVK ? undefined : (simReader() as never),
  }));
