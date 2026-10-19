# Fetch helper: design and route survey

imani works offline by default. The checker and the login kit take raw transaction hex
from a file. This helper is the optional other way in: give it txids (or block heights)
and it downloads the raw transactions from public servers, checks every one against its
txid, and by default makes two servers run by different operators agree on the exact
bytes.

Nothing fetches unless the caller asks. The planned CLI flag on the main `imani` command
is `--fetch` (not wired up yet). Today the helper is reachable as:

- library: `fetchTransactions({ network, txids | heights, servers?, crossCheck?, proxy?, timeoutMs?, retries? })` from `src/fetch/index.ts`
- script: `node --import tsx src/fetch/cli.ts --network main --txid <txid> [--txid ...] [--height N] [--server URL ...] [--single-server] [--proxy socks5h://127.0.0.1:9050] [--out file.json]`

It returns `{ transactions: [{ txid, hex, height?, server, confirmedBy }], serversContacted, problems }`.
`serversContacted` is every server a connection was opened to, so a caller can print
"servers contacted: ..." honestly. On failure it throws `FetchError`, which carries the
same list.

## Routes that exist today (checked from this PC on 2026-10-07)

| Route | How Node talks to it | Result of the live test | What the server learns | Licence and terms |
|---|---|---|---|---|
| Light wallet server, gRPC `GetTransaction` (lightwalletd or Zaino) | Hand-written gRPC over `node:http2`, about 150 lines, no dependency. The protocol is in `walletrpc/service.proto` at github.com/zcash/lightwallet-protocol | Works. See the server table below | The exact txid you ask for, so which auction you are checking. Also your IP address and the time | Protocol definition MIT. Public servers are free with no published rate limit; none limited us |
| Light wallet server, gRPC `GetBlock` then `GetTransaction` for every tx in the block | Same | Works on mainnet (block 3,509,781: 5 transactions, all verified) | Only the block height. It then sees requests for every transaction in that block, so it cannot tell which one you care about. It still learns roughly when the auction happened | Same |
| Zebra JSON-RPC `getrawtransaction` / `getblock` | Plain HTTPS POST | Not tested: found no public Zebra node that answers without an account. Hosted ones (GetBlock, NOWNodes, Tatum) need an API key | Same as above, plus the API key ties every request to your account | Provider terms |
| Explorer JSON API, CipherScan `GET /api/tx/{txid}/raw` | Plain HTTPS GET, `node:https` | Works on mainnet and testnet. Returns `{ txid, hex }`. Headers say 600 requests per minute | The txid, your IP, and whatever a web server logs (user agent). We send a generic user agent and no cookies | Free public API; no written terms found |
| Explorer JSON API, Blockchair `GET /zcash/raw/transaction/{txid}` | Plain HTTPS GET | Works on mainnet. Not used: one more company in the loop, and its free tier has request limits | Same as CipherScan | Commercial terms |

Light wallet servers have no "give me the whole full block" call. `GetBlock` returns a
compact block (txids and shielded outputs, no full transactions). So "fetch by height"
is done as: get the compact block from two operators, require the same block hash and
txid list, then fetch every transaction in it. To the server this looks the same as a
whole-block download.

### Light servers tested (GetLightdInfo, GetBlock, GetTransaction)

Mainnet tip was 3,509,790 at the time.

| Server | Software | Result |
|---|---|---|
| zec.rocks:443 (also na., eu., ap., sa.) | lightwalletd v0.5.3 | Works, 1.7 to 3.7 s for three calls |
| zec-node.cakewallet.com:443 | lightwalletd v0.5.4 | Works |
| lwd.zcashexplorer.app:9067 | lightwalletd v0.5.4 | Works |
| us.zec.stardust.rest:443, eu.zec.stardust.rest:443 | lightwalletd v0.5.4 | Works |
| zcash.mysideoftheweb.com:9067 | lightwalletd v0.5.4 | Works |
| lightwalletd.mainnet.cipherscan.app:443 | lightwalletd v0.5.3 | Works |
| zaino.unsafe.zec.rocks:443 | Zaino 0.6.0 | Works (same byte order and replies as lightwalletd) |
| zec.0xrpc.io:443 | unknown | Answered but returned an empty block |
| mainnet.lightwalletd.com, lwd1/lwd2.zcash-infra.com, na./eu.lightwalletd.com, eu2./jp.zec.stardust.rest | | Host name does not exist any more |
| testnet.zec.rocks:443 | lightwalletd v0.5.4 | Works (testnet tip 4,475,835) |
| lightwalletd.testnet.electriccoin.co:9067 | | Timed out |
| zaino.testnet.unsafe.zec.rocks:443 | | HTTP 503 |
| lightwalletd.testnet.cipherscan.app:443 | | TLS refuses HTTP/2, so plain gRPC does not work (probably gRPC-web only) |
| testnet.lightwalletd.com, lightwalletd.testnet.z.cash | | Host name does not exist |

Server names came from the zingolib indexer list (`zingo-netutils/src/indexers.rs`) and
older wallet defaults.

## Chosen route

Light wallet servers over hand-written gRPC on `node:http2`, with the CipherScan
explorer as an extra source. Reasons: it is what every Zcash light wallet already uses,
there are many independent operators on mainnet, it gives heights, it needs zero new
dependencies, and it speaks the same protocol to lightwalletd and Zaino.

Default lists (in `src/fetch/index.ts`), walked in order, stopping as soon as each tx has
enough copies, so normally only the first two operators are contacted:

- main: zec.rocks, zec-node.cakewallet.com, lwd.zcashexplorer.app, us.zec.stardust.rest, zcash.mysideoftheweb.com, CipherScan API
- test: testnet.zec.rocks, CipherScan testnet API (the only two independent testnet sources that answered)

## Checks on every transaction

1. **txid check.** The bytes are parsed by librustzcash (the prebuilt decoder in
   `vendor/decoder`) and the txid is recomputed: double SHA-256 for v4, the ZIP-244 digest
   for v5 and v6. No hash code was written by hand. The decoder's only entry point needs a
   viewing key, so the helper passes the public throwaway "stranger" test key from
   `test/vectors/offline-vectors.json`. That key never leaves the process.
2. **No extra bytes.** librustzcash ignores bytes after the end of a transaction, so junk
   on the end would still give the right txid. The helper also hashes the bytes minus the
   last byte; if that still gives the same txid, there was junk and the copy is refused.
3. **Two operators, same bytes.** For v5 and v6 the txid does not cover signatures and
   proofs. A server could change those and the txid would still match (the tests do this
   by changing one signature byte). The amounts, addresses and memos the checker reads are
   covered by the txid, but we still require a second operator to return identical bytes,
   and fail if they differ. "Operator" means the last two labels of the host name, so
   na.zec.rocks and eu.zec.rocks count as one.
4. **Right network.** Each light server is asked `GetLightdInfo` first and skipped if it
   serves the other network.
5. **Heights.** A height is returned only when every light server that reported one agrees
   (and it matches the block, in height mode). Height 0 (mempool) and the fork marker give
   no height.

Anything that cannot be verified fails closed: the helper throws and returns nothing.

## What still leaks, plainly

- Each server contacted learns the txids (or block heights) you asked for. If those are an
  auction's transactions, it learns which auction you are checking. Cross-checking means
  two servers learn it, not one.
- They learn your IP address and the time, unless you pass `proxy` (`--proxy`), for example
  a local Tor at `socks5h://127.0.0.1:9050`. Host names are then resolved by the proxy.
- Height mode hides which transaction in a block you want, but not which block.
- No key, seed or address is ever sent. The function has no parameter that takes one, and a
  test checks every request body.

Ways to reduce it: pass your own `servers` list (your own lightwalletd or Zaino gives zero
third-party leak), use `--proxy` with Tor, use height mode, or skip fetching and keep using
a saved file (the default).

## Reading from your own Zebra node

A source written `zebra+http://127.0.0.1:18232` (or `zebra+https://`) reads blocks from a Zebra node's JSON-RPC port. Default ports in zebra-rpc: 8232 mainnet, 18232 testnet. Checked against ZcashFoundation/zebra, `zebra-rpc` (config/rpc.rs, server/cookie.rs, server/http_request_compatibility.rs, methods.rs):

| Call | Used for |
|---|---|
| `getblockchaininfo` | `chain` is `main` or `test`; a node on the other network is refused |
| `getblock "<height>" 2` | the height goes in as a string; verbosity 2 returns `hash`, `height` and `tx` as objects with `txid` and `hex` |
| `getrawtransaction <txid> 1` | one transaction with `hex` and `height` |

Verbosity 2 is used instead of verbosity 0 (raw block hex) so no transaction splitting is hand-written: every `hex` still goes through the librustzcash txid check like on the other routes. Zebra's own docs list verbosity 0 as hex data, 1 as a JSON object, 2 as a JSON object with transaction data.

Password: Zebra asks for HTTP Basic auth by default (`enable_cookie_auth = true`). It writes `.cookie` in its cookie directory holding `__cookie__:<secret>`; only the text after the first colon is checked. Give the file with `--zebra-auth-file`, or put the text in `IMANI_ZEBRA_AUTH`. It is never taken from the address or the command line, never printed, and never sent over plain http to a machine that is not local or on a private network.

Trust: one `zebra+` source alone is trusted as your own node. Next to a light server or explorer, the two must agree on the block hash, the transaction list and every byte, like any two operators. Zebra can also serve the light server protocol itself (`lightwalletd_listen_addr`, experimental, no password), which the existing `--server https://...` route already reads.

Not tested against a real node: no Zebra node was available. The tests use a fake node that answers in the shape of Zebra's source, filled with real testnet blocks. `LIVE=1 IMANI_ZEBRA_URL=zebra+http://127.0.0.1:18232 npm run test:fetch` checks a real node of your own.

## Known limits (2026-10-07)

- **NU7 (fixed 2026-10-07).** Testnet activated NU7 (branch id 0x77190ad9, ZIP 259) at
  height 4,465,026. The first decoder build (zcash_primitives 0.30.1) did not know that
  branch id and failed closed on every newer testnet transaction. `vendor/decoder` is now
  built on the librustzcash pre-releases that know NU7 (zcash_primitives 0.31.0-pre.1), and
  real NU7 testnet transactions fetch and verify through both testnet sources. A branch id
  the decoder does not know still fails closed, now with "unsupported network upgrade
  0x...". See `docs/UPGRADES.md` for the weekly check.
- Testnet has only one working public light server, so the cross-check there relies on
  CipherScan as the second source.
- gRPC replies must be uncompressed and under 8 MB. Each call opens a fresh connection.

## Tests

`npm run test:fetch` runs without network: fake light servers on `node:http2`, a fake
explorer on `node:http` and a fake SOCKS5 proxy, all on 127.0.0.1. They cover a good
fetch, servers that disagree, a server that sends another transaction, padded bytes,
one-server refusal, wrong network, timeout and retry, height mode, the explorer route, the
proxy, refusal of bad input, and that no request carries a key. `LIVE=1 npm run test:fetch`
adds one real mainnet fetch from the default servers.
