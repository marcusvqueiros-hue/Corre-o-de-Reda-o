import { type Bytes, fromB64u, randomBytes, toB64u, utf8 } from "./encoding";
import { DecryptionError } from "./errors";
import { importAesKey, open, seal } from "./aead";
import { DEFAULT_KDF, type KdfParams, assertKdfParams } from "./params";
import { type VaultMeta, vaultMetaSchema } from "./schema";
import { getSodium } from "./sodium";

/**
 * Hierarquia de chaves (Zero Knowledge):
 *
 *   senha mestra --Argon2id(salt, params)--> KEK  --AES-GCM--> DEK embrulhada ("wrappedDekMaster")
 *   chave de recuperação (256 bits aleatórios) --HKDF-SHA256--> RK --AES-GCM--> a MESMA DEK ("wrappedDekRecovery")
 *   DEK (256 bits aleatórios) cifra cada registro.
 *
 * - A senha de login do Supabase não participa de nada aqui.
 * - Trocar a senha mestra só reembrulha a DEK (não recifra os registros).
 * - Sem a senha mestra e sem a chave de recuperação, não há como recuperar os dados. Não há backdoor.
 * - A DEK ativa é um CryptoKey NÃO extraível: o JS da página não consegue lê-la; só usá-la.
 */

export interface UnlockedVault {
  meta: VaultMeta;
  dek: CryptoKey;
}

const aadDek = (vaultId: string, role: "master" | "recovery") => `vg/dek/v1/${vaultId}/${role}`;

function normalizePassword(password: string): Bytes {
  return utf8(password.normalize("NFKC"));
}

async function deriveMasterKek(password: string, salt: Bytes, kdf: KdfParams): Promise<CryptoKey> {
  const sodium = await getSodium();
  const pw = normalizePassword(password);
  let raw: Uint8Array | null = null;
  try {
    raw = sodium.crypto_pwhash(32, pw, salt, kdf.opslimit, kdf.memlimit, sodium.crypto_pwhash_ALG_ARGON2ID13);
    return await importAesKey(raw, ["encrypt", "decrypt"]);
  } finally {
    pw.fill(0);
    raw?.fill(0);
  }
}

const RECOVERY_RE = /^[0-9A-F]{64}$/;

export function formatRecoveryKey(raw: Uint8Array): string {
  const hex = Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return hex.match(/.{4}/g)!.join("-");
}

export function parseRecoveryKey(text: string): Bytes | null {
  const hex = text.replace(/[\s-]/g, "").toUpperCase();
  if (!RECOVERY_RE.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function deriveRecoveryKek(recoveryRaw: Uint8Array, vaultId: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", recoveryRaw as Bytes, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8(vaultId), info: utf8("vault-guard/recovery-wrap/v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function wrapDek(kek: CryptoKey, rawDek: Uint8Array, vaultId: string, role: "master" | "recovery") {
  return seal(kek, rawDek, aadDek(vaultId, role));
}

async function toDekKey(raw: Uint8Array): Promise<CryptoKey> {
  try {
    return await importAesKey(raw, ["encrypt", "decrypt"]);
  } finally {
    raw.fill(0);
  }
}

/** Cria um cofre novo. Devolve a chave de recuperação UMA vez: exiba-a e não a guarde. */
export async function createVault(
  masterPassword: string,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<{ vault: UnlockedVault; recoveryKey: string }> {
  const params = assertKdfParams(kdf);
  const vaultId = crypto.randomUUID();
  const salt = randomBytes(16);
  const rawDek = randomBytes(32);
  const recoveryRaw = randomBytes(32);
  try {
    const masterKek = await deriveMasterKek(masterPassword, salt, params);
    const recoveryKek = await deriveRecoveryKek(recoveryRaw, vaultId);
    const meta: VaultMeta = {
      version: 1,
      vaultId,
      salt: toB64u(salt),
      kdf: params,
      encryption: "aes-256-gcm",
      wrappedDekMaster: await wrapDek(masterKek, rawDek, vaultId, "master"),
      wrappedDekRecovery: await wrapDek(recoveryKek, rawDek, vaultId, "recovery"),
    };
    const recoveryKey = formatRecoveryKey(recoveryRaw);
    return { vault: { meta, dek: await toDekKey(rawDek) }, recoveryKey };
  } finally {
    recoveryRaw.fill(0);
    rawDek.fill(0);
  }
}

async function unwrapWithMaster(metaInput: unknown, password: string) {
  const meta = vaultMetaSchema.parse(metaInput); // valida e impõe limites do KDF
  const kek = await deriveMasterKek(password, fromB64u(meta.salt), meta.kdf);
  const raw = await open(kek, meta.wrappedDekMaster, aadDek(meta.vaultId, "master"));
  return { meta, raw };
}

async function unwrapWithRecovery(metaInput: unknown, recoveryKey: string) {
  const meta = vaultMetaSchema.parse(metaInput);
  const recoveryRaw = parseRecoveryKey(recoveryKey);
  if (!recoveryRaw || !meta.wrappedDekRecovery) throw new DecryptionError();
  try {
    const kek = await deriveRecoveryKek(recoveryRaw, meta.vaultId);
    const raw = await open(kek, meta.wrappedDekRecovery, aadDek(meta.vaultId, "recovery"));
    return { meta, raw };
  } finally {
    recoveryRaw.fill(0);
  }
}

export async function unlockVault(meta: unknown, masterPassword: string): Promise<UnlockedVault> {
  const { meta: m, raw } = await unwrapWithMaster(meta, masterPassword);
  return { meta: m, dek: await toDekKey(raw) };
}

export async function unlockVaultWithRecoveryKey(meta: unknown, recoveryKey: string): Promise<UnlockedVault> {
  const { meta: m, raw } = await unwrapWithRecovery(meta, recoveryKey);
  return { meta: m, dek: await toDekKey(raw) };
}

async function rewrapMaster(meta: VaultMeta, raw: Bytes, newPassword: string, kdf: KdfParams): Promise<VaultMeta> {
  const params = assertKdfParams(kdf);
  const salt = randomBytes(16); // salt novo a cada troca
  try {
    const kek = await deriveMasterKek(newPassword, salt, params);
    return {
      ...meta,
      salt: toB64u(salt),
      kdf: params,
      wrappedDekMaster: await wrapDek(kek, raw, meta.vaultId, "master"),
    };
  } finally {
    raw.fill(0);
  }
}

/**
 * Troca a senha mestra: novo salt, novo KEK, DEK reembrulhada. Os registros NÃO são recifrados e a
 * chave de recuperação continua válida (ela está vinculada ao vaultId, não ao salt).
 */
export async function changeMasterPassword(
  meta: unknown,
  currentPassword: string,
  newPassword: string,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<VaultMeta> {
  const { meta: m, raw } = await unwrapWithMaster(meta, currentPassword);
  return rewrapMaster(m, raw, newPassword, kdf);
}

/** "Esqueci a senha mestra": a chave de recuperação define uma senha mestra nova. */
export async function resetMasterPasswordWithRecoveryKey(
  meta: unknown,
  recoveryKey: string,
  newPassword: string,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<VaultMeta> {
  const { meta: m, raw } = await unwrapWithRecovery(meta, recoveryKey);
  return rewrapMaster(m, raw, newPassword, kdf);
}

/** Gera uma chave de recuperação nova (a antiga deixa de funcionar). Exige a senha mestra. */
export async function rotateRecoveryKey(
  meta: unknown,
  masterPassword: string,
): Promise<{ meta: VaultMeta; recoveryKey: string }> {
  const { meta: m, raw } = await unwrapWithMaster(meta, masterPassword);
  const recoveryRaw = randomBytes(32);
  try {
    const kek = await deriveRecoveryKek(recoveryRaw, m.vaultId);
    const next: VaultMeta = { ...m, wrappedDekRecovery: await wrapDek(kek, raw, m.vaultId, "recovery") };
    return { meta: next, recoveryKey: formatRecoveryKey(recoveryRaw) };
  } finally {
    raw.fill(0);
    recoveryRaw.fill(0);
  }
}
