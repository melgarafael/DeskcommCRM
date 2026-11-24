/**
 * Configurações → Tipos de link do contato (#5128).
 *
 * A ficha do contato e o card do funil mostram Instagram, site, Google My
 * Business, LinkedIn e mais cinco tipos. Nem toda operação usa todos: uma
 * clínica não preenche TikTok, e um escritório não preenche Google Meu Negócio.
 * Até aqui o catálogo era fixo no código (`lib/leads/links-de-contato.ts`), então
 * a única saída era conviver com campo que não se usa.
 *
 * A tela marca/desmarca e grava em `organizations.settings.links_de_contato`
 * (`{ tipos: [...] }`). Desmarcar NÃO apaga o que já foi preenchido: o valor
 * continua no `custom_fields` e volta a aparecer se o tipo for marcado de novo.
 *
 * Gate = admin, o mesmo da rota de escrita (`settings/catalogo` é a vizinha que
 * grava configuração da empresa).
 */
import { redirect } from "next/navigation";

import { CabecalhoDaSubTela } from "@/components/settings/CabecalhoDaSubTela";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { tiposDeLinkHabilitados } from "@/lib/leads/tipos-por-organizacao";
import { createClient } from "@/lib/supabase/server";

import { PainelDosTiposDeLink } from "./_painel";

export const metadata = { title: "Tipos de link do contato" };
export const dynamic = "force-dynamic";

export default async function TiposDeLinkPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  // O platform admin sem dívida escreve como admin; o `support` NÃO — o mesmo
  // atalho das vizinhas. `requireSupportWrite` na rota fecha o resto.
  if (
    !(user.is_platform_admin && !user.support) &&
    ROLE_RANK[activeOrg.role] < ROLE_RANK.admin
  ) {
    redirect("/403");
  }

  const supabase = await createClient();
  // Filtra a org ATIVA explicitamente: a policy de leitura deixa passar as duas
  // organizações de quem é membro de duas.
  const { data } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();

  const tipos = tiposDeLinkHabilitados(data?.settings);

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <CabecalhoDaSubTela
        titulo={traduzir("Tipos de link do contato", user.idioma)}
        idioma={user.idioma}
      >
        <p className="max-w-2xl text-sm text-muted-foreground">
          {traduzir(
            "Escolha quais tipos aparecem na ficha do contato e no funil. Desmarcar um tipo não apaga o que já foi preenchido nele: o valor fica guardado e volta a aparecer se você marcar de novo.",
            user.idioma,
          )}
        </p>
      </CabecalhoDaSubTela>

      <PainelDosTiposDeLink tiposIniciais={tipos} />
    </div>
  );
}
