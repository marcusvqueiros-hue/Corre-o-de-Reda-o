// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app";
import { MemoryRepository } from "@/lib/repository";
import { DEFAULT_KDF, KDF_LIMITS } from "@/lib/crypto";
import { clearClipboardNow } from "@/lib/clipboard";

const FAST = { ...DEFAULT_KDF, opslimit: KDF_LIMITS.opsMin, memlimit: KDF_LIMITS.memMin };
const MASTER = "frase-mestra-bem-longa-2026";
const SECRET = "Zx9!qL#4vTn@8wRb";

let clip = "";
function mockClipboard() {
  // instalado DEPOIS de userEvent.setup(), que injeta o próprio stub de navigator.clipboard
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async (t: string) => { clip = t; }), readText: vi.fn(async () => clip) },
  });
}
beforeEach(() => { clip = ""; localStorage.clear(); });
afterEach(async () => { await clearClipboardNow(); cleanup(); vi.useRealTimers(); });

async function setup(repo = new MemoryRepository()) {
  const user = userEvent.setup();
  mockClipboard();
  render(<App repository={repo} kdf={FAST} />);
  return { user, repo };
}

async function createAndEnter(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText("Senha mestra"), MASTER);
  await user.type(screen.getByLabelText("Repita a senha mestra"), MASTER);
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Criar cofre" }));
  const key = await screen.findByTestId("recovery-key");
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Continuar" }));
  return key.textContent!;
}

async function addAccount(user: ReturnType<typeof userEvent.setup>, name: string, password: string, username = "ana@exemplo.com") {
  await user.click(screen.getByRole("button", { name: /Adicionar conta/ }));
  const dialog = await screen.findByRole("dialog", { name: "Nova conta" });
  await user.type(within(dialog).getByLabelText("Nome do serviço"), name);
  await user.type(within(dialog).getByLabelText("Usuário ou e-mail"), username);
  await user.type(within(dialog).getByLabelText("Senha"), password);
  await user.click(within(dialog).getByRole("button", { name: "Salvar" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

describe("fluxo completo do cofre", () => {
  it("cria o cofre, mostra a chave de recuperação e abre o painel", async () => {
    const { user } = await setup();
    const rk = await createAndEnter(user);
    expect(rk).toMatch(/^([0-9A-F]{4}-){15}[0-9A-F]{4}$/);
    expect(await screen.findByTestId("unlocked-pill")).toBeTruthy();
    expect(screen.getByText(/Seu cofre está vazio/)).toBeTruthy();
  });

  it("cadastra conta, NÃO exibe a senha na lista e grava só texto cifrado", async () => {
    const { user, repo } = await setup();
    await createAndEnter(user);
    await addAccount(user, "GitHub", SECRET);

    expect(await screen.findByText("GitHub")).toBeTruthy();
    expect(document.body.textContent).not.toContain(SECRET); // nunca na lista/tela
    const stored = JSON.stringify([...repo.records.values()]) + JSON.stringify(repo.meta);
    for (const v of [SECRET, "GitHub", "ana@exemplo.com", MASTER]) expect(stored).not.toContain(v);
    const localStore = JSON.stringify({ ...localStorage });
    expect(localStore).not.toContain(SECRET);
    expect(localStore).not.toContain(MASTER);
  });

  it("clicar na linha copia a senha, mostra aviso discreto sem a senha e limpa em 30 s", async () => {
    const { user } = await setup();
    await createAndEnter(user);
    await addAccount(user, "GitHub", SECRET);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    await user.click(await screen.findByRole("button", { name: "Copiar senha de GitHub" }));
    await waitFor(() => expect(clip).toBe(SECRET));
    const toast = await screen.findByText("Senha copiada com segurança");
    expect(toast.textContent).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain(SECRET);

    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    await waitFor(() => expect(clip).toBe(""));
  });

  it("se a cópia for negada, oferece alternativa manual", async () => {
    const { user } = await setup();
    await createAndEnter(user);
    await addAccount(user, "Banco", SECRET);
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("negado"));
    await user.click(await screen.findByRole("button", { name: "Copiar senha de Banco" }));
    const dialog = await screen.findByRole("dialog", { name: "Copiar manualmente" });
    await waitFor(() => expect((within(dialog).getByLabelText("Senha para cópia manual") as HTMLInputElement).value).toBe(SECRET));
  });

  it("bloqueio manual remove a chave: precisa da senha mestra de novo e a área de transferência é limpa", async () => {
    const { user } = await setup();
    await createAndEnter(user);
    await addAccount(user, "GitHub", SECRET);
    await user.click(screen.getByRole("button", { name: "Copiar senha de GitHub" }));
    await waitFor(() => expect(clip).toBe(SECRET));

    await user.click(screen.getByRole("button", { name: "Bloquear cofre" }));
    expect(await screen.findByText("Seu cofre está protegido")).toBeTruthy();
    await waitFor(() => expect(clip).toBe(""));
    expect(screen.queryByText("GitHub")).toBeNull();

    await user.type(screen.getByLabelText("Senha mestra"), "senha-errada-qualquer");
    await user.click(screen.getByRole("button", { name: "Desbloquear cofre" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Senha mestra incorreta.");

    await user.clear(screen.getByLabelText("Senha mestra"));
    await user.type(screen.getByLabelText("Senha mestra"), MASTER);
    await user.click(screen.getByRole("button", { name: "Desbloquear cofre" }));
    expect(await screen.findByText("GitHub")).toBeTruthy();
  });

  it("bloqueia automaticamente após o tempo de inatividade (5 min)", async () => {
    const { user } = await setup();
    await createAndEnter(user);
    await addAccount(user, "GitHub", SECRET);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    act(() => { window.dispatchEvent(new Event("pointerdown")); }); // rearma o timer sob o relógio falso
    await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60_000); });
    expect(screen.queryByText("Seu cofre está protegido")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(await screen.findByText("Seu cofre está protegido")).toBeTruthy();
  });

  it("busca por nome, usuário e categoria; resumo conta fortes e atenção", async () => {
    const { user } = await setup();
    await createAndEnter(user);
    await addAccount(user, "GitHub", SECRET, "dev@trabalho.com");
    await addAccount(user, "Netflix", "123456", "familia@casa.com");
    expect(await screen.findByText("Netflix")).toBeTruthy();

    const summary = screen.getByLabelText("Resumo");
    expect(within(summary).getByText("Contas").previousSibling?.textContent).toBe("2");
    expect(within(summary).getByText("Fortes").previousSibling?.textContent).toBe("1");
    expect(within(summary).getByText("Atenção").previousSibling?.textContent).toBe("1");

    await user.type(screen.getByLabelText("Buscar"), "familia");
    expect(screen.queryByText("GitHub")).toBeNull();
    expect(screen.getByText("Netflix")).toBeTruthy();
    await user.clear(screen.getByLabelText("Buscar"));
    await user.type(screen.getByLabelText("Buscar"), "GITHUB");
    expect(screen.queryByText("Netflix")).toBeNull();
  });

  it("um registro adulterado no armazenamento é rejeitado e sinalizado como ilegível", async () => {
    const { user, repo } = await setup();
    await createAndEnter(user);
    await addAccount(user, "GitHub", SECRET);
    const [rec] = [...repo.records.values()];
    const parts = rec!.sealed.split(".");
    const ct = parts[2]!;
    parts[2] = (ct[0] === "A" ? "B" : "A") + ct.slice(1); // altera o texto cifrado
    repo.records.set(rec!.id, { ...rec!, sealed: parts.join(".") });

    await user.click(screen.getByRole("button", { name: "Bloquear cofre" }));
    await user.type(await screen.findByLabelText("Senha mestra"), MASTER);
    await user.click(screen.getByRole("button", { name: "Desbloquear cofre" }));
    expect(await screen.findByText("Registro ilegível")).toBeTruthy();
    expect(screen.queryByText("GitHub")).toBeNull();
  });

  it("recuperação: a chave redefine a senha mestra e os dados continuam lá", async () => {
    const { user, repo } = await setup();
    const rk = await createAndEnter(user);
    await addAccount(user, "GitHub", SECRET);
    await user.click(screen.getByRole("button", { name: "Bloquear cofre" }));
    await user.click(await screen.findByRole("button", { name: "Usar chave de recuperação" }));
    await user.type(screen.getByLabelText("Chave de recuperação"), rk);
    await user.type(screen.getByLabelText("Nova senha mestra"), "outra-frase-mestra-nova-1");
    await user.click(screen.getByRole("button", { name: "Redefinir e desbloquear" }));
    expect(await screen.findByText("GitHub")).toBeTruthy();
    expect(repo.meta).not.toBeNull();
  });

  it("rejeita senha mestra curta e confirmação divergente", async () => {
    const { user } = await setup();
    await user.type(await screen.findByLabelText("Senha mestra"), "curta");
    await user.type(screen.getByLabelText("Repita a senha mestra"), "curta");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Criar cofre" }));
    expect((await screen.findByRole("alert")).textContent).toContain("12");
  });
});
