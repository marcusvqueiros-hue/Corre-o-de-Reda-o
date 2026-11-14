"use client";
import { useState } from "react";
import { useVault, masterPasswordSchema } from "@/lib/vault-store";
import { copySecret } from "@/lib/clipboard";
import { rate } from "@/lib/strength";
import { Button, Field, LocalModeBanner, Logo, inputCls } from "./ui";
import { EyeIcon, EyeOffIcon, LockIcon } from "./icons";

function PasswordInput({ id, value, onChange, label = "Senha mestra", autoFocus }: { id: string; value: string; onChange: (v: string) => void; label?: string; autoFocus?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex gap-2">
      <input id={id} className={inputCls} type={show ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" autoFocus={autoFocus} maxLength={256} />
      <button type="button" aria-label={show ? `Ocultar ${label.toLowerCase()}` : `Exibir ${label.toLowerCase()}`} onClick={() => setShow((s) => !s)} className="rounded-xl border border-white/10 px-3 text-neutral-300">{show ? <EyeOffIcon /> : <EyeIcon />}</button>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { mode } = useVault();
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-4 py-8">
      <div className="flex flex-col items-center gap-2 text-center"><Logo size="lg" /></div>
      {mode === "local" && <LocalModeBanner />}
      <div className="space-y-4 rounded-3xl border border-white/10 bg-white/[0.03] p-5">{children}</div>
    </main>
  );
}

export function CreateVaultScreen({ onRecoveryKey }: { onRecoveryKey: (k: string) => void }) {
  const vault = useVault();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [ack, setAck] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const strength = pw ? rate(pw) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    const ok = masterPasswordSchema.safeParse(pw);
    if (!ok.success) return setErr(ok.error.issues[0]?.message ?? "Senha inválida.");
    if (pw !== pw2) return setErr("As senhas não conferem.");
    setBusy(true);
    try {
      const { recoveryKey } = await vault.create(pw);
      onRecoveryKey(recoveryKey);
      setPw(""); setPw2("");
    } catch { setErr("Não foi possível criar o cofre."); } finally { setBusy(false); }
  }

  return (
    <Shell>
      <h1 className="text-lg font-semibold">Crie seu cofre</h1>
      <p className="text-sm text-neutral-400">A senha mestra protege tudo e <strong>nunca sai do seu aparelho</strong>.</p>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Senha mestra" hint="Mínimo de 12 caracteres. Uma frase longa é melhor que uma senha curta e complicada.">{(i) => <PasswordInput id={i} value={pw} onChange={setPw} autoFocus />}</Field>
        {strength && <p className="text-xs text-neutral-400">Força estimada: {strength === "strong" ? "forte" : strength === "ok" ? "média" : "fraca"}</p>}
        <Field label="Repita a senha mestra">{(i) => <PasswordInput id={i} value={pw2} onChange={setPw2} label="Confirmação" />}</Field>
        <label className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-100">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 accent-blue-500" />
          <span>Entendo que, <strong>se eu perder a senha mestra e a chave de recuperação, meus dados não poderão ser recuperados</strong> — nem pelo VAULT GUARD.</span>
        </label>
        {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
        <Button type="submit" disabled={!ack || busy} className="w-full">{busy ? "Protegendo… (pode levar alguns segundos)" : "Criar cofre"}</Button>
      </form>
    </Shell>
  );
}

export function RecoveryKeyScreen({ recoveryKey, onDone }: { recoveryKey: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [msg, setMsg] = useState("");
  function download() {
    const blob = new Blob([`VAULT GUARD — chave de recuperação\n\n${recoveryKey}\n\nGuarde em local seguro e offline. Quem tiver esta chave consegue abrir seu cofre.\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "vault-guard-chave-de-recuperacao.txt"; a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <Shell>
      <h1 className="text-lg font-semibold">Guarde sua chave de recuperação</h1>
      <p className="text-sm text-neutral-400">É a <strong>única</strong> forma de reabrir o cofre se você esquecer a senha mestra. Ela aparece só agora.</p>
      <p className="break-all rounded-xl border border-white/10 bg-black/50 p-3 text-center font-mono text-sm tracking-wider" data-testid="recovery-key">{recoveryKey}</p>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="ghost" onClick={async () => setMsg((await copySecret(recoveryKey)).ok ? "Copiada (some da área de transferência em 30 s)." : "Não foi possível copiar: anote à mão.")}>Copiar</Button>
        <Button variant="ghost" onClick={download}>Baixar .txt</Button>
      </div>
      {msg && <p role="status" className="text-xs text-neutral-400">{msg}</p>}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="mt-1 accent-blue-500" />
        Guardei a chave em um lugar seguro.
      </label>
      <Button disabled={!saved} onClick={onDone} className="w-full">Continuar</Button>
    </Shell>
  );
}

export function UnlockScreen() {
  const vault = useVault();
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [rk, setRk] = useState("");
  const [np, setNp] = useState("");
  const wait = Math.ceil(vault.retryInMs / 1000);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const ok = await vault.unlock(pw);
      if (!ok) setErr("Senha mestra incorreta."); else setPw("");
    } catch { setErr("Não foi possível desbloquear."); } finally { setBusy(false); }
  }
  async function submitRecovery(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const ok = await vault.unlockWithRecovery(rk, np);
      if (!ok) setErr("Chave de recuperação inválida."); else { setRk(""); setNp(""); }
    } catch (x) { setErr(x instanceof Error && x.message.includes("12") ? "A nova senha mestra precisa de 12 caracteres ou mais." : "Não foi possível usar a chave."); } finally { setBusy(false); }
  }

  if (recovery) return (
    <Shell>
      <h1 className="text-lg font-semibold">Usar chave de recuperação</h1>
      <form onSubmit={submitRecovery} className="space-y-3">
        <Field label="Chave de recuperação">{(i) => <input id={i} className={`${inputCls} font-mono`} value={rk} onChange={(e) => setRk(e.target.value)} autoComplete="off" autoCapitalize="characters" />}</Field>
        <Field label="Nova senha mestra" hint="Mínimo de 12 caracteres.">{(i) => <PasswordInput id={i} value={np} onChange={setNp} label="Nova senha mestra" />}</Field>
        {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
        <Button type="submit" disabled={busy} className="w-full">{busy ? "Verificando…" : "Redefinir e desbloquear"}</Button>
        <Button variant="ghost" onClick={() => { setRecovery(false); setErr(""); }} className="w-full">Voltar</Button>
      </form>
    </Shell>
  );

  return (
    <Shell>
      <div className="flex items-center gap-2"><LockIcon className="text-blue-400" /><h1 className="text-lg font-semibold">Seu cofre está protegido</h1></div>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Senha mestra">{(i) => <PasswordInput id={i} value={pw} onChange={setPw} autoFocus />}</Field>
        {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
        {wait > 0 && <p role="status" className="text-xs text-amber-300">Muitas tentativas. Aguarde {wait} s para tentar de novo.</p>}
        <Button type="submit" disabled={busy || wait > 0 || !pw} className="w-full">{busy ? "Desbloqueando…" : "Desbloquear cofre"}</Button>
      </form>
      <button type="button" onClick={() => { setRecovery(true); setErr(""); }} className="w-full text-center text-sm text-blue-300 underline-offset-4 hover:underline">Usar chave de recuperação</button>
    </Shell>
  );
}
