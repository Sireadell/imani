# Block links

When blocks are downloaded, each one names the block before it by its hash. Imani checks that the name matches: block N must say that the block before it is the one it holds as block N-1. If not, the download is refused with a message naming the block, for example "block 4200001 does not link to block 4200000".

This sits next to the existing rule that two servers run by different operators must agree on every block and every transaction. Together they mean a server cannot mix blocks from different histories into one range and have it accepted.

## Where it applies

- `imani check --fetch`, `imani settle --fetch`, `imani bidder-check --fetch` and the fetch helper with several heights: every block in the range is compared with its neighbour.
- Blocks that are not next to each other (a gap) are not compared with each other. Missing blocks are reported where they always were.
- A server that sends no previous-block hash for a block is not refused for that; there is nothing to compare. Light servers and Zebra nodes send it. Explorer answers are used if they carry it.

## Where it does not apply

- Saved chain files (`chain.json`) store each block's height and transactions only, with no hashes. Checking a saved file offline therefore does not run this check, and nothing about how saved rounds pass or fail has changed.
- The "check any round" web page asks for one block at a time through the site, and the answer carries no previous-block hash, so it is not linked there.

## What it can and cannot catch

It catches a range assembled from blocks that do not belong together, including a server that edits or swaps one block in the middle. It cannot tell a real chain from a complete, consistent fake one made by a server that controls every answer; asking two independent operators is what covers that, and it does not prove a block has enough work behind it.
