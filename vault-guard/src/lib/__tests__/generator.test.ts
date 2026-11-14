import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GENERATOR as D, entropyBits, generatePassword, randomInt, validateOptions } from "../generator";

describe("gerador de senhas", () => {
  it("respeita o comprimento (12 a 64) e rejeita fora do intervalo", () => {
    for (const n of [12, 20, 64]) expect(generatePassword({ ...D, length: n })).toHaveLength(n);
    expect(() => generatePassword({ ...D, length: 11 })).toThrow();
    expect(() => generatePassword({ ...D, length: 65 })).toThrow();
    expect(() => generatePassword({ ...D, upper: false, lower: false, digits: false, symbols: false })).toThrow();
    expect(validateOptions({ ...D, length: 12 })).toBeNull();
  });

  it("inclui ao menos um caractere de cada tipo escolhido (1000 amostras)", () => {
    for (let i = 0; i < 1000; i++) {
      const p = generatePassword({ ...D, length: 12 });
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/\d/);
      expect(p).toMatch(/[^A-Za-z0-9]/);
    }
  });

  it("só usa os tipos habilitados e exclui caracteres ambíguos", () => {
    for (let i = 0; i < 500; i++) {
      expect(generatePassword({ ...D, symbols: false, digits: false, length: 30 })).toMatch(/^[A-Za-z]+$/);
      expect(generatePassword({ ...D, excludeAmbiguous: true, length: 64 })).not.toMatch(/[Il1O0o|`'"]/);
    }
  });

  it("usa crypto.getRandomValues e nunca Math.random", () => {
    const rnd = vi.spyOn(Math, "random");
    const grv = vi.spyOn(crypto, "getRandomValues");
    generatePassword(D);
    expect(grv).toHaveBeenCalled();
    expect(rnd).not.toHaveBeenCalled();
    rnd.mockRestore();
    grv.mockRestore();
  });

  it("randomInt é uniforme (qui-quadrado) e respeita os limites", () => {
    const max = 7, N = 70_000, c = new Array<number>(max).fill(0);
    for (let i = 0; i < N; i++) c[randomInt(max)]!++;
    const exp = N / max;
    const chi = c.reduce((s, o) => s + (o - exp) ** 2 / exp, 0);
    expect(chi).toBeLessThan(22.5); // gl=6, p≈0,001
    expect(() => randomInt(0)).toThrow();
  });

  it("não repete senhas e a entropia estimada cresce com o comprimento", () => {
    const set = new Set(Array.from({ length: 2000 }, () => generatePassword(D)));
    expect(set.size).toBe(2000);
    expect(entropyBits({ ...D, length: 32 })).toBeGreaterThan(entropyBits({ ...D, length: 16 }));
    expect(entropyBits({ ...D, length: 20 })).toBeGreaterThan(110);
  });
});
