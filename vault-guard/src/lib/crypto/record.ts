import { utf8 } from "./encoding";
import { open, seal } from "./aead";
import { type RecordPayload, recordPayloadSchema } from "./schema";

/** AAD do registro: troca de vault ou de id entre linhas do banco invalida a decifragem. */
const aadRecord = (vaultId: string, recordId: string) => `vg/rec/v1/${vaultId}/${recordId}`;

export interface RecordContext {
  vaultId: string;
  recordId: string;
}

export async function encryptRecord(dek: CryptoKey, ctx: RecordContext, payload: unknown): Promise<string> {
  const data = recordPayloadSchema.parse(payload);
  const bytes = utf8(JSON.stringify(data));
  try {
    return await seal(dek, bytes, aadRecord(ctx.vaultId, ctx.recordId));
  } finally {
    bytes.fill(0);
  }
}

export async function decryptRecord(dek: CryptoKey, ctx: RecordContext, sealed: string): Promise<RecordPayload> {
  const bytes = await open(dek, sealed, aadRecord(ctx.vaultId, ctx.recordId));
  try {
    return recordPayloadSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } finally {
    bytes.fill(0);
  }
}
