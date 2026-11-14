/** Gerador de senhas. Aleatoriedade SOMENTE de crypto.getRandomValues (nunca Math.random). */
export interface GeneratorOptions {
  length: number;
  upper: boolean;
  lower: boolean;
  digits: boolean;
  symbols: boolean;
  excludeAmbiguous: boolean;
}

export const DEFAULT_GENERATOR: GeneratorOptions = {
  length: 20,
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: false,
};

export const MIN_LENGTH = 12;
export const MAX_LENGTH = 64;

const SETS = {
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  lower: "abcdefghijklmnopqrstuvwxyz",
  digits: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{};:,.?/~",
} as const;
const AMBIGUOUS = new Set("Il1O0o|`'\"".split(""));

/** Inteiro uniforme em [0, max) por amostragem com rejeição (sem viés de módulo). */
export function randomInt(max: number): number {
  if (!Number.isInteger(max) || max <= 0 || max > 2 ** 32) throw new RangeError("max inválido");
  const limit = Math.floor(2 ** 32 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % max;
  }
}

function activeSets(o: GeneratorOptions): string[] {
  const keys = (["upper", "lower", "digits", "symbols"] as const).filter((k) => o[k]);
  return keys.map((k) => [...SETS[k]].filter((c) => !(o.excludeAmbiguous && AMBIGUOUS.has(c))).join(""));
}

export function validateOptions(o: GeneratorOptions): string | null {
  if (!Number.isInteger(o.length) || o.length < MIN_LENGTH || o.length > MAX_LENGTH)
    return `O comprimento deve ficar entre ${MIN_LENGTH} e ${MAX_LENGTH}.`;
  if (activeSets(o).length === 0) return "Escolha ao menos um tipo de caractere.";
  return null;
}

/** Entropia estimada em bits: comprimento × log2(tamanho do alfabeto). */
export function entropyBits(o: GeneratorOptions): number {
  const sets = activeSets(o);
  const pool = new Set(sets.join("")).size;
  return pool > 1 ? Math.round(o.length * Math.log2(pool)) : 0;
}

export function generatePassword(o: GeneratorOptions): string {
  const err = validateOptions(o);
  if (err) throw new RangeError(err);
  const sets = activeSets(o);
  const pool = sets.join("");
  // garante ao menos um caractere de cada tipo escolhido e preenche o resto do alfabeto completo
  const chars = sets.map((s) => s[randomInt(s.length)]!);
  while (chars.length < o.length) chars.push(pool[randomInt(pool.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1); // Fisher-Yates
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}
