// Generates the committed test fixtures in test/fixtures/.
//
// Synthetic fixtures: built with @solana/web3.js from fixed public keys and
// left UNSIGNED (zero signatures), so no keypair or secret is involved. The
// `meta` blocks are hand-written to look like real RPC metadata.
//
// `--live`: also fetches one real devnet transaction touching the Memo program
// (read-only RPC call) and stores the raw getTransaction response.
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { writeFileSync, readFileSync } from "node:fs";
import bs58 from "bs58";

const dir = new URL("../test/fixtures/", import.meta.url);
const pk = (n) => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : (n * 7 + i) % 256)));
const payer = pk(1);
const bob = pk(2);
const blockhash = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";

const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN22 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

function ata(owner, mint, program = TOKEN) {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA)[0];
}

function serialize(msg, lookups = []) {
  const m = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: msg });
  const compiled = lookups.length ? m.compileToV0Message(lookups) : m.compileToLegacyMessage();
  const tx = new VersionedTransaction(compiled); // signatures default to zeros
  return Buffer.from(tx.serialize()).toString("base64");
}

function save(name, obj) {
  writeFileSync(new URL(name, dir), JSON.stringify(obj, null, 2) + "\n");
  console.log("wrote", name);
}

const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

// 1. SOL transfer + memo + compute budget
{
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: bob, lamports: 250_000_000 }),
    new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: payer, isSigner: true, isWritable: false }], data: Buffer.from("rent for October") }),
  ];
  const fee = 5000 + 50; // base + ceil(1000 * 50_000 / 1e6)
  save("sol-transfer.json", {
    slot: 300000001,
    blockTime: 1760000000,
    version: "legacy",
    transaction: [serialize(ixs), "base64"],
    meta: {
      err: null,
      fee,
      preBalances: [2_000_000_000, 0, 1, 1, 1],
      postBalances: [2_000_000_000 - 250_000_000 - fee, 250_000_000, 1, 1, 1],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: [],
      logMessages: [],
      computeUnitsConsumed: 750,
    },
  });
}

// 2. Create ATA (idempotent) + TransferChecked of a 6-decimal token
{
  const mint = pk(10);
  const src = ata(payer, mint);
  const dst = ata(bob, mint);
  const createIdem = new TransactionInstruction({
    programId: ATA,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: dst, isSigner: false, isWritable: true },
      { pubkey: bob, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
  const transferChecked = new TransactionInstruction({
    programId: TOKEN,
    keys: [
      { pubkey: src, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dst, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([12]), u64(12_500_000), Buffer.from([6])]),
  });
  const tx = serialize([createIdem, transferChecked]);
  // account order after compile: payer, dst, src, bob, mint, system, ATA, token (check with parse in tests)
  const msg = VersionedTransaction.deserialize(Buffer.from(tx, "base64")).message;
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  const idx = (k) => keys.indexOf(k.toBase58());
  const rent = 2_039_280;
  const pre = keys.map(() => 1);
  const post = keys.map(() => 1);
  pre[idx(payer)] = 1_000_000_000;
  post[idx(payer)] = 1_000_000_000 - rent - 5000;
  pre[idx(dst)] = 0;
  post[idx(dst)] = rent;
  pre[idx(src)] = rent;
  post[idx(src)] = rent;
  const tb = (accountIndex, owner, amount) => ({ accountIndex, mint: mint.toBase58(), owner: owner.toBase58(), programId: TOKEN.toBase58(), uiTokenAmount: { amount: String(amount), decimals: 6 } });
  save("token-transfer.json", {
    slot: 300000002,
    blockTime: 1760000100,
    version: "legacy",
    transaction: [tx, "base64"],
    meta: {
      err: null,
      fee: 5000,
      preBalances: pre,
      postBalances: post,
      preTokenBalances: [tb(idx(src), payer, 50_000_000)],
      postTokenBalances: [tb(idx(src), payer, 37_500_000), tb(idx(dst), bob, 12_500_000)],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            { programIdIndex: idx(TOKEN), accounts: [idx(mint)], data: bs58.encode([21]), stackHeight: 2 }, // GetAccountDataSize
            {
              programIdIndex: idx(SystemProgram.programId),
              accounts: [idx(payer), idx(dst)],
              data: bs58.encode(Buffer.concat([Buffer.from([0, 0, 0, 0]), u64(rent), u64(165), TOKEN.toBuffer()])),
              stackHeight: 2,
            },
            { programIdIndex: idx(TOKEN), accounts: [idx(dst)], data: bs58.encode([22]), stackHeight: 2 }, // InitializeImmutableOwner
            { programIdIndex: idx(TOKEN), accounts: [idx(dst), idx(mint)], data: bs58.encode(Buffer.concat([Buffer.from([18]), bob.toBuffer()])), stackHeight: 2 },
          ],
        },
      ],
      logMessages: [],
      computeUnitsConsumed: 27_654,
    },
  });
}

// 3. v0 transaction with an address lookup table, Token-2022 MintToChecked
{
  const mint = pk(20);
  const table = pk(30);
  const dest = ata(bob, mint, TOKEN22);
  const lut = new AddressLookupTableAccount({ key: table, state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [mint, dest] } });
  const mintTo = new TransactionInstruction({
    programId: TOKEN22,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([14]), u64(3_000_000_000), Buffer.from([9])]),
  });
  const tx = serialize([mintTo], [lut]);
  save("v0-lookup-mint.json", {
    slot: 300000003,
    blockTime: 1760000200,
    version: 0,
    transaction: [tx, "base64"],
    meta: {
      err: null,
      fee: 5000,
      preBalances: [500_000_000, 1, 1_461_600, 2_074_080],
      postBalances: [499_995_000, 1, 1_461_600, 2_074_080],
      preTokenBalances: [{ accountIndex: 3, mint: mint.toBase58(), owner: bob.toBase58(), programId: TOKEN22.toBase58(), uiTokenAmount: { amount: "0", decimals: 9 } }],
      postTokenBalances: [{ accountIndex: 3, mint: mint.toBase58(), owner: bob.toBase58(), programId: TOKEN22.toBase58(), uiTokenAmount: { amount: "3000000000", decimals: 9 } }],
      innerInstructions: [],
      logMessages: [],
      computeUnitsConsumed: 4_500,
      loadedAddresses: { writable: [mint.toBase58(), dest.toBase58()], readonly: [] },
    },
  });
}

// 4. Anchor program call (counter_todo.increment) that fails with Overflow (6000)
{
  const idl = JSON.parse(readFileSync(new URL("idl/counter_todo.json", dir), "utf8"));
  const ix = idl.instructions.find((i) => i.name === "increment");
  const program = new PublicKey(idl.address);
  const counter = PublicKey.findProgramAddressSync([Buffer.from("counter"), payer.toBuffer()], program)[0];
  const call = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: counter, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([Buffer.from(ix.discriminator), u64(5)]),
  });
  save("anchor-increment-failed.json", {
    slot: 300000004,
    blockTime: 1760000300,
    version: "legacy",
    transaction: [serialize([call]), "base64"],
    meta: {
      err: { InstructionError: [0, { Custom: 6000 }] },
      fee: 5000,
      preBalances: [100_000_000, 1_238_880, 1],
      postBalances: [99_995_000, 1_238_880, 1],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: [],
      logMessages: ["Program log: AnchorError occurred. Error Code: Overflow. Error Number: 6000."],
      computeUnitsConsumed: 3_210,
    },
  });
}

// 5. Optional: one real devnet transaction (read-only RPC)
if (process.argv.includes("--live")) {
  const rpc = "https://api.devnet.solana.com";
  const call = async (method, params) => {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return (await r.json()).result;
  };
  const sigs = await call("getSignaturesForAddress", [MEMO.toBase58(), { limit: 20 }]);
  for (const s of sigs.filter((s) => !s.err)) {
    const tx = await call("getTransaction", [s.signature, { encoding: "base64", maxSupportedTransactionVersion: 0 }]);
    if (tx && tx.transaction[0].length < 1500) {
      save("devnet-memo.json", { signature: s.signature, ...tx });
      break;
    }
  }
}
