/**
 * ONDE NASCEM OS CARDS DAS CONVERSAS NOVAS DE UM AGENTE (#4940).
 *
 * A tela do agente avisa quando o funil de entrada fica fora dos funis que ele
 * pode mexer. Desde o #4921 esse funil é por número, então a tela precisa saber
 * duas coisas:
 *
 *  1. **Os números que chegam a este agente por roteador** — os roteadores
 *     ATIVOS em que ele é membro ou o agente de reserva. Só números vivos (os da
 *     lista oferecível, que já exclui arquivado): número arquivado não recebe
 *     conversa nova. O número escolhido no próprio formulário a tela já tem.
 *  2. **O funil onde nasce o card de cada número** — pela MESMA função que o
 *     nascimento do lead usa (`funilDoNumero`), para o aviso nunca discordar do
 *     que acontece de verdade: funil arquivado, etapa escolhida que não serve
 *     mais e funil sem etapa aberta caem no funil padrão, aqui e lá.
 *
 * Fica de fora o agente que só recebe conversa por regra de quem escreve dentro
 * do roteador: a regra decide por mensagem, não por número.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { funilDoNumero } from "./nascimento-do-lead";

export interface EntradasDoAgente {
  /** Por id do número: o funil onde nasce o card. Nulo = o funil padrão da organização. */
  funilDeEntradaPorNumero: Record<string, string | null>;
  /** Números (vivos) dos roteadores ativos que levam conversa a este agente. */
  numerosDoRoteador: string[];
}

interface LinhaDeMembro {
  ai_routers: { channel_session_id: string; organization_id: string; is_active: boolean } | null;
}

export async function entradasDoAgente(
  db: SupabaseClient,
  organizationId: string,
  agentId: string,
  numerosVivos: ReadonlyArray<{ id: string }>,
): Promise<EntradasDoAgente> {
  const vivos = new Set(numerosVivos.map((n) => n.id));

  const [membros, reserva] = await Promise.all([
    db
      .from("ai_router_members")
      .select("ai_routers(channel_session_id, organization_id, is_active)")
      .eq("organization_id", organizationId)
      .eq("agent_id", agentId),
    db
      .from("ai_routers")
      .select("channel_session_id")
      .eq("organization_id", organizationId)
      .eq("fallback_agent_id", agentId)
      .eq("is_active", true),
  ]);
  const doRoteador = [
    ...((membros.data ?? []) as unknown as LinhaDeMembro[])
      .map((m) => m.ai_routers)
      .filter((r) => r?.organization_id === organizationId && r.is_active)
      .map((r) => r!.channel_session_id),
    ...((reserva.data ?? []) as Array<{ channel_session_id: string }>).map((r) => r.channel_session_id),
  ];
  const numerosDoRoteador = [...new Set(doRoteador.filter((id) => vivos.has(id)))];

  // Um por número vivo (não só os deste agente): o formulário troca o número na
  // hora, antes de salvar, e o aviso precisa acompanhar sem outra ida ao servidor.
  const entradas = await Promise.all(
    [...vivos].map(async (id) => [id, (await funilDoNumero(db, organizationId, id))?.pipelineId ?? null] as const),
  );
  return { funilDeEntradaPorNumero: Object.fromEntries(entradas), numerosDoRoteador };
}
