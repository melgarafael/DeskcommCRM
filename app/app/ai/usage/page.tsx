import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { BudgetCard } from "@/components/ai/BudgetCard";
import { Card } from "@/components/ui/card";
import { getBudgetStatus } from "@/lib/ai/budget/check";
import {
  avaliarContextoCaro,
  LIMITE_DE_TOKENS_DE_ENTRADA,
  PROPOSITOS_DE_TURNO,
} from "@/lib/ai/usage/agente-caro";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { UsageDashboardClient } from "./_client";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function singleParam(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/** Janela do aviso de contexto caro: os mesmos 30 dias que a tela mostra por padrão. */
const JANELA_DO_AVISO_MS = 29 * 86_400_000;

type SupabaseDaPagina = Awaited<ReturnType<typeof createClient>>;

/**
 * Quantas chamadas de TURNO o agente fez no período — e, quando pedido, quantas
 * passaram do limite de entrada.
 *
 * `count: "exact"` com `head: true` conta no banco sem trazer linha nenhuma: a
 * tela de Uso já foi corrigida uma vez por somar `llm_calls` em JS e parar em
 * `max_rows` (1000). Não voltar a esse caminho por causa de um aviso.
 *
 * `null` é falha de medição — e falha NÃO vira aviso: um aviso baseado em zero
 * inventado acusaria (ou inocentaria) o agente errado.
 */
async function contarTurnos(
  supabase: SupabaseDaPagina,
  orgId: string,
  agentId: string,
  desdeIso: string,
  ateIso: string,
  acimaDoLimite: boolean,
): Promise<number | null> {
  let consulta = supabase
    .from("llm_calls")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("agent_id", agentId)
    .in("purpose", [...PROPOSITOS_DE_TURNO])
    .gte("created_at", desdeIso)
    .lte("created_at", ateIso);
  if (acimaDoLimite) consulta = consulta.gt("input_tokens", LIMITE_DE_TOKENS_DE_ENTRADA);
  const { count, error } = await consulta;
  if (error) {
    logger.warn("ai_usage.contexto_caro_nao_medido", { agentId, error: error.message });
    return null;
  }
  return count ?? 0;
}

export default async function AiUsagePage({ searchParams }: PageProps) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data: agentRows } = await supabase
    .from("ai_agents")
    .select("id, name, is_default")
    .eq("organization_id", activeOrg.orgId)
    .order("is_default", { ascending: false })
    .order("name", { ascending: true });

  const agents = (agentRows ?? []).map(
    (a: { id: string; name: string; is_default?: boolean | null }) => ({
      id: a.id,
      name: a.name,
    }),
  );

  const sp = await searchParams;
  const initial = {
    agent_id: singleParam(sp.agent_id),
    invocation_kind: singleParam(sp.invocation_kind),
    from: singleParam(sp.from),
    to: singleParam(sp.to),
  };

  const budget = await getBudgetStatus(activeOrg.orgId);
  const isAdmin = ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;
  const idioma = user.idioma;

  // Aviso de contexto caro (#4123): a fatia das chamadas de turno acima de 100
  // mil tokens de entrada. Duas contagens por agente — exatas e sem linha
  // trafegando —, e os agentes de uma organização são poucos. A janela é fixa
  // (30 dias) de propósito: o aviso é sobre o hábito do agente, não sobre o
  // recorte que o operador escolheu no filtro logo abaixo.
  const agora = new Date();
  const desdeIso = new Date(agora.getTime() - JANELA_DO_AVISO_MS).toISOString();
  const ateIso = agora.toISOString();
  const avisos = (
    await Promise.all(
      agents.map(async (agente) => {
        const [chamadas, acimaDoLimite] = await Promise.all([
          contarTurnos(supabase, activeOrg.orgId, agente.id, desdeIso, ateIso, false),
          contarTurnos(supabase, activeOrg.orgId, agente.id, desdeIso, ateIso, true),
        ]);
        const medida =
          chamadas === null || acimaDoLimite === null
            ? null
            : { chamadas, acima_do_limite: acimaDoLimite };
        return { agente, aviso: avaliarContextoCaro(medida) };
      }),
    )
  ).filter(({ aviso }) => aviso.avisa);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Uso de IA", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Quanto a inteligência artificial custou, quantas vezes foi chamada, quantos turnos o agente fez, quanto demora uma chamada e quantas vezes precisou chamar uma pessoa — nos últimos 30 dias.",
            idioma,
          )}
        </p>
      </header>
      {avisos.length > 0 && (
        <Card
          className="border-amber-500/40 bg-amber-500/5 p-4"
          data-testid="aviso-contexto-caro"
        >
          <p className="text-sm font-medium">{traduzir("Agente com contexto caro", idioma)}</p>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-muted-foreground">
            {avisos.map(({ agente, aviso }) => (
              <li key={agente.id}>
                <span className="font-medium text-foreground">{agente.name}</span>
                {` — ${aviso.percentual}% `}
                {traduzir(
                  "das chamadas de turno passaram de 100 mil tokens de entrada nos últimos 30 dias",
                  idioma,
                )}
                {` (${aviso.acima_do_limite.toLocaleString("pt-BR")} de ${aviso.chamadas.toLocaleString("pt-BR")}).`}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            {traduzir(
              "Acima de 100 mil tokens de entrada o Claude Haiku 5.5 cobra 5× pela chamada inteira (entrada, saída e cache). Base de conhecimento, ferramentas ou histórico grandes demais costumam ser a causa — reduza o que entra no prompt deste agente.",
              idioma,
            )}
          </p>
        </Card>
      )}
      <BudgetCard initialData={budget} isAdmin={isAdmin} />
      <UsageDashboardClient agents={agents} initial={initial} />
    </div>
  );
}
