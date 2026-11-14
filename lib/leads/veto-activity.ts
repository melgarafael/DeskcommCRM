import type pg from "pg";

import { emitAgentActivityForContact } from "@/lib/leads/agent-activity";

export interface VetoActivityInput {
  pool: pg.Pool;
  organizationId: string;
  /** No harness, "lead" é o CONTATO (inbound-turn: leadId = job.contact_id). */
  contactId: string;
  /** `before_send_traces.id` — o lastro desta decisão. */
  traceId: string;
  gate: string;
  code: string;
  agentId?: string | null;
  /**
   * O texto que a IA ia mandar e a trava barrou. Só entra na linha da timeline
   * (`payload.texto_barrado`) — nunca no rastro da cadeia, que não guarda corpo.
   * A anonimização de LGPD esvazia o `payload` desta linha junto com o contato.
   */
  textoBarrado?: string;
  /** O pedaço do texto que acionou a trava (`trechoComercialNaSaida`), quando a trava foi a comercial. */
  trecho?: string | null;
}

/**
 * O agente decidiu NÃO falar — e isso vira linha na timeline.
 *
 * É o evento mais contra-intuitivo da entrega: o silêncio da IA com motivo é
 * informação (o humano vê que houve decisão e por quê); o silêncio sem registro
 * é abandono disfarçado de calmaria. Cenário 11 do §7.
 *
 * Roda no motor do agente, fora do request: escreve pelo `pg.Pool`, mas a linha
 * é montada pela MESMA regra da API (`buildLeadActivityRow`).
 *
 * Nunca lança: um veto registrado com sucesso não pode falhar por causa da
 * timeline dele.
 */
export async function emitVetoActivity(
  input: VetoActivityInput,
): Promise<{ routed: boolean; reason?: string }> {
  const r = await emitAgentActivityForContact({
    pool: input.pool,
    organizationId: input.organizationId,
    contactId: input.contactId,
    type: "send_vetoed",
    // Origem e prova coincidem aqui por natureza: a linha de auditoria do gate
    // é o que originou E o que sustenta. `source_id` fica com o ponteiro,
    // `evidence` com a referência — a fronteira DIRC continua valendo.
    sourceModule: "agent_guardrails",
    sourceId: input.traceId,
    evidence: { trace_ids: [input.traceId] },
    agentId: input.agentId ?? null,
    reason: vetoReason(input.gate, input.code, input.trecho),
    payload: {
      gate: input.gate,
      code: input.code,
      ...(input.textoBarrado !== undefined ? { texto_barrado: input.textoBarrado } : {}),
      ...(input.trecho ? { trecho: input.trecho } : {}),
    },
  });
  return r.routed ? { routed: true } : { routed: false, reason: r.reason };
}

/** Motivo legível — o humano lê "não enviei porque", não um código de gate. */
export function vetoReason(gate: string, code: string, trecho?: string | null): string {
  if (gate === "commercial_restriction") {
    const base = "Não enviei: a mensagem tocava em valores ou negociação, que são só com a equipe";
    return trecho ? `${base} (o texto tinha "${trecho}")` : base;
  }
  // A conversa passou para a equipe: o contato NÃO pediu para parar (#3310).
  if (gate === "stop" && code === "atendimento_com_humano") return "Não enviei: a conversa está com a equipe";
  const porGate: Record<string, string> = {
    stop: "Não enviei: o contato pediu para parar de receber mensagens",
    window: "Não enviei: fora da janela de horário permitida",
    pacing: "Não enviei: limite de ritmo de envio atingido",
    budget: "Não enviei: orçamento de IA esgotado",
    warmup: "Não enviei: número ainda em aquecimento",
    promise: "Não enviei: a mensagem prometia algo que não posso garantir",
    internal_vocabulary:
      "Não enviei: a mensagem usava termos internos do sistema que o cliente não deve ler",
    near_dup:
      "Não enviei: o agente ia repetir quase a mesma mensagem que já foi enviada nesta conversa",
  };
  return porGate[gate] ?? `Não enviei: bloqueado pela regra "${gate}" (${code})`;
}
