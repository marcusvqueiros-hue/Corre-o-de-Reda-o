import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "VAULT GUARD", description: "Cofre pessoal de senhas com criptografia de ponta a ponta." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
