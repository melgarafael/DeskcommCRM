import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { ROLE_RANK } from "@/lib/auth/types";

import { MetricsClient } from "./_components/MetricsClient";

export const dynamic = "force-dynamic";

export default async function MetricsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  // spec 13 §6.1: agent vê as próprias (RLS); a comparação por atendente é manager+.
  const canCompare = !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  // `t` local em vez do hook: esta página é componente de SERVIDOR, e lá o
  // idioma vem resolvido em `user.idioma` (a cadeia pessoa → organização →
  // padrão vive em `lib/auth/server.ts`), sem reler o `locale` cru.
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    /*
      Superficie clara — mesmo escopo da Agenda e de Funis. `-m-6` cancela o
      respiro do `<main>` do AppShell para o Paper alcancar a borda, e o `p-6`
      que ja existia aqui o repoe: sem cancelar, seriam 48px e uma moldura
      escura em volta, que e o que denuncia um tema aplicado pela metade.

      Tela unica, entao o escopo mora na propria pagina — Contatos e
      Configuracoes usam `layout.tsx` porque tem varias.
    */
    <div
      data-superficie="clara"
      className="-m-6 flex min-h-[calc(100%+3rem)] flex-col gap-6 bg-bg p-6 text-text"
    >
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Desempenho")}</h1>
        <p className="text-sm text-muted-foreground">
          {canCompare
            ? t("Atrito, funil e performance por atendente nos últimos 30 dias.")
            : t("Atrito, seu funil e sua performance nos últimos 30 dias.")}
        </p>
      </header>

      <MetricsClient canCompare={canCompare} currentUserId={user.id} />
    </div>
  );
}
