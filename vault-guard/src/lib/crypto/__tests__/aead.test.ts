import { describe, expect, it, vi } from "vitest";
import { IV_BYTES, importAesKey, open, seal } from "../aead";
import { CryptoFormatError, DecryptionError } from "../errors";
import { fromB64u, randomBytes, toB64u, utf8 } from "../encoding";

const key = () => importAesKey(randomBytes(32), ["encrypt", "decrypt"]);
const AAD = "teste/aad";

describe("encoding", () => {
  it("base64url faz ida e volta e rejeita lixo", () => {
    for (const n of [0, 1, 2, 3, 16, 33, 60_000]) {
      const b = randomBytes(n);
      expect(fromB64u(toB64u(b))).toEqual(b);
    }
    expect(() => fromB64u("abc$")).toThrow(CryptoFormatError);
    expect(() => fromB64u("a")).toThrow(CryptoFormatError);
  });
});

describe("AES-256-GCM", () => {
  it("cifra e decifra", async () => {
    const k = await key();
    const sealed = await seal(k, utf8("segredo ç ã 🔐"), AAD);
    expect(new TextDecoder().decode(await open(k, sealed, AAD))).toBe("segredo ç ã 🔐");
  });

  it("texto cifrado não contém o texto aberto", async () => {
    const k = await key();
    const sealed = await seal(k, utf8("SENHA-SUPER-SECRETA-123"), AAD);
    expect(sealed).not.toContain("SENHA-SUPER-SECRETA-123");
    const raw = new TextDecoder("latin1").decode(fromB64u(sealed.split(".")[2]!));
    expect(raw).not.toContain("SENHA-SUPER-SECRETA");
  });

  it("rejeita adulteração de QUALQUER byte do texto cifrado, da tag e do IV", async () => {
    const k = await key();
    const sealed = await seal(k, utf8("conteudo de teste com varios bytes"), AAD);
    const [v, ivS, ctS] = sealed.split(".") as [string, string, string];
    const ct = fromB64u(ctS);
    for (let i = 0; i < ct.length; i++) {
      const bad = new Uint8Array(ct);
      bad[i] = bad[i]! ^ 0x01;
      await expect(open(k, `${v}.${ivS}.${toB64u(bad)}`, AAD)).rejects.toThrow(DecryptionError);
    }
    const iv = fromB64u(ivS);
    for (let i = 0; i < iv.length; i++) {
      const bad = new Uint8Array(iv);
      bad[i] = bad[i]! ^ 0x80;
      await expect(open(k, `${v}.${toB64u(bad)}.${ctS}`, AAD)).rejects.toThrow(DecryptionError);
    }
  });

  it("rejeita AAD diferente, chave errada, truncamento e versão desconhecida", async () => {
    const k = await key();
    const sealed = await seal(k, utf8("x"), AAD);
    await expect(open(k, sealed, "outro/aad")).rejects.toThrow(DecryptionError);
    await expect(open(await key(), sealed, AAD)).rejects.toThrow(DecryptionError);
    const [v, iv, ct] = sealed.split(".") as [string, string, string];
    await expect(open(k, `${v}.${iv}.${ct.slice(0, 4)}`, AAD)).rejects.toThrow(CryptoFormatError);
    await expect(open(k, `9.${iv}.${ct}`, AAD)).rejects.toThrow(CryptoFormatError);
    await expect(open(k, "lixo", AAD)).rejects.toThrow(CryptoFormatError);
    await expect(open(k, `${v}.${toB64u(randomBytes(8))}.${ct}`, AAD)).rejects.toThrow(CryptoFormatError);
  });

  it("IV tem 96 bits, vem de crypto.getRandomValues e nunca se repete", async () => {
    const k = await key();
    const spy = vi.spyOn(crypto, "getRandomValues");
    const first = await seal(k, utf8("igual"), AAD);
    expect(fromB64u(first.split(".")[1]!).length).toBe(IV_BYTES);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();

    const ivs = new Set<string>([first.split(".")[1]!]);
    const N = 20_000;
    for (let i = 0; i < N; i++) ivs.add((await seal(k, utf8("igual"), AAD)).split(".")[1]!);
    expect(ivs.size).toBe(N + 1); // mesma chave e mesmo texto: IVs sempre distintos
  });
});
