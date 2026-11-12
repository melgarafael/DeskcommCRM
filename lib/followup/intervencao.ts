/**
 * As quatro formas de UM HUMANO intervir num follow-up em andamento.
 *
 * Antes disto, a fila oferecia exatamente uma ação: cancelar. Cancelar é porta
 * de saída, não intervenção — quem quisesse segurar o fluxo por dois dias tinha
 * de matá-lo e perder a caminhada, e quem quisesse só empurrar o próximo passo
 * não tinha o que fazer. Pausar, retomar, adiar e pular são o que faltava para
 * o invariante "nenhuma demanda sem próximo passo" valer também na direção
 * humano→IA.
 *
 * ═══ A CORRIDA CONTRA O MOTOR ═══
 *
 * O worker pode estar com este enrollment reclamado (`claimed_until` no futuro)
 * no instante em que a pessoa clica. Duas escritas concorrentes sobre a mesma
 * linha e a última vence: se o humano pausar no meio de um tick, o
 * `updateEnrollment` do engine sobrescreve a pausa com `status:'active'` e o
 * fluxo continua andando — a tela diria "pausado" sobre um follow-up que está
 * mandando mensagem.
 *
 * A defesa é a GUARDA OTIMISTA de `aplicaPatchComGuarda`: o UPDATE só casa se o
 * status ainda for o que foi lido E o enrollment não estiver reclamado. Zero
 * linhas afetadas não é sucesso silencioso — vira 409 com o motivo relido do
 * banco. É "falhar fechado na ação, aberto na informação": na dúvida não age, e
 * nunca esconde de quem clicou o que aconteceu.
 *
 * ⚠️ A OUTRA METADE DA CORRIDA MORA NO `turn-bridge.ts`. Um turno de envio ou de
 * classificação pode terminar DEPOIS da pausa e trazer um resultado calculado
 * antes dela. Lá o descarte é por lista de status, e a lista era negativa
 * ("estes não avançam") — desenho em que todo estado NOVO passa por omissão. Ela
 * virou positiva ("só `active` e `waiting_reply` avançam") no mesmo commit desta
 * entrega; sem isso, a pausa seria desfeita em silêncio pelo turno atrasado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import type { ActivityType } from "@/lib/leads/activity-vocabulary";
import { logger } from "@/lib/logger";

import { resolveAlvoDoRetorno } from "./retorno-crm";
import { flowGraphSchema, type FlowEdge, type FlowNode } from "./graph-schema";
import { carregaEtapasCitadas, nomesDasEtapas } from "./etapas-citadas";
import { rotuloDaAresta } from "./eventos-legiveis";
import type { NomesDeValor } from "./vocabulario";

/** Estados em que o enrollment tem relógio: são os únicos que o motor reclama. */
export const STATUS_COM_RELOGIO = ["active", "waiting_reply"] as const;
export type StatusComRelogio = (typeof STATUS_COM_RELOGIO)[number];

/** O estado da pausa pedida por uma pessoa. Ver a 0145 para por que não é `paused_handoff`. */
export const STATUS_PAUSA_MANUAL = "paused_manual";

/** Teto do adiamento: o mesmo do nó de espera (`waitConfigSchema`), 90 dias. */
export const ADIAMENTO_MAXIMO_MS = 7_776_000_000;

export function podePausar(status: string): boolean {
  return (STATUS_COM_RELOGIO as readonly string[]).includes(status);
}
export function podeRetomar(status: string): boolean {
  return status === STATUS_PAUSA_MANUAL;
}
/** Adiar e pular mexem no relógio e no passo: exigem um enrollment que ainda anda. */
export function podeAdiarOuPular(status: string): boolean {
  return (STATUS_COM_RELOGIO as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// As regras, puras
// ---------------------------------------------------------------------------

/**
 * Quanto ainda faltava de espera no instante em que a pausa começou.
 *
 * Congelar o RESTANTE (e não a data de acordar) é o que faz a retomada honrar o
 * fluxo: pausar por uma semana um follow-up que ia falar em 4h devolve 4h de
 * espera, não uma rajada imediata. Já vencido devolve 0 — retomar deve acordar
 * na hora, que é o que teria acontecido se ninguém tivesse pausado.
 */
export function restanteDaEspera(nextEvalAt: string | null, agora: Date): number {
  if (!nextEvalAt) return 0;
  const t = Date.parse(nextEvalAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, t - agora.getTime());
}

export interface PayloadDaPausa {
  prior_status?: unknown;
  restante_ms?: unknown;
}

/**
 * Para onde a retomada devolve o enrollment.
 *
 * Lê o evento da pausa vigente — o mesmo desenho do `handoff_paused`, que já
 * guarda `prior_status` no payload em vez de gastar uma coluna. Evento ausente
 * (pausa gravada e evento perdido no fire-and-forget) NÃO trava a retomada:
 * volta como `active` agora, que é o estado seguro — o motor reavalia o nó e
 * decide de novo. Travar aqui deixaria o follow-up preso para sempre por causa
 * de uma linha de log que faltou.
 */
export function retomadaApos(
  payload: PayloadDaPausa | null,
  agora: Date,
): { status: StatusComRelogio; next_eval_at: string } {
  const prior = payload?.prior_status;
  const status: StatusComRelogio = prior === "waiting_reply" ? "waiting_reply" : "active";
  const restante =
    typeof payload?.restante_ms === "number" && Number.isFinite(payload.restante_ms) && payload.restante_ms > 0
      ? payload.restante_ms
      : 0;
  return { status, next_eval_at: new Date(agora.getTime() + restante).toISOString() };
}

export type EscolhaDeSaida =
  | { ok: true; edge: FlowEdge }
  | { ok: false; codigo: "sem_caminho" | "escolha_necessaria" | "caminho_invalido"; opcoes: SaidaDoNo[] };

export interface SaidaDoNo {
  edge_id: string;
  target_id: string;
  quando: string;
}

/**
 * Por onde o "pular este passo" segue.
 *
 * Um nó pode ter várias saídas (o `ai_classify` tem uma por classe), e escolher
 * a de maior prioridade no automático seria decidir pelo operador o rumo do
 * atendimento — a tela pergunta. Com saída única, perguntar seria burocracia; com
 * várias, `escolha_necessaria` devolve as opções para a tela oferecer.
 */
export function escolheSaida(
  edges: FlowEdge[],
  from: string,
  edgeIdPedido?: string | null,
  /** O nó de origem — no grafo v2 é ele que conhece o NOME de cada ramo. */
  origem?: FlowNode,
  /** Nome das etapas que as regras do nó citam por id. */
  nomes: NomesDeValor = {},
): EscolhaDeSaida {
  const candidatas = edges.filter((e) => e.source === from).slice().sort((a, b) => b.priority - a.priority);
  const opcoes: SaidaDoNo[] = candidatas.map((e) => ({
    edge_id: e.id,
    target_id: e.target,
    quando: rotuloDaAresta(e, origem, nomes),
  }));

  if (candidatas.length === 0) return { ok: false, codigo: "sem_caminho", opcoes };

  if (edgeIdPedido) {
    const escolhida = candidatas.find((e) => e.id === edgeIdPedido);
    // Aresta que não sai DESTE nó é pedido inválido, não "deixa eu escolher por
    // você": aceitar mandaria o follow-up para um ponto arbitrário do fluxo.
    return escolhida ? { ok: true, edge: escolhida } : { ok: false, codigo: "caminho_invalido", opcoes };
  }

  if (candidatas.length === 1) return { ok: true, edge: candidatas[0]! };
  return { ok: false, codigo: "escolha_necessaria", opcoes };
}

export type ValidacaoDoAdiamento =
  | { ok: true; quando: Date }
  | { ok: false; motivo: "data_invalida" | "data_no_passado" | "data_longe_demais" };

export function validaAdiamento(iso: string, agora: Date): ValidacaoDoAdiamento {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { ok: false, motivo: "data_invalida" };
  // Um minuto de folga: o relógio do navegador e o do servidor não são o mesmo,
  // e recusar "daqui a 10 segundos" por 2s de deriva seria erro de instrumento.
  if (t <= agora.getTime() - 60_000) return { ok: false, motivo: "data_no_passado" };
  if (t - agora.getTime() > ADIAMENTO_MAXIMO_MS) return { ok: false, motivo: "data_longe_demais" };
  return { ok: true, quando: new Date(t) };
}

// ---------------------------------------------------------------------------
// A execução
// ---------------------------------------------------------------------------

export interface DepsDaIntervencao {
  /** Client da SESSÃO do humano: a RLS continua valendo sobre o enrollment. */
  supabase: SupabaseClient;
  /**
   * Service role, e SÓ para a timeline do negócio. `fn_can_view_lead` pode
   * esconder do usuário o negócio dono do contato (visibilidade por dono), e
   * nesse caso a linha da timeline simplesmente não nasceria — a intervenção
   * ficaria invisível para o próximo atendente justamente no caso em que ele
   * mais precisa dela. A organização vem do JWT (`requireRole`), nunca do
   * caminho nem do body, e toda query filtra por ela.
   */
  admin: SupabaseClient;
  orgId: string;
  /**
   * Id da PESSOA da sessão — `null` quando quem age é um token de integração
   * (não existe pessoa; `actorParaAtividade` grava a timeline como sistema).
   */
  userId: string | null;
  /** Id do token, quando quem age é uma integração. Vai no evento e no audit. */
  apiTokenId?: string | null;
  requestId: string;
  agora?: Date;
}

function atorDaIntervencao(deps: DepsDaIntervencao): Actor {
  if (deps.userId) return { type: "user", id: deps.userId };
  // Token de integração: a timeline grava como sistema; o audit leva o id do token.
  return { type: "api_token", id: deps.apiTokenId ?? "desconhecido" };
}

export interface EnrollmentParaIntervir {
  id: string;
  status: string;
  contact_id: string;
  pointer_id: string;
  version_id: string;
  current_node_id: string;
  next_eval_at: string | null;
  claimed_until: string | null;
  steps_taken: number;
}

const COLUNAS = [
  "id",
  "status",
  "contact_id",
  "pointer_id",
  "version_id",
  "current_node_id",
  "next_eval_at",
  "claimed_until",
  "steps_taken",
].join(", ");

export type FalhaDaIntervencao = {
  ok: false;
  codigo:
    | "nao_encontrado"
    | "estado_incompativel"
    | "motor_ocupado"
    | "sem_caminho"
    | "escolha_necessaria"
    | "caminho_invalido"
    | "adiamento_invalido"
    | "erro_interno";
  mensagem: string;
  detalhes?: unknown;
};

export type ResultadoDaIntervencao =
  | { ok: true; enrollment: EnrollmentParaIntervir; status_novo: string; next_eval_at: string | null }
  | FalhaDaIntervencao;

async function carrega(
  deps: DepsDaIntervencao,
  id: string,
): Promise<EnrollmentParaIntervir | null | FalhaDaIntervencao> {
  const { data, error } = await deps.supabase
    .from("followup_enrollments")
    .select(COLUNAS)
    .eq("organization_id", deps.orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) return { ok: false, codigo: "erro_interno", mensagem: error.message };
  return (data as EnrollmentParaIntervir | null) ?? null;
}

interface Patch {
  status?: string;
  next_eval_at?: string | null;
  current_node_id?: string;
  steps_taken?: number;
  claimed_until?: null;
  updated_at: string;
}

/**
 * O UPDATE que só acontece se o mundo não mudou desde a leitura.
 *
 * `.eq("status", ...)` fecha a corrida com qualquer outro escritor (o motor, o
 * reactivity, outra aba). `claimed_until` fecha a corrida com o TICK EM CURSO:
 * um enrollment reclamado está sendo processado, e o `updateEnrollment` do
 * engine vai escrever por cima em instantes.
 *
 * ⚠️ CONTAR AS LINHAS É A METADE QUE FALTA. Um UPDATE que não casa nada devolve
 * sucesso no PostgREST — a tela diria "pausado" e nada teria sido gravado. Por
 * isso `.select("id")` e a contagem: zero linhas é FALHA, com o motivo relido do
 * banco para a mensagem não ser um genérico.
 */
async function aplicaPatchComGuarda(
  deps: DepsDaIntervencao,
  alvo: EnrollmentParaIntervir,
  patch: Patch,
  agoraIso: string,
): Promise<{ ok: true } | FalhaDaIntervencao> {
  const { data, error } = await deps.supabase
    .from("followup_enrollments")
    .update(patch)
    .eq("id", alvo.id)
    .eq("organization_id", deps.orgId)
    .eq("status", alvo.status)
    .or(`claimed_until.is.null,claimed_until.lt.${agoraIso}`)
    .select("id");

  if (error) return { ok: false, codigo: "erro_interno", mensagem: error.message };
  if ((data ?? []).length > 0) return { ok: true };

  const relido = await carrega(deps, alvo.id);
  if (relido && "ok" in relido) return relido;
  if (!relido) return { ok: false, codigo: "nao_encontrado", mensagem: "Follow-up não encontrado." };

  if (relido.claimed_until && Date.parse(relido.claimed_until) > Date.parse(agoraIso)) {
    return {
      ok: false,
      codigo: "motor_ocupado",
      mensagem:
        "O automático está executando este follow-up agora. Nada foi alterado — tente de novo em alguns instantes.",
    };
  }
  return {
    ok: false,
    codigo: "estado_incompativel",
    mensagem: "Este follow-up mudou de estado enquanto você decidia. Nada foi alterado — recarregue e confira.",
  };
}

/**
 * O passo no log do motor.
 *
 * `idempotency_key` fica NULO de propósito: a chave `${nó}:${passo}` pertence ao
 * dedup de replay do engine, e ocupá-la aqui faria a intervenção manual ser
 * confundida com um passo do motor. O índice único é parcial (`where
 * idempotency_key is not null`), então o nulo é livre.
 *
 * Falha vira log e não derruba a intervenção — o estado já mudou no banco, e
 * abortar por causa do registro deixaria o pior dos dois mundos.
 */
async function registraEvento(
  deps: DepsDaIntervencao,
  alvo: EnrollmentParaIntervir,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { error } = await deps.supabase.from("followup_enrollment_events").insert({
    organization_id: deps.orgId,
    enrollment_id: alvo.id,
    node_id: alvo.current_node_id,
    event_type: eventType,
    payload: {
      ...payload,
      actor_user_id: deps.userId,
      // Id de token nunca viaja em campo `*_user_id` — e continua visível.
      ...(deps.apiTokenId ? { actor_api_token_id: deps.apiTokenId } : {}),
    },
  });
  if (error) {
    logger.error("[followup.intervencao] evento não gravado", {
      erro: error.message,
      requestId: deps.requestId,
      enrollmentId: alvo.id,
      eventType,
    });
  }
}

/**
 * A intervenção na vida do NEGÓCIO, com autor humano.
 *
 * Um atendente pausar o follow-up de um lead é informação que o próximo
 * atendente precisa ver no card — e que o AGENTE precisa ver ao retomar, para
 * não reagendar o que uma pessoa acabou de segurar. Mesma regra de linha
 * (`buildLeadActivityRow`) e mesmo par "falha baixo, mas falha contada" do
 * `retorno-crm.ts`: sem negócio a que ancorar, não há linha possível
 * (`lead_id` é NOT NULL) e o que resta é registrar que o rastro não coube.
 */
async function registraNaTimeline(
  deps: DepsDaIntervencao,
  alvo: EnrollmentParaIntervir,
  tipo: ActivityType,
  reason: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const resolucao = await resolveAlvoDoRetorno(deps.admin, deps.orgId, { contactId: alvo.contact_id });
    const leadId = resolucao.ok ? resolucao.alvo.leadId : null;

    if (!leadId) {
      await registraFalhaDeAtividade(deps.admin, {
        organizationId: deps.orgId,
        leadId: alvo.contact_id,
        tipo,
        origem: "lib/followup/intervencao (sem negócio aberto para ancorar)",
        erro: undefined,
        requestId: deps.requestId,
      });
      return;
    }

    const r = await emitLeadActivity(deps.admin, {
      organizationId: deps.orgId,
      leadId,
      contactId: alvo.contact_id,
      type: tipo,
      sourceModule: "followup",
      sourceId: alvo.id,
      actor: atorDaIntervencao(deps),
      reason,
      payload,
    });
    if (!r.ok) {
      await registraFalhaDeAtividade(deps.admin, {
        organizationId: deps.orgId,
        leadId,
        tipo,
        origem: "lib/followup/intervencao",
        erro: r.error,
        requestId: deps.requestId,
      });
    }
  } catch (err) {
    logger.error("[followup.intervencao] timeline do negócio falhou", {
      erro: err instanceof Error ? err.message : String(err),
      requestId: deps.requestId,
      enrollmentId: alvo.id,
    });
  }
}

async function abre(
  deps: DepsDaIntervencao,
  id: string,
  aceita: (status: string) => boolean,
  mensagemDeEstado: string,
): Promise<{ ok: true; alvo: EnrollmentParaIntervir } | FalhaDaIntervencao> {
  const lido = await carrega(deps, id);
  if (lido && "ok" in lido) return lido;
  if (!lido) return { ok: false, codigo: "nao_encontrado", mensagem: "Follow-up não encontrado." };
  if (!aceita(lido.status)) {
    return { ok: false, codigo: "estado_incompativel", mensagem: mensagemDeEstado };
  }
  return { ok: true, alvo: lido };
}

export async function pausaEnrollment(
  deps: DepsDaIntervencao,
  id: string,
): Promise<ResultadoDaIntervencao> {
  const agora = deps.agora ?? new Date();
  const agoraIso = agora.toISOString();
  const aberto = await abre(
    deps,
    id,
    podePausar,
    "Só dá para pausar um follow-up que está andando (ativo ou aguardando resposta).",
  );
  if (!aberto.ok) return aberto;
  const alvo = aberto.alvo;

  const restante = restanteDaEspera(alvo.next_eval_at, agora);
  const aplicado = await aplicaPatchComGuarda(
    deps,
    alvo,
    { status: STATUS_PAUSA_MANUAL, next_eval_at: null, claimed_until: null, updated_at: agoraIso },
    agoraIso,
  );
  if (!aplicado.ok) return aplicado;

  await registraEvento(deps, alvo, "paused_manual", {
    prior_status: alvo.status,
    prior_next_eval_at: alvo.next_eval_at,
    restante_ms: restante,
  });
  await registraNaTimeline(
    deps,
    alvo,
    "followup_paused",
    "O fluxo automático não vai mandar mensagens até alguém retomar",
    { enrollment_id: alvo.id, restante_ms: restante },
  );

  return { ok: true, enrollment: alvo, status_novo: STATUS_PAUSA_MANUAL, next_eval_at: null };
}

export async function retomaEnrollment(
  deps: DepsDaIntervencao,
  id: string,
): Promise<ResultadoDaIntervencao> {
  const agora = deps.agora ?? new Date();
  const agoraIso = agora.toISOString();
  const aberto = await abre(deps, id, podeRetomar, "Este follow-up não está pausado por uma pessoa.");
  if (!aberto.ok) return aberto;
  const alvo = aberto.alvo;

  const { data: eventos } = await deps.supabase
    .from("followup_enrollment_events")
    .select("payload")
    .eq("organization_id", deps.orgId)
    .eq("enrollment_id", alvo.id)
    .eq("event_type", "paused_manual")
    .order("created_at", { ascending: false })
    .limit(1);

  const payloadDaPausa = ((eventos ?? [])[0]?.payload ?? null) as PayloadDaPausa | null;
  const volta = retomadaApos(payloadDaPausa, agora);

  const aplicado = await aplicaPatchComGuarda(
    deps,
    alvo,
    { status: volta.status, next_eval_at: volta.next_eval_at, claimed_until: null, updated_at: agoraIso },
    agoraIso,
  );
  if (!aplicado.ok) return aplicado;

  await registraEvento(deps, alvo, "resumed_manual", {
    status: volta.status,
    next_eval_at: volta.next_eval_at,
  });
  await registraNaTimeline(deps, alvo, "followup_resumed", "O fluxo automático voltou a andar", {
    enrollment_id: alvo.id,
    next_eval_at: volta.next_eval_at,
  });

  return { ok: true, enrollment: alvo, status_novo: volta.status, next_eval_at: volta.next_eval_at };
}

export async function adiaEnrollment(
  deps: DepsDaIntervencao,
  id: string,
  quandoIso: string,
): Promise<ResultadoDaIntervencao> {
  const agora = deps.agora ?? new Date();
  const agoraIso = agora.toISOString();

  const validacao = validaAdiamento(quandoIso, agora);
  if (!validacao.ok) {
    const mensagem =
      validacao.motivo === "data_invalida"
        ? "Data inválida."
        : validacao.motivo === "data_no_passado"
          ? "Escolha um horário no futuro."
          : "O adiamento máximo é de 90 dias.";
    return { ok: false, codigo: "adiamento_invalido", mensagem, detalhes: { motivo: validacao.motivo } };
  }

  const aberto = await abre(
    deps,
    id,
    podeAdiarOuPular,
    "Só dá para adiar um follow-up que está andando (ativo ou aguardando resposta).",
  );
  if (!aberto.ok) return aberto;
  const alvo = aberto.alvo;

  const novo = validacao.quando.toISOString();
  const aplicado = await aplicaPatchComGuarda(
    deps,
    alvo,
    { next_eval_at: novo, claimed_until: null, updated_at: agoraIso },
    agoraIso,
  );
  if (!aplicado.ok) return aplicado;

  await registraEvento(deps, alvo, "snoozed_manual", {
    de: alvo.next_eval_at,
    next_eval_at: novo,
  });
  await registraNaTimeline(deps, alvo, "followup_snoozed", "O próximo passo do fluxo foi remarcado", {
    enrollment_id: alvo.id,
    de: alvo.next_eval_at,
    para: novo,
  });

  return { ok: true, enrollment: alvo, status_novo: alvo.status, next_eval_at: novo };
}

export async function pulaPassoDoEnrollment(
  deps: DepsDaIntervencao,
  id: string,
  edgeId?: string | null,
): Promise<ResultadoDaIntervencao> {
  const agora = deps.agora ?? new Date();
  const agoraIso = agora.toISOString();
  const aberto = await abre(
    deps,
    id,
    podeAdiarOuPular,
    "Só dá para pular o passo de um follow-up que está andando (ativo ou aguardando resposta).",
  );
  if (!aberto.ok) return aberto;
  const alvo = aberto.alvo;

  const { data: versao, error: versaoErr } = await deps.supabase
    .from("followup_flow_versions")
    .select("graph")
    .eq("organization_id", deps.orgId)
    .eq("id", alvo.version_id)
    .maybeSingle();
  if (versaoErr) return { ok: false, codigo: "erro_interno", mensagem: versaoErr.message };
  if (!versao) {
    return { ok: false, codigo: "erro_interno", mensagem: "A versão do fluxo em que este follow-up anda sumiu." };
  }

  const grafo = flowGraphSchema.safeParse(versao.graph);
  if (!grafo.success) {
    return {
      ok: false,
      codigo: "erro_interno",
      mensagem: "A versão do fluxo em que este follow-up anda não pôde ser lida.",
    };
  }

  const origem = grafo.data.nodes.find((n) => n.id === alvo.current_node_id);
  // Os nomes só descrevem as opções: falhar a leitura não pode impedir o pulo —
  // a frase cai em "(não encontrada)" em vez de mostrar o id.
  const citadas = await carregaEtapasCitadas(deps.supabase, deps.orgId, origem ? [origem] : []);
  if (!citadas.ok) {
    logger.warn("[followup.intervencao] nomes das etapas indisponíveis", { enrollment_id: alvo.id, erro: citadas.mensagem });
  }
  const escolha = escolheSaida(
    grafo.data.edges,
    alvo.current_node_id,
    edgeId,
    origem,
    citadas.ok ? nomesDasEtapas(citadas.etapas) : {},
  );
  if (!escolha.ok) {
    const mensagem =
      escolha.codigo === "sem_caminho"
        ? "Este passo não tem saída no fluxo — não há para onde pular."
        : escolha.codigo === "caminho_invalido"
          ? "O caminho escolhido não sai deste passo."
          : "Este passo tem mais de um caminho. Escolha por onde seguir.";
    return { ok: false, codigo: escolha.codigo, mensagem, detalhes: { opcoes: escolha.opcoes } };
  }

  const destino = escolha.edge.target;
  const aplicado = await aplicaPatchComGuarda(
    deps,
    alvo,
    {
      current_node_id: destino,
      // `active` + agora: o passo seguinte é avaliado no próximo tick, que é
      // exatamente o que o motor faria ao avançar sozinho (`advance`).
      status: "active",
      next_eval_at: agoraIso,
      // O passo é CONSUMIDO. Sem isto, o dedup do engine (`${nó}:${passo}`) e o
      // `resolveWaitPhase` (que olha o passo anterior NESTE nó) leriam a chegada
      // ao destino como se fosse a segunda visita ao passo antigo.
      steps_taken: alvo.steps_taken + 1,
      claimed_until: null,
      updated_at: agoraIso,
    },
    agoraIso,
  );
  if (!aplicado.ok) return aplicado;

  await registraEvento(deps, alvo, "skipped_manual", {
    from_node_id: alvo.current_node_id,
    next_node_id: destino,
    edge_id: escolha.edge.id,
  });
  await registraNaTimeline(
    deps,
    alvo,
    "followup_step_skipped",
    "O fluxo seguiu direto para o passo seguinte",
    { enrollment_id: alvo.id, de: alvo.current_node_id, para: destino },
  );

  return { ok: true, enrollment: alvo, status_novo: "active", next_eval_at: agoraIso };
}
