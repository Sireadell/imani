// Measures the full-range scan on real mainnet blocks: how long the download takes, how many
// bytes come in, and how long reading every transaction with a viewing key takes.
// Online, so it only runs with LIVE=1:
//   LIVE=1 node --disable-warning=ExperimentalWarning tools/measure-scan.ts [from] [count] [concurrency] [blocks per group]
// No key is ever sent: blocks are asked for by height. The key used for reading is a public
// test key from the Zcash unified address test vectors (ZIP 316, zcash-test-vectors,
// unified_full_viewing_keys.json, entry 9). Its seed is public, so it owns nothing and
// nothing on mainnet decrypts with it, which is what a stranger's key looks like.
import { fetchBlocks } from "../src/scan/fetch-blocks.ts";
import { readTransactionWithId } from "../src/read.ts";

const STRANGER_MAIN_KEY =
  "uview1qtdjghnl06nh4tuypvextrazr9uxes52h64wgh7xkwpf5ahvugkaevdswnryh83fwevdwr905f9gqgm7vx70q7p8grl6cj99zmhjmn7phge5qmp97fy04544kcey9m48yyrdqakl86azp44jmweyn9yy70qhjp0rdyq0j34umhahesy6tsu78syu2s92gwcgexkk53qktsk4cuk85maezc0xqrx2ky779mgx047206wnq9vs4jvquf6z79v4d86x0hn2gfj3pe7nhusw5n4ryq3u4urs2k9d0y4lnhxzrdvhsgext5vc26fgt7zpr67vgdn9rlgnv9mkcnnj8pcxe70z4ktvef7mfp235frwavsp49pf0gcz0yxjhdgw3tf9l2eq6pm3vch44xtu3nsdwr6nfuus7887r2hdfrsny40sjx74cc5k500x009q0gv222af5plg7acngnc96apy696q3fyr34zgk6lfey0948tkrkn7cyr6v5e8";

if (process.env.LIVE !== "1") {
  console.log("Online measurement. Run with LIVE=1 to download real mainnet blocks.");
  process.exit(0);
}
const from = Number(process.argv[2] ?? 3_509_000);
const count = Number(process.argv[3] ?? 500);
const concurrency = Number(process.argv[4] ?? 12);
const groupSize = Number(process.argv[5] ?? 1);

const t0 = Date.now();
const { blocks, source } = await fetchBlocks({
  network: "main",
  from,
  to: from + count - 1,
  concurrency,
  groupSize,
  onProgress: (done, all) => {
    if (done % 50 < 4 || done === all) console.error(`  ${done} of ${all} blocks, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  },
});
const fetchMs = Date.now() - t0;
const t1 = Date.now();
let txs = 0;
let seen = 0;
let unreadable = 0;
for (const b of blocks) {
  for (const t of b.txs) {
    txs++;
    try {
      seen += readTransactionWithId(t.txHex, STRANGER_MAIN_KEY).outputs.length;
    } catch {
      unreadable++;
    }
  }
}
const readMs = Date.now() - t1;
console.log(
  JSON.stringify(
    {
      blocks: blocks.length,
      range: `${from} to ${from + count - 1}`,
      transactions: txs,
      concurrency,
      groupSize,
      downloadSeconds: +(fetchMs / 1000).toFixed(1),
      readSeconds: +(readMs / 1000).toFixed(1),
      transactionBytesReceived: source.bytes,
      outputsTheKeySees: seen,
      unreadable,
      serversContacted: source.serversContacted,
      secondsPerBlock: +(fetchMs / 1000 / blocks.length).toFixed(2),
      estimatedMinutesForOneDay1150Blocks: +((fetchMs / blocks.length) * 1150 / 60000).toFixed(1),
    },
    null,
    2,
  ),
);
