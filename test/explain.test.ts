import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { explain, render, toJSON, fetchTransaction, type RpcTransaction, type Idl } from "../src/index.js";
import { decodeType } from "../src/anchor.js";
import { Reader, formatUnits, decodeRawTx } from "../src/bytes.js";

const fx = (name: string): RpcTransaction => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const counterIdl: Idl = JSON.parse(readFileSync(new URL("./fixtures/idl/counter_todo.json", import.meta.url), "utf8"));
const summaries = (e: ReturnType<typeof explain>) => e.instructions.map((i) => `${i.index} ${i.name}: ${i.summary}`);

describe("system + memo + compute budget", () => {
  const e = explain({ rpc: fx("sol-transfer.json") });
  it("decodes every instruction", () => {
    expect(e.instructions.map((i) => i.name)).toEqual(["SetComputeUnitLimit", "SetComputeUnitPrice", "Transfer", "Memo"]);
    expect(e.instructions[2].summary).toMatch(/^Transfer 0\.25 SOL from 52Wp…etf7 \(fee payer\) to 938w…ZPwz$/);
    expect(e.instructions[3].args.text).toBe("rent for October");
  });
  it("computes fees, CU and priority fee", () => {
    expect(e.fee).toBe(5050n);
    expect(e.computeUnits).toBe(750);
    expect(e.computeUnitLimit).toBe(1000);
    expect(e.computeUnitPriceMicroLamports).toBe(50_000n);
    expect(e.priorityFee).toBe(50n);
  });
  it("reports SOL balance changes", () => {
    expect(e.solChanges.map((c) => c.delta)).toEqual([-250_005_050n, 250_000_000n]);
    expect(e.solChanges[0].label).toBe("fee payer");
  });
  it("renders text", () => {
    const t = render(e);
    expect(t).toContain("Transaction (unsigned)  [legacy]");
    expect(t).toContain("Status: succeeded");
    expect(t).toContain("Fee: 0.00000505 SOL (of which priority ≈ 0.00000005 SOL)");
    expect(t).toContain("  3. [System Program] Transfer 0.25 SOL");
    expect(t).toContain('  4. [Memo] Memo: "rent for October"');
  });
});

describe("ATA + TransferChecked with inner instructions", () => {
  const e = explain({ rpc: fx("token-transfer.json") });
  it("decodes outer and inner instructions in order", () => {
    expect(e.instructions.map((i) => `${i.index}:${i.program}:${i.name}`)).toEqual([
      "1:Associated Token Account:CreateIdempotent",
      "1.1:SPL Token:GetAccountDataSize",
      "1.2:System Program:CreateAccount",
      "1.3:SPL Token:InitializeImmutableOwner",
      "1.4:SPL Token:InitializeAccount3",
      "2:SPL Token:TransferChecked",
    ]);
    expect(e.instructions[2].summary).toContain("with 165 bytes owned by SPL Token");
    expect(e.instructions[5].summary).toMatch(/^Transfer 12\.5 tokens of mint /);
  });
  it("reports token balance changes with decimals", () => {
    expect(e.tokenChanges.map((c) => [c.delta, c.decimals])).toEqual(
      expect.arrayContaining([[-12_500_000n, 6], [12_500_000n, 6]]),
    );
  });
});

describe("v0 + address lookup table + Token-2022", () => {
  it("resolves lookup addresses from meta.loadedAddresses", () => {
    const e = explain({ rpc: fx("v0-lookup-mint.json") });
    expect(e.version).toBe(0);
    expect(e.accounts.filter((a) => a.source === "lookup")).toHaveLength(2);
    expect(e.instructions[0].program).toBe("Token-2022");
    expect(e.instructions[0].summary).toMatch(/^Mint 3 tokens of mint .* to /);
    expect(e.notes).toEqual([]);
  });
  it("without metadata, shows table[index] placeholders and a note", () => {
    const raw = fx("v0-lookup-mint.json").transaction[0];
    const e = explain({ raw });
    expect(e.status).toBe("unknown");
    expect(e.instructions[0].accounts[0].pubkey).toMatch(/\[0\]$/);
    expect(e.notes[0]).toMatch(/lookup tables/);
  });
});

describe("Anchor via IDL", () => {
  const rpc = fx("anchor-increment-failed.json");
  it("decodes the instruction name, args and account names", () => {
    const e = explain({ rpc }, { idls: [counterIdl] });
    const ix = e.instructions[0];
    expect(ix.program).toBe("counter_todo (Anchor)");
    expect(ix.name).toBe("increment");
    expect(ix.args).toEqual({ by: 5n });
    expect(ix.accounts.map((a) => a.name)).toEqual(["authority", "counter"]);
    expect(e.status).toBe("failed");
    expect(e.error).toBe("instruction 1 failed with custom error 6000 (Overflow: Counter would overflow u64)");
  });
  it("falls back to raw data without the IDL", () => {
    const e = explain({ rpc });
    expect(e.instructions[0].name).toBe("Unknown");
    expect(e.instructions[0].summary).toMatch(/^Call with 16 bytes of data/);
    expect(e.error).toBe("instruction 1 failed with custom error 6000");
  });
  it("decodes nested IDL types", () => {
    const idl = {
      address: "x",
      metadata: { name: "t" },
      instructions: [],
      types: [
        { name: "Point", type: { kind: "struct", fields: [{ name: "x", type: "i16" }, { name: "tags", type: { vec: "string" } }] } },
        { name: "Side", type: { kind: "enum", variants: [{ name: "Bid" }, { name: "Ask", fields: [{ name: "px", type: "u64" }] }] } },
      ],
    } as unknown as Idl;
    const bytes = [
      0xfe, 0xff, // x = -2
      1, 0, 0, 0, 2, 0, 0, 0, 0x68, 0x69, // tags = ["hi"]
      1, 7, 0, 0, 0, 0, 0, 0, 0, // Ask { px: 7 }
      1, 42, // Some(42u8)
      0, // None
    ];
    const r = new Reader(Uint8Array.from(bytes));
    expect(decodeType(r, { defined: { name: "Point" } }, idl)).toEqual({ x: -2, tags: ["hi"] });
    expect(decodeType(r, { defined: { name: "Side" } }, idl)).toEqual({ Ask: { px: 7n } });
    expect(decodeType(r, { option: "u8" }, idl)).toBe(42);
    expect(decodeType(r, { option: "u8" }, idl)).toBeNull();
  });
});

describe("real devnet transaction", () => {
  it("explains a captured devnet memo + token payout", () => {
    const rpc = fx("devnet-memo.json") as RpcTransaction & { signature: string };
    const e = explain({ rpc });
    expect(e.signature).toBe(rpc.signature);
    expect(e.status).toBe("success");
    expect(e.instructions.some((i) => i.name === "Memo")).toBe(true);
    expect(e.instructions.every((i) => !i.error)).toBe(true);
    expect(e.fee).toBe(BigInt(rpc.meta!.fee));
  });
});

describe("raw input", () => {
  it("accepts base64 and base58 and gives the same result", () => {
    const b64 = fx("sol-transfer.json").transaction[0];
    const b58 = bs58.encode(Buffer.from(b64, "base64"));
    const a = toJSON(explain({ raw: b64 }));
    const b = toJSON(explain({ raw: b58 }));
    expect(a).toEqual(b);
    expect(explain({ raw: b64 }).instructions[2].name).toBe("Transfer");
  });
  it("rejects garbage", () => {
    expect(() => decodeRawTx("not a tx!!")).toThrow();
    expect(() => explain({ raw: "AAAA" })).toThrow();
  });
});

describe("helpers", () => {
  it("formats units", () => {
    expect(formatUnits(1_234_500_000n, 9)).toBe("1.2345");
    expect(formatUnits(-5n, 2)).toBe("-0.05");
    expect(formatUnits(1_000_000n, 0)).toBe("1,000,000");
  });
  it("fetchTransaction calls getTransaction with base64 + v0 support", async () => {
    const body = fx("sol-transfer.json");
    const fake = vi.fn(async (_url: string, init: RequestInit) => {
      const req = JSON.parse(init.body as string);
      expect(req.method).toBe("getTransaction");
      expect(req.params[1]).toMatchObject({ encoding: "base64", maxSupportedTransactionVersion: 0 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: body }));
    });
    const r = await fetchTransaction("sig", "http://rpc", fake as unknown as typeof fetch);
    expect(r.meta?.fee).toBe(5050);
    const missing = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null })));
    await expect(fetchTransaction("sig", "http://rpc", missing as unknown as typeof fetch)).rejects.toThrow(/not found/);
  });
});
