import { z } from "zod";
import { KdfParamsError } from "./errors";

/**
 * Parâmetros Argon2id (libsodium: crypto_pwhash, ALG_ARGON2ID13; paralelismo fixo em 1 pela libsodium).
 *
 * Padrão v1: 3 iterações, 64 MiB. Acima do mínimo OWASP (19 MiB / 2 iterações) e viável em celulares
 * (a calibração medida em aparelhos reais é uma pendência registrada no README).
 *
 * Os limites abaixo valem também para parâmetros vindos do servidor: impedem que um servidor
 * comprometido force parâmetros fracos (downgrade) ou gigantes (DoS no aparelho).
 */
export const KDF_PARAMS_VERSION = 1;
export const KDF_ALGORITHM = "argon2id13" as const;
export const KDF_LIMITS = {
  opsMin: 2,
  opsMax: 10,
  memMin: 32 * 1024 * 1024,
  memMax: 256 * 1024 * 1024,
} as const;

export const DEFAULT_KDF = {
  algorithm: KDF_ALGORITHM,
  paramsVersion: KDF_PARAMS_VERSION,
  opslimit: 3,
  memlimit: 64 * 1024 * 1024,
} as const;

export const kdfParamsSchema = z.object({
  algorithm: z.literal(KDF_ALGORITHM),
  paramsVersion: z.literal(KDF_PARAMS_VERSION),
  opslimit: z.int().min(KDF_LIMITS.opsMin).max(KDF_LIMITS.opsMax),
  memlimit: z.int().min(KDF_LIMITS.memMin).max(KDF_LIMITS.memMax),
});

export type KdfParams = z.infer<typeof kdfParamsSchema>;

export function assertKdfParams(input: unknown): KdfParams {
  const parsed = kdfParamsSchema.safeParse(input);
  if (!parsed.success) throw new KdfParamsError();
  return parsed.data;
}
