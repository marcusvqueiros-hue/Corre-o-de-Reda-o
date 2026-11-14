"use client";
import { useState } from "react";
import { DEFAULT_GENERATOR, MAX_LENGTH, MIN_LENGTH, type GeneratorOptions, entropyBits, generatePassword } from "@/lib/generator";
import { copySecret } from "@/lib/clipboard";
import { Button } from "./ui";
import { CopyIcon, RefreshIcon } from "./icons";

/** `onUse` devolve a senha gerada ao formulário. A senha só vive neste estado local. */
export function GeneratorPanel({ onUse, onCopied }: { onUse?: (pw: string) => void; onCopied?: (ok: boolean) => void }) {
  const [opts, setOpts] = useState<GeneratorOptions>(DEFAULT_GENERATOR);
  const [pw, setPw] = useState(() => generatePassword(DEFAULT_GENERATOR));
  const bits = entropyBits(opts);
  const level = bits >= 100 ? ["Excelente", "bg-emerald-400"] : bits >= 70 ? ["Forte", "bg-blue-400"] : ["Moderada", "bg-amber-400"];

  const update = (next: GeneratorOptions) => {
    const none = !next.upper && !next.lower && !next.digits && !next.symbols;
    if (none) return; // mantém ao menos um tipo
    setOpts(next);
    setPw(generatePassword(next));
  };
  const toggles: [keyof GeneratorOptions, string][] = [
    ["upper", "Maiúsculas"], ["lower", "Minúsculas"], ["digits", "Números"], ["symbols", "Especiais"], ["excludeAmbiguous", "Sem ambíguos (0/O, 1/l/I)"],
  ];
  return (
    <div className="space-y-4">
      <div className="break-all rounded-xl border border-white/10 bg-black/50 p-3 font-mono text-sm" data-testid="generated-password">{pw}</div>
      <div className="flex items-center gap-2 text-xs text-neutral-400">
        <span className={`h-2 w-2 rounded-full ${level[1]}`} />
        {level[0]} · ≈ {bits} bits de entropia
      </div>
      <label className="block text-xs text-neutral-400">
        Comprimento: <span className="text-neutral-100">{opts.length}</span>
        <input type="range" min={MIN_LENGTH} max={MAX_LENGTH} value={opts.length} aria-label="Comprimento da senha"
          onChange={(e) => update({ ...opts, length: Number(e.target.value) })} className="mt-1 w-full accent-blue-500" />
      </label>
      <div className="grid grid-cols-2 gap-2">
        {toggles.map(([k, label]) => (
          <label key={k} className="flex min-h-11 items-center gap-2 rounded-xl border border-white/10 px-3 text-xs">
            <input type="checkbox" checked={Boolean(opts[k])} onChange={(e) => update({ ...opts, [k]: e.target.checked })} className="accent-blue-500" />
            {label}
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => setPw(generatePassword(opts))} className="flex-1"><RefreshIcon />Gerar novamente</Button>
        <Button variant="ghost" onClick={async () => onCopied?.((await copySecret(pw)).ok)} aria-label="Copiar senha gerada"><CopyIcon />Copiar</Button>
      </div>
      {onUse && <Button onClick={() => onUse(pw)} className="w-full">Usar esta senha</Button>}
    </div>
  );
}
