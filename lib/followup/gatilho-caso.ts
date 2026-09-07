import { parseServiceBoundary, StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { assertServiceBoundarySupabase } from "@/lib/atendimento/origem";
/**
 * Gatilho de CASO ABERTO (`trigger_config.kind='case_opened'`) — o follow-up
 * passa a nascer sozinho quando o agente abre um caso de escalação, e a morrer
 * sozinho quando esse caso fecha.
 *
 * ## O PAR, e por que ele é uma peça só
 *
 * Este consumidor lê DOIS eventos, não um: `ai.case_opened` cria e
 * `ai.case_closed` cancela. Separar em duas entregas seria um laço aberto —
 * medido no banco de referência, um caso fechou em **6 segundos**, e um
 * enrollment nascido de caso e nunca cancelado só morre por esgotamento ou por
 * resposta do contato. O cliente receberia cobrança sobre um problema que já
 * foi resolvido. É o invariante 7 do Sistema Vivo na forma mais literal: o que
 * abre precisa saber fechar.
 *
 * ## O que este gatilho NÃO casa (a diferença estrutural para o de etapa)
 *
 * `stage_change` casa `to_stage_id` com `params.stage_id`: cada fluxo espera UMA
 * etapa. Aqui não há o que casar — todo caso aberto da organização dispara todo
 * fluxo armado por caso. É por isso que `params` é vazio, e é deliberado:
 * filtrar por `source` ('agent' vs 'guardrail_autofallback') poria jargão de
 * motor na tela de um usuário leigo, e o caso que NINGUÉM escolheu abrir (o
 * fallback de guardrail) é justamente o mais fácil de esquecer — logo o que mais
 * merece acompanhamento. O `source` viaja no payload do evento, então um filtro
 * futuro não exige migração de dado.
 *
 * ## ⚠️ O RISCO QUE ESTE ARQUIVO NÃO RESOLVE SOZINHO, escrito por inteiro
 *
 * Abrir um caso **não** cala o agente: `inbound-turn.ts` instrui o modelo a
 * "CONTINUAR conversando" depois de abrir. Então um follow-up que falasse no
 * mesmo instante poria duas vozes autônomas na mesma conversa. Três defesas, e a
 * terceira é a que fica declarada como PARCIAL:
 *
 *   1. `ai.case_closed` cancela em minutos — o caso que resolve rápido não vira
 *      cobrança.
 *   2. O atraso é do FLUXO, não deste produtor: o nó de espera existe, e a tela
 *      manda começar por ele. Quem monta o fluxo decide quanto esperar.
 *   3. A cadeia de envio do follow-up passa por `runBeforeSend`, que lê
 *      `force_human` — quem assumiu de verdade não é atropelado. **NÃO coberto,
 *      e medido:** `conversations.assignee_kind='user'` e `bot_silenced_until`
 *      NÃO são lidos por essa cadeia. Se o atendente pegou a conversa sem
 *      levantar `force_human`, esta defesa não pega.
 *
 * ## PROVENIÊNCIA e o vínculo com a conversa
 *
 * Este produtor é o PRIMEIRO no repo a escrever `followup_enrollments.conversation_id`.
 * A coluna existe desde a 0054 e é LIDA por `turn-bridge.ts` e `node-handlers.ts`,
 * mas o único "escritor" era o typegen — ninguém gravava. Um caso É de uma
 * conversa: sem esse vínculo o enrollment não sabe dizer de onde veio, e o
 * cancelamento pelo fechamento não teria por onde achar a linha.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { flowGraphSchema } from "./graph-schema";
import { triggerConfigSchema } from "./api-schemas";
import { resolveAgentForAutomaticTrigger, type FollowupGateDb } from "./agent-followup-gate";

/** Os dois eventos deste produtor. Constantes porque o handler, o registro e os
 *  testes precisam do MESMO literal — cópias divergem no primeiro ajuste. */
export const EVENTO_CASO_ABERTO = "ai.case_opened";
export const EVENTO_CASO_FECHADO = "ai.case_closed";

/**
 * Teto de idade do evento.
 *
 * O drain leva 50 linhas por tick e **não tem janela de recência**: tipo sem
 * handler registrado fica `pending` para sempre (medido no banco local:
 * `contact.created` com 40 pendentes, `ai_agent.run_started` com 10). Se a
 * migration subir antes do código — cenário real neste produto, onde o deploy
 * publica código sem gate de schema e o inverso também acontece — o primeiro
 * drain depois disso enrollaria casos de dias atrás de uma vez.
 *
 * 60 min porque o atraso normal do par de crons é de minutos. Atraso
 * INTENCIONAL é papel do nó de espera do fluxo, nunca deste produtor.
 */
export const IDADE_MAXIMA_MS = 60 * 60 * 1000;

/** Pointer ativo armado por caso. Sem `params`: não há o que casar. */
export interface PointerDeCaso {
  id: string;
  organization_id: string;
  active_version_id: string;
}

export interface GatilhoCasoDb {
  carregaPointersDeCaso(orgId: string): Promise<PointerDeCaso[]>;
  /** Fallback: o payload do trigger já traz `contact_id`; isto só roda se faltar. */
  carregaContatoDaConversa(orgId: string, conversationId: string): Promise<string | null>;
  carregaNoDeGatilho(orgId: string, versionId: string): Promise<string | null>;
  insereEnrollment(input: {
    source_case_id?: string | null;
    organization_id: string;
    pointer_id: string;
    version_id: string;
    contact_id: string;
    conversation_id: string;
    current_node_id: string;
    agent_id: string | null;
    // `next_eval_at` OMITIDO de propósito: o `default now()` da 0147 decide. O
    // "agora" do processo é FUTURO para o `now()` do Postgres (17–34 ms medidos)
    // e o claim pularia o tick.
  }): Promise<{ inserted: boolean; id: string | null; reason?: "stale_origin" }>;
  insereEventoDoEnrollment(evento: {
    organization_id: string;
    enrollment_id: string;
    node_id: string | null;
    event_type: string;
    payload: Record<string, unknown>;
    idempotency_key: string;
  }): Promise<void>;
  /** Vivos NASCIDOS DE CASO nesta conversa. Não devolve follow-up de etapa,
   *  silêncio ou manual que o contato tenha — aquele não nasceu daqui e
   *  cancelá-lo seria este gatilho decidindo sobre trabalho alheio. */
  carregaVivosDoCaso(
    orgId: string,
    conversationId: string,
    pointerIds: string[],
  ): Promise<Array<{ id: string; current_node_id: string | null }>>;
  cancelaEnrollment(orgId: string, id: string): Promise<boolean>;
}

export interface GatilhoCasoSummary {
  /** `false` = evento não utilizável por este produtor. */
  matched: boolean;
  pointers_armados: number;
  pointers_barrados_pelo_gate: number;
  enrolled: number;
  skipped_existing: number;
  skipped_stale_origin?: number;
  /** Conversa sem contato — não há a quem escrever. Contado, nunca calado. */
  sem_contato: number;
  cancelados: number;
  /** Evento além do teto de idade: descartado, e o descarte APARECE. */
  vencidos: number;
}

export interface GatilhoCasoDeps {
  db: GatilhoCasoDb;
  gateDb: FollowupGateDb;
  clock: () => Date;
}

function textoOuNulo(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function vazio(): GatilhoCasoSummary {
  return {
    matched: false,
    pointers_armados: 0,
    pointers_barrados_pelo_gate: 0,
    enrolled: 0,
    skipped_existing: 0,
    sem_contato: 0,
    cancelados: 0,
    vencidos: 0,
  };
}

/**
 * `true` quando dá para AFIRMAR que o evento passou do teto.
 *
 * Sem `created_at` devolve `false` — falhar ABERTO na informação: sem a idade
 * não dá para dizer que o evento é velho, e descartar na dúvida perderia um
 * evento bom. `EventRow.created_at` é opcional porque 26 arquivos constroem
 * fixtures; o caminho de produção sempre o traz (o drain o seleciona).
 */
function passouDoTeto(row: EventRow, agora: Date): boolean {
  if (!row.created_at) return false;
  const emitido = Date.parse(row.created_at);
  if (Number.isNaN(emitido)) return false;
  return agora.getTime() - emitido > IDADE_MAXIMA_MS;
}

/**
 * Aplica UMA linha de `ai.case_opened` ou `ai.case_closed`. Chamado pelo adapter
 * do dispatcher (`gatilho-caso.handler.ts`) e direto pelos testes contra
 * Postgres real.
 */
export async function aplicaGatilhoDeCaso(
  deps: GatilhoCasoDeps,
  row: EventRow,
): Promise<GatilhoCasoSummary> {
  const summary = vazio();
  const abriu = row.event_type === EVENTO_CASO_ABERTO;
  const fechou = row.event_type === EVENTO_CASO_FECHADO;
  if (!abriu && !fechou) return summary;

  const conversationId = textoOuNulo(row.payload.conversation_id);
  // Sem conversa o evento não descreve o fato que este gatilho espera.
  // `matched:false` faz o dispatcher registrar 'skipped': o evento fica marcado
  // como visto, não como consumido com efeito.
  if (!conversationId) return summary;
  summary.matched = true;

  const armados = await deps.db.carregaPointersDeCaso(row.organization_id);
  summary.pointers_armados = armados.length;
  if (armados.length === 0) return summary;

  // ---- FECHOU: cancela o que nasceu deste caso, e só isso ----
  if (fechou) {
    // O teto de idade NÃO vale para o cancelamento. Cancelar tarde é melhor que
    // não cancelar: o efeito de um `case_closed` velho é parar de incomodar
    // alguém, nunca começar.
    const vivos = await deps.db.carregaVivosDoCaso(
      row.organization_id,
      conversationId,
      armados.map((p) => p.id),
    );
    for (const vivo of vivos) {
      const ok = await deps.db.cancelaEnrollment(row.organization_id, vivo.id);
      if (!ok) continue;
      summary.cancelados++;
      await deps.db.insereEventoDoEnrollment({
        organization_id: row.organization_id,
        enrollment_id: vivo.id,
        node_id: vivo.current_node_id,
        event_type: "cancelled_by_case_closed",
        payload: {
          case_id: textoOuNulo(row.payload.case_id),
          conversation_id: conversationId,
          status_do_caso: textoOuNulo(row.payload.status),
          event_log_id: row.id,
        },
        idempotency_key: `gatilho-caso-fecha:${row.id}:${vivo.id}`,
      });
    }
    return summary;
  }

  // ---- ABRIU ----
  if (passouDoTeto(row, deps.clock())) {
    // Contado, jamais `return` mudo: o invariante 6 do Sistema Vivo proíbe que
    // um mecanismo desista em silêncio de estado configurável.
    summary.vencidos = armados.length;
    return summary;
  }

  const contatoId =
    textoOuNulo(row.payload.contact_id) ??
    (await deps.db.carregaContatoDaConversa(row.organization_id, conversationId));
  if (!contatoId) {
    summary.sem_contato = armados.length;
    return summary;
  }

  for (const pointer of armados) {
    const agentId = await resolveAgentForAutomaticTrigger(deps.gateDb, row.organization_id, pointer.id);
    if (agentId === null) {
      summary.pointers_barrados_pelo_gate++;
      continue;
    }

    const noDeGatilho = await deps.db.carregaNoDeGatilho(row.organization_id, pointer.active_version_id);
    if (!noDeGatilho) continue;

    const { inserted, id, reason } = await deps.db.insereEnrollment({
      source_case_id: textoOuNulo(row.payload.case_id),
      organization_id: row.organization_id,
      pointer_id: pointer.id,
      version_id: pointer.active_version_id,
      contact_id: contatoId,
      conversation_id: conversationId,
      current_node_id: noDeGatilho,
      agent_id: agentId,
    });
    if (!inserted) {
      if (reason === "stale_origin") summary.skipped_stale_origin = (summary.skipped_stale_origin ?? 0) + 1;
      else summary.skipped_existing++;
      continue;
    }
    summary.enrolled++;

    if (id) {
      await deps.db.insereEventoDoEnrollment({
        organization_id: row.organization_id,
        enrollment_id: id,
        node_id: noDeGatilho,
        event_type: "enrolled_by_case_opened",
        payload: {
          case_id: textoOuNulo(row.payload.case_id),
          conversation_id: conversationId,
          source: textoOuNulo(row.payload.source),
          event_log_id: row.id,
        },
        // Chave pela linha do event_log: re-drain do MESMO evento não escreve
        // a linha duas vezes.
        idempotency_key: `gatilho-caso:${row.id}`,
      });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Adapter de produção — `GatilhoCasoDb` sobre o client service-role real.
// ---------------------------------------------------------------------------

export function createSupabaseGatilhoCasoDb(admin: SupabaseClient): GatilhoCasoDb {
  return {
    async carregaPointersDeCaso(orgId) {
      const { data, error } = await admin
        .from("followup_flow_pointers")
        .select("id, organization_id, active_version_id, trigger_config")
        .eq("organization_id", orgId)
        .eq("status", "active")
        .not("active_version_id", "is", null);
      if (error) throw new Error(error.message);

      const pointers: PointerDeCaso[] = [];
      for (const row of (data ?? []) as Array<{
        id: string;
        organization_id: string;
        active_version_id: string | null;
        trigger_config: unknown;
      }>) {
        if (!row.active_version_id) continue;
        // Mesmo schema do publish: `trigger_config` que não passa nele não arma
        // nada, em vez de armar torto.
        const parsed = triggerConfigSchema.safeParse(row.trigger_config);
        if (!parsed.success || parsed.data.kind !== "case_opened") continue;
        pointers.push({
          id: row.id,
          organization_id: row.organization_id,
          active_version_id: row.active_version_id,
        });
      }
      return pointers;
    },

    async carregaContatoDaConversa(orgId, conversationId) {
      const { data, error } = await admin
        .from("conversations")
        .select("contact_id")
        .eq("id", conversationId)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data?.contact_id ?? null;
    },

    async carregaNoDeGatilho(orgId, versionId) {
      const { data, error } = await admin
        .from("followup_flow_versions")
        .select("graph")
        .eq("organization_id", orgId)
        .eq("id", versionId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const graph = flowGraphSchema.parse(data.graph);
      return graph.nodes.find((n) => n.type === "trigger")?.id ?? null;
    },

    async insereEnrollment(input) {
      const { source_case_id, ...values } = input;
      const { data: source, error: sourceError } = await admin.from("agent_cases").select("context_snapshot")
        .eq("organization_id", input.organization_id).eq("id", source_case_id ?? "").maybeSingle();
      if (sourceError) throw sourceError;
      const boundary = parseServiceBoundary(source?.context_snapshot?.service_boundary);
      if (!boundary) return { inserted: false, id: null, reason: "stale_origin" };
      try { await assertServiceBoundarySupabase(admin, boundary); } catch (error) {
        if (error instanceof StaleServiceBoundaryError) return { inserted: false, id: null, reason: "stale_origin" }; throw error;
      }
      const { data, error } = await admin
        .from("followup_enrollments")
        .insert({ ...values, service_boundary: boundary })
        .select("id")
        .maybeSingle();
      if (error) {
        // 23505 = o contato já está vivo em algum fluxo. Caminho normal.
        if (error.code === "23505") return { inserted: false, id: null };
        throw new Error(error.message);
      }
      return { inserted: true, id: (data as { id: string } | null)?.id ?? null };
    },

    async insereEventoDoEnrollment(evento) {
      const { error } = await admin.from("followup_enrollment_events").insert(evento);
      if (error && error.code !== "23505") throw new Error(error.message);
    },

    async carregaVivosDoCaso(orgId, conversationId, pointerIds) {
      if (pointerIds.length === 0) return [];
      const { data, error } = await admin
        .from("followup_enrollments")
        .select("id, current_node_id")
        .eq("organization_id", orgId)
        .eq("conversation_id", conversationId)
        .in("pointer_id", pointerIds)
        .in("status", ["active", "waiting_reply", "paused_handoff", "paused_manual"]);
      if (error) throw new Error(error.message);
      return (data ?? []) as Array<{ id: string; current_node_id: string | null }>;
    },

    async cancelaEnrollment(orgId, id) {
      // O `.eq("status", ...)` no UPDATE é a trava contra a corrida com o motor:
      // se o tick já concluiu o enrollment entre a leitura e aqui, a linha não
      // casa e devolvemos `false` em vez de ressuscitar um estado terminal.
      const { data, error } = await admin
        .from("followup_enrollments")
        .update({
          status: "cancelled",
          outcome: "handoff",
          cancel_reason: "case_closed",
          next_eval_at: null,
          claimed_until: null,
          completed_at: new Date().toISOString(),
        })
        .eq("organization_id", orgId)
        .eq("id", id)
        .in("status", ["active", "waiting_reply", "paused_handoff", "paused_manual"])
        .select("id");
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    },
  };
}
