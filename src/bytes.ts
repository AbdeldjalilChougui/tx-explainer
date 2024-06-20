import bs58 from "bs58";

export class Reader {
  private view: DataView;
  pos = 0;
  constructor(public buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get remaining(): number {
    return this.buf.length - this.pos;
  }
  private need(n: number) {
    if (this.pos + n > this.buf.length) throw new Error(`unexpected end of data (need ${n} at ${this.pos})`);
  }
  u8(): number {
    this.need(1);
    return this.buf[this.pos++];
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }
  i64(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return v;
  }
  u128(): bigint {
    const lo = this.u64();
    const hi = this.u64();
    return (hi << 64n) | lo;
  }
  i128(): bigint {
    const v = this.u128();
    return v >= 1n << 127n ? v - (1n << 128n) : v;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  pubkey(): string {
    return bs58.encode(this.bytes(32));
  }
  /** Solana "compact-u16" (shortvec) length prefix. */
  shortvec(): number {
    let len = 0;
    for (let i = 0; i < 3; i++) {
      const b = this.u8();
      len |= (b & 0x7f) << (7 * i);
      if ((b & 0x80) === 0) return len;
    }
    throw new Error("invalid compact-u16");
  }
  /** Borsh string: u32 length + UTF-8. */
  string(): string {
    return new TextDecoder().decode(this.bytes(this.u32()));
  }
}

export function fromBase64(s: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Accept base64 or base58 and return bytes. */
export function decodeRawTx(input: string): Uint8Array {
  const s = input.trim();
  if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) {
    try {
      return bs58.decode(s);
    } catch {
      /* fall through */
    }
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return fromBase64(s.replace(/\s+/g, ""));
  throw new Error("input is neither base58 nor base64");
}

/** Format an integer amount with `decimals` decimals, trimming trailing zeros. */
export function formatUnits(amount: bigint, decimals: number): string {
  const neg = amount < 0n;
  let a = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  let frac = (a % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${w}${frac ? "." + frac : ""}`;
}

export const LAMPORTS_PER_SOL = 9;

export function sol(lamports: bigint | number): string {
  return `${formatUnits(BigInt(lamports), LAMPORTS_PER_SOL)} SOL`;
}

export function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}
