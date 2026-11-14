export type Strength = "strong" | "ok" | "weak";

const COMMON = ["password", "senha", "123456", "qwerty", "abc123", "letmein", "admin", "welcome", "iloveyou", "11111", "12345678", "senha123"];
const SEQ = ["abcdefghijklmnopqrstuvwxyz", "0123456789", "qwertyuiopasdfghjklzxcvbnm"];

/** Estimativa simples e conservadora (não substitui um verificador de vazamentos). */
export function estimateBits(pw: string): number {
  if (!pw) return 0;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  const unique = new Set(pw).size;
  let bits = Math.min(pw.length, unique * 2) * Math.log2(Math.max(pool, 2));
  const lower = pw.toLowerCase();
  if (COMMON.some((c) => lower.includes(c))) bits = Math.min(bits, 28);
  for (const s of SEQ) {
    for (let i = 0; i + 4 <= s.length; i++) {
      const frag = s.slice(i, i + 4);
      if (lower.includes(frag) || lower.includes([...frag].reverse().join(""))) bits -= 8;
    }
  }
  return Math.max(0, Math.round(bits));
}

export function rate(pw: string): Strength {
  const bits = estimateBits(pw);
  return bits >= 60 ? "strong" : bits >= 40 ? "ok" : "weak";
}
