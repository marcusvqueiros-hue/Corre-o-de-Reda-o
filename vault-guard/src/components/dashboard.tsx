"use client";
import { useEffect, useMemo, useState } from "react";
import { useVault, type RecordMeta } from "@/lib/vault-store";
import { LOCK_CHOICES } from "@/lib/autolock";
import { Button, LocalModeBanner, Logo, Sheet, inputCls } from "./ui";
import { CogIcon, DiceIcon, DotsIcon, LockIcon, PlusIcon, SearchIcon } from "./icons";
import { RecordForm } from "./record-form";
import { RecordDetails } from "./record-details";
import { GeneratorPanel } from "./generator-panel";

const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const COLORS = ["bg-blue-500/20 text-blue-300", "bg-emerald-500/20 text-emerald-300", "bg-violet-500/20 text-violet-300", "bg-amber-500/20 text-amber-300", "bg-rose-500/20 text-rose-300", "bg-cyan-500/20 text-cyan-300"];
const colorFor = (s: string) => COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length]!;

type Sheetname = null | "new" | "gen" | "settings" | { details: string };

export function Dashboard() {
  const vault = useVault();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("Todas");
  const [sheet, setSheet] = useState<Sheetname>(null);
  const [toast, setToast] = useState("");
  const [manual, setManual] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const readable = vault.metas.filter((m) => !m.unreadable);
  const strong = readable.filter((m) => m.strength === "strong" && !m.reused).length;
  const attention = readable.length - strong;
  const categories = useMemo(() => ["Todas", ...new Set(readable.map((m) => m.category))], [readable]);
  const list = useMemo(() => {
    const n = norm(q.trim());
    return vault.metas.filter((m) => (cat === "Todas" || m.category === cat) && (!n || norm(`${m.name} ${m.username} ${m.category} ${m.url}`).includes(n)));
  }, [vault.metas, q, cat]);

  async function copy(id: string) {
    const r = await vault.copyPassword(id);
    if (r === "copied") setToast("Senha copiada com segurança");
    else if (r === "denied") setManual(id);
    else setToast("Não foi possível abrir este registro.");
  }
  const onCopyResult = (r: "copied" | "denied" | "error", id: string) => {
    if (r === "copied") setToast("Senha copiada com segurança"); else if (r === "denied") { setSheet(null); setManual(id); } else setToast("Não foi possível copiar.");
  };

  return (
    <div className="mx-auto min-h-dvh max-w-2xl space-y-4 px-4 pb-28 pt-4">
      <header className="flex items-center justify-between">
        <Logo />
        <div className="flex items-center gap-1">
          <span className="mr-1 flex items-center gap-1.5 rounded-full bg-emerald-400/10 px-2.5 py-1 text-xs text-emerald-300" data-testid="unlocked-pill"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Desbloqueado</span>
          <button type="button" aria-label="Gerador de senhas" onClick={() => setSheet("gen")} className="rounded-lg p-2.5 text-neutral-300 hover:bg-white/10"><DiceIcon /></button>
          <button type="button" aria-label="Configurações" onClick={() => setSheet("settings")} className="rounded-lg p-2.5 text-neutral-300 hover:bg-white/10"><CogIcon /></button>
          <button type="button" aria-label="Bloquear cofre" onClick={vault.lock} className="rounded-lg p-2.5 text-blue-300 hover:bg-white/10"><LockIcon /></button>
        </div>
      </header>
      {vault.mode === "local" && <LocalModeBanner />}

      <section className="grid grid-cols-3 gap-2 text-center" aria-label="Resumo">
        {[["Contas", readable.length, "text-neutral-100"], ["Fortes", strong, "text-emerald-300"], ["Atenção", attention, attention ? "text-amber-300" : "text-neutral-100"]].map(([l, v, c]) => (
          <div key={String(l)} className="rounded-2xl border border-white/10 bg-white/[0.03] py-3"><div className={`text-xl font-semibold ${c}`}>{v}</div><div className="text-xs text-neutral-400">{l}</div></div>
        ))}
      </section>

      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
        <input className={`${inputCls} pl-10`} placeholder="Buscar conta, usuário ou categoria" aria-label="Buscar" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Categorias">
        {categories.map((c) => (
          <button key={c} type="button" role="tab" aria-selected={cat === c} onClick={() => setCat(c)}
            className={`shrink-0 rounded-full border px-3 py-1.5 text-xs ${cat === c ? "border-blue-400 bg-blue-500/20 text-blue-200" : "border-white/10 text-neutral-400"}`}>{c}</button>
        ))}
      </div>

      {vault.metas.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-white/15 p-8 text-center text-sm text-neutral-400">Seu cofre está vazio. Toque em <strong>Adicionar conta</strong> para começar.</div>
      ) : list.length === 0 ? (
        <p className="py-8 text-center text-sm text-neutral-500">Nenhuma conta encontrada.</p>
      ) : (
        <ul className="space-y-2">
          {list.map((m) => <Row key={m.id} m={m} onCopy={() => copy(m.id)} onOpen={() => setSheet({ details: m.id })} />)}
        </ul>
      )}

      <div className="fixed inset-x-0 bottom-0 bg-gradient-to-t from-[#0b0d10] via-[#0b0d10]/95 to-transparent px-4 pb-5 pt-8">
        <div className="mx-auto max-w-2xl"><Button onClick={() => setSheet("new")} className="w-full shadow-lg shadow-blue-500/20"><PlusIcon />Adicionar conta</Button></div>
      </div>

      {toast && <div role="status" aria-live="polite" className="fixed inset-x-0 bottom-24 z-50 mx-auto w-fit rounded-full border border-white/10 bg-[#1b1f26] px-4 py-2 text-sm shadow-xl">{toast}</div>}

      {sheet === "new" && <Sheet title="Nova conta" onClose={() => setSheet(null)}><RecordForm onDone={() => { setSheet(null); setToast("Conta salva e cifrada"); }} /></Sheet>}
      {sheet === "gen" && <Sheet title="Gerador de senhas" onClose={() => setSheet(null)}><GeneratorPanel onCopied={(ok) => setToast(ok ? "Senha copiada com segurança" : "Não foi possível copiar")} /></Sheet>}
      {sheet === "settings" && <Sheet title="Configurações" onClose={() => setSheet(null)}><Settings /></Sheet>}
      {sheet && typeof sheet === "object" && <Sheet title="Detalhes da conta" onClose={() => setSheet(null)}><RecordDetails id={sheet.details} onClose={() => setSheet(null)} onCopy={(r) => onCopyResult(r, sheet.details)} /></Sheet>}
      {manual && <Sheet title="Copiar manualmente" onClose={() => setManual(null)}><ManualCopy id={manual} onClose={() => setManual(null)} /></Sheet>}
    </div>
  );
}

function Row({ m, onCopy, onOpen }: { m: RecordMeta; onCopy: () => void; onOpen: () => void }) {
  return (
    <li className="flex items-stretch rounded-2xl border border-white/10 bg-white/[0.03]">
      <button type="button" onClick={onCopy} disabled={m.unreadable} aria-label={`Copiar senha de ${m.name}`} className="flex min-h-16 flex-1 items-center gap-3 rounded-l-2xl p-3 text-left hover:bg-white/5">
        <span aria-hidden="true" className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-base font-semibold ${colorFor(m.name)}`}>{m.name.charAt(0).toUpperCase()}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{m.name}</span>
          <span className="block truncate text-xs text-neutral-400">{m.username || "—"}</span>
          <span className="mt-0.5 flex items-center gap-2 text-[11px] text-neutral-500">
            <span>{m.category}</span><span aria-hidden="true">•</span>
            <span className={m.reused || m.strength === "weak" ? "text-amber-300" : ""}>{m.unreadable ? "ilegível" : m.reused ? "senha repetida" : m.strength === "weak" ? "senha fraca" : "senha cadastrada"}</span>
          </span>
        </span>
      </button>
      <button type="button" onClick={onOpen} aria-label={`Opções de ${m.name}`} className="rounded-r-2xl px-3 text-neutral-400 hover:bg-white/5"><DotsIcon /></button>
    </li>
  );
}

function ManualCopy({ id, onClose }: { id: string; onClose: () => void }) {
  const vault = useVault();
  const [pw, setPw] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    vault.getPayload(id).then((p) => alive && setPw(p?.password ?? null));
    const t = setTimeout(onClose, 20_000); // some sozinho
    return () => { alive = false; clearTimeout(t); setPw(null); };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-300">O navegador não permitiu copiar automaticamente. Selecione e copie abaixo — esta janela se fecha em 20 segundos.</p>
      <input readOnly value={pw ?? "…"} onFocus={(e) => e.currentTarget.select()} aria-label="Senha para cópia manual" className={`${inputCls} font-mono`} />
      <Button variant="ghost" onClick={onClose} className="w-full">Fechar</Button>
    </div>
  );
}

function Settings() {
  const vault = useVault();
  const m = vault.meta;
  return (
    <div className="space-y-5">
      <label className="block text-sm">
        <span className="text-xs text-neutral-400">Bloquear automaticamente após</span>
        <select className={`${inputCls} mt-1.5`} value={vault.lockMinutes} onChange={(e) => vault.setLockMinutes(Number(e.target.value))}>
          {LOCK_CHOICES.map((c) => <option key={c} value={c}>{c} {c === 1 ? "minuto" : "minutos"} de inatividade</option>)}
        </select>
      </label>
      <Button variant="ghost" onClick={vault.lock} className="w-full"><LockIcon />Bloquear agora</Button>
      {m && (
        <dl className="space-y-1 rounded-xl border border-white/10 p-3 text-xs text-neutral-400">
          <div className="flex justify-between"><dt>Criptografia</dt><dd>AES-256-GCM (formato v{m.version})</dd></div>
          <div className="flex justify-between"><dt>Derivação de chave</dt><dd>Argon2id v{m.kdf.paramsVersion}</dd></div>
          <div className="flex justify-between"><dt>Memória / iterações</dt><dd>{Math.round(m.kdf.memlimit / 1048576)} MiB / {m.kdf.opslimit}</dd></div>
        </dl>
      )}
      <p className="text-xs text-neutral-500">MFA, exportação cifrada, histórico e troca da senha mestra ainda não estão disponíveis nesta versão.</p>
    </div>
  );
}
