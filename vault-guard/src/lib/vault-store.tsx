"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import {
  DEFAULT_KDF, DecryptionError, type KdfParams, type RecordPayload, type VaultMeta,
  createVault, decryptRecord, encryptRecord, resetMasterPasswordWithRecoveryKey, unlockVault,
} from "./crypto";
import { useAutoLock, readLockMinutes, writeLockMinutes } from "./autolock";
import { clearClipboardNow, copySecret } from "./clipboard";
import { rate, type Strength } from "./strength";
import { LocalStorageRepository, type StoredRecord, type VaultRepository } from "./repository";

export type VaultStatus = "loading" | "empty" | "locked" | "unlocked";

/** Só metadados de exibição. A senha NUNCA fica no estado da interface. */
export interface RecordMeta {
  id: string;
  name: string;
  url: string;
  username: string;
  category: string;
  strength: Strength;
  reused: boolean;
  unreadable: boolean;
  updatedAt: string;
}

export const masterPasswordSchema = z.string().min(12, "Use pelo menos 12 caracteres.").max(256);

interface VaultApi {
  status: VaultStatus;
  mode: "local" | "cloud";
  metas: RecordMeta[];
  meta: VaultMeta | null;
  lockMinutes: number;
  setLockMinutes(m: number): void;
  create(masterPassword: string): Promise<{ recoveryKey: string }>;
  unlock(masterPassword: string): Promise<boolean>;
  unlockWithRecovery(recoveryKey: string, newMasterPassword: string): Promise<boolean>;
  lock(): void;
  getPayload(id: string): Promise<RecordPayload | null>;
  save(payload: unknown, id?: string): Promise<string>;
  remove(id: string): Promise<void>;
  copyPassword(id: string): Promise<"copied" | "denied" | "error">;
  failedAttempts: number;
  retryInMs: number;
}

const Ctx = createContext<VaultApi | null>(null);
export function useVault(): VaultApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useVault fora do VaultProvider");
  return v;
}

/** Espera crescente após erros de senha (defesa local; o custo do Argon2id já limita ataques offline). */
const backoffMs = (fails: number) => (fails < 5 ? 0 : Math.min(300_000, 2 ** (fails - 5) * 5_000));

export function VaultProvider({
  children, repository, kdf = DEFAULT_KDF,
}: { children: ReactNode; repository?: VaultRepository; kdf?: KdfParams }) {
  const repo = useMemo<VaultRepository>(() => repository ?? new LocalStorageRepository(), [repository]);
  const [status, setStatus] = useState<VaultStatus>("loading");
  const [meta, setMeta] = useState<VaultMeta | null>(null);
  const [metas, setMetas] = useState<RecordMeta[]>([]);
  const [lockMinutes, setLockMinutesState] = useState(5);
  const [failedAttempts, setFailed] = useState(0);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(0);

  const dek = useRef<CryptoKey | null>(null);
  const stored = useRef(new Map<string, StoredRecord>());
  const epoch = useRef(0); // incrementa ao bloquear: invalida operações em andamento

  useEffect(() => {
    let alive = true;
    repo.getVault().then((m) => {
      if (!alive) return;
      setLockMinutesState(readLockMinutes());
      setMeta(m);
      setStatus(m ? "locked" : "empty");
    }).catch(() => alive && setStatus("empty"));
    return () => { alive = false; };
  }, [repo]);

  useEffect(() => {
    if (retryAt <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [retryAt]);

  const lock = useCallback(() => {
    epoch.current++;
    dek.current = null;
    stored.current = new Map();
    setMetas([]);
    setStatus((s) => (s === "unlocked" ? "locked" : s));
    void clearClipboardNow();
  }, []);

  useAutoLock(status === "unlocked", lockMinutes, lock);

  const rebuild = useCallback(async (key: CryptoKey, vaultId: string, ep: number) => {
    const entries: { s: StoredRecord; p: RecordPayload | null }[] = [];
    const counts = new Map<string, number>();
    for (const s of stored.current.values()) {
      let p: RecordPayload | null = null;
      try { p = await decryptRecord(key, { vaultId, recordId: s.id }, s.sealed); } catch { p = null; }
      if (ep !== epoch.current) return; // bloqueado no meio do caminho
      if (p) counts.set(p.password, (counts.get(p.password) ?? 0) + 1);
      entries.push({ s, p });
    }
    const out: RecordMeta[] = entries.map(({ s, p }) => ({
      id: s.id,
      name: p?.name ?? "Registro ilegível",
      url: p?.url ?? "",
      username: p?.username ?? "",
      category: p?.category ?? "—",
      strength: p ? rate(p.password) : "weak",
      reused: p ? (counts.get(p.password) ?? 0) > 1 : false,
      unreadable: !p,
      updatedAt: s.updatedAt,
    }));
    entries.length = 0;
    counts.clear(); // descarta as senhas usadas só no cálculo
    out.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    setMetas(out);
  }, []);

  const open = useCallback(async (key: CryptoKey, m: VaultMeta) => {
    const ep = ++epoch.current;
    dek.current = key;
    const list = await repo.listRecords();
    stored.current = new Map(list.map((r) => [r.id, r]));
    await rebuild(key, m.vaultId, ep);
    if (ep !== epoch.current) return;
    setMeta(m);
    setFailed(0);
    setStatus("unlocked");
  }, [repo, rebuild]);

  const api = useMemo<VaultApi>(() => {
    const getPayload = async (id: string): Promise<RecordPayload | null> => {
      const key = dek.current, s = stored.current.get(id), ep = epoch.current;
      if (!key || !s || !meta) return null;
      try {
        const p = await decryptRecord(key, { vaultId: meta.vaultId, recordId: id }, s.sealed);
        return ep === epoch.current ? p : null;
      } catch { return null; }
    };
    return {
    status, mode: repo.mode, metas, meta, lockMinutes, failedAttempts,
    retryInMs: Math.max(0, retryAt - now),
    setLockMinutes(m) { setLockMinutesState(m); writeLockMinutes(m); },

    async create(masterPassword) {
      masterPasswordSchema.parse(masterPassword);
      const { vault, recoveryKey } = await createVault(masterPassword, kdf);
      await repo.saveVault(vault.meta);
      await open(vault.dek, vault.meta);
      return { recoveryKey };
    },

    async unlock(masterPassword) {
      if (!meta) return false;
      if (retryAt > Date.now()) return false;
      try {
        const v = await unlockVault(meta, masterPassword);
        await open(v.dek, v.meta);
        return true;
      } catch (e) {
        if (!(e instanceof DecryptionError)) throw e;
        const n = failedAttempts + 1;
        setFailed(n);
        const wait = backoffMs(n);
        if (wait) { setRetryAt(Date.now() + wait); setNow(Date.now()); }
        return false;
      }
    },

    async unlockWithRecovery(recoveryKey, newMasterPassword) {
      if (!meta) return false;
      masterPasswordSchema.parse(newMasterPassword);
      try {
        const next = await resetMasterPasswordWithRecoveryKey(meta, recoveryKey, newMasterPassword, kdf);
        await repo.saveVault(next);
        const v = await unlockVault(next, newMasterPassword);
        await open(v.dek, v.meta);
        return true;
      } catch (e) {
        if (e instanceof DecryptionError) return false;
        throw e;
      }
    },

    lock,

    getPayload,

    async save(payload, id) {
      const key = dek.current, ep = epoch.current;
      if (!key || !meta) throw new Error("Cofre bloqueado.");
      const recordId = id ?? crypto.randomUUID();
      const sealed = await encryptRecord(key, { vaultId: meta.vaultId, recordId }, payload);
      if (ep !== epoch.current) throw new Error("Cofre bloqueado.");
      const rec: StoredRecord = { id: recordId, sealed, updatedAt: new Date().toISOString() };
      await repo.putRecord(rec); // apenas o conteúdo cifrado sai do dispositivo
      stored.current.set(recordId, rec);
      await rebuild(key, meta.vaultId, ep);
      return recordId;
    },

    async remove(id) {
      const key = dek.current, ep = epoch.current;
      if (!key || !meta) throw new Error("Cofre bloqueado.");
      await repo.deleteRecord(id);
      stored.current.delete(id);
      await rebuild(key, meta.vaultId, ep);
    },

    async copyPassword(id) {
      const p = await getPayload(id);
      if (!p) return "error";
      const r = await copySecret(p.password);
      return r.ok ? "copied" : "denied";
    },
    };
  }, [status, repo, metas, meta, lockMinutes, failedAttempts, retryAt, now, kdf, open, rebuild, lock]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

