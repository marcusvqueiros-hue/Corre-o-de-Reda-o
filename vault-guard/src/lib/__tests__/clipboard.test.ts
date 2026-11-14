// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearClipboardNow, copySecret } from "../clipboard";

let clip = "";
const mockClipboard = (opts: { read?: boolean; write?: boolean } = {}) => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async (t: string) => { if (opts.write === false) throw new Error("negado"); clip = t; }),
      readText: vi.fn(async () => { if (opts.read === false) throw new Error("negado"); return clip; }),
    },
  });
};

beforeEach(() => { vi.useFakeTimers(); clip = ""; });
afterEach(async () => { await clearClipboardNow(); vi.useRealTimers(); });

describe("área de transferência", () => {
  it("copia e limpa após 30 s", async () => {
    mockClipboard();
    expect((await copySecret("S3nh@-secreta")).ok).toBe(true);
    expect(clip).toBe("S3nh@-secreta");
    await vi.advanceTimersByTimeAsync(29_000);
    expect(clip).toBe("S3nh@-secreta");
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(clip).toBe(""));
  });

  it("não apaga se o usuário copiou outra coisa nesse meio-tempo", async () => {
    mockClipboard();
    await copySecret("S3nh@-secreta");
    clip = "outra coisa que o usuário copiou";
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.waitFor(() => expect(navigator.clipboard.readText).toHaveBeenCalled());
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 100)); // dá tempo real para o hash e a decisão
    expect(clip).toBe("outra coisa que o usuário copiou");
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1); // só a cópia original, nenhuma limpeza
  });

  it("se a leitura for negada, apaga mesmo assim (segurança primeiro)", async () => {
    mockClipboard({ read: false });
    await copySecret("S3nh@-secreta");
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.waitFor(() => expect(clip).toBe(""));
  });

  it("sinaliza falha quando a escrita é negada (para a UI mostrar o alternativo)", async () => {
    mockClipboard({ write: false });
    expect((await copySecret("x")).ok).toBe(false);
  });

  it("limpa imediatamente ao ser chamado (ex.: bloqueio do cofre)", async () => {
    mockClipboard();
    await copySecret("S3nh@-secreta");
    await clearClipboardNow();
    expect(clip).toBe("");
  });

  it("uma nova cópia reinicia o prazo", async () => {
    mockClipboard();
    await copySecret("primeira-senha");
    await vi.advanceTimersByTimeAsync(20_000);
    await copySecret("segunda-senha");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(clip).toBe("segunda-senha");
    await vi.advanceTimersByTimeAsync(11_000);
    await vi.waitFor(() => expect(clip).toBe(""));
  });
});
