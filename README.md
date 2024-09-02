# tx-explainer

> **Not audited. Devnet/testnet/localnet first.** This is a read-only decoder: it never signs or
> sends anything. The plain-language output is a best effort and does not replace reading the
> program's code.

Turn a Solana transaction into plain language:

```
$ tx-explainer --file test/fixtures/devnet-memo.json
Transaction 5zhK…  [legacy]
Status: succeeded
Fee: 0.0000155 SOL (of which priority ≈ 0.0000105 SOL)
Compute units: 26,021 of 70,000 requested

What happened:
  1. [Compute Budget] Set compute unit limit to 70,000
  2. [Compute Budget] Set priority fee to 150,000 micro-lamports per compute unit
  3. [Associated Token Account] Create (if missing) the associated token account Expy…TCA6 for wallet 6a1w…BNqd and mint 4wMp…jY4y, paid by 2VyJ…TeEs (fee payer)
  4. [SPL Token] Transfer 1,236.871165 tokens of mint 4wMp…jY4y from 55Xo…AmDQ to Expy…TCA6 (authority 2VyJ…TeEs (fee payer))
  5. [Memo] Memo: "helm-payout-v1:…"

Token balance changes:
  55Xo…AmDQ (owner 2VyJ…TeEs): -1,236.871165 of mint 4wMp…jY4y
  Expy…TCA6 (owner 6a1w…BNqd): +1,236.871165 of mint 4wMp…jY4y
```

**Live demo of the web UI: <https://abdeldjalilchougui.github.io/tx-explainer/>**

## What it decodes

| program | instructions |
|---|---|
| System | CreateAccount, Assign, Transfer, CreateAccountWithSeed, nonce ops, Allocate, TransferWithSeed |
| SPL Token / Token-2022 | InitializeMint(2), InitializeAccount(2/3), Transfer(Checked), Approve(Checked), Revoke, SetAuthority, MintTo(Checked), Burn(Checked), CloseAccount, Freeze/Thaw, SyncNative, GetAccountDataSize, InitializeImmutableOwner. Token-2022 extension instructions are named by number |
| Associated Token Account | Create, CreateIdempotent, RecoverNested |
| Compute Budget | SetComputeUnitLimit, SetComputeUnitPrice, RequestHeapFrame, SetLoadedAccountsDataSizeLimit |
| Memo (v1 and v2) | UTF-8 text |
| any Anchor program | pass its IDL (`--idl`, Anchor 0.30+ format): instruction name, Borsh-decoded args (structs, enums, vec, option, arrays), account names, and custom error names |

When the input carries RPC metadata, it also shows the status (with Anchor error names), the
fee, the priority fee estimate (CU limit × CU price), compute units, inner instructions (CPIs),
SOL balance changes, and token balance changes with decimals. Legacy and v0 messages are both
supported. Address lookup table entries are resolved from `meta.loadedAddresses`, or shown as
`table[index]` for raw input.

## Install

```bash
npx tx-explainer <signature> --cluster devnet     # run without installing
npm i -g tx-explainer                              # or install the CLI globally
npm i tx-explainer                                 # or use it as a library
```

Requires Node.js 20+. **Live demo of the web UI: <https://abdeldjalilchougui.github.io/tx-explainer/>**
(runs entirely in your browser and calls the selected cluster's public RPC).

## Quick start (from a checkout)

```bash
pnpm install
pnpm build

node dist/cli.js <signature> --cluster devnet           # fetch via getTransaction
node dist/cli.js <signature> --rpc http://127.0.0.1:8899
node dist/cli.js --raw <base64-or-base58 tx bytes>      # offline, no metadata
node dist/cli.js --file saved-getTransaction.json --idl target/idl/my_program.json
node dist/cli.js ... --json                             # machine-readable
node dist/cli.js serve --port 8787                      # web UI on 127.0.0.1
```

The web UI (`web/index.html` + the bundled `web/app.js`) runs the same decoder in the browser and
calls the cluster RPC directly. It is deployed at
<https://abdeldjalilchougui.github.io/tx-explainer/>.

Library use:

```ts
import { explain, render, fetchTransaction } from "tx-explainer";
const e = explain({ rpc: await fetchTransaction(sig, "https://api.devnet.solana.com") }, { idls: [myIdl] });
console.log(render(e));
```

## How it works

1. `message.ts` parses the wire format by hand: compact-u16 lengths, signatures, the message
   header, account keys, compiled instructions and v0 lookup tables. It then derives each key's
   signer and writable flags from the header.
2. `programs.ts` has one small decoder per built-in program. Each one reads the
   instruction tag (u32 for System, u8 for Token) and its fields with a little-endian `Reader`.
3. `anchor.ts` matches the first 8 bytes against each IDL instruction's `discriminator` and
   Borsh-decodes the args from the IDL type tree.
4. `explain.ts` combines these with the RPC metadata: token balances give mint and decimals,
   inner instructions give CPIs, and pre/post balances give the deltas.

## Tests

```bash
pnpm test
```

Tests use only committed fixtures in `test/fixtures/`:

- four **synthetic** transactions built by `scripts/make-fixtures.mjs` with `@solana/web3.js`
  from fixed public keys. They are left **unsigned**, so no keypair is ever created, and carry
  hand-written metadata: SOL transfer + memo + compute budget, ATA create + TransferChecked
  with CPIs, a v0 lookup-table Token-2022 mint, and a failed Anchor call;
- one **real devnet transaction** captured once with `node scripts/make-fixtures.mjs --live`
  (read-only RPC).

## Limitations

- Token-2022 extension instructions (transfer fees, confidential transfers, ...) are shown by
  number only.
- Stake, Vote, Address Lookup Table and loader instructions are not decoded (only named).
- The priority fee is estimated as `ceil(limit × price / 1e6)`. When no limit is set, it assumes
  the default 200k CU per instruction.
- Raw input has no metadata, so it cannot show the status, fees, balance changes or inner instructions.

## License

MIT © Abdeldjalil Chougui
