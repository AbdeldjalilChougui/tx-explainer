import bs58 from "bs58";
import { Reader } from "./bytes.js";

export interface CompiledInstruction {
  programIdIndex: number;
  accounts: number[];
  data: Uint8Array;
}

export interface LookupRef {
  table: string;
  writable: number[];
  readonly: number[];
}

export interface ParsedMessage {
  version: "legacy" | 0;
  numRequiredSignatures: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
  staticKeys: string[];
  recentBlockhash: string;
  instructions: CompiledInstruction[];
  lookups: LookupRef[];
}

export interface ParsedTransaction {
  signatures: string[];
  message: ParsedMessage;
}

export function parseMessage(r: Reader): ParsedMessage {
  let version: "legacy" | 0 = "legacy";
  const first = r.u8();
  let numRequiredSignatures = first;
  if (first & 0x80) {
    const v = first & 0x7f;
    if (v !== 0) throw new Error(`unsupported message version ${v}`);
    version = 0;
    numRequiredSignatures = r.u8();
  }
  const numReadonlySigned = r.u8();
  const numReadonlyUnsigned = r.u8();
  const nKeys = r.shortvec();
  const staticKeys = Array.from({ length: nKeys }, () => r.pubkey());
  const recentBlockhash = bs58.encode(r.bytes(32));
  const nIx = r.shortvec();
  const instructions: CompiledInstruction[] = [];
  for (let i = 0; i < nIx; i++) {
    const programIdIndex = r.u8();
    const accounts = Array.from(r.bytes(r.shortvec()));
    const data = r.bytes(r.shortvec()).slice();
    instructions.push({ programIdIndex, accounts, data });
  }
  const lookups: LookupRef[] = [];
  if (version === 0) {
    const n = r.shortvec();
    for (let i = 0; i < n; i++) {
      const table = r.pubkey();
      const writable = Array.from(r.bytes(r.shortvec()));
      const readonly = Array.from(r.bytes(r.shortvec()));
      lookups.push({ table, writable, readonly });
    }
  }
  return {
    version,
    numRequiredSignatures,
    numReadonlySigned,
    numReadonlyUnsigned,
    staticKeys,
    recentBlockhash,
    instructions,
    lookups,
  };
}

/** Parse a wire-format transaction (signatures + message). */
export function parseTransaction(bytes: Uint8Array): ParsedTransaction {
  const r = new Reader(bytes);
  const nSig = r.shortvec();
  const signatures = Array.from({ length: nSig }, () => bs58.encode(r.bytes(64)));
  const message = parseMessage(r);
  if (r.remaining !== 0) throw new Error(`${r.remaining} trailing bytes after message`);
  return { signatures, message };
}

export interface AccountKey {
  pubkey: string;
  signer: boolean;
  writable: boolean;
  /** "static" or the lookup table it came from */
  source: "static" | "lookup" | "unresolved";
}

/**
 * Full account list in index order: static keys, then lookup-table writable
 * keys, then lookup-table readonly keys. Without `loaded` (from RPC meta),
 * table entries are shown as placeholders.
 */
export function accountKeys(
  m: ParsedMessage,
  loaded?: { writable: string[]; readonly: string[] },
): AccountKey[] {
  const n = m.staticKeys.length;
  const keys: AccountKey[] = m.staticKeys.map((pubkey, i) => {
    const signer = i < m.numRequiredSignatures;
    const writable = signer
      ? i < m.numRequiredSignatures - m.numReadonlySigned
      : i < n - m.numReadonlyUnsigned;
    return { pubkey, signer, writable, source: "static" as const };
  });
  const placeholder = (kind: string) =>
    m.lookups.flatMap((l) => (kind === "w" ? l.writable : l.readonly).map((idx) => `${l.table}[${idx}]`));
  const w = loaded?.writable ?? placeholder("w");
  const ro = loaded?.readonly ?? placeholder("r");
  const src = loaded ? ("lookup" as const) : ("unresolved" as const);
  for (const pubkey of w) keys.push({ pubkey, signer: false, writable: true, source: src });
  for (const pubkey of ro) keys.push({ pubkey, signer: false, writable: false, source: src });
  return keys;
}
