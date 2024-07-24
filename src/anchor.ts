import bs58 from "bs58";
import { Reader, toHex } from "./bytes.js";
import type { DecodedInstruction, IxAccount } from "./programs.js";

/** Minimal subset of the Anchor 0.30+ IDL spec used for decoding. */
export type IdlType =
  | string
  | { vec: IdlType }
  | { option: IdlType }
  | { coption: IdlType }
  | { array: [IdlType, number] }
  | { defined: { name: string } | string };

export interface IdlField {
  name: string;
  type: IdlType;
}
export interface IdlAccountItem {
  name: string;
  writable?: boolean;
  signer?: boolean;
  accounts?: IdlAccountItem[];
}
export interface Idl {
  address: string;
  metadata: { name: string; version?: string; spec?: string };
  instructions: { name: string; discriminator: number[]; accounts: IdlAccountItem[]; args: IdlField[] }[];
  types?: {
    name: string;
    type:
      | { kind: "struct"; fields?: (IdlField | IdlType)[] }
      | { kind: "enum"; variants: { name: string; fields?: (IdlField | IdlType)[] }[] }
      | { kind: "type"; alias: IdlType };
  }[];
  errors?: { code: number; name: string; msg?: string }[];
}

export function decodeType(r: Reader, t: IdlType, idl: Idl): unknown {
  if (typeof t === "string") {
    switch (t) {
      case "bool":
        return r.u8() !== 0;
      case "u8":
        return r.u8();
      case "i8": {
        const v = r.u8();
        return v > 127 ? v - 256 : v;
      }
      case "u16":
        return r.u16();
      case "i16": {
        const v = r.u16();
        return v > 32767 ? v - 65536 : v;
      }
      case "u32":
        return r.u32();
      case "i32":
        return r.i32();
      case "u64":
        return r.u64();
      case "i64":
        return r.i64();
      case "u128":
        return r.u128();
      case "i128":
        return r.i128();
      case "f32": {
        const b = r.bytes(4);
        return new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true);
      }
      case "f64": {
        const b = r.bytes(8);
        return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
      }
      case "string":
        return r.string();
      case "pubkey":
      case "publicKey":
        return r.pubkey();
      case "bytes":
        return toHex(r.bytes(r.u32()));
      default:
        throw new Error(`unsupported IDL type ${t}`);
    }
  }
  if ("vec" in t) {
    const n = r.u32();
    return Array.from({ length: n }, () => decodeType(r, t.vec, idl));
  }
  if ("option" in t) return r.u8() ? decodeType(r, t.option, idl) : null;
  if ("coption" in t) {
    const tag = r.u32();
    return tag ? decodeType(r, t.coption, idl) : null;
  }
  if ("array" in t) {
    const [inner, n] = t.array;
    if (inner === "u8") return toHex(r.bytes(n));
    return Array.from({ length: n }, () => decodeType(r, inner, idl));
  }
  if ("defined" in t) {
    const name = typeof t.defined === "string" ? t.defined : t.defined.name;
    const def = idl.types?.find((x) => x.name === name);
    if (!def) throw new Error(`type ${name} not found in IDL`);
    const ty = def.type;
    if (ty.kind === "struct") return decodeFields(r, ty.fields ?? [], idl);
    if (ty.kind === "type") return decodeType(r, ty.alias, idl);
    const idx = r.u8();
    const v = ty.variants[idx];
    if (!v) throw new Error(`enum ${name}: bad variant ${idx}`);
    if (!v.fields?.length) return v.name;
    return { [v.name]: decodeFields(r, v.fields, idl) };
  }
  throw new Error(`unsupported IDL type ${JSON.stringify(t)}`);
}

function decodeFields(r: Reader, fields: (IdlField | IdlType)[], idl: Idl): unknown {
  if (fields.length && typeof fields[0] === "object" && fields[0] !== null && "name" in (fields[0] as object)) {
    const out: Record<string, unknown> = {};
    for (const f of fields as IdlField[]) out[f.name] = decodeType(r, f.type, idl);
    return out;
  }
  return (fields as IdlType[]).map((t) => decodeType(r, t, idl));
}

function flattenAccounts(items: IdlAccountItem[], prefix = ""): string[] {
  return items.flatMap((a) => (a.accounts ? flattenAccounts(a.accounts, `${prefix}${a.name}.`) : [`${prefix}${a.name}`]));
}

const eq = (a: Uint8Array, b: number[]) => b.length <= a.length && b.every((x, i) => a[i] === x);

/** Decode an instruction for a program whose IDL we have. Returns null if no discriminator matches. */
export function decodeAnchor(idl: Idl, data: Uint8Array, keys: string[]): Omit<DecodedInstruction, "programId" | "program"> | null {
  const ix = idl.instructions.find((i) => eq(data, i.discriminator));
  if (!ix) {
    // Anchor event emitted via CPI (emit_cpi!) starts with the event-ix tag.
    if (eq(data, [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]))
      return { name: "AnchorEvent", args: {}, accounts: [], summary: `${idl.metadata.name}: emitted an event (self-CPI)` };
    return null;
  }
  const names = flattenAccounts(ix.accounts);
  const accounts: IxAccount[] = keys.map((pubkey, i) => ({ name: names[i] ?? `remaining${i - names.length}`, pubkey }));
  const r = new Reader(data.subarray(ix.discriminator.length));
  const args: Record<string, unknown> = {};
  try {
    for (const a of ix.args) args[a.name] = decodeType(r, a.type, idl);
  } catch (e) {
    return { name: ix.name, args, accounts, summary: `${idl.metadata.name}.${ix.name}`, error: `could not decode args: ${(e as Error).message}` };
  }
  const argStr = Object.entries(args)
    .map(([k, v]) => `${k}=${fmtValue(v)}`)
    .join(", ");
  return { name: ix.name, args, accounts, summary: `${idl.metadata.name}.${ix.name}(${argStr})` };
}

export function fmtValue(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return JSON.stringify(v);
  return JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
}

/** Map an Anchor custom error code to its IDL name/message. */
export function anchorError(idl: Idl, code: number): string | undefined {
  const e = idl.errors?.find((x) => x.code === code);
  return e ? `${e.name}${e.msg ? `: ${e.msg}` : ""}` : undefined;
}

export const isPubkey = (s: string) => {
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
};
