/**
 * Configurações → Meta de vendas (issue #3025, fatia 1).
 *
 * ─── Por que a porta fica em Configurações, e não no Desempenho ─────────────
 * O Desempenho é onde se LÊ o progresso — a tela de uso diário, aberta por
 * ATTENDANT e manager. Definir o alvo é decisão de quem administra a empresa, e
 * ela se toma uma vez por mês. Mesma separação das vizinhas: o número se lê em
 * Análise, e se ajusta em Configurações.
 *
 * ─── `manager+`, e a tela diz por quê ───────────────────────────────────────
 * `definirMetaMensal` é quem autoriza na action; aqui o gate é a MESMA
 * régua (o dono da instalação entra), e quem estiver abaixo vai para /403 em vez
 * de ver um formulário que não salva. O ponto de leitura é o client de SESSÃO:
 * a RLS de `crm_metas` deixa qualquer membro LER a meta da empresa, então o
 * valor atual aparece sem client privilegiado nenhum.
 */
import { redirect } from "next/navigation";

import { CabecalhoDaSubTela } from "@/components/settings/CabecalhoDaSubTela";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK, escreveComoPlatformAdmin } from "@/lib/auth/types";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { traduzir } from "@/lib/i18n/dicionario";
import { mesLocal } from "@/lib/metas/periodo";
import { createClient } from "@/lib/supabase/server";

import { FormularioDaMeta } from "./_form";

export const metadata = { title: "Meta de vendas" };
export const dynamic = "force-dynamic";

export default async function MetaDeVendasPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  // O dono da instalação (sem modo suporte) passa; o resto precisa de manager.
  if (!(escreveComoPlatformAdmin(user) && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const mes = mesLocal();
  const supabase = await createClient();
  // Todas as metas do MÊS (empresa, vendedor, funil): o formulário mostra a que
  // já existe para a combinação escolhida em vez de fingir campo vazio. Os
  // outros meses o formulário lê quando a pessoa troca o mês. Leitura que
  // falhou vai como `null`: o formulário tenta de novo, em vez de mostrar
  // "ainda não há meta" para um mês que pode ter.
  const { data, error: erroDasMetas } = await supabase
    .from("crm_metas")
    .select("indicador, vendedor_id, pipeline_id, alvo")
    .eq("organization_id", activeOrg.orgId)
    .eq("periodo", `${mes}-01`);
  const metas = erroDasMetas ? null : (
    (data ?? []) as Array<{ indicador: string; vendedor_id: string | null; pipeline_id: string | null; alvo: number }>
  )
    .filter((m) => m.indicador === "vendas_ganhas" || m.indicador === "valor_vendido")
    .map((m) => ({
      periodo: mes,
      indicador: m.indicador as "vendas_ganhas" | "valor_vendido",
      vendedor_id: m.vendedor_id ?? null,
      pipeline_id: m.pipeline_id ?? null,
      alvo: Number(m.alvo),
    }));
  // Os funis que podem ter meta própria (#4796): os em uso. Arquivado não recebe
  // meta nova — a action recusa o mesmo —, e a meta antiga dele segue no Desempenho.
  const { data: dadosDosFunis } = await supabase
    .from("crm_pipelines")
    .select("id, name")
    .eq("organization_id", activeOrg.orgId)
    .eq("is_archived", false)
    .order("name", { ascending: true });
  const funis = ((dadosDosFunis ?? []) as Array<{ id: string; name: string }>).map((f) => ({
    id: f.id,
    name: f.name,
  }));
  // A unidade do alvo em valor: a moeda que a organização declarou (cai em BRL,
  // o default da coluna, se a linha não vier).
  const moeda = await moedaDaOrganizacao(supabase, activeOrg.orgId);

  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <CabecalhoDaSubTela className="flex flex-col gap-2" titulo={t("Meta de vendas")} idioma={idioma}>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "Quanto a empresa — ou um funil, ou um vendedor — quer vender neste mês, em quantidade de vendas ou em valor. O Desempenho passa a mostrar o quanto já foi feito contra esse número: o realizado, o percentual, o quanto falta e a projeção até o fim do mês.",
          )}
        </p>
      </CabecalhoDaSubTela>

      <FormularioDaMeta mes={mes} metas={metas} moeda={moeda} funis={funis} />

      <p className="max-w-2xl text-xs text-muted-foreground">
        {t(
          "A meta da empresa conta os negócios fechados como ganhos no mês; a do funil, só os daquele funil; a do vendedor, só os dele. Metas por trimestre ficam para uma próxima fatia.",
        )}
      </p>
    </div>
  );
}
