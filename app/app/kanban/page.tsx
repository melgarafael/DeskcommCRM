import { redirect } from "next/navigation";

import { Kanban } from "@/lib/ui/icons";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { FunisClient, type FunilDaLista } from "./_client";

export const dynamic = "force-dynamic";

/**
 * A lista de funis — e o lugar onde eles se gerenciam.
 *
 * ⚠️ O FILTRO DE `organization_id` NÃO É REDUNDANTE COM A RLS, e a falta dele era
 * um bug visível: a policy `crm_pipelines_select` libera TODAS as organizações do
 * usuário (`organization_id in fn_user_org_ids()`) e libera tudo para
 * `fn_is_platform_admin()`. Quem participa de duas organizações via as duas
 * listas misturadas — e como o gatilho `trg_seed_default_pipeline_for_org` semeia
 * um funil "Pedidos" em toda organização nova, a tela mostrava várias linhas
 * idênticas, indistinguíveis, cada uma levando a um quadro diferente. A RLS
 * responde "pode ver?"; a tela precisa responder "quer ver agora?".
 *
 * ⚠️ A LEITURA É ABERTA, A ESCRITA É manager+. Ver a lista e abrir o quadro é
 * trabalho de qualquer papel; criar, renomear, reordenar e arquivar é
 * configuração — e é o que `requireRole("manager")` cobra nas rotas.
 * `podeGerenciar` usa o MESMO critério delas (o papel na organização ativa, sem
 * atalho de platform admin, que as rotas não concedem por padrão): mostrar um
 * botão que o servidor recusaria seria prometer o que não se cumpre.
 */
export default async function KanbanPickerPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const supabase = await createClient();
  const { data } = await supabase
    .from("crm_pipelines")
    .select("id, name, slug, description, position, is_default")
    .eq("organization_id", activeOrg.orgId)
    .eq("is_archived", false)
    .order("position");

  const funis = (data ?? []) as FunilDaLista[];
  const podeGerenciar = ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  // Importar planilha é ESCRITA DE OPERAÇÃO, não configuração: quem atende
  // sobe a lista que recebeu. Espelha o `requireRole("agent")` da rota.
  const podeImportar = ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center gap-3">
        <Kanban size={28} className="text-muted-foreground" weight="duotone" />
        {/* Era "Pipelines" — nome de quem construiu o sistema, não de quem
            vende. O comentário anterior aqui listava o preço de trocá-lo
            (`rbac-roles.spec.ts` e `invite-lifecycle.spec.ts`) e dizia que
            uniformizar era decisão do dono do produto. Ela foi tomada, e o preço
            era maior do que o comentário contava: são QUATRO assertions em TRÊS
            specs, e `pipelines-gestao.spec.ts` — a spec da própria feature que
            gerou o comentário — é uma delas. Todas atualizadas junto. */}
        <h1 className="text-2xl font-semibold tracking-tight">{t("Funis")}</h1>
      </header>

      <FunisClient funis={funis} podeGerenciar={podeGerenciar} podeImportar={podeImportar} />
    </div>
  );
}
