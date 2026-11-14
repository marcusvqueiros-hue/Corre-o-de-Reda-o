"use client";
import { useState } from "react";
import { VaultProvider, useVault } from "@/lib/vault-store";
import { CreateVaultScreen, RecoveryKeyScreen, UnlockScreen } from "./auth-screens";
import { Dashboard } from "./dashboard";
import type { VaultRepository } from "@/lib/repository";
import type { KdfParams } from "@/lib/crypto";

function Router() {
  const { status } = useVault();
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  if (recoveryKey) return <RecoveryKeyScreen recoveryKey={recoveryKey} onDone={() => setRecoveryKey(null)} />;
  if (status === "loading") return <main className="grid min-h-dvh place-items-center text-sm text-neutral-500">Carregando…</main>;
  if (status === "empty") return <CreateVaultScreen onRecoveryKey={setRecoveryKey} />;
  if (status === "locked") return <UnlockScreen />;
  return <Dashboard />;
}

export function App({ repository, kdf }: { repository?: VaultRepository; kdf?: KdfParams }) {
  return <VaultProvider repository={repository} kdf={kdf}><Router /></VaultProvider>;
}
