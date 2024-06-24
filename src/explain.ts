import bs58 from "bs58";
import { decodeRawTx, formatUnits, fromBase64, short, sol } from "./bytes.js";
import { accountKeys, parseTransaction, type AccountKey, type ParsedTransaction } from "./message.js";
import {
  PROGRAMS,
  PROGRAM_NAMES,
  decodeAta,
  decodeComputeBudget,
  decodeMemo,
  decodeSystem,
  decodeToken,
  emptyContext,
  unknown,
  type Context,
  type DecodedInstruction,
} from "./programs.js";
import { anchorError, decodeAnchor, type Idl } from "./anchor.js";

export interface UiTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

/** Shape of `getTransaction(sig, { encoding: "base64", maxSupportedTransactionVersion: 0 })`. */
export interface RpcTransaction {
  slot?: number;
  blockTime?: number | null;
  version?: "legacy" | 0;
  transaction: [string, "base64"] | string[];
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: UiTokenBalance[];
    postTokenBalances?: UiTokenBalance[];
    innerInstructions?: { index: number; instructions: { programIdIndex: number; accounts: number[]; data: string; stackHeight?: number }[] }[];
    logMessages?: string[];
    computeUnitsConsumed?: number;
    loadedAddresses?: { writable: string[]; readonly: string[] };
  } | null;
}

export interface ExplainedInstruction extends DecodedInstruction {
  index: string; // "1", "1.2" for inner
  depth: number;
}

export interface BalanceChange {
  account: string;
  label?: string;
  before: bigint;
  after: bigint;
  delta: bigint;
}

export interface TokenChange {
  account: string;
  owner?: string;
  mint: string;
  decimals: number;
  delta: bigint;
}

export interface Explanation {
  signature?: string;
  signatures: string[];
  version: "legacy" | 0;
  feePayer: string;
  slot?: number;
  blockTime?: number | null;
  status: "success" | "failed" | "unknown";
  error?: string;
  fee?: bigint;
  computeUnits?: number;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: bigint;
  priorityFee?: bigint;
  accounts: AccountKey[];
  instructions: ExplainedInstruction[];
  solChanges: BalanceChange[];
  tokenChanges: TokenChange[];
  notes: string[];
}

export interface ExplainOptions {
  idls?: Idl[];
}

function decodeOne(
  programId: string,
  data: Uint8Array,
  keys: string[],
  ctx: Context,
  idls: Map<string, Idl>,
): Omit<DecodedInstruction, "programId" | "program"> {
  try {
    switch (programId) {
      case PROGRAMS.system:
        return decodeSystem(data, keys, ctx);
      case PROGRAMS.token:
        return decodeToken(data, keys, ctx, false);
      case PROGRAMS.token2022:
        return decodeToken(data, keys, ctx, true);
      case PROGRAMS.ata:
        return decodeAta(data, keys, ctx);
      case PROGRAMS.computeBudget:
        return { ...decodeComputeBudget(data), accounts: [] };
      case PROGRAMS.memo:
      case PROGRAMS.memoV1:
        return decodeMemo(data, keys);
    }
    const idl = idls.get(programId);
    if (idl) {
      const d = decodeAnchor(idl, data, keys);
      if (d) return d;
      return { ...unknown(data, keys), error: `no instruction in IDL ${idl.metadata.name} matches the discriminator` };
    }
    return unknown(data, keys);
  } catch (e) {
    return { ...unknown(data, keys), error: (e as Error).message };
  }
}

function programName(id: string, idls: Map<string, Idl>): string {
  return PROGRAM_NAMES[id] ?? (idls.get(id) ? `${idls.get(id)!.metadata.name} (Anchor)` : short(id));
}

/** Build the context (token accounts, decimals, labels) from metadata. */
function buildContext(keys: AccountKey[], meta: RpcTransaction["meta"]): Context {
  const ctx = emptyContext();
  ctx.labels.set(keys[0].pubkey, "fee payer");
  for (const tb of [...(meta?.preTokenBalances ?? []), ...(meta?.postTokenBalances ?? [])]) {
    const acc = keys[tb.accountIndex]?.pubkey;
    if (!acc) continue;
    ctx.tokenAccounts.set(acc, { mint: tb.mint, decimals: tb.uiTokenAmount.decimals, owner: tb.owner });
    ctx.mintDecimals.set(tb.mint, tb.uiTokenAmount.decimals);
  }
  return ctx;
}

function describeError(err: unknown, idls: Map<string, Idl>, programAt: (ix: number) => string | undefined): string {
  if (err && typeof err === "object" && "InstructionError" in err) {
    const [ix, e] = (err as { InstructionError: [number, unknown] }).InstructionError;
    const prog = programAt(ix);
    if (e && typeof e === "object" && "Custom" in e) {
      const code = (e as { Custom: number }).Custom;
      const idl = prog ? idls.get(prog) : undefined;
      const named = idl ? anchorError(idl, code) : undefined;
      return `instruction ${ix + 1} failed with custom error ${code}${named ? ` (${named})` : ""}`;
    }
    return `instruction ${ix + 1} failed: ${JSON.stringify(e)}`;
  }
  return JSON.stringify(err);
}

export function explain(input: { raw?: Uint8Array | string; rpc?: RpcTransaction }, opts: ExplainOptions = {}): Explanation {
  const idls = new Map((opts.idls ?? []).map((i) => [i.address, i]));
  let tx: ParsedTransaction;
  const meta = input.rpc?.meta ?? null;
  if (input.rpc) {
    const [b64] = input.rpc.transaction;
    tx = parseTransaction(fromBase64(b64));
  } else if (input.raw !== undefined) {
    tx = parseTransaction(typeof input.raw === "string" ? decodeRawTx(input.raw) : input.raw);
  } else {
    throw new Error("nothing to explain");
  }
  const keys = accountKeys(tx.message, meta?.loadedAddresses);
  const ctx = buildContext(keys, meta);
  const notes: string[] = [];
  if (tx.message.lookups.length && !meta?.loadedAddresses) {
    notes.push("Uses address lookup tables; their entries are shown as table[index] (fetch via RPC to resolve).");
  }

  const instructions: ExplainedInstruction[] = [];
  let cuLimit: number | undefined;
  let cuPrice: bigint | undefined;
  tx.message.instructions.forEach((ix, i) => {
    const programId = keys[ix.programIdIndex]?.pubkey ?? `#${ix.programIdIndex}`;
    const ixKeys = ix.accounts.map((a) => keys[a]?.pubkey ?? `#${a}`);
    const d = decodeOne(programId, ix.data, ixKeys, ctx, idls);
    if (programId === PROGRAMS.computeBudget) {
      if (d.name === "SetComputeUnitLimit") cuLimit = d.args.units as number;
      if (d.name === "SetComputeUnitPrice") cuPrice = d.args.microLamports as bigint;
    }
    instructions.push({ ...d, programId, program: programName(programId, idls), index: `${i + 1}`, depth: 0 });
    const inner = meta?.innerInstructions?.find((x) => x.index === i);
    inner?.instructions.forEach((iix, j) => {
      const pid = keys[iix.programIdIndex]?.pubkey ?? `#${iix.programIdIndex}`;
      const k = iix.accounts.map((a) => keys[a]?.pubkey ?? `#${a}`);
      const dd = decodeOne(pid, bs58.decode(iix.data), k, ctx, idls);
      instructions.push({ ...dd, programId: pid, program: programName(pid, idls), index: `${i + 1}.${j + 1}`, depth: Math.max(1, (iix.stackHeight ?? 2) - 1) });
    });
  });

  const solChanges: BalanceChange[] = [];
  const tokenChanges: TokenChange[] = [];
  if (meta) {
    meta.preBalances.forEach((pre, i) => {
      const post = meta.postBalances[i];
      if (post !== pre && keys[i]) {
        solChanges.push({ account: keys[i].pubkey, label: ctx.labels.get(keys[i].pubkey), before: BigInt(pre), after: BigInt(post), delta: BigInt(post) - BigInt(pre) });
      }
    });
    const pre = new Map((meta.preTokenBalances ?? []).map((b) => [b.accountIndex, b]));
    const post = new Map((meta.postTokenBalances ?? []).map((b) => [b.accountIndex, b]));
    for (const idx of new Set([...pre.keys(), ...post.keys()])) {
      const a = pre.get(idx);
      const b = post.get(idx);
      const delta = BigInt(b?.uiTokenAmount.amount ?? "0") - BigInt(a?.uiTokenAmount.amount ?? "0");
      if (delta === 0n) continue;
      const ref = (b ?? a)!;
      tokenChanges.push({ account: keys[idx]?.pubkey ?? `#${idx}`, owner: ref.owner, mint: ref.mint, decimals: ref.uiTokenAmount.decimals, delta });
    }
    tokenChanges.sort((x, y) => x.account.localeCompare(y.account));
  }

  const status = meta ? (meta.err ? "failed" : "success") : "unknown";
  const programAt = (ix: number) => keys[tx.message.instructions[ix]?.programIdIndex]?.pubkey;
  const priorityFee =
    cuPrice !== undefined ? (cuPrice * BigInt(cuLimit ?? 200_000 * tx.message.instructions.filter((x) => keys[x.programIdIndex]?.pubkey !== PROGRAMS.computeBudget).length) + 999_999n) / 1_000_000n : undefined;

  return {
    signature: tx.signatures[0],
    signatures: tx.signatures,
    version: tx.message.version,
    feePayer: keys[0].pubkey,
    slot: input.rpc?.slot,
    blockTime: input.rpc?.blockTime,
    status,
    error: meta?.err ? describeError(meta.err, idls, programAt) : undefined,
    fee: meta ? BigInt(meta.fee) : undefined,
    computeUnits: meta?.computeUnitsConsumed,
    computeUnitLimit: cuLimit,
    computeUnitPriceMicroLamports: cuPrice,
    priorityFee,
    accounts: keys,
    instructions,
    solChanges,
    tokenChanges,
    notes,
  };
}

/** Plain-text report. */
export function render(e: Explanation): string {
  const L: string[] = [];
  const unsigned = !e.signature || /^1+$/.test(e.signature);
  L.push(`Transaction ${unsigned ? "(unsigned)" : e.signature}  [${e.version === 0 ? "v0" : "legacy"}]`);
  if (e.slot !== undefined) L.push(`Slot ${e.slot}${e.blockTime ? `, ${new Date(e.blockTime * 1000).toISOString()}` : ""}`);
  L.push(`Status: ${e.status === "success" ? "succeeded" : e.status === "failed" ? `FAILED (${e.error})` : "unknown (no metadata)"}`);
  L.push(`Fee payer: ${e.feePayer}`);
  if (e.fee !== undefined) {
    let f = `Fee: ${sol(e.fee)}`;
    if (e.priorityFee !== undefined) f += ` (of which priority ≈ ${sol(e.priorityFee)})`;
    L.push(f);
  }
  if (e.computeUnits !== undefined) L.push(`Compute units: ${e.computeUnits.toLocaleString("en-US")}${e.computeUnitLimit ? ` of ${e.computeUnitLimit.toLocaleString("en-US")} requested` : ""}`);
  L.push("");
  L.push("What happened:");
  for (const ix of e.instructions) {
    const pad = "  ".repeat(ix.depth + 1);
    L.push(`${pad}${ix.index}. [${ix.program}] ${ix.summary}${ix.error ? `  (!) ${ix.error}` : ""}`);
  }
  if (e.solChanges.length) {
    L.push("");
    L.push("SOL balance changes:");
    for (const c of e.solChanges) {
      const sign = c.delta > 0n ? "+" : "";
      L.push(`  ${short(c.account)}${c.label ? ` (${c.label})` : ""}: ${sign}${formatUnits(c.delta, 9)} SOL`);
    }
  }
  if (e.tokenChanges.length) {
    L.push("");
    L.push("Token balance changes:");
    for (const c of e.tokenChanges) {
      const sign = c.delta > 0n ? "+" : "";
      L.push(`  ${short(c.account)}${c.owner ? ` (owner ${short(c.owner)})` : ""}: ${sign}${formatUnits(c.delta, c.decimals)} of mint ${short(c.mint)}`);
    }
  }
  if (e.notes.length) {
    L.push("");
    for (const n of e.notes) L.push(`Note: ${n}`);
  }
  return L.join("\n") + "\n";
}

/** JSON-safe version (bigints -> strings). */
export function toJSON(e: Explanation): unknown {
  return JSON.parse(JSON.stringify(e, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Array.from(v) : v)));
}
