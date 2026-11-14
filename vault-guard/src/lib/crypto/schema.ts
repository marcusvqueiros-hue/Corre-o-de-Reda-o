import { z } from "zod";
import { IV_BYTES } from "./aead";
import { fromB64u } from "./encoding";
import { kdfParamsSchema } from "./params";

const b64uOfLength = (len: number) =>
  z.string().refine((s) => {
    try {
      return fromB64u(s).length === len;
    } catch {
      return false;
    }
  });

const sealed = z.string().max(1024).regex(/^1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

/** Metadados do cofre (a única coisa que o servidor guarda além dos blobs cifrados). */
export const vaultMetaSchema = z.object({
  version: z.literal(1),
  vaultId: z.uuid(),
  salt: b64uOfLength(16),
  kdf: kdfParamsSchema,
  encryption: z.literal("aes-256-gcm"),
  wrappedDekMaster: sealed,
  wrappedDekRecovery: sealed.nullable(),
});

export type VaultMeta = z.infer<typeof vaultMetaSchema>;
export { IV_BYTES };

export const CATEGORIES_DEFAULT = [
  "Redes sociais",
  "E-mails",
  "Bancos",
  "Trabalho",
  "Compras",
  "Entretenimento",
  "Sistemas",
  "Outros",
] as const;

/** Conteúdo COMPLETO de um registro: tudo isto vai dentro do payload cifrado. */
export const recordPayloadSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().trim().max(2048).default(""),
  username: z.string().trim().max(320).default(""),
  password: z.string().min(1).max(1024),
  category: z.string().trim().min(1).max(60).default("Outros"),
  notes: z.string().max(8192).default(""),
});

export type RecordPayload = z.infer<typeof recordPayloadSchema>;
