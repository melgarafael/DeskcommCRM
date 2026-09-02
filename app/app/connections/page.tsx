import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { ConexoesShell } from "@/components/connections/ConexoesShell";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!user.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }
  const idioma = user.idioma;

  const key = process.env.WAHA_API_KEY;
  const wahaConfigured = Boolean(
    process.env.WAHA_API_BASE_URL && key && key !== "dev_plaintext_change_me",
  );

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
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Conexões", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Por onde seu negócio fala com o cliente. Conecte números por QR ou o número oficial da Meta, e acompanhe a saúde de cada um.",
            idioma,
          )}
        </p>
      </header>
      <ConexoesShell wahaConfigured={wahaConfigured} />
    </div>
  );
}
