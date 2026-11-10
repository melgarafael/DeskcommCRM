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

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK, escreveComoPlatformAdmin } from "@/lib/auth/types";
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
  const { data } = await supabase
    .from("crm_metas")
    .select("alvo")
    .eq("organization_id", activeOrg.orgId)
    .eq("indicador", "vendas_ganhas")
    .is("pipeline_id", null)
    .eq("periodo", `${mes}-01`)
    .maybeSingle();
  const alvoAtual = ((data as { alvo?: number } | null)?.alvo ?? null) as number | null;

  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Meta de vendas")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "Quanto a empresa quer vender neste mês. O Desempenho passa a mostrar o quanto já foi feito contra esse número — o realizado, o percentual e o quanto falta.",
          )}
        </p>
      </header>

      <FormularioDaMeta mes={mes} alvoAtual={alvoAtual} />

      <p className="max-w-2xl text-xs text-muted-foreground">
        {t(
          "Nesta primeira versão a meta é da EMPRESA inteira, para a quantidade de vendas ganhas: o que conta é o negócio fechado como ganho dentro do mês. Meta por vendedor, por período maior e por funil ficam para as próximas fatias.",
        )}
      </p>
    </div>
  );
}
