import { EVENTO_DE_ETAPA } from "./gatilho-etapa";
/**
 * O OUTRO LADO DO GATILHO DE ETAPA: o toque que a etapa armou morre quando o
 * negócio SAI dela.
 *
 * ─── O que já existia, e o que faltava ─────────────────────────────────────
 *
 * `gatilho-etapa.ts` arma o follow-up quando o card ENTRA numa etapa com fluxo
 * publicado (`trigger_config.kind='stage_change'`). O `condicao-antes-do-envio.ts`
 * cobre o caso do grafo que TEM um nó de condição «está na etapa X?» — ali a
 * decisão é reavaliada no instante do envio e o passo desvia. Mas o grafo que a
 * maioria da operação monta é o curto, `trigger → espera 24 h → enviar`, sem
 * condição nenhuma: nele a etapa é PREMISSA, não ramo. O lead que saiu da etapa
 * às 10h da manhã recebia de qualquer jeito o toque marcado para as 15h — e o
 * toque falava de uma etapa onde ele não está mais.
 *
 * Este módulo é a metade que faltava: consome o MESMO evento, no MESMO
 * dispatcher, e cancela as inscrições que a etapa de ORIGEM armou.
 *
 * ─── Por que NÃO é um segundo motor ────────────────────────────────────────
 *
 * Não há tabela nova, coluna nova, cron novo nem agendador novo. O que este
 * arquivo faz é um UPDATE com guarda em `followup_enrollments` — o mesmo
 * caminho de `reactivity.ts` (inbound, opt-out, handoff) e de `intervencao.ts`
 * (cancelamento humano). Quem envia continua sendo `engine.ts`; quem agenda
 * continua sendo o nó `wait` do grafo; quem decide se ainda deve enviar
 * continua sendo o motor. Aqui só se DESAGENDA.
 *
 * ─── A régua ──────────────────────────────────────────────────────────────
 *
 *   - evento que não descreve saída (`from_stage_id` ausente — negócio nascendo
 *     na etapa; `from === to` — carimbo de reordenação) → `matched:false`, e
 *     nenhuma consulta;
 *   - etapa de origem SEM pointer armado → sai antes de consultar o negócio.
 *     Arrastar card é a operação mais frequente do Kanban; uma ida ao banco por
 *     card para servir quem não configurou nada é custo puro;
 *   - organização sem nenhum fluxo por etapa → o comportamento é o de sempre
 *     (controle da fatia);
 *   - negócio sem contato → não há inscrição a alcançar;
 *   - só morre o que tinha relógio: `active`, `waiting_reply` e `dormente`.
 *     `paused_manual` (uma pessoa pediu a pausa) e `paused_handoff` (o
 *     atendimento está com um humano) NÃO são desfeitos por um arrasto de card
 *     — quem os retoma é quem os pausou, doutrina da 0145 / `reactivity.ts`.
 *
 * ─── Idempotência em duas camadas, como em `reactivity.ts` ─────────────────
 *
 * A linha de `followup_enrollment_events` entra PRIMEIRO, com
 * `idempotency_key = saida-da-etapa:<event_log id>:<enrollment id>`; só quando o
 * insert é de fato novo o patch do enrollment é aplicado. Re-drain do mesmo
 * evento (o dreno reentrega por desenho) não cancela duas vezes nem grava duas
 * linhas de proveniência. A segunda camada é o próprio UPDATE, que casa apenas
 * com `status` ainda na lista dos que morrem — um cancelamento concorrente
 * (opt-out, por exemplo) não é sobrescrito.
 *
 * ─── Proveniência sem coluna nova ──────────────────────────────────────────
 *
 * `cancelled_by_stage_change` é o espelho de `enrolled_by_stage_change`, na
 * mesma timeline que a fila e o dossiê já leem (`eventos-legiveis.ts`). Uma
 * coluna `cancelado_por` em `followup_enrollments` seria uma segunda verdade
 * sobre o mesmo fato (doutrina DIRC).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { triggerConfigSchema } from "./api-schemas";
import type { EnrollmentPatch } from "./engine";
import type { EnrollmentStatus } from "./node-handlers";

/** A linha de timeline que este produtor grava. Espelha `enrolled_by_stage_change`. */
export const EVENTO_DE_SAIDA = "cancelled_by_stage_change";

/** Motivo curto no `cancel_reason` — o que a fila mostra ao operador. */
export const MOTIVO_DA_SAIDA = "Lead saiu da etapa do follow-up";

/**
 * O prefixo com que o PRÓPRIO fluxo se identifica quando move o card.
 *
 * O nó `move_lead` existe (#2065) e é o motor quem escreve a etapa: o
 * `moverLeadNoFunil` do `engine.ts` chama o `moveLeadHandler` com
 * `actor: { type: "webhook_source", id: `followup:<enrollment>` }`, que vira
 * `p_metadata.actor_id` no `lead.stage_changed`. Ou seja: um evento de saída de
 * etapa PODE ter sido causado pela inscrição que ele cancelaria — o toque
 * morreria por ter sido obedecido, e o fluxo que move o card e depois fala
 * dele nunca falaria.
 *
 * Daí o corte: inscrição cujo id é o ator do evento é POUPADA. Só ela — o
 * movimento de OUTRA inscrição do mesmo contato (outro fluxo, mesma etapa de
 * origem) continua cancelando esta, porque o toque desta perdeu a premissa de
 * verdade.
 */
export const PREFIXO_DO_ATOR_DO_FLUXO = "followup:";

/** O id de ator que a inscrição usa quando é ela quem move o card. */
export function atorDoProprioFluxo(enrollmentId: string): string {
  return `${PREFIXO_DO_ATOR_DO_FLUXO}${enrollmentId}`;
}

/**
 * Os status que MORREM com a saída da etapa: os três que ainda tinham um toque
 * por vir. Fora daqui ficam `paused_manual` e `paused_handoff` (pausa de gente),
 * `coletando` (roteiro de atendimento conduzido pelo turno, nunca pelo relógio) e
 * os terminais.
 */
export const STATUS_QUE_MORREM: readonly EnrollmentStatus[] = ["active", "waiting_reply", "dormente"];

/** Um fluxo armado por etapa — só o que este consumidor precisa saber. */
export interface PointerDaSaida {
  id: string;
  stage_id: string;
}

/** A inscrição alcançável — o mínimo para cancelar e provar de onde veio. */
export interface InscricaoAlcancavel {
  id: string;
  pointer_id: string;
  status: EnrollmentStatus;
  current_node_id: string;
}

export interface SaidaDaEtapaDb {
  /** Pointers `stage_change` ativos da org armados NESTA etapa. Lista vazia = nada a fazer. */
  carregaPointersDaEtapa(orgId: string, stageId: string): Promise<PointerDaSaida[]>;
  /** `contact_id` do negócio — `null` quando o negócio não tem contato. */
  carregaContatoDoNegocio(orgId: string, leadId: string): Promise<string | null>;
  /** Inscrições dos pointers armados, para este contato, ainda nos status que morrem. */
  carregaInscricoesVivas(
    orgId: string,
    contatoId: string,
    pointerIds: readonly string[],
  ): Promise<InscricaoAlcancavel[]>;
  /** `inserted:false` = a chave idempotente já existia (re-drain): não reaplicar. */
  insereEventoDoEnrollment(evento: {
    organization_id: string;
    enrollment_id: string;
    node_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    idempotency_key: string;
  }): Promise<{ inserted: boolean }>;
  /**
   * UPDATE com guarda de status. `false` = nenhuma linha casou (já não estava
   * mais na lista dos que morrem), e isso é caminho normal, não erro.
   */
  cancelaInscricao(id: string, orgId: string, patch: EnrollmentPatch): Promise<boolean>;
}

export interface SaidaDaEtapaSummary {
  /** `false` = o evento não descreve saída de etapa (aí nada foi consultado). */
  matched: boolean;
  pointers_armados: number;
  inscricoes_encontradas: number;
  canceladas: number;
  /** Cancelamento concorrente chegou primeiro: nada a fazer, contado e não calado. */
  ja_encerradas: number;
  sem_contato: number;
  /**
   * Inscrições poupadas por serem o ATOR do evento — o próprio fluxo movendo o
   * card. Contado, e não calado: um `matched` com `canceladas:0` sem este número
   * é indistinguível de "não havia o que cancelar".
   */
  proprio_ator: number;
}

export interface SaidaDaEtapaDeps {
  db: SaidaDaEtapaDb;
  clock: () => Date;
}

function textoOuNulo(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function vazio(): SaidaDaEtapaSummary {
  return {
    matched: false,
    pointers_armados: 0,
    inscricoes_encontradas: 0,
    canceladas: 0,
    ja_encerradas: 0,
    sem_contato: 0,
    proprio_ator: 0,
  };
}

function patchDeCancelamento(clock: () => Date): EnrollmentPatch {
  return {
    status: "cancelled",
    cancel_reason: MOTIVO_DA_SAIDA,
    next_eval_at: null,
    claimed_until: null,
    completed_at: clock().toISOString(),
    updated_at: clock().toISOString(),
  };
}

/**
 * Aplica UMA linha de `lead.stage_changed`. Chamado pelo adapter do dispatcher
 * (`saida-da-etapa.handler.ts`) e diretamente pelos testes.
 */
export async function aplicaSaidaDaEtapa(
  deps: SaidaDaEtapaDeps,
  row: EventRow,
): Promise<SaidaDaEtapaSummary> {
  const summary = vazio();
  if (row.event_type !== EVENTO_DE_ETAPA) return summary;

  const etapaDeOrigem = textoOuNulo(row.payload.from_stage_id);
  const etapaDeDestino = textoOuNulo(row.payload.to_stage_id);
  const negocioId = textoOuNulo(row.entity_id);
  // Sem origem não houve saída (é o negócio NASCENDO na etapa, que é trabalho do
  // `gatilho-etapa.ts`). Sem destino o payload não descreve um movimento.
  if (!etapaDeOrigem || !etapaDeDestino || !negocioId) return summary;
  // Carimbo de reordenação no Kanban emite o mesmo `to_stage_id`: nada mudou.
  if (etapaDeOrigem === etapaDeDestino) return summary;
  summary.matched = true;

  const armados = await deps.db.carregaPointersDaEtapa(row.organization_id, etapaDeOrigem);
  summary.pointers_armados = armados.length;
  // A esmagadora maioria das mudanças de etapa não tem fluxo armado na origem:
  // sai ANTES de consultar o negócio.
  if (armados.length === 0) return summary;

  const contatoId = await deps.db.carregaContatoDoNegocio(row.organization_id, negocioId);
  if (!contatoId) {
    summary.sem_contato = 1;
    return summary;
  }

  const inscricoes = await deps.db.carregaInscricoesVivas(
    row.organization_id,
    contatoId,
    armados.map((p) => p.id),
  );
  summary.inscricoes_encontradas = inscricoes.length;
  if (inscricoes.length === 0) return summary;

  const etapaPorPointer = new Map(armados.map((p) => [p.id, p.stage_id]));
  const patch = patchDeCancelamento(deps.clock);
  // Quem pediu o movimento, quando o emissor se identifica. `null` = mão humana,
  // agente, automação, lote ou emissor antigo sem metadata: nada é poupado.
  const autorDoEvento = textoOuNulo(row.metadata.actor_id);

  for (const inscricao of inscricoes) {
    // O fluxo NÃO cancela a si mesmo. O `move_lead` grava
    // `metadata.actor_id = followup:<id da inscrição>`; sem este corte, a
    // inscrição que mandou mover o card apareceria na lista de saída e mataria
    // o próprio toque — o fluxo "move para X, espera, fala de X" nunca falaria.
    // O ator é comparado com o id DESTA inscrição, um por um: o movimento de
    // outro fluxo do mesmo contato continua cancelando esta.
    if (autorDoEvento !== null && autorDoEvento === atorDoProprioFluxo(inscricao.id)) {
      summary.proprio_ator += 1;
      continue;
    }

    // A inscrição PRIMEIRO, a guarda de status depois: um cancelamento
    // concorrente (opt-out, handoff) que chegou antes não é sobrescrito aqui.
    if (!STATUS_QUE_MORREM.includes(inscricao.status)) continue;

    const { inserted } = await deps.db.insereEventoDoEnrollment({
      organization_id: row.organization_id,
      enrollment_id: inscricao.id,
      node_id: inscricao.current_node_id,
      event_type: EVENTO_DE_SAIDA,
      payload: {
        lead_id: negocioId,
        from_stage_id: etapaDeOrigem,
        to_stage_id: etapaDeDestino,
        pointer_id: inscricao.pointer_id,
        stage_id: etapaPorPointer.get(inscricao.pointer_id) ?? etapaDeOrigem,
        event_log_id: row.id,
      },
      idempotency_key: `saida-da-etapa:${row.id}:${inscricao.id}`,
    });
    // Já aplicado nesta entrega: re-drain não cancela de novo.
    if (!inserted) continue;

    if (await deps.db.cancelaInscricao(inscricao.id, row.organization_id, patch)) summary.canceladas += 1;
    else summary.ja_encerradas += 1;
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Adapter de produção — `SaidaDaEtapaDb` sobre o client service-role real.
// ---------------------------------------------------------------------------

export function createSupabaseSaidaDaEtapaDb(admin: SupabaseClient): SaidaDaEtapaDb {
  return {
    async carregaPointersDaEtapa(orgId, stageId) {
      const { data, error } = await admin
        .from("followup_flow_pointers")
        .select("id, trigger_config, surface, status, active_version_id")
        .eq("organization_id", orgId)
        .eq("status", "active")
        .not("active_version_id", "is", null);
      if (error) throw new Error(error.message);

      const pointers: PointerDaSaida[] = [];
      for (const raw of (data ?? []) as Array<{
        id: string;
        trigger_config: unknown;
        surface?: string | null;
      }>) {
        // Roteiro de atendimento (0394) é do turno, nunca do relógio — o mesmo
        // corte que o `gatilho-etapa.ts` faz ao armar. Quem não arma não cancela.
        if (raw.surface === "atendimento") continue;
        const parsed = triggerConfigSchema.safeParse(raw.trigger_config);
        if (!parsed.success || parsed.data.kind !== "stage_change") continue;
        if (parsed.data.params.stage_id !== stageId) continue;
        pointers.push({ id: raw.id, stage_id: parsed.data.params.stage_id });
      }
      return pointers;
    },

    async carregaContatoDoNegocio(orgId, leadId) {
      const { data, error } = await admin
        .from("crm_leads")
        .select("contact_id")
        .eq("id", leadId)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data?.contact_id ?? null;
    },

    async carregaInscricoesVivas(orgId, contatoId, pointerIds) {
      if (pointerIds.length === 0) return [];
      const { data, error } = await admin
        .from("followup_enrollments")
        .select("id, pointer_id, status, current_node_id")
        .eq("organization_id", orgId)
        .eq("contact_id", contatoId)
        .in("pointer_id", [...pointerIds])
        .in("status", [...STATUS_QUE_MORREM]);
      if (error) throw new Error(error.message);
      return ((data ?? []) as Array<{ id: string; pointer_id: string; status: string; current_node_id: string }>).map(
        (e) => ({
          id: e.id,
          pointer_id: e.pointer_id,
          status: e.status as EnrollmentStatus,
          current_node_id: e.current_node_id,
        }),
      );
    },

    async insereEventoDoEnrollment(evento) {
      const { error } = await admin.from("followup_enrollment_events").insert(evento);
      // 23505 é o índice de idempotência: re-drain do mesmo evento, caminho normal.
      if (error) {
        if (error.code === "23505") return { inserted: false };
        throw new Error(error.message);
      }
      return { inserted: true };
    },

    async cancelaInscricao(id, orgId, patch) {
      // `.select("id")` não é enfeite: sem ele um UPDATE que não casa nada
      // responde `error: null` e o código contaria cancelamento que não houve.
      const { data, error } = await admin
        .from("followup_enrollments")
        .update(patch)
        .eq("id", id)
        .eq("organization_id", orgId)
        .in("status", [...STATUS_QUE_MORREM])
        .select("id");
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    },
  };
}
