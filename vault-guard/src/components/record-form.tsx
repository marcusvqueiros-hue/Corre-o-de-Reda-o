"use client";
import { useState } from "react";
import { CATEGORIES_DEFAULT, type RecordPayload, recordPayloadSchema } from "@/lib/crypto";
import { useVault } from "@/lib/vault-store";
import { Button, Field, inputCls } from "./ui";
import { DiceIcon, EyeIcon, EyeOffIcon } from "./icons";
import { GeneratorPanel } from "./generator-panel";

const NEW = "__nova__";

export function RecordForm({ id, initial, onDone }: { id?: string; initial?: RecordPayload; onDone: () => void }) {
  const vault = useVault();
  const [f, setF] = useState<RecordPayload>(initial ?? { name: "", url: "", username: "", password: "", category: "Outros", notes: "" });
  const [custom, setCustom] = useState("");
  const [show, setShow] = useState(false);
  const [gen, setGen] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const categories = [...new Set([...CATEGORIES_DEFAULT, ...vault.metas.map((m) => m.category).filter((c) => c !== "—")])];
  const set = <K extends keyof RecordPayload>(k: K, v: RecordPayload[K]) => setF((s) => ({ ...s, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    const category = f.category === NEW ? custom.trim() : f.category;
    const parsed = recordPayloadSchema.safeParse({ ...f, category });
    if (!parsed.success) { setErr(parsed.error.issues[0]?.path[0] === "password" ? "Informe a senha." : "Confira o nome do serviço e os campos preenchidos."); return; }
    setBusy(true);
    try {
      await vault.save(parsed.data, id);
      setF({ name: "", url: "", username: "", password: "", category: "Outros", notes: "" }); // limpa campos sensíveis
      onDone();
    } catch {
      setErr("Não foi possível salvar. Se o cofre foi bloqueado, desbloqueie e tente de novo.");
    } finally { setBusy(false); }
  }

  if (gen) return (
    <div className="space-y-3">
      <GeneratorPanel onUse={(pw) => { set("password", pw); setShow(true); setGen(false); }} />
      <Button variant="ghost" onClick={() => setGen(false)} className="w-full">Voltar</Button>
    </div>
  );

  return (
    <form onSubmit={submit} className="space-y-3" autoComplete="off">
      <Field label="Nome do serviço">{(i) => <input id={i} className={inputCls} value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={120} required autoFocus />}</Field>
      <Field label="Site (URL)">{(i) => <input id={i} className={inputCls} value={f.url} onChange={(e) => set("url", e.target.value)} inputMode="url" maxLength={2048} placeholder="https://" />}</Field>
      <Field label="Usuário ou e-mail">{(i) => <input id={i} className={inputCls} value={f.username} onChange={(e) => set("username", e.target.value)} maxLength={320} autoCapitalize="none" />}</Field>
      <Field label="Senha">
        {(i) => (
          <div className="flex gap-2">
            <input id={i} className={`${inputCls} font-mono`} type={show ? "text" : "password"} value={f.password} onChange={(e) => set("password", e.target.value)} maxLength={1024} autoComplete="new-password" />
            <button type="button" aria-label={show ? "Ocultar senha" : "Mostrar senha"} onClick={() => setShow((s) => !s)} className="rounded-xl border border-white/10 px-3 text-neutral-300">{show ? <EyeOffIcon /> : <EyeIcon />}</button>
          </div>
        )}
      </Field>
      <Button variant="ghost" onClick={() => setGen(true)} className="w-full"><DiceIcon />Gerar senha</Button>
      <Field label="Categoria">
        {(i) => (
          <select id={i} className={inputCls} value={f.category} onChange={(e) => set("category", e.target.value)}>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            <option value={NEW}>+ Nova categoria…</option>
          </select>
        )}
      </Field>
      {f.category === NEW && <Field label="Nome da nova categoria">{(i) => <input id={i} className={inputCls} value={custom} onChange={(e) => setCustom(e.target.value)} maxLength={60} />}</Field>}
      <Field label="Observações">{(i) => <textarea id={i} className={`${inputCls} min-h-24 py-2`} value={f.notes} onChange={(e) => set("notes", e.target.value)} maxLength={8192} />}</Field>
      {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
      <Button type="submit" disabled={busy} className="w-full">{busy ? "Cifrando e salvando…" : "Salvar"}</Button>
    </form>
  );
}
