import type { ReactNode } from "react";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { AdminShell } from "@/components/admin/AdminShell";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { modulosLigados } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

export default async function ProtectedAdminLayout({ children }: { children: ReactNode }) {
  const { user } = await requirePlatformAdmin();
  // Mesmo padrão de `app/app/layout.tsx`: o idioma envolve a árvore inteira e
  // recebe o código PRONTO. Sem este Provider, `useT()` nos componentes do
  // admin cai no padrão do Context (pt-BR) e nenhuma tradução aparece, não
  // importa quantas entradas o dicionário tenha — um admin de plataforma é a
  // MESMA conta que o dono do tenant (o install.sh promove o dono a platform
  // admin), então o `user_metadata.locale` dele já existe e é o mesmo lido em
  // `lib/auth/server.ts`.
  const locale = (user.user_metadata?.locale as string | undefined) ?? null;
  // Da INSTALAÇÃO: decide as entradas de módulo do menu (nunca lança: falha fechada).
  const modulos = await modulosLigados(createAdminClient());
  return (
    <IdiomaProvider locale={locale}>
      <AdminShell userEmail={user.email ?? ""} modulosLigados={modulos}>{children}</AdminShell>
    </IdiomaProvider>
  );
}
