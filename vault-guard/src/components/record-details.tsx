"use client";
import { useEffect, useState } from "react";
import type { RecordPayload } from "@/lib/crypto";
import { useVault } from "@/lib/vault-store";
import { Button } from "./ui";
import { CopyIcon, EyeIcon, EyeOffIcon } from "./icons";
import { RecordForm } from "./record-form";

const REVEAL_MS = 15_000;

export function RecordDetails({ id, onClose, onCopy }: { id: string; onClose: () => void; onCopy: (r: "copied" | "denied" | "error") => void }) {
  const vault = useVault();
  const [p, setP] = useState<RecordPayload | null>(null);
  const [missing, setMissing] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    let alive = true;
    vault.getPayload(id).then((x) => { if (!alive) return; if (x) setP(x); else setMissing(true); });
    return () => { alive = false; setP(null); }; // não deixa a senha viva depois de fechar
  }, [id, vault.status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!reveal) return;
    const t = setTimeout(() => setReveal(false), REVEAL_MS);
    return () => clearTimeout(t);
  }, [reveal]);

  if (missing) return <p role="alert" className="text-sm text-red-400">Não foi possível abrir este registro (dados corrompidos ou adulterados).</p>;
  if (!p) return <p className="text-sm text-neutral-400">Descriptografando…</p>;
  if (editing) return <RecordForm id={id} initial={p} onDone={onClose} />;

  const row = (label: string, value: string) => value ? (
    <div><dt className="text-xs text-neutral-500">{label}</dt><dd className="break-all text-sm">{value}</dd></div>
  ) : null;

  return (
    <div className="space-y-4">
      <dl className="space-y-3">
        {row("Serviço", p.name)}{row("Site", p.url)}{row("Usuário ou e-mail", p.username)}{row("Categoria", p.category)}
        <div>
          <dt className="text-xs text-neutral-500">Senha</dt>
          <dd className="flex items-center gap-2">
            <span className="break-all font-mono text-sm" data-testid="detail-password">{reveal ? p.password : "••••••••••••"}</span>
            <button type="button" aria-label={reveal ? "Ocultar senha" : "Mostrar senha por 15 segundos"} onClick={() => setReveal((r) => !r)} className="rounded-lg p-2 text-neutral-300 hover:bg-white/10">{reveal ? <EyeOffIcon /> : <EyeIcon />}</button>
          </dd>
        </div>
        {row("Observações", p.notes)}
      </dl>
      <div className="grid grid-cols-2 gap-2">
        <Button onClick={async () => onCopy(await vault.copyPassword(id))}><CopyIcon />Copiar senha</Button>
        <Button variant="ghost" onClick={() => setEditing(true)}>Editar</Button>
      </div>
      {confirmDel ? (
        <div className="space-y-2 rounded-xl border border-red-400/30 p-3">
          <p className="text-sm">Excluir este registro? Isso não pode ser desfeito.</p>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={() => setConfirmDel(false)}>Cancelar</Button>
            <Button variant="danger" onClick={async () => { await vault.remove(id); onClose(); }}>Excluir</Button>
          </div>
        </div>
      ) : <Button variant="ghost" onClick={() => setConfirmDel(true)} className="w-full text-red-300">Excluir</Button>}
    </div>
  );
}
