If you publish auction results from a GitHub repository, this action checks them on every push. It runs the same check as the command line on your round's two files, and the build goes red when the round doesn't add up: a bid missing, a refund short, the wrong winner. Nothing is sent to us. The check runs inside your own workflow.

# The imani-check GitHub Action

## Use it

Add a step to a workflow in the repository that holds your round's files:

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: OWNER/imani@main
    with:
      disclosure: round/disclosure.json
      result: round/result.json
      scan: "true"
      chain: round/chain.json
```

Replace `OWNER/imani` with the place this repository lives. Once the repository is public, anyone outside our team can use the action this way. It is not listed on any marketplace.

## Inputs

| Input | Needed | What it is |
|---|---|---|
| `disclosure` | yes | Path to the lot's disclosure file. |
| `result` | yes | Path to the seller's result file. |
| `scan` | no | Set to `"true"` to also read every block of the round. Default `"false"`. |
| `chain` | no | Path to a chain file. Needed when `scan` is `"true"`. |

## What the build does

The action runs `node bin/imani.js check --disclosure <disclosure> --result <result>` from its own folder, and adds `--scan --chain <chain>` when you turn the scan on. The step exits 0 when the round passes, 1 when a check fails (the build goes red), and 2 when the input is refused or unreadable. It never opens a network connection.

## Try it on the examples

`examples/testnet-01` is an honest round and passes. `examples/testnet-broken/01-hidden-losing-bid` hides a losing bid and fails. The workflow `.github/workflows/action-selftest.yml` runs both on Linux, Windows and macOS, and checks that the broken one really turns the build red.
