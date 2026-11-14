import type { VaultMeta } from "./crypto";

/** Só texto cifrado e metadados do cofre passam por aqui. */
export interface StoredRecord {
  id: string;
  sealed: string;
  updatedAt: string;
}

export interface VaultRepository {
  readonly mode: "local" | "cloud";
  getVault(): Promise<VaultMeta | null>;
  saveVault(meta: VaultMeta): Promise<void>;
  listRecords(): Promise<StoredRecord[]>;
  putRecord(rec: StoredRecord): Promise<void>;
  deleteRecord(id: string): Promise<void>;
}

export class MemoryRepository implements VaultRepository {
  readonly mode = "local" as const;
  meta: VaultMeta | null = null;
  records = new Map<string, StoredRecord>();
  async getVault() { return this.meta; }
  async saveVault(meta: VaultMeta) { this.meta = meta; }
  async listRecords() { return [...this.records.values()]; }
  async putRecord(rec: StoredRecord) { this.records.set(rec.id, rec); }
  async deleteRecord(id: string) { this.records.delete(id); }
}

/**
 * Modo local (sem login nem sincronização): guarda no navegador SOMENTE o que já está cifrado.
 * A chave nunca é gravada. Limpar os dados do site apaga o cofre.
 */
export class LocalStorageRepository implements VaultRepository {
  readonly mode = "local" as const;
  private static META = "vg.v1.meta";
  private static RECS = "vg.v1.records";
  async getVault() {
    const raw = localStorage.getItem(LocalStorageRepository.META);
    return raw ? (JSON.parse(raw) as VaultMeta) : null;
  }
  async saveVault(meta: VaultMeta) { localStorage.setItem(LocalStorageRepository.META, JSON.stringify(meta)); }
  private read(): Record<string, StoredRecord> {
    const raw = localStorage.getItem(LocalStorageRepository.RECS);
    return raw ? (JSON.parse(raw) as Record<string, StoredRecord>) : {};
  }
  async listRecords() { return Object.values(this.read()); }
  async putRecord(rec: StoredRecord) {
    const all = this.read();
    all[rec.id] = rec;
    localStorage.setItem(LocalStorageRepository.RECS, JSON.stringify(all));
  }
  async deleteRecord(id: string) {
    const all = this.read();
    delete all[id];
    localStorage.setItem(LocalStorageRepository.RECS, JSON.stringify(all));
  }
}
