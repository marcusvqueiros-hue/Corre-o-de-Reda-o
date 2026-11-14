import { CryptoFormatError, DecryptionError } from "./errors";
import { type Bytes, fromB64u, randomBytes, toB64u, utf8 } from "./encoding";

/**
 * AES-256-GCM via Web Crypto. Formato selado, versionado:  "1.<iv b64url>.<ciphertext+tag b64url>"
 *
 * - IV de 96 bits, aleatório (crypto.getRandomValues) em CADA operação; nunca é aceito de fora.
 *   Com IV aleatório de 96 bits o limite seguro é ~2^32 mensagens por chave (NIST SP 800-38D);
 *   um cofre pessoal fica muitas ordens de grandeza abaixo.
 * - Tag de autenticação de 128 bits: a decifragem só devolve dados se a autenticidade for válida.
 * - AAD vincula o texto cifrado ao seu contexto (vault, registro, função), impedindo troca de blobs.
 */
export const SEAL_VERSION = "1";
export const IV_BYTES = 12;
const TAG_BYTES = 16;

export async function importAesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  if (raw.length !== 32) throw new CryptoFormatError("Chave deve ter 256 bits.");
  return crypto.subtle.importKey("raw", raw as Bytes, { name: "AES-GCM" }, false, usages);
}

export async function seal(key: CryptoKey, plaintext: Uint8Array, aad: string): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(aad), tagLength: TAG_BYTES * 8 },
    key,
    plaintext as Bytes,
  );
  return `${SEAL_VERSION}.${toB64u(iv)}.${toB64u(new Uint8Array(ct))}`;
}

export async function open(key: CryptoKey, sealed: string, aad: string): Promise<Bytes> {
  const parts = sealed.split(".");
  if (parts.length !== 3 || parts[0] !== SEAL_VERSION) throw new CryptoFormatError();
  const iv = fromB64u(parts[1] ?? "");
  const ct = fromB64u(parts[2] ?? "");
  if (iv.length !== IV_BYTES || ct.length < TAG_BYTES) throw new CryptoFormatError();
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: utf8(aad), tagLength: TAG_BYTES * 8 },
      key,
      ct,
    );
    return new Uint8Array(pt);
  } catch {
    throw new DecryptionError();
  }
}
