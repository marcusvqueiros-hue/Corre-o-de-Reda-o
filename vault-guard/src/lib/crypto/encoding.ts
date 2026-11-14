import { CryptoFormatError } from "./errors";

export type Bytes = Uint8Array<ArrayBuffer>;

const B64U = /^[A-Za-z0-9_-]*$/;

/** Apenas codificação (não é criptografia): base64url sem padding. */
export function toB64u(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(text: string): Bytes {
  if (!B64U.test(text) || text.length % 4 === 1) throw new CryptoFormatError();
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  let bin: string;
  try {
    bin = atob(padded);
  } catch {
    throw new CryptoFormatError();
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8(text: string): Bytes {
  // new Uint8Array(...) garante um array do realm atual (o libsodium valida com instanceof)
  return new Uint8Array(new TextEncoder().encode(text));
}

export function randomBytes(length: number): Bytes {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}
