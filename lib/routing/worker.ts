/**
 * Worker de roteamento de conversas (G5-02 — AT-03, spec 13 §5).
 *
 * Doutrina: trigger NUNCA faz HTTP. A entrada da conversa na fila emite
 * `conversation.routing_requested` em `event_log` (trigger AFTER INSERT em
 * conversations, migration 0040); ESTE worker (cron TS) drena o evento, resolve
 * o modo da org e atribui — como service_role (admin client bypassa RLS, então
 * TODA query filtra organization_id vindo do payload confiável do evento).
 *
 * Mecânica de claim = mesma do agent-dispatcher: CAS status pending→processing,
 * `consumed_by` marca o consumidor, `next_attempt_at`/`attempts` reenfileiram.
 * A lógica de decisão (manual/round_robin/no-eligible/replay) é pura em
 * lib/routing/decide.ts; aqui só há I/O.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { filtrarCandidatosExcluidos } from "@/lib/escalacao/devolucao-ao-rodizio";
import { logger } from "@/lib/logger";
import { moduloLigado } from "@/lib/instalacao/modulos";
import {
  decideRouting,
  resolverRoteamentoPorNumero,
  type RegraDoNumero,
} from "@/lib/routing/decide";
import { agenteAtende } from "@/lib/ai/agents/no-ar";
import { resolverAgenteDaConversa, type CandidatoDeAgente } from "@/lib/ai/agents/agente-da-conversa";
import { casoPedePessoa, motivoParaNaoRotear, type MotivoDoCaso } from "@/lib/routing/caso-da-conversa";
import {
  decidirEsperaPelaQualificacao,
  esperaDaLigada,
  leadJaQualificado,
  lerEsperaDoCanal,
  type EsperaDecidida,
} from "@/lib/routing/qualificacao";
import { loadEligibleAttendants, InvalidRoutingChannel, InvalidRoutingSector } from "@/lib/routing/eligibles";
import { routingConfigSchema, type RoutingConfig } from "@/lib/schemas/routing";

export const ROUTING_WORKER_KEY = "worker.routing.v1";
export const ROUTING_EVENT_TYPE = "conversation.routing_requested";

const DEFAULT_BATCH_SIZE = 100;

export type RoutingOutcome =
  | "assigned"
  | "skipped_manual"
  | "skipped_already_assigned"
  | "skipped_unsupported_mode"
  | "requeued_no_eligible"
  | "skipped_invalid_channel"
  | "skipped_invalid_sector"
  | "skipped_conv_missing"
  | "skipped_invalid_payload"
  | "skipped_contato_pessoal"
  /** #3937: contato do tipo `fornecedor` não entra na distribuição automática. */
  | "skipped_contato_fornecedor"
  /** #3717: o caso mais recente da conversa não pede uma pessoa agora. */
  | "skipped_caso_sem_humano"
  /** #3966: a IA está qualificando — a distribuição espera o sinal de fim. */
  | "waiting_qualification"
  | "assign_lost_race"
  | "error";

export interface RoutingSummary {
  batch_size: number;
  outcomes: Record<RoutingOutcome, number>;
  errors: string[];
}

/**
 * A linha como ela sai da VARREDURA (#3878, item 3): sem `payload`/`metadata`.
 *
 * O corpo do evento só existe depois do claim, em `EventRow` — antes disso
 * ninguém pode lê-lo, e é o tipo que impede alguém de "só usar o payload" a
 * partir da varredura e reintroduzir o egress que este corte tirou.
 */
interface EventoDaFila {
  id: string;
  organization_id: string;
  consumed_by: string[];
  attempts: number;
}

interface EventRow extends EventoDaFila {
  payload: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
  claimed_at?: string;
}

const EMPTY_OUTCOMES = (): Record<RoutingOutcome, number> => ({
  assigned: 0,
  skipped_manual: 0,
  skipped_already_assigned: 0,
  skipped_unsupported_mode: 0,
  requeued_no_eligible: 0,
  skipped_invalid_channel: 0,
  skipped_invalid_sector: 0,
  skipped_conv_missing: 0,
  skipped_invalid_payload: 0,
  skipped_contato_pessoal: 0,
  skipped_contato_fornecedor: 0,
  skipped_caso_sem_humano: 0,
  waiting_qualification: 0,
  assign_lost_race: 0,
  error: 0,
});

/**
 * O que a leitura da espera precisa da conversa e do contato (#3966). Um tipo só,
 * com as colunas que o worker já traz no SELECT de `processEvent` — nada de
 * segunda leitura da mesma linha.
 */
export interface ParametrosDaEspera {
  config: RoutingConfig;
  conversa: {
    channel_session_id: string | null;
    contact_id?: string | null;
    active_ai_agent_id?: string | null;
    created_at?: string | null;
    bot_silenced_until?: string | null;
  };
  contato:
    | {
        force_human?: boolean | null;
        ai_opt_out?: boolean | null;
        is_blocked?: boolean | null;
      }
    | null;
  /** Do caso mais recente — `casoPedePessoa(caso.status)`. */
  casoPedePessoa: boolean;
  agora: Date;
}

export interface RoutingWorkerOptions {
  batchSize?: number;
  /** Relógio injetável (testes) — usado na elegibilidade (horário) e no backoff. */
  now?: Date;
}

export async function runRoutingWorker(opts: RoutingWorkerOptions = {}): Promise<RoutingSummary> {
  const admin = createAdminClient();
  const now = opts.now ?? new Date();
  const batchSize = Math.min(Math.max(opts.batchSize ?? DEFAULT_BATCH_SIZE, 1), 500);
  const summary: RoutingSummary = { batch_size: 0, outcomes: EMPTY_OUTCOMES(), errors: [] };

  // Recupera execução interrompida sem criar outro evento. O timestamp do
  // claim cerca o fechamento: um worker antigo não conclui a nova tentativa.
  const { data: abandoned, error: recoveryError } = await admin
    .from("event_log")
    .select("id, organization_id, updated_at")
    .eq("event_type", ROUTING_EVENT_TYPE)
    .eq("status", "processing")
    .lte("updated_at", new Date(now.getTime() - 300_000).toISOString())
    .limit(batchSize);
  if (recoveryError) {
    summary.errors.push("routing_recovery_failed");
    return summary;
  }
  for (const previous of abandoned ?? []) {
    const { error } = await admin
      .from("event_log")
      .update({ status: "pending", next_attempt_at: now.toISOString() })
      .eq("organization_id", previous.organization_id)
      .eq("id", previous.id)
      .eq("status", "processing")
      .eq("updated_at", previous.updated_at);
    if (error) summary.errors.push("routing_recovery_failed");
  }
  // ─── A VARREDURA NÃO LEVA O CORPO DO EVENTO (#3878, item 3) ────────────────
  //
  // `payload`/`metadata` são o JSONB gordo da linha, e este pull traz até 100
  // eventos por tique só para decidir QUAIS reclamar. O corpo é de quem chega
  // ao `processEvent` — um por claim — e vem no `update ... select` do claim
  // (`claimEvent`), que já acontecia: uma linha por evento processado em vez de
  // 100 por tique, sem consulta a mais.
  const { data: rawEvents, error: pullErr } = await admin
    .from("event_log")
    .select("id, organization_id, consumed_by, attempts")
    .eq("event_type", ROUTING_EVENT_TYPE)
    .eq("status", "pending")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now.toISOString()}`)
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (pullErr) {
    summary.errors.push(`event_log_pull_failed: ${pullErr.message}`);
    return summary;
  }

  const naFila = (rawEvents ?? []).filter(
    (e) => !(Array.isArray(e.consumed_by) && e.consumed_by.includes(ROUTING_WORKER_KEY)),
  ) as EventoDaFila[];

  for (const candidato of naFila) {
    // O claim devolve a linha COM o corpo; quem perde a corrida (outro worker
    // pegou) não custa um byte de `payload`/`metadata`.
    const event = await claimEvent(candidato);
    if (!event) continue;
    summary.batch_size += 1;
    try {
      const outcome = await processEvent(event, now);
      summary.outcomes[outcome] += 1;
    } catch (err) {
      summary.outcomes.error += 1;
      const detail = err instanceof Error ? err.message : String(err);
      summary.errors.push(`${event.id}:${detail}`);
      logger.error("[routing-worker] processEvent threw", {
        event_id: event.id,
        organization_id: event.organization_id,
        error: detail,
      });
      await requeueEvent(event, now, event.attempts + 1, { error: detail.slice(0, 200) });
    }
  }

  return summary;
}

async function processEvent(event: EventRow, now: Date): Promise<RoutingOutcome> {
  const admin = createAdminClient();
  const payload = event.payload ?? {};
  const orgId = strOrNull(payload.organization_id) ?? event.organization_id;
  const conversationId = strOrNull(payload.conversation_id);

  if (
    !conversationId ||
    !z.string().uuid().safeParse(conversationId).success ||
    orgId !== event.organization_id
  ) {
    await markDone(event, "skipped_invalid_payload");
    return "skipped_invalid_payload";
  }

  const { data: conv, error: convError } = await admin
    .from("conversations")
    .select(
      "id, organization_id, contact_id, channel_session_id, assigned_to_user_id, status, metadata, last_inbound_at, sector_id, created_at, bot_silenced_until, active_ai_agent_id",
    )
    .eq("id", conversationId)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (convError) throw new Error(convError.message);
  if (!conv || !["open", "pending", "claimed", "ai_handling"].includes(conv.status)) {
    await markDone(event, "skipped_conv_missing");
    return "skipped_conv_missing";
  }

  // Contato pessoal não distribui (spec 21, caminho 9): depois da leitura da
  // conversa — o pulo precisa do contato, que só ela tem.
  //
  // #3937: a MESMA leitura, na MESMA ordem, decide o contato FORNECEDOR
  // (`contacts.contact_type`, issue #3005) — promoção de operadora, comunicado
  // de companhia aérea e recado de grupo comercial chegam pelo mesmo número do
  // cliente e ocupavam carga e capacidade do rodízio. Um contato, uma query,
  // duas réguas: pessoal primeiro porque a dele é a mais forte (tira a conversa
  // da operação inteira); fornecedor depois, e só ele sai da DISTRIBUIÇÃO — a
  // conversa continua no Inbox, sem dono, como hoje.
  // #3966: a MESMA leitura traz as três travas que decidem se a IA está calada
  // nesta conversa. Uma query, três perguntas — e só quando a opção está ligada
  // elas são lidas (ver `esperaDaQualificacao` logo abaixo).
  const { data: contato } = await admin
    .from("contacts")
    .select("is_personal, contact_type, force_human, ai_opt_out, is_blocked")
    .eq("id", conv.contact_id)
    .eq("organization_id", orgId)
    .maybeSingle();
  const contatoDaConversa = contato as
    | {
        is_personal?: boolean;
        contact_type?: string | null;
        force_human?: boolean | null;
        ai_opt_out?: boolean | null;
        is_blocked?: boolean | null;
      }
    | null;
  if (contatoDaConversa?.is_personal === true) {
    await markDone(event, "skipped_contato_pessoal");
    return "skipped_contato_pessoal";
  }
  // Fornecedor: `contact_type` nasce 'cliente' no banco (migration 0763), então
  // quem nunca falou de tipo continua distribuindo. Fornecedor E pessoal já saiu
  // acima — a precedência é a de hoje e não há filtro duplo divergente.
  if (contatoDaConversa?.contact_type === "fornecedor") {
    await markDone(event, "skipped_contato_fornecedor");
    return "skipped_contato_fornecedor";
  }

  // O CASO DA CONVERSA (#3717): a pergunta que a fila nunca fazia. Fica AQUI —
  // depois de a conversa existir no pool e de não ser contato pessoal (não
  // gastar query em quem já saiu) —, e antes de qualquer leitura de config ou
  // de candidatos: o caso barra a conversa ANTES de o rodízio montar a lista.
  const caso = await lerCasoDaConversa(admin, orgId, {
    id: conversationId,
    last_inbound_at: (conv as { last_inbound_at?: string | null }).last_inbound_at ?? null,
  });
  const motivoDoCaso = caso.motivo;

  // organizations.settings.routing → Zod (default manual; knobs = config, não hardcode).
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  if (orgError) throw new Error(orgError.message);
  if (!org) throw new Error("routing_organization_missing");
  const settings = (org?.settings ?? {}) as { routing?: unknown };
  const config = routingConfigSchema.parse(settings.routing ?? {});

  // Regra POR NÚMERO (#2331): o canal pode ter modo próprio e um atendente de
  // destino padrão. Número sem regra (policy ausente ou colunas nulas) cai no
  // comportamento da organização — resolverRoteamentoPorNumero é pura e o
  // resultado é o mesmo que o worker já usava quando não havia coluna.
  const regraDoNumero = await carregarRegraDoNumero(admin, orgId, conv.channel_session_id);
  const efetivo = resolverRoteamentoPorNumero(config, regraDoNumero);

  const alreadyAssigned = Boolean(conv.assigned_to_user_id);
  /**
   * (migration 9062) A FILA da conversa. Quando existe, ela manda em QUEM pode
   * receber — é o que transforma "setor que agrupa" em "fila que distribui".
   * Sem fila (`null`), tudo abaixo é o comportamento de sempre, byte a byte.
   */
  // (revisão do mantenedor, 31/10) O `sector_id` PRECISA vir no select acima.
  // Sem ele o cast antigo devolvia sempre `null` e a conversa com fila era
  // distribuída pelo número — a fila existia e não valia nada.
  const sectorIdBruto = strOrNull(conv.sector_id);
  // Módulo `setores` desligado ⇒ a fila não manda: quem desligou o módulo não
  // espera que a conversa pare de ser distribuída pelo número.
  const sectorId = sectorIdBruto && (await moduloLigado(admin, "setores")) ? sectorIdBruto : null;
  /**
   * O destino padrão NÃO depende da lista de elegíveis do modo: é entrega
   * direta. Mas ele não pode furar a fila: se a conversa tem fila e o destino
   * padrão do número não é membro dela, o destino padrão não vale aqui (a fila
   * é a regra mais específica) e o modo distribui normalmente. Sem esta
   * checagem, o claim recusaria (candidate_not_in_sector) e a conversa
   * ficaria girando em backoff para sempre.
   */
  const viaDestinoPadrao = !alreadyAssigned && Boolean(efetivo.defaultAssigneeUserId)
    && (!sectorId || await ehMembroDaFila(admin, orgId, sectorId, efetivo.defaultAssigneeUserId as string));

  // A DISTRIBUIÇÃO ESPERA A IA QUALIFICAR (#3966). Lida AQUI — depois do caso,
  // da config e da regra do número, e antes de montar a lista de elegíveis — por
  // dois motivos: a decisão depende da config (que acabou de ser lida) e, quando
  // a resposta é "espera", a lista de candidatos não é montada (a conversa não
  // vai ser sorteada neste tick; carregar elegíveis seria query jogada fora).
  const espera = await esperaDaQualificacao(admin, orgId, {
    config,
    conversa: conv as ParametrosDaEspera["conversa"],
    contato: contatoDaConversa,
    casoPedePessoa: caso.pedePessoa,
    agora: now,
  });

  let eligibles: Awaited<ReturnType<typeof loadEligibleAttendants>> = [];
  if (
    !alreadyAssigned &&
    !espera.espera &&
    !viaDestinoPadrao &&
    (efetivo.mode === "round_robin" || efetivo.mode === "load")
  ) {
    try {
      eligibles = await loadEligibleAttendants(admin, orgId, now, sectorId
        ? { kind: "sector", sectorId, channelSessionId: conv.channel_session_id }
        : { kind: "conversation_channel", channelSessionId: conv.channel_session_id });
    } catch (error) {
      if (error instanceof InvalidRoutingSector) {
        // A fila sumiu entre o enfileiramento e o processamento. A conversa não
        // perde nada: o `set null` da FK já a deixou sem fila; o próximo evento
        // a distribui pelo caminho de sempre.
        await notice(orgId, conversationId, "invalid_sector");
        await markDone(event, "skipped_invalid_sector");
        return "skipped_invalid_sector";
      }
      if (!(error instanceof InvalidRoutingChannel)) throw error;
      await notice(orgId, conversationId, "invalid_channel");
      await markDone(event, "skipped_invalid_channel");
      return "skipped_invalid_channel";
    }
  }

  // A EXCLUSÃO DE 24 H DA DEVOLUÇÃO AO RODÍZIO (issue #2985). Quem recebeu esta
  // conversa do rodízio e não respondeu no prazo fica fora dela por um dia
  // (`conversations.metadata.devolucao_ao_rodizio`, escrito pelo cron
  // `rodizio-devolucao`). Sem este corte, o cron devolveria a conversa e o
  // próximo tick deste worker a entregaria à MESMA pessoa — numa instalação com
  // um atendente só, sempre ela. A regra da marca é pura e mora em
  // `lib/escalacao/devolucao-ao-rodizio.ts`.
  const elegiveis = filtrarCandidatosExcluidos(eligibles, conv.metadata, now.getTime());

  const action = decideRouting({
    mode: efetivo.mode,
    alreadyAssigned,
    eligibles: elegiveis,
    config,
    // (revisão do mantenedor, 31/10) O destino padrão só entra no decide quando
    // ele PODE receber. `decideRouting` o prefere incondicionalmente (linha 90);
    // passar o destino padrão barrado pela fila fazia o worker pedir um claim que
    // o banco recusa com `candidate_not_in_sector` — a conversa girava a cada
    // minuto, para sempre, sem aviso. Com fila, quem decide é a lista elegível.
    defaultAssigneeUserId: viaDestinoPadrao ? efetivo.defaultAssigneeUserId : null,
    attempts: event.attempts,
    now,
    motivoDoCaso,
    // `espera` já é a decisão pronta (regra pura em `lib/routing/qualificacao.ts`):
    // aqui só o que o `decideRouting` precisa para agendar o próximo olhar.
    esperaPelaQualificacao: espera.espera
      ? { motivo: espera.motivo, limiteEm: espera.limiteEm }
      : null,
  });

  switch (action.kind) {
    case "assign": {
      // O destino padrão não passou pela régua de elegibilidade (não é
      // rodízio): vai sem snapshot de jornada — a RPC checa disponibilidade e
      // capacidade, mas não compara jornada de quem ninguém escolheu.
      const schedule = viaDestinoPadrao
        ? null
        : (eligibles.find((candidate) => candidate.userId === action.userId)?.scheduleSnapshot ??
          {});
      const { data: result, error } = await admin.rpc("fn_channel_routing_claim", {
        p_org: orgId,
        p_conversation: conversationId,
        p_channel: conv.channel_session_id,
        p_user: action.userId,
        p_reason: "routing",
        p_schedule: schedule,
      });
      if (error) throw new Error(`fn_channel_routing_claim: ${error.message}`);
      if (result === "already_assigned" || result === "conversation_changed") {
        await markDone(event, "assign_lost_race");
        return "assign_lost_race";
      }
      if (result !== "assigned") {
        if (
          ![
            "candidate_revoked",
            "candidate_not_allowed",
            "capacity_changed",
            // (9062) a fila mudou entre a leitura e o claim: reenfileira, não quebra.
            "candidate_not_in_sector",
          ].includes(String(result))
        ) {
          throw new Error("routing_claim_invalid_result");
        }
        await requeueEvent(event, now, Math.min(event.attempts + 1, config.max_retries), {
          reason: result,
        });
        return "requeued_no_eligible";
      }
      const leads = await adotarLeadsDoContato(
        admin,
        orgId,
        strOrNull((conv as { contact_id?: unknown }).contact_id),
        action.userId,
      );
      await markDone(event, "assigned", {
        assigned_to_user_id: action.userId,
        leads_adotados: leads,
      });
      return "assigned";
    }
    case "skip": {
      const outcome: RoutingOutcome =
        action.reason === "manual_mode"
          ? "skipped_manual"
          : action.reason === "already_assigned"
            ? "skipped_already_assigned"
            : action.reason === "caso_aguardando_cliente" || action.reason === "caso_encerrado"
              ? "skipped_caso_sem_humano"
              : "skipped_unsupported_mode";
      if (action.reason.startsWith("unsupported_mode")) {
        logger.warn("[routing-worker] modo não suportado (post-MVP) — no-op", {
          organization_id: orgId,
          mode: config.mode,
        });
      }
      // #3717: o motivo do caso vai para o `metadata` do evento. As duas causas
      // ("esperando o cliente" × "caso concluído") viram o MESMO outcome de
      // contagem — o que se mede é "quantas conversas a fila recusou por causa
      // do caso" —, e a distinção fica no evento para quem for investigar.
      await markDone(
        event,
        outcome,
        outcome === "skipped_caso_sem_humano" ? { motivo_do_caso: action.reason } : {},
      );
      return outcome;
    }
    case "wait": {
      // #3966: o evento continua PENDENTE (não fecha, não conta tentativa) e o
      // próximo olhar é agendado para o backoff — ou para o limite, quando ele
      // chega antes. `notice` NÃO sai aqui: avisar "ninguém disponível" numa
      // conversa que está com a IA seria mentira, e o aviso é único por conversa.
      await requeueEvent(event, now, event.attempts, { reason: action.reason }, action.nextAttemptAt);
      return "waiting_qualification";
    }
    case "requeue": {
      if (action.attempts >= config.max_retries) await notice(orgId, conversationId, "no_eligible");
      await requeueEvent(
        event,
        now,
        action.attempts,
        { reason: "no_eligible" },
        action.nextAttemptAt,
      );
      return "requeued_no_eligible";
    }
  }
}

// --- event lifecycle (mesma mecânica do agent-dispatcher; status ∈ pending|processing|done|dead) ---

async function claimEvent(naFila: EventoDaFila): Promise<EventRow | null> {
  const admin = createAdminClient();
  const claimedAt = new Date().toISOString();
  // O corpo do evento vem DAQUI (#3878, item 3): a varredura acima só trouxe
  // `id/organization_id/consumed_by/attempts`, e este `update ... select` — que
  // já existia para carimbar o claim e ler o `updated_at` — devolve a
  // representação da linha reclamada. Uma linha por evento processado, no mesmo
  // round-trip; nenhum evento que perde o claim paga o JSONB.
  const { data, error } = await admin
    .from("event_log")
    .update({ status: "processing", updated_at: claimedAt })
    .eq("id", naFila.id)
    .eq("organization_id", naFila.organization_id)
    .eq("status", "pending")
    .select("id, updated_at, payload, metadata")
    .maybeSingle();
  if (error) {
    logger.warn("[routing-worker] claim failed", { event_id: naFila.id, error: error.message });
    return null;
  }
  if (!data) return null;
  return {
    ...naFila,
    payload: (data.payload ?? {}) as Record<string, unknown>,
    metadata: (data.metadata ?? null) as Record<string, unknown> | null,
    claimed_at: data.updated_at,
  };
}

async function markDone(
  event: EventRow,
  outcome: RoutingOutcome,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const admin = createAdminClient();
  const consumed = Array.isArray(event.consumed_by) ? event.consumed_by.slice() : [];
  if (!consumed.includes(ROUTING_WORKER_KEY)) consumed.push(ROUTING_WORKER_KEY);
  const { error } = await admin
    .from("event_log")
    .update({
      status: "done",
      consumed_by: consumed,
      metadata: { ...(event.metadata ?? {}), outcome, handled_by: ROUTING_WORKER_KEY, ...extra },
      updated_at: new Date().toISOString(),
    })
    .eq("id", event.id)
    .eq("organization_id", event.organization_id)
    .eq("status", "processing")
    .eq("updated_at", event.claimed_at!);
  if (error)
    logger.warn("[routing-worker] markDone failed", { event_id: event.id, error: error.message });
}

async function requeueEvent(
  event: EventRow,
  now: Date,
  attempts: number,
  extra: Record<string, unknown>,
  nextAttemptAt?: string,
): Promise<void> {
  const admin = createAdminClient();
  const next = nextAttemptAt ?? new Date(now.getTime() + 60_000).toISOString();
  const { error } = await admin
    .from("event_log")
    .update({
      status: "pending",
      attempts,
      next_attempt_at: next,
      metadata: { ...(event.metadata ?? {}), last_requeue: { ...extra, at: now.toISOString() } },
      updated_at: new Date().toISOString(),
    })
    .eq("id", event.id)
    .eq("organization_id", event.organization_id)
    .eq("status", "processing")
    .eq("updated_at", event.claimed_at!);
  if (error)
    logger.warn("[routing-worker] requeue failed", { event_id: event.id, error: error.message });
}

async function notice(orgId: string, conversationId: string, reason: string): Promise<void> {
  const { error } = await createAdminClient().rpc("fn_routing_unassigned_notice", {
    p_org: orgId,
    p_conversation: conversationId,
    p_reason: reason,
  });
  if (error) throw new Error(error.message);
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * A pessoa atende esta fila? (migration 9062)
 *
 * Pergunta única usada para decidir se o destino padrão do número vale dentro
 * da fila. A mesma regra está no claim (`fn_channel_routing_claim`): aqui é
 * para NÃO montar um claim que o banco vai recusar; lá é a garantia de que
 * nenhum caminho entrega fora da fila.
 */
export async function ehMembroDaFila(
  admin: Pick<SupabaseClient, "from">,
  orgId: string,
  sectorId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("attendant_sector_members")
    .select("user_id")
    .eq("organization_id", orgId)
    .eq("sector_id", sectorId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}

/**
 * Lê a regra do NÚMERO (#2331) de `channel_routing_policies`.
 *
 * Ausência de policy = número sem regra própria, e é o estado de TODA
 * instalação existente: as duas colunas nasceram nulas. Devolver `null` (e não
 * um objeto default) é o que faz o worker cair no comportamento da organização.
 */
export async function carregarRegraDoNumero(
  admin: Pick<SupabaseClient, "from">,
  orgId: string,
  channelSessionId: string | null,
): Promise<RegraDoNumero | null> {
  if (!channelSessionId) return null;
  const { data, error } = await admin
    .from("channel_routing_policies")
    .select("distribution_mode, default_assignee_user_id")
    .eq("organization_id", orgId)
    .eq("channel_session_id", channelSessionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as { distribution_mode: string | null; default_assignee_user_id: string | null };
  return {
    distribution_mode: (row.distribution_mode ?? null) as RegraDoNumero["distribution_mode"],
    default_assignee_user_id: row.default_assignee_user_id ?? null,
  };
}

/**
 * A ESPERA PELA QUALIFICAÇÃO, lida do banco (#3966).
 *
 * A REGRA é pura e mora em `lib/routing/qualificacao.ts`; aqui só existe a
 * pergunta "quais são os fatos?". Três leituras, e cada uma só acontece se a
 * anterior deixou a espera de pé — quem desligou a opção paga ZERO query nova
 * neste caminho, e quem não tem agente no número paga uma.
 *
 * ## Por que a opção vem antes de tudo
 *
 * Ela é a única fonte que o dono do negócio controla. Ler agente, contato e
 * estágio de quem nunca ligou a opção seria custo em todo evento de roteamento
 * de toda instalação — e o worker roda um evento por conversa nova, mais um por
 * minuto enquanto alguma espera.
 *
 * ## Falha de leitura distribui (falha ABERTA)
 *
 * Se a leitura do canal, do agente ou do lead estourar, a resposta é "não
 * espera" — o mesmo princípio de `motivoDoCasoParaRoteamento` e do
 * `operator-turn.ts:686` ("na dúvida o aviso sai, que é o erro barato"). Subir a
 * exceção deixaria a conversa sem dono por causa de um SELECT que falhou, e o
 * evento em retry eterno.
 */
export async function esperaDaQualificacao(
  admin: Pick<SupabaseClient, "from">,
  orgId: string,
  p: ParametrosDaEspera,
): Promise<EsperaDecidida> {
  const doNumero = await lerEsperaDoNumero(admin, orgId, p.conversa.channel_session_id);
  const ligada = esperaDaLigada(p.config.distribute_only_after_qualification, doNumero);
  if (!ligada) return { espera: false, motivo: "opcao_desligada", limiteEm: null };

  const iaAtende = await agenteAtendeOCanal(admin, orgId, p.conversa);
  const stage = iaAtende ? await stageDoContato(admin, orgId, p.conversa.contact_id ?? null) : null;

  return decidirEsperaPelaQualificacao({
    ligada,
    iaAtende,
    forceHuman: p.contato?.force_human === true,
    aiOptOut: p.contato?.ai_opt_out === true,
    contatoBloqueado: p.contato?.is_blocked === true,
    botSilencedUntil: p.conversa.bot_silenced_until ?? null,
    casoPedePessoa: p.casoPedePessoa,
    leadQualificado: leadJaQualificado(stage),
    nasceuEm: p.conversa.created_at ?? null,
    agora: p.agora,
    limiteMinutos: p.config.qualification_wait_minutes,
  });
}

/**
 * A opção do NÚMERO, de `channel_sessions.metadata` — o mesmo jsonb em que mora
 * `ai_gate` (#573). `null` = o número não decidiu, herda a organização; é também
 * o que uma leitura que falhou devolve (falha aberta, como o resto do caminho).
 */
export async function lerEsperaDoNumero(
  admin: Pick<SupabaseClient, "from">,
  orgId: string,
  channelSessionId: string | null | undefined,
): Promise<boolean | null> {
  if (!channelSessionId) return null;
  const { data, error } = await admin
    .from("channel_sessions")
    .select("metadata")
    .eq("organization_id", orgId)
    .eq("id", channelSessionId)
    .maybeSingle();
  if (error) {
    logger.warn("[routing-worker] não consegui ler a opção do número — herdando a organização", {
      organization_id: orgId,
      channel_session_id: channelSessionId,
      error: error.message,
    });
    return null;
  }
  return lerEsperaDoCanal((data as { metadata?: unknown } | null)?.metadata);
}

/**
 * Há agente de IA NO AR atendendo o número desta conversa?
 *
 * A pergunta NÃO é nova: `resolverAgenteDaConversa` (`lib/ai/agents/
 * agente-da-conversa.ts`) já responde "qual agente atende esta conversa", com a
 * ordem do motor (stickiness da conversa → versão publicada na sessão → agente
 * único da organização). Aqui ela é usada como o motor a usa, e a única escolha
 * própria é o filtro: só conta quem está `no_ar` (`agenteAtende` — publicado, não
 * pausado, não arquivado). O `rag_bot` legado sem versão publicada fica FORA de
 * propósito: `precisaRecuperarLegado` é elegibilidade de recuperação e triagem,
 * nunca permissão para responder — e uma IA que não responde não qualifica
 * ninguém, então não há o que esperar dela.
 *
 * Dois agentes e nenhum vínculo com o número devolve `null` (indefinido) — e
 * indefinido responde `false`: sem saber que há IA aqui, distribuir é o
 * comportamento de hoje.
 */
export async function agenteAtendeOCanal(
  admin: Pick<SupabaseClient, "from">,
  orgId: string,
  conversa: ParametrosDaEspera["conversa"],
): Promise<boolean> {
  try {
    const { data, error } = await admin
      .from("ai_agents")
      .select("id, kind, is_active, paused_at, published_version_id, archived_at, priority, created_at")
      .eq("organization_id", orgId)
      .is("archived_at", null);
    if (error) throw new Error(error.message);
    const atendem = ((data ?? []) as unknown as CandidatoDeAgente[]).filter(agenteAtende);
    if (atendem.length === 0) return false;

    let versoes: string[] = [];
    if (conversa.channel_session_id) {
      const publicadas = await admin
        .from("ai_agent_versions")
        .select("id")
        .eq("organization_id", orgId)
        .eq("channel_session_id", conversa.channel_session_id)
        .eq("status", "published");
      if (publicadas.error) throw new Error(publicadas.error.message);
      versoes = ((publicadas.data ?? []) as { id: string }[]).map((v) => v.id);
    }

    const { agente } = resolverAgenteDaConversa(atendem, {
      active_ai_agent_id: conversa.active_ai_agent_id ?? null,
      versoesPublicadasNaSessao: versoes,
    });
    return agente !== null;
  } catch (err) {
    logger.warn("[routing-worker] não consegui saber se há agente no número — distribuindo", {
      organization_id: orgId,
      channel_session_id: conversa.channel_session_id ?? null,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** `lead_state.stage` do contato (unique por org+contato). Falha aberta: `null`. */
async function stageDoContato(
  admin: Pick<SupabaseClient, "from">,
  orgId: string,
  contactId: string | null,
): Promise<string | null> {
  if (!contactId) return null;
  const { data, error } = await admin
    .from("lead_state")
    .select("stage")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .maybeSingle();
  if (error) return null;
  return (data as { stage?: string | null } | null)?.stage ?? null;
}

/**
 * Lê o caso MAIS RECENTE da conversa e responde se ele tira a conversa da fila
 * (issue #3717). `null` = a fila pode distribuir.
 *
 * ## Por que a leitura é separada da regra
 *
 * `motivoParaNaoRotear` (`lib/routing/caso-da-conversa.ts`) é puro e não sabe o
 * que é um banco; aqui só existe a pergunta "qual é a linha mais recente?".
 * `agent_cases_conv_idx` (organization_id, conversation_id) existe desde a 0066
 * — não há índice novo a criar.
 *
 * ## Falha de leitura distribui (falha ABERTA)
 *
 * Se o SELECT do caso estourar, o worker segue para a decisão com `null`, e não
 * derruba o evento. Mesma escolha de `operator-turn.ts:686` ("na dúvida o aviso
 * sai, que é o erro barato"): subir a exceção reenfileiraria o evento e deixaria
 * a conversa sem dono — o desfecho caro. O erro sai no log, com a org e a
 * conversa, para não sumir.
 */
export async function motivoDoCasoParaRoteamento(
  admin: Pick<SupabaseClient, "from">,
  orgId: string,
  conversa: { id: string; last_inbound_at?: string | null },
): Promise<MotivoDoCaso | null> {
  return (await lerCasoDaConversa(admin, orgId, conversa)).motivo;
}

/**
 * O caso mais recente em DUAS respostas (#3966): o motivo de recusa que já
 * existia (`null` = a fila pode seguir) **e** se ele está pedindo uma pessoa.
 *
 * A distinção importa para a espera pela qualificação: `motivo === null` cobre
 * dois mundos opostos — "não há caso, a IA ainda está trabalhando" e "o caso
 * pede a equipe, a qualificação acabou". Achatar os dois em `null` faria a
 * conversa esperar exatamente no instante em que o humano é chamado.
 *
 * O `motivoDoCasoParaRoteamento` acima continua existindo porque é o contrato
 * que os testes do #3717 fixam; ele delega para cá, uma leitura só.
 */
export async function lerCasoDaConversa(
  admin: Pick<SupabaseClient, "from">,
  orgId: string,
  conversa: { id: string; last_inbound_at?: string | null },
): Promise<{ motivo: MotivoDoCaso | null; pedePessoa: boolean }> {
  const { data, error } = await admin
    .from("agent_cases")
    .select("status, closed_at, updated_at")
    .eq("organization_id", orgId)
    .eq("conversation_id", conversa.id)
    // O MAIS RECENTE, com desempate determinístico: `created_at` sozinho pode
    // empatar (dois casos no mesmo instante) e dois ticks leriam linhas
    // diferentes para a mesma conversa.
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.warn("[routing-worker] não consegui ler o caso da conversa — seguindo para a fila", {
      organization_id: orgId,
      conversation_id: conversa.id,
      error: error.message,
    });
    return { motivo: null, pedePessoa: false };
  }
  const caso = data as {
    status: string;
    closed_at: string | null;
    updated_at: string | null;
  } | null;
  return {
    motivo: motivoParaNaoRotear(
      caso
        ? {
            status: caso.status,
            encerradoEm: caso.closed_at ?? null,
            atualizadoEm: caso.updated_at ?? null,
          }
        : null,
      conversa.last_inbound_at ?? null,
    ),
    pedePessoa: casoPedePessoa(caso?.status),
  };
}

/**
 * O rodízio distribui CONVERSA. Sem esta função ele não distribui LEAD — e é o
 * lead que o dono do negócio olha no funil (issue #144).
 *
 * ## Por que isto existe
 *
 * `fn_conversation_assign` grava `conversations.assigned_to_user_id` e, desde a
 * 9208, adota o negócio quando o contato tem UM aberto sem dono. Esta função
 * cobre o contato com mais de um, que a 9208 não toca (por isso
 * `leads_adotados` conta só esses). Enquanto `visibility_mode` era `all` ou
 * `own_and_unassigned`, ninguém notava: o lead sem dono aparecia para todo
 * mundo. No modo `own` — exatamente o que a issue #144 pede — lead sem dono não
 * aparece para NINGUÉM. O atendente receberia a conversa e o funil dele ficaria
 * vazio. A restrição funcionaria e a fila não existiria.
 *
 * ## As três condições, e por que cada uma
 *
 * Adota só o lead que está `open` (negócio fechado não muda de dono), do
 * `contact_id` da conversa, e **sem dono nenhum** — nem humano (`owner_user_id`)
 * nem agente de IA (`owner_agent_id`). Roubar lead com dono transformaria o
 * rodízio numa reatribuição silenciosa a cada mensagem nova do mesmo contato,
 * que é o oposto de "cada um com a sua carteira".
 *
 * `owner_kind` entra junto com `owner_user_id` de propósito: o CHECK aceita
 * kind nulo, então um lead com dono e sem kind some do filtro por dono e das
 * métricas por kind — drift silencioso já registrado em `leads/_handler.ts`.
 *
 * Best-effort por decisão: a conversa JÁ foi atribuída quando chegamos aqui.
 * Deixar uma exceção subir faria o evento voltar para a fila e tentar atribuir
 * de novo uma conversa que já tem dono — troca um funil incompleto por um
 * retry inútil. O que falhou vira log, e a próxima mensagem do contato tenta
 * de novo.
 */
export async function adotarLeadsDoContato(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  contactId: string | null,
  userId: string,
): Promise<number> {
  if (!contactId) return 0;
  try {
    const { data, error } = await admin
      .from("crm_leads")
      .update({
        owner_user_id: userId,
        owner_kind: "user",
        updated_at: new Date().toISOString(),
      })
      .eq("organization_id", orgId)
      .eq("contact_id", contactId)
      .eq("status", "open")
      .is("owner_user_id", null)
      .is("owner_agent_id", null)
      .select("id");
    if (error) {
      logger.warn("[routing-worker] não consegui dar dono ao lead do contato", {
        organization_id: orgId,
        contact_id: contactId,
        error: error.message,
      });
      return 0;
    }
    return (data ?? []).length;
  } catch (err) {
    logger.warn("[routing-worker] adoção de lead lançou", {
      organization_id: orgId,
      contact_id: contactId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
