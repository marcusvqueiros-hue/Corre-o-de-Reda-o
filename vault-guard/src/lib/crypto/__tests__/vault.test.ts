import { beforeAll, describe, expect, it } from "vitest";
import {
  changeMasterPassword,
  createVault,
  decryptRecord,
  encryptRecord,
  resetMasterPasswordWithRecoveryKey,
  rotateRecoveryKey,
  unlockVault,
  unlockVaultWithRecoveryKey,
} from "..";
import { DecryptionError, KdfParamsError } from "../errors";
import { DEFAULT_KDF, KDF_LIMITS } from "../params";
import { toB64u, randomBytes } from "../encoding";

// Parâmetros mínimos aceitos, só para acelerar os testes. Um teste usa o padrão de produção.
const FAST = { ...DEFAULT_KDF, opslimit: KDF_LIMITS.opsMin, memlimit: KDF_LIMITS.memMin };
const PW = "correct horse battery staple ✓";
const sample = { name: "GitHub", url: "https://github.com", username: "ana@exemplo.com", password: "Tr0ub4dor&3-xyz", category: "Trabalho", notes: "nota" };

describe("cofre: criação e desbloqueio", () => {
  let created: Awaited<ReturnType<typeof createVault>>;
  beforeAll(async () => {
    created = await createVault(PW, FAST);
  });

  it("desbloqueia com a senha certa e decifra registros", async () => {
    const { vault } = created;
    const ctx = { vaultId: vault.meta.vaultId, recordId: crypto.randomUUID() };
    const sealed = await encryptRecord(vault.dek, ctx, sample);
    const unlocked = await unlockVault(vault.meta, PW);
    expect(await decryptRecord(unlocked.dek, ctx, sealed)).toEqual(sample);
  });

  it("a DEK é uma CryptoKey não extraível", async () => {
    expect(created.vault.dek.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", created.vault.dek)).rejects.toThrow();
  });

  it("senha errada falha com erro genérico", async () => {
    await expect(unlockVault(created.vault.meta, PW + "x")).rejects.toThrow(DecryptionError);
  });

  it("metadados do servidor não contêm senha nem chaves em claro", () => {
    const json = JSON.stringify(created.vault.meta);
    expect(json).not.toContain(PW);
    expect(json).not.toContain(created.recoveryKey);
    expect(json).not.toContain(created.recoveryKey.replace(/-/g, ""));
  });

  it("rejeita downgrade/DoS dos parâmetros KDF vindos do servidor", async () => {
    const m = created.vault.meta;
    const weak = { ...m, kdf: { ...m.kdf, memlimit: 8192, opslimit: 1 } };
    await expect(unlockVault(weak, PW)).rejects.toThrow();
    const huge = { ...m, kdf: { ...m.kdf, memlimit: 4 * 1024 ** 3 } };
    await expect(unlockVault(huge, PW)).rejects.toThrow();
    const otherAlg = { ...m, kdf: { ...m.kdf, algorithm: "sha256" } };
    await expect(unlockVault(otherAlg, PW)).rejects.toThrow();
    await expect(createVault(PW, { ...FAST, opslimit: 1 })).rejects.toThrow(KdfParamsError);
  });

  it("parâmetros KDF adulterados (válidos, mas diferentes) não abrem o cofre", async () => {
    const m = created.vault.meta;
    await expect(unlockVault({ ...m, kdf: { ...m.kdf, opslimit: m.kdf.opslimit + 1 } }, PW)).rejects.toThrow(DecryptionError);
  });

  it("salt trocado ou vaultId trocado invalidam o desbloqueio", async () => {
    const m = created.vault.meta;
    await expect(unlockVault({ ...m, salt: toB64u(randomBytes(16)) }, PW)).rejects.toThrow(DecryptionError);
    await expect(unlockVault({ ...m, vaultId: crypto.randomUUID() }, PW)).rejects.toThrow(DecryptionError);
  });

  it("não aceita embrulho de recuperação no lugar do embrulho mestre", async () => {
    const m = created.vault.meta;
    await expect(unlockVault({ ...m, wrappedDekMaster: m.wrappedDekRecovery }, PW)).rejects.toThrow(DecryptionError);
  });

  it("dois cofres com a mesma senha têm salts e blobs diferentes", async () => {
    const other = await createVault(PW, FAST);
    expect(other.vault.meta.salt).not.toBe(created.vault.meta.salt);
    expect(other.vault.meta.wrappedDekMaster).not.toBe(created.vault.meta.wrappedDekMaster);
    expect(other.recoveryKey).not.toBe(created.recoveryKey);
  });

  it("parâmetros padrão de produção funcionam (Argon2id 64 MiB, 3 iterações)", async () => {
    const t0 = performance.now();
    const c = await createVault("senha-longa-de-teste-123", DEFAULT_KDF);
    await unlockVault(c.vault.meta, "senha-longa-de-teste-123");
    console.info(`Argon2id padrão: create+unlock em ${Math.round(performance.now() - t0)} ms (Node/WASM)`);
    expect(c.vault.meta.kdf.memlimit).toBe(64 * 1024 * 1024);
  });
});

describe("registros", () => {
  it("o AAD impede trocar registro ou cofre", async () => {
    const { vault } = await createVault(PW, FAST);
    const ctx = { vaultId: vault.meta.vaultId, recordId: crypto.randomUUID() };
    const sealed = await encryptRecord(vault.dek, ctx, sample);
    await expect(decryptRecord(vault.dek, { ...ctx, recordId: crypto.randomUUID() }, sealed)).rejects.toThrow(DecryptionError);
    await expect(decryptRecord(vault.dek, { ...ctx, vaultId: crypto.randomUUID() }, sealed)).rejects.toThrow(DecryptionError);
  });

  it("cifra o registro inteiro: nenhum campo aparece em claro", async () => {
    const { vault } = await createVault(PW, FAST);
    const ctx = { vaultId: vault.meta.vaultId, recordId: crypto.randomUUID() };
    const sealed = await encryptRecord(vault.dek, ctx, sample);
    for (const v of Object.values(sample)) expect(sealed).not.toContain(v);
  });

  it("valida a entrada com Zod", async () => {
    const { vault } = await createVault(PW, FAST);
    const ctx = { vaultId: vault.meta.vaultId, recordId: crypto.randomUUID() };
    await expect(encryptRecord(vault.dek, ctx, { ...sample, password: "" })).rejects.toThrow();
    await expect(encryptRecord(vault.dek, ctx, { ...sample, name: "" })).rejects.toThrow();
    await expect(encryptRecord(vault.dek, ctx, "texto")).rejects.toThrow();
  });
});

describe("troca de senha e recuperação", () => {
  it("trocar a senha mestra: antiga falha, nova funciona, registros continuam legíveis, recuperação segue válida", async () => {
    const { vault, recoveryKey } = await createVault(PW, FAST);
    const ctx = { vaultId: vault.meta.vaultId, recordId: crypto.randomUUID() };
    const sealed = await encryptRecord(vault.dek, ctx, sample);

    const next = await changeMasterPassword(vault.meta, PW, "nova senha mestra 456", FAST);
    expect(next.salt).not.toBe(vault.meta.salt);
    await expect(unlockVault(next, PW)).rejects.toThrow(DecryptionError);
    const u = await unlockVault(next, "nova senha mestra 456");
    expect(await decryptRecord(u.dek, ctx, sealed)).toEqual(sample);
    const r = await unlockVaultWithRecoveryKey(next, recoveryKey);
    expect(await decryptRecord(r.dek, ctx, sealed)).toEqual(sample);
    await expect(changeMasterPassword(vault.meta, "errada", "x".repeat(12), FAST)).rejects.toThrow(DecryptionError);
  });

  it("a chave de recuperação abre o cofre; formatação livre é aceita; chave errada falha", async () => {
    const { vault, recoveryKey } = await createVault(PW, FAST);
    expect(recoveryKey).toMatch(/^([0-9A-F]{4}-){15}[0-9A-F]{4}$/);
    await unlockVaultWithRecoveryKey(vault.meta, recoveryKey.toLowerCase().replace(/-/g, " "));
    const wrong = (recoveryKey.startsWith("0") ? "1" : "0") + recoveryKey.slice(1);
    await expect(unlockVaultWithRecoveryKey(vault.meta, wrong)).rejects.toThrow(DecryptionError);
    await expect(unlockVaultWithRecoveryKey(vault.meta, "curta")).rejects.toThrow(DecryptionError);
  });

  it("'esqueci a senha mestra': a recuperação define senha nova sem perder dados", async () => {
    const { vault, recoveryKey } = await createVault(PW, FAST);
    const ctx = { vaultId: vault.meta.vaultId, recordId: crypto.randomUUID() };
    const sealed = await encryptRecord(vault.dek, ctx, sample);
    const next = await resetMasterPasswordWithRecoveryKey(vault.meta, recoveryKey, "senha totalmente nova 789", FAST);
    const u = await unlockVault(next, "senha totalmente nova 789");
    expect(await decryptRecord(u.dek, ctx, sealed)).toEqual(sample);
    await expect(unlockVault(next, PW)).rejects.toThrow(DecryptionError);
  });

  it("rotacionar a chave de recuperação invalida a antiga", async () => {
    const { vault, recoveryKey } = await createVault(PW, FAST);
    const rotated = await rotateRecoveryKey(vault.meta, PW);
    expect(rotated.recoveryKey).not.toBe(recoveryKey);
    await expect(unlockVaultWithRecoveryKey(rotated.meta, recoveryKey)).rejects.toThrow(DecryptionError);
    await unlockVaultWithRecoveryKey(rotated.meta, rotated.recoveryKey);
  });

  it("sem chave de recuperação configurada, a recuperação falha (sem backdoor)", async () => {
    const { vault, recoveryKey } = await createVault(PW, FAST);
    await expect(unlockVaultWithRecoveryKey({ ...vault.meta, wrappedDekRecovery: null }, recoveryKey)).rejects.toThrow(DecryptionError);
  });
});
