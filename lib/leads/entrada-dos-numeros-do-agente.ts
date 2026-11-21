/**
 * ONDE NASCEM OS CARDS DAS CONVERSAS NOVAS DE UM AGENTE (#4940).
 *
 * A tela do agente avisa quando o funil de entrada fica fora dos funis que ele
 * pode mexer. Desde o #4921 esse funil é por número, então a tela precisa saber
 * duas coisas:
 *
 *  1. **Os números que chegam a este agente por roteador** — por roteador ATIVO,
 *     com a régua do turno (`resolve-turn-agent.ts`): roteador com regras por
 *     remetente leva a conversa aos agentes das regras ou ao de reserva (os
 *     membros não entram); sem regras, aos membros ou ao de reserva. Só números
 *     vivos (os da lista oferecível, que já exclui arquivado). O número escolhido
 *     no próprio formulário a tela já tem.
 *  2. **O funil onde nasce o card de cada número** — pela MESMA função que o
 *     nascimento do lead usa (`funilDoNumero`), para o aviso nunca discordar do
 *     que acontece de verdade: funil arquivado, etapa escolhida que não serve
 *     mais e funil sem etapa aberta caem no funil padrão, aqui e lá. Uma leitura
 *     só para todos os números; a função completa roda só para quem escolheu um
 *     funil (os outros já são o padrão).
 *
 * Campanhas (de prospecção e de anúncio) também podem levar conversa a um
 * agente, mas por conversa, não por número: ficam fora do aviso.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { funilDoNumero } from "./nascimento-do-lead";

export interface EntradasDoAgente {
  /** Por id do número: o funil onde nasce o card. Nulo = o funil padrão da organização. */
  funilDeEntradaPorNumero: Record<string, string | null>;
  /** Números (vivos) dos roteadores ativos que levam conversa a este agente. */
  numerosDoRoteador: string[];
}

interface Roteador {
  id: string;
  channel_session_id: string;
  fallback_agent_id: string | null;
  config: { sender_routes?: unknown } | null;
}

/** Mesma pergunta de `roteadorPorRemetente` (transferir-agente.ts), sobre a linha crua. */
function temRegrasDeRemetente(r: Roteador): boolean {
  const regras = r.config?.sender_routes;
  return regras !== undefined && (!Array.isArray(regras) || regras.length > 0);
}

function agentesDasRegras(r: Roteador): string[] {
  const regras = r.config?.sender_routes;
  return Array.isArray(regras)
    ? regras.flatMap((x) =>
        x && typeof (x as { agent_id?: unknown }).agent_id === "string"
          ? [(x as { agent_id: string }).agent_id]
          : [],
      )
    : [];
}

export async function entradasDoAgente(
  db: SupabaseClient,
  organizationId: string,
  agentId: string,
  numerosVivos: ReadonlyArray<{ id: string }>,
): Promise<EntradasDoAgente> {
  const vivos = [...new Set(numerosVivos.map((n) => n.id))];
  const vivo = new Set(vivos);

  // Um roteador por número, então a lista é do tamanho da lista de números.
  const [roteadores, membros, entradas] = await Promise.all([
    db
      .from("ai_routers")
      .select("id, channel_session_id, fallback_agent_id, config")
      .eq("organization_id", organizationId)
      .eq("is_active", true),
    db
      .from("ai_router_members")
      .select("router_id")
      .eq("organization_id", organizationId)
      .eq("agent_id", agentId),
    vivos.length
      ? db
          .from("channel_sessions")
          .select("id, entry_pipeline_id")
          .eq("organization_id", organizationId)
          .in("id", vivos)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const souMembro = new Set(
    ((membros.data ?? []) as Array<{ router_id: string }>).map((m) => m.router_id),
  );
  const numerosDoRoteador = [
    ...new Set(
      ((roteadores.data ?? []) as Roteador[])
        .filter((r) => vivo.has(r.channel_session_id))
        .filter(
          (r) =>
            r.fallback_agent_id === agentId ||
            (temRegrasDeRemetente(r) ? agentesDasRegras(r).includes(agentId) : souMembro.has(r.id)),
        )
        .map((r) => r.channel_session_id),
    ),
  ];

  // Sem a coluna (banco sem a migration 9430) ou com a leitura falhando, todo
  // número fica no padrão — que é o que o nascimento do lead faz nesse banco.
  const escolheram = entradas.error
    ? []
    : ((entradas.data ?? []) as Array<{ id: string; entry_pipeline_id: string | null }>)
        .filter((n) => n.entry_pipeline_id)
        .map((n) => n.id);
  const resolvidos = await Promise.all(
    escolheram.map(
      async (id) =>
        [id, (await funilDoNumero(db, organizationId, id))?.pipelineId ?? null] as const,
    ),
  );
  const funilDeEntradaPorNumero: Record<string, string | null> = Object.fromEntries(
    vivos.map((id) => [id, null]),
  );
  for (const [id, funil] of resolvidos) funilDeEntradaPorNumero[id] = funil;
  return { funilDeEntradaPorNumero, numerosDoRoteador };
}
