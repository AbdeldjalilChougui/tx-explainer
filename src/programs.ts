import { Reader, formatUnits, sol, short, toHex } from "./bytes.js";

export const PROGRAMS = {
  system: "11111111111111111111111111111111",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ata: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  computeBudget: "ComputeBudget111111111111111111111111111111",
  memo: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  memoV1: "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
} as const;

export const PROGRAM_NAMES: Record<string, string> = {
  [PROGRAMS.system]: "System Program",
  [PROGRAMS.token]: "SPL Token",
  [PROGRAMS.token2022]: "Token-2022",
  [PROGRAMS.ata]: "Associated Token Account",
  [PROGRAMS.computeBudget]: "Compute Budget",
  [PROGRAMS.memo]: "Memo",
  [PROGRAMS.memoV1]: "Memo (v1)",
  Stake11111111111111111111111111111111111111: "Stake Program",
  Vote111111111111111111111111111111111111111: "Vote Program",
  AddressLookupTab1e1111111111111111111111111: "Address Lookup Table",
  BPFLoaderUpgradeab1e11111111111111111111111: "BPF Upgradeable Loader",
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: "Metaplex Token Metadata",
};

export interface IxAccount {
  name: string;
  pubkey: string;
}

export interface DecodedInstruction {
  programId: string;
  program: string;
  name: string;
  /** One plain-language sentence. */
  summary: string;
  args: Record<string, unknown>;
  accounts: IxAccount[];
  /** Set when the program is known but the data could not be decoded. */
  error?: string;
}

/** Facts from transaction metadata that make summaries nicer. */
export interface Context {
  /** token account -> { mint, decimals, owner } */
  tokenAccounts: Map<string, { mint: string; decimals: number; owner?: string }>;
  /** mint -> decimals */
  mintDecimals: Map<string, number>;
  /** address -> label (e.g. "fee payer") */
  labels: Map<string, string>;
}

export function emptyContext(): Context {
  return { tokenAccounts: new Map(), mintDecimals: new Map(), labels: new Map() };
}

const named = (names: string[], keys: string[]): IxAccount[] =>
  keys.map((pubkey, i) => ({ name: names[i] ?? `account${i}`, pubkey }));

export const who = (ctx: Context, a: string | undefined) => {
  if (!a) return "?";
  const l = ctx.labels.get(a);
  return l ? `${short(a)} (${l})` : short(a);
};

// ----------------------------------------------------------------- System

export function decodeSystem(data: Uint8Array, keys: string[], ctx: Context): Omit<DecodedInstruction, "programId" | "program"> {
  const r = new Reader(data);
  const tag = r.u32();
  switch (tag) {
    case 0: {
      const lamports = r.u64();
      const space = r.u64();
      const owner = r.pubkey();
      return {
        name: "CreateAccount",
        args: { lamports, space, owner },
        accounts: named(["from", "newAccount"], keys),
        summary: `Create account ${who(ctx, keys[1])} with ${space} bytes owned by ${PROGRAM_NAMES[owner] ?? short(owner)}, funded with ${sol(lamports)} by ${who(ctx, keys[0])}`,
      };
    }
    case 1: {
      const owner = r.pubkey();
      return {
        name: "Assign",
        args: { owner },
        accounts: named(["account"], keys),
        summary: `Assign ${who(ctx, keys[0])} to program ${PROGRAM_NAMES[owner] ?? short(owner)}`,
      };
    }
    case 2: {
      const lamports = r.u64();
      return {
        name: "Transfer",
        args: { lamports },
        accounts: named(["from", "to"], keys),
        summary: `Transfer ${sol(lamports)} from ${who(ctx, keys[0])} to ${who(ctx, keys[1])}`,
      };
    }
    case 3: {
      const base = r.pubkey();
      const seed = r.string();
      const lamports = r.u64();
      const space = r.u64();
      const owner = r.pubkey();
      return {
        name: "CreateAccountWithSeed",
        args: { base, seed, lamports, space, owner },
        accounts: named(["from", "newAccount", "base"], keys),
        summary: `Create account ${who(ctx, keys[1])} from seed "${seed}" (${space} bytes, ${sol(lamports)})`,
      };
    }
    case 4:
      return { name: "AdvanceNonceAccount", args: {}, accounts: named(["nonce", "recentBlockhashes", "authority"], keys), summary: `Advance durable nonce ${who(ctx, keys[0])}` };
    case 5: {
      const lamports = r.u64();
      return { name: "WithdrawNonceAccount", args: { lamports }, accounts: named(["nonce", "to"], keys), summary: `Withdraw ${sol(lamports)} from nonce account ${who(ctx, keys[0])}` };
    }
    case 8: {
      const space = r.u64();
      return { name: "Allocate", args: { space }, accounts: named(["account"], keys), summary: `Allocate ${space} bytes for ${who(ctx, keys[0])}` };
    }
    case 11: {
      const lamports = r.u64();
      const seed = r.string();
      const owner = r.pubkey();
      return { name: "TransferWithSeed", args: { lamports, seed, owner }, accounts: named(["from", "base", "to"], keys), summary: `Transfer ${sol(lamports)} from seed account ${who(ctx, keys[0])} to ${who(ctx, keys[2])}` };
    }
    default:
      return { name: `SystemInstruction#${tag}`, args: {}, accounts: named([], keys), summary: `System instruction #${tag}` };
  }
}

// ------------------------------------------------------------ SPL Token

function tokenAmount(ctx: Context, amount: bigint, mint?: string, tokenAccount?: string, decimals?: number) {
  const info = tokenAccount ? ctx.tokenAccounts.get(tokenAccount) : undefined;
  const m = mint ?? info?.mint;
  const d = decimals ?? info?.decimals ?? (m ? ctx.mintDecimals.get(m) : undefined);
  const mintStr = m ? ` of mint ${short(m)}` : "";
  return d === undefined ? `${amount} base units${mintStr}` : `${formatUnits(amount, d)} tokens${mintStr}`;
}

const AUTHORITY_TYPES = ["MintTokens", "FreezeAccount", "AccountOwner", "CloseAccount"];

export function decodeToken(data: Uint8Array, keys: string[], ctx: Context, is2022: boolean): Omit<DecodedInstruction, "programId" | "program"> {
  const r = new Reader(data);
  const tag = r.u8();
  const optPubkey = () => (r.u8() === 1 ? r.pubkey() : null);
  switch (tag) {
    case 0:
    case 20: {
      const decimals = r.u8();
      const mintAuthority = r.pubkey();
      const freezeAuthority = optPubkey();
      ctx.mintDecimals.set(keys[0], decimals);
      return {
        name: tag === 0 ? "InitializeMint" : "InitializeMint2",
        args: { decimals, mintAuthority, freezeAuthority },
        accounts: named(["mint"], keys),
        summary: `Initialize mint ${who(ctx, keys[0])} with ${decimals} decimals, mint authority ${short(mintAuthority)}${freezeAuthority ? `, freeze authority ${short(freezeAuthority)}` : ""}`,
      };
    }
    case 1:
      return { name: "InitializeAccount", args: {}, accounts: named(["account", "mint", "owner"], keys), summary: `Initialize token account ${who(ctx, keys[0])} for mint ${short(keys[1])} owned by ${who(ctx, keys[2])}` };
    case 16:
    case 18: {
      const owner = r.pubkey();
      return { name: tag === 16 ? "InitializeAccount2" : "InitializeAccount3", args: { owner }, accounts: named(["account", "mint"], keys), summary: `Initialize token account ${who(ctx, keys[0])} for mint ${short(keys[1])} owned by ${short(owner)}` };
    }
    case 3: {
      const amount = r.u64();
      return { name: "Transfer", args: { amount }, accounts: named(["source", "destination", "authority"], keys), summary: `Transfer ${tokenAmount(ctx, amount, undefined, keys[0])} from ${who(ctx, keys[0])} to ${who(ctx, keys[1])} (authority ${who(ctx, keys[2])})` };
    }
    case 4: {
      const amount = r.u64();
      return { name: "Approve", args: { amount }, accounts: named(["source", "delegate", "owner"], keys), summary: `Approve ${who(ctx, keys[1])} to spend ${tokenAmount(ctx, amount, undefined, keys[0])} from ${who(ctx, keys[0])}` };
    }
    case 5:
      return { name: "Revoke", args: {}, accounts: named(["source", "owner"], keys), summary: `Revoke the delegate of ${who(ctx, keys[0])}` };
    case 6: {
      const t = r.u8();
      const newAuthority = optPubkey();
      const kind = AUTHORITY_TYPES[t] ?? `authority type ${t}`;
      return { name: "SetAuthority", args: { authorityType: kind, newAuthority }, accounts: named(["account", "currentAuthority"], keys), summary: newAuthority ? `Set ${kind} authority of ${who(ctx, keys[0])} to ${short(newAuthority)}` : `Remove ${kind} authority of ${who(ctx, keys[0])} (permanently)` };
    }
    case 7: {
      const amount = r.u64();
      return { name: "MintTo", args: { amount }, accounts: named(["mint", "destination", "authority"], keys), summary: `Mint ${tokenAmount(ctx, amount, keys[0])} to ${who(ctx, keys[1])}` };
    }
    case 8: {
      const amount = r.u64();
      return { name: "Burn", args: { amount }, accounts: named(["account", "mint", "owner"], keys), summary: `Burn ${tokenAmount(ctx, amount, keys[1])} from ${who(ctx, keys[0])}` };
    }
    case 9:
      return { name: "CloseAccount", args: {}, accounts: named(["account", "destination", "owner"], keys), summary: `Close token account ${who(ctx, keys[0])}, rent goes to ${who(ctx, keys[1])}` };
    case 10:
      return { name: "FreezeAccount", args: {}, accounts: named(["account", "mint", "authority"], keys), summary: `Freeze token account ${who(ctx, keys[0])}` };
    case 11:
      return { name: "ThawAccount", args: {}, accounts: named(["account", "mint", "authority"], keys), summary: `Thaw token account ${who(ctx, keys[0])}` };
    case 12: {
      const amount = r.u64();
      const decimals = r.u8();
      return { name: "TransferChecked", args: { amount, decimals }, accounts: named(["source", "mint", "destination", "authority"], keys), summary: `Transfer ${tokenAmount(ctx, amount, keys[1], undefined, decimals)} from ${who(ctx, keys[0])} to ${who(ctx, keys[2])} (authority ${who(ctx, keys[3])})` };
    }
    case 13: {
      const amount = r.u64();
      const decimals = r.u8();
      return { name: "ApproveChecked", args: { amount, decimals }, accounts: named(["source", "mint", "delegate", "owner"], keys), summary: `Approve ${who(ctx, keys[2])} to spend ${tokenAmount(ctx, amount, keys[1], undefined, decimals)}` };
    }
    case 14: {
      const amount = r.u64();
      const decimals = r.u8();
      return { name: "MintToChecked", args: { amount, decimals }, accounts: named(["mint", "destination", "authority"], keys), summary: `Mint ${tokenAmount(ctx, amount, keys[0], undefined, decimals)} to ${who(ctx, keys[1])}` };
    }
    case 15: {
      const amount = r.u64();
      const decimals = r.u8();
      return { name: "BurnChecked", args: { amount, decimals }, accounts: named(["account", "mint", "owner"], keys), summary: `Burn ${tokenAmount(ctx, amount, keys[1], undefined, decimals)} from ${who(ctx, keys[0])}` };
    }
    case 17:
      return { name: "SyncNative", args: {}, accounts: named(["account"], keys), summary: `Sync wrapped-SOL balance of ${who(ctx, keys[0])}` };
    case 21:
      return { name: "GetAccountDataSize", args: {}, accounts: named(["mint"], keys), summary: `Query token account size for mint ${short(keys[0])}` };
    case 22:
      return { name: "InitializeImmutableOwner", args: {}, accounts: named(["account"], keys), summary: `Make the owner of ${who(ctx, keys[0])} immutable` };
    default:
      return {
        name: `${is2022 ? "Token2022" : "Token"}Instruction#${tag}`,
        args: {},
        accounts: named([], keys),
        summary: is2022 && tag >= 23 ? `Token-2022 extension instruction #${tag}` : `Token instruction #${tag}`,
      };
  }
}

// ------------------------------------------------------------------- ATA

export function decodeAta(data: Uint8Array, keys: string[], ctx: Context): Omit<DecodedInstruction, "programId" | "program"> {
  const tag = data.length === 0 ? 0 : data[0];
  const names = ["payer", "associatedAccount", "wallet", "mint", "systemProgram", "tokenProgram"];
  const accounts = named(names, keys);
  const mint = keys[3];
  if (keys[1] && mint) {
    const prev = ctx.tokenAccounts.get(keys[1]);
    if (!prev) ctx.tokenAccounts.set(keys[1], { mint, decimals: ctx.mintDecimals.get(mint) ?? NaN, owner: keys[2] });
  }
  if (tag === 2) return { name: "RecoverNested", args: {}, accounts: named(["nestedAta", "nestedMint", "destinationAta", "ownerAta", "ownerMint", "wallet", "tokenProgram"], keys), summary: `Recover tokens from a nested associated token account ${short(keys[0])}` };
  const idem = tag === 1;
  return {
    name: idem ? "CreateIdempotent" : "Create",
    args: {},
    accounts,
    summary: `${idem ? "Create (if missing)" : "Create"} the associated token account ${short(keys[1])} for wallet ${who(ctx, keys[2])} and mint ${short(mint)}, paid by ${who(ctx, keys[0])}`,
  };
}

// ---------------------------------------------------------- Compute Budget

export function decodeComputeBudget(data: Uint8Array): Omit<DecodedInstruction, "programId" | "program" | "accounts"> {
  const r = new Reader(data);
  const tag = r.u8();
  switch (tag) {
    case 1: {
      const bytes = r.u32();
      return { name: "RequestHeapFrame", args: { bytes }, summary: `Request a ${bytes / 1024} KiB heap` };
    }
    case 2: {
      const units = r.u32();
      return { name: "SetComputeUnitLimit", args: { units }, summary: `Set compute unit limit to ${units.toLocaleString("en-US")}` };
    }
    case 3: {
      const microLamports = r.u64();
      return { name: "SetComputeUnitPrice", args: { microLamports }, summary: `Set priority fee to ${microLamports.toLocaleString("en-US")} micro-lamports per compute unit` };
    }
    case 4: {
      const bytes = r.u32();
      return { name: "SetLoadedAccountsDataSizeLimit", args: { bytes }, summary: `Limit loaded account data to ${bytes.toLocaleString("en-US")} bytes` };
    }
    default:
      return { name: `ComputeBudget#${tag}`, args: {}, summary: `Compute budget instruction #${tag} (deprecated or unknown)` };
  }
}

export function decodeMemo(data: Uint8Array, keys: string[]): Omit<DecodedInstruction, "programId" | "program"> {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  return { name: "Memo", args: { text }, accounts: named(keys.map((_, i) => `signer${i}`), keys), summary: `Memo: "${text}"` };
}

export function unknown(data: Uint8Array, keys: string[]): Omit<DecodedInstruction, "programId" | "program"> {
  const hex = toHex(data.subarray(0, 16));
  return {
    name: "Unknown",
    args: { dataHex: toHex(data) },
    accounts: named([], keys),
    summary: `Call with ${data.length} bytes of data (${hex}${data.length > 16 ? "…" : ""}) and ${keys.length} account(s)`,
  };
}
