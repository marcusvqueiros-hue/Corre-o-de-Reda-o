/**
 * Cópia de segredos. A senha NÃO fica guardada aqui: para saber se a área de transferência
 * ainda contém o que copiamos, guardamos apenas o hash SHA-256.
 */
export const CLEAR_AFTER_MS = 30_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let pendingHash: string | null = null;

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Apaga a área de transferência agora. Se ela mudou desde a cópia (e dá para ler), não mexe. */
export async function clearClipboardNow(): Promise<void> {
  const expected = pendingHash;
  if (timer) clearTimeout(timer);
  timer = null;
  pendingHash = null;
  if (!expected) return;
  try {
    let current: string | null = null;
    try {
      current = await navigator.clipboard.readText();
    } catch {
      current = null; // leitura negada: por segurança, apaga mesmo assim
    }
    if (current === null || (await sha256(current)) === expected) await navigator.clipboard.writeText("");
  } catch {
    /* o navegador não permitiu: nada mais a fazer */
  }
}

export async function copySecret(text: string, clearAfterMs = CLEAR_AFTER_MS): Promise<{ ok: boolean }> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return { ok: false };
  }
  if (timer) clearTimeout(timer);
  pendingHash = await sha256(text);
  timer = setTimeout(() => void clearClipboardNow(), clearAfterMs);
  return { ok: true };
}
