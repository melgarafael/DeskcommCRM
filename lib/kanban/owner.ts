import type { Lead, OwnerKind } from "@/lib/types/leads";

/** O que o card precisa saber sobre o dono para desenhá-lo. */
export interface OwnerDisplay {
  kind: OwnerKind;
  name: string | null;
  /** Versão publicada do agente HOJE — resolvida na exibição, nunca no lead. */
  agentVersion: number | null;
}

/**
 * Resolve o dono do negócio (0070) para exibição: humano, agente ou ninguém.
 *
 * Função pura e única — card, filtro e (nas waves seguintes) dossiê e radar
 * leem daqui. Resolver "quem é o dono" dentro de componente é como o board
 * acaba com duas verdades sobre a mesma pessoa.
 *
 * O agente vem anexado ao próprio lead (`owner_agent`, resolvido pela rota do
 * board sem filtro de is_active/archived_at) — e NÃO de uma lista de agentes
 * atribuíveis: aquela lista é o picker e exclui inativos, o que deixaria o dono
 * anônimo assim que alguém desativasse o agente.
 *
 * Tolerante a dado incompleto de propósito: dono cujo nome ainda não carregou
 * vira `name: null` (o badge cai para o rótulo genérico) — nunca "Sem
 * responsável", que mentiria dizendo que o negócio está órfão.
 */
export function resolveLeadOwner(
  lead: Pick<
    Lead,
    "owner_kind" | "owner_user_id" | "owner_agent_id" | "owner_agent" | "owner_user_name"
  >,
  ownerNames: Map<string, string | null> | undefined,
): OwnerDisplay {
  if (lead.owner_kind === "ai" && lead.owner_agent_id) {
    return {
      kind: "ai",
      name: lead.owner_agent?.name ?? null,
      agentVersion: lead.owner_agent?.version_number ?? null,
    };
  }

  if (lead.owner_user_id) {
    // Cobre owner_kind='user' e também bancos anteriores à 0070 (escrita legada
    // sem owner_kind): o dono humano aparece sem depender do backfill.
    return {
      kind: "user",
      // O nome que vem NO PAYLOAD vence: foi resolvido no servidor, do mesmo
      // quadro (`owner_user_name`, #3945), sem depender de a tela ter carregado
      // a lista de membros — e vale até para quem não pode ler `/team/assignable`.
      // `null` (olhei e não há nome) e `undefined` (payload antigo) caem os dois
      // no mapa do time, que é o comportamento anterior a esta fatia.
      name: lead.owner_user_name ?? ownerNames?.get(lead.owner_user_id) ?? null,
      agentVersion: null,
    };
  }

  return { kind: null, name: null, agentVersion: null };
}
