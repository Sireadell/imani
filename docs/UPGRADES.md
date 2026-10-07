# Network upgrades: what to check and when

## What an upgrade is

Every so often all Zcash nodes switch to new rules at an agreed block number. That switch is
a network upgrade (NU6.3, NU7 and so on). Each upgrade has a short code, the consensus branch
id, and every new transaction carries that code in its first bytes.

imani's reader (the decoder in `vendor/decoder`) only opens transactions whose code it knows.
If the network moves to an upgrade the reader has never heard of, it stops with a clear
message instead of guessing:

```
unsupported network upgrade 0x........: this decoder reads up to NU7 (branch id 0x77190ad9); a newer decoder build is needed
```

Older transactions keep working. Only transactions made after the new upgrade are refused.

## Where we stand (2026-10-07)

| Network | Upgrade in use today | Reader knows it? | Next upgrade |
|---|---|---|---|
| Mainnet (real money) | NU6.3, branch id `0x37a5165b` | yes | NU7, date to be set around October 20 (ZIP 259) |
| Testnet | NU7, branch id `0x77190ad9`, since block 4,465,026 | yes | none scheduled |

The reader already knows NU7, so when mainnet switches to NU7 during judging (October 29 to
November 22) it keeps working. NU7 changes no transaction layout, only the code (ZIP 259).
Proof: three real testnet NU7 transactions and two built offline are in `test/vectors/` and
pass `npm test`.

## Weekly check (one command)

From the project folder:

```sh
node --import tsx tools/decoder/check-upgrade.ts --network main
```

It asks two public light wallet servers (zec.rocks and Cake Wallet) which upgrade mainnet is
on now and which one is scheduled next, then compares that with what the reader knows. It
sends nothing about you or any auction: no key, no transaction id, no address.

| Last line | Meaning | What to do |
|---|---|---|
| `OK` | The reader handles today's and the next scheduled upgrade | nothing |
| `REBUILD SOON` | An upgrade the reader does not know is scheduled | rebuild before the height it prints (see below) |
| `REBUILD NOW` | Mainnet already uses an upgrade the reader does not know | rebuild today; new payments cannot be read |
| `NO ANSWER` | No server replied | run it again later, or add `--server https://host:port` |

Add `--network test` to check testnet too. To see what the reader itself knows:

```sh
node --import tsx -e "import('./src/read.ts').then(m => console.log(m.decoderInfo()))"
```

## October 20 re-check

ZIP 259 says the mainnet NU7 block number is to be set on October 20. That day:

1. Run the weekly check. Expect `next upgrade scheduled: NU7 at height ...` and `OK`.
2. Read the NU7 section of ZIP 259 (github.com/zcash/zips, `zips/zip-0259.md`) and confirm two
   things: the branch id is still `0x77190ad9`, and it still says NU7 adds no new transaction
   format. If either changed, rebuild.
3. Check crates.io for a full (non "pre") release of `zcash_primitives` 0.31 or newer. If one
   exists, moving to it is tidy but not urgent; the reader already reads NU7.

The reader does not need the mainnet NU7 block number to read NU7 transactions; it reads the
code from each transaction.

## How to rebuild the reader

Rust is needed only for this, on Linux or macOS (the project's Codespace works). Steps are in
`tools/decoder/README.md`: change the crate versions in `tools/decoder/Cargo.toml`, run
`bash tools/decoder/build.sh`, copy `vendor/decoder/` back, then run `npm test`. The build
takes about 3.5 minutes on a 2-core machine.
