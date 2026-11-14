"use client";
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { CloseIcon, ShieldIcon } from "./icons";

export function Logo({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <div className="flex items-center gap-2 text-blue-400">
      <ShieldIcon width={size === "lg" ? 34 : 22} height={size === "lg" ? 34 : 22} />
      <span className={`whitespace-nowrap font-semibold ${size === "lg" ? "text-2xl tracking-[0.25em]" : "text-xs tracking-[0.18em]"}`}>VAULT GUARD</span>
    </div>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" };
export function Button({ variant = "primary", className = "", ...p }: BtnProps) {
  const styles = {
    primary: "bg-blue-500 text-white hover:bg-blue-400 disabled:bg-blue-500/40",
    ghost: "border border-white/10 bg-white/5 text-neutral-200 hover:bg-white/10 disabled:opacity-50",
    danger: "bg-red-500/90 text-white hover:bg-red-500 disabled:opacity-50",
  }[variant];
  return <button type="button" {...p} className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition ${styles} ${className}`} />;
}

export const inputCls =
  "min-h-11 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-sm text-neutral-100 placeholder:text-neutral-500 outline-none focus:border-blue-400";

export function Field({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: string }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-neutral-400">{label}</label>
      {children(id)}
      {hint && <p className="text-xs text-neutral-500">{hint}</p>}
    </div>
  );
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/70 sm:items-center" onClick={onClose}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-white/10 bg-[#12151a] p-5 outline-none sm:rounded-3xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" aria-label="Fechar" onClick={onClose} className="rounded-lg p-2 text-neutral-400 hover:bg-white/10"><CloseIcon /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function LocalModeBanner() {
  return (
    <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
      <strong>Modo local.</strong> Os dados ficam cifrados só neste navegador, sem login e sem sincronização. Limpar os dados do site apaga o cofre.
    </p>
  );
}
