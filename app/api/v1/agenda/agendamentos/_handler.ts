import { randomUUID } from "node:crypto";
import type { Json } from "@/lib/database.types";
/**
 * A REGRA de marcar, remarcar e cancelar — fora da rota, de propósito.
 *
 * ⚠️ UMA FERRAMENTA MCP NÃO CHAMA ROTA NEXT. Não há `request`, não há cookie, e
 * a rota devolve `Response` em vez de dado. Por isso este repo tem o padrão do
 * `_handler` — messages, conversations, contacts, leads e pipelines já o usam: a
 * regra mora aqui, e a ROTA e a TOOL chamam a mesma função. A agenda era a
 * exceção, com a regra inline na rota, e por isso as três ferramentas de escrita
 * do agente não tinham o que embrulhar.
 *
 * ⚠️ A ORGANIZAÇÃO ENTRA POR PARÂMETRO (`ctx.organization_id`), nunca resolvida
 * aqui. Quem chama é que sabe de onde ela vem: a rota tira do cookie validado, a
 * tool tira do contexto do agente. Se este arquivo lesse cookie, deixaria de
 * servir à tool — que é o motivo de ele existir.
 *
 * ⚠️ E O `organization_id` VAI EM TODA QUERY. Pelo MCP o client é service-role e
 * a RLS não vale: sem o filtro explícito, a leitura entregaria ao modelo
 * compromisso de outra organização — e ler não devolve erro, então nada
 * quebraria; o agente só passaria a "saber" coisas que não são da casa dele.
 *
 * A recusa sai como `ApiError`: a rota a traduz em `fail()`, a tool a traduz
 * para o modelo, e nenhum dos dois reimplementa a decisão.
 */
import { coletaOQueOcupa, horariosLivresDaOrg } from "@/lib/agenda/consulta";
import { colide } from "@/lib/agenda/horarios-livres";
import {
  atividadeDaTransicao,
  autorParaTimeline,
  gatilhoDaTransicao,
  type SituacaoAnterior,
  type Transicao,
} from "@/lib/agenda/laco";
import {
  ALVO_DE_VINCULO_DO_AGENDAMENTO,
  ENTIDADE_DO_AGENDAMENTO,
  NOME_GENERICO_DO_TIPO,
  VINCULO_DE_AGENDAMENTO,
} from "@/lib/agenda/tipos";
import { ApiError } from "@/lib/api/types";
import type { Actor, HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { roleAtLeast } from "@/lib/auth/types";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import { moverLeadParaEtapaDeAgendamento } from "@/lib/leads/appointment-stage-move";
import { logger } from "@/lib/logger";
import type { SupabaseClient } from "@supabase/supabase-js";

type SB = SupabaseClient;

/** A recusa da coleta vira código de wire — um mapa, não `if` espalhado. */
const CODIGO_DA_RECUSA = {
  tipo_desconhecido: { status: 404, code: "not_found" },
  tipo_desativado: { status: 422, code: "agenda_tipo_desativado" },
  sem_responsavel: { status: 422, code: "agenda_sem_responsavel" },
  jornada_mal_configurada: { status: 422, code: "agenda_disponibilidade_invalida" },
  erro_interno: { status: 500, code: "internal_error" },
} as const;

export interface MarcarInput {
  event_type_id: string;
  starts_at: string;
  owner_user_id?: string;
  contact_id?: string;
  conversation_id?: string;
  title?: string;
  notes?: string;
  /**
   * Observação do compromisso — o campo `description` do calendário externo.
   *
   * Distinto de `notes`: `notes` é anotação INTERNA (numa clínica, queixa) e
   * não entra na revisão publicável (`fn_google_projection_stamp`). Sem este
   * campo a observação gravava em `notes` e o calendário nascia mudo.
   */
  description?: string;
  /**
   * Endereço/local DESTE compromisso. Ausente herda o do tipo; `""` grava
   * vazio — quem apagou o que o tipo sugeria quis apagar, não herdar de novo.
   */
  location_details?: string;
  /**
   * Convidado externo, digitado na tela. `""` limpa; ausente não mexe.
   *
   * NÃO é o e-mail da ficha do contato. O contato (quem é atendido) entra no
   * convite do Google pelo e-mail da ficha, quando existe. Este campo é a outra
   * pessoa — acompanhante, responsável. Quem transforma os dois em `attendees`
   * é o worker de push.
   */
  guest_email?: string;
}

export interface AlterarInput {
  id: string;
  revision?: number;
  outcome_message_id?: string;
  confirmation_next_at?: string;
  starts_at?: string;
  status?: "confirmed" | "completed" | "no_show";
  notes?: string;
  /** Igual ao de `MarcarInput`: `""` desconvida, ausente não mexe. */
  guest_email?: string;
}

export interface CancelarInput {
  id: string;
  revision?: number;
  reason: string;
}

/**
 * A AGENDA DO COLEGA SÓ É DO COLEGA QUANDO A ORGANIZAÇÃO DESLIGA A OPÇÃO.
 *
 * ─── O que era, e por que virou opção ─────────────────────────────────────
 *
 * Qualquer Atendente cancelava e remarcava o compromisso de qualquer colega: a
 * rota nunca perguntou de quem era o compromisso. É o pedido original da issue
 * #978 ("minha agenda seja só minha"), e a decisão do mantenedor no fio
 * (16/09) NÃO foi uma guarda fixa — é uma OPÇÃO POR ORGANIZAÇÃO, LIGADA POR
 * PADRÃO, com rótulo em Configurações › Tipos de agendamento.
 *
 *   LIGADA    (o padrão, e o que já existia): este bloco não faz nada.
 *   DESLIGADA: o Atendente só mexe no compromisso de que é DONO. Gerente e
 *              Administrador seguem mexendo em tudo.
 *
 * ─── A MESMA REGRA ESTÁ NO BANCO, E DE PROPÓSITO ──────────────────────────
 *
 * `fn_appointment_change_core` recusa com `appointment_do_colega` (42501) a
 * mudança de compromisso alheio (migration 0343). Aqui a recusa vem ANTES, com
 * a frase em português e o código de wire próprio, porque a rota é o que uma
 * pessoa vê — e porque o handler também atende MCP e webhook. Duas cópias da
 * mesma regra só valem se a régua for UMA: quem lê a opção é
 * `fn_colegas_podem_mexer_na_agenda`, a mesma função que o núcleo consulta.
 *
 * ─── PARA QUEM VALE, E ISSO É DECLARADO ───────────────────────────────────
 *
 *   * `"user"` — sessão de gente — com papel abaixo de `manager`: recortado por
 *     dono quando a opção está desligada. É o caso que a decisão descreve.
 *   * `ai_agent`, `api_token`, `webhook_source`: NÃO são "um atendente" e não
 *     têm agenda própria. O que os governa continua sendo o papel do token, que
 *     a rota já cobra em `requireRole`, e as permissões de cada ferramenta.
 *     Esta opção não acrescenta recorte por dono para eles — mudar isso seria
 *     inventar escopo que o mantenedor não decidiu.
 *   * Compromisso SEM dono (`owner_user_id` nulo): com a opção desligada o
 *     Atendente não mexe, porque não é a agenda dele. É o lado conservador da
 *     mesma frase, e é o que o banco também faz (`is distinct from auth.uid()`).
 *
 * ─── O QUE ESTA OPÇÃO NÃO MUDA ────────────────────────────────────────────
 *
 * A LEITURA. Quem é Atendente continua recebendo a grade da organização inteira
 * — `useAgendamentos()` não manda `owner_user_id` e o recorte da grade só tem
 * `{de, ate}` (`hooks/agenda/useAgendamentos.ts` e `lib/agenda/consulta.ts`).
 * Isso é decisão do mantenedor, em aberto, e está declarado no PR da issue —
 * não é efeito colateral desta migration.
 */
async function colegasPodemMexerNaAgenda(supabase: SB, ctx: HandlerCtx): Promise<boolean> {
  const { data, error } = await supabase.rpc("fn_colegas_podem_mexer_na_agenda", {
    p_org: ctx.organization_id,
  });
  if (error) throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  // Ausente ou corpo estranho é LIGADO — o padrão, a mesma régua do banco e de
  // `colegasPodemMexerNaAgendaLigado` (lib/schemas/settings.ts).
  return data !== false;
}

/** A recusa de mexer na agenda alheia com a opção desligada — uma frase só. */
const RECUSA_DO_COLEGA =
  "Esta empresa está com “Atendentes podem mexer na agenda dos colegas” desligado: " +
  "você mexe só nos compromissos de que é responsável. Peça a um gerente ou administrador.";

/**
 * A PERGUNTA QUE VEM ANTES DA LEITURA — e ela é o que evita ler a opção à toa.
 *
 * As duas peças juntas são a régua, exportadas porque o teste as fixa
 * (`tests/unit/agenda-dos-colegas-e-opcao-da-org.test.ts` prova a matriz
 * inteira: as duas posições da opção, os quatro papéis humanos e o compromisso
 * sem dono) e porque as duas chamadas do handler — a mudança e a criação —
 * precisam responder IGUAL. Duas cópias da mesma pergunta divergem no primeiro
 * ajuste.
 *
 * Duas das respostas são conhecidas sem banco nenhum: IA, token de servidor e
 * webhook não são "um atendente" (o que os governa é o papel do token, cobrado
 * na rota), e Gerente ou Administrador mexe em tudo. Só o Atendente de gente,
 * mexendo no compromisso de OUTRA pessoa, depende do que está gravado na
 * organização.
 *
 * Ler a opção quando a resposta já é conhecida custaria uma ida ao banco em TODO
 * cancelamento, remarcação e marcação — inclusive nas da própria agenda — e
 * faria a rota depender de uma função que pode não existir numa instalação
 * antiga para deixar alguém escrever na agenda DELE. A régua continua UMA:
 * `recusaMudancaNaAgendaAlheia` é esta função E a opção.
 */
export function aOpcaoPodeRecortar(actor: Actor, ehDono: boolean): boolean {
  // IA e integração não são "um atendente" e não têm agenda própria: o que as
  // governa é o papel do token, cobrado na rota.
  if (actor.type !== "user") return false;
  // Gerente e Administrador seguem mexendo em tudo — a decisão diz os dois.
  if (roleAtLeast(actor.role, "manager")) return false;
  // O dono mexe no que é dele em QUALQUER posição da opção. Compromisso SEM dono
  // (`ehDono` falso para todo mundo) fica com Gerente e Administrador, acima.
  return !ehDono;
}

export function recusaMudancaNaAgendaAlheia(
  actor: Actor,
  opcaoLigada: boolean,
  ehDono: boolean,
): boolean {
  // LIGADA é o padrão e o comportamento de sempre: nada muda. É a última
  // pergunta, e é por isso que a leitura da opção só acontece quando
  // `aOpcaoPodeRecortar` já disse que ela pode mudar alguma coisa.
  return aOpcaoPodeRecortar(actor, ehDono) && !opcaoLigada;
}

/**
 * A opção está desligada e o compromisso NÃO é de quem está pedindo?
 *
 * Chamada por `alterarAgendamentoHandler` e `cancelarAgendamentoHandler` logo
 * depois de `exigeAgendamento` — antes de qualquer escrita, e é o mesmo ponto
 * em que o banco recusa (`appointment_do_colega`, migration 0343).
 */
async function exigeDonoDoCompromisso(
  supabase: SB,
  ctx: HandlerCtx,
  atual: Record<string, unknown>,
): Promise<void> {
  const ehDono = ctx.actor.type === "user" && atual.owner_user_id === ctx.actor.id;
  if (!aOpcaoPodeRecortar(ctx.actor, ehDono)) return;
  const ligada = await colegasPodemMexerNaAgenda(supabase, ctx);
  if (!recusaMudancaNaAgendaAlheia(ctx.actor, ligada, ehDono)) return;
  throw new ApiError(403, "appointment_do_colega", undefined, ctx.requestId, RECUSA_DO_COLEGA);
}

export async function marcarAgendamentoHandler(
  supabase: SB,
  ctx: HandlerCtx,
  input: MarcarInput,
): Promise<Record<string, unknown>> {
  const inicio = new Date(input.starts_at);

  const { data: tipo, error: erroTipo } = await supabase
    .from("calendar_event_types")
    .select(
      "id, name, is_active, duration_minutes, default_owner_user_id, requires_confirmation, location_kind, location_details",
    )
    .eq("organization_id", ctx.organization_id)
    .eq("id", input.event_type_id)
    .maybeSingle();
  if (erroTipo) throw new ApiError(500, "internal_error", undefined, ctx.requestId, erroTipo.message);
  if (!tipo) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Tipo de agendamento não encontrado.");
  }
  if (!tipo.is_active) {
    throw new ApiError(422, "agenda_tipo_desativado", undefined, ctx.requestId, `"${tipo.name}" está desativado.`);
  }

  const donoId = input.owner_user_id ?? tipo.default_owner_user_id;
  if (!donoId) {
    throw new ApiError(
      422,
      "agenda_sem_responsavel",
      undefined,
      ctx.requestId,
      `"${tipo.name}" não tem responsável definido, e sem responsável não há agenda.`,
    );
  }

  // ─── A CRIAÇÃO: O RESPONSÁVEL RESOLVIDO, E O ACHADO DO MANTENEDOR ─────────
  //
  // A recusa existe só quando as TRÊS coisas valem juntas: (a) quem pede é
  // pessoa e está abaixo de `manager` — a régua é `aOpcaoPodeRecortar` —, (b) o
  // responsável resolvido NÃO é quem pede, e (c) a opção está DESLIGADA.
  //
  // ⚠️ A régua aqui é o `donoId` JÁ RESOLVIDO, e não só o que veio no corpo — é
  // pedido textual do mantenedor no fio da issue #978 (16/09): "escolher o tipo
  // de outra pessoa não pode virar atalho". `donoId` sai de `input.owner_user_id`
  // quando o campo vem e do responsável PADRÃO DO TIPO
  // (`calendar_event_types.default_owner_user_id`) quando não vem; com a opção
  // desligada os DOIS caminhos escrevem na agenda de um colega, então os dois
  // recusam. Sem esta simetria, bastaria escolher o tipo cujo responsável padrão
  // é a outra pessoa para contornar a opção.
  //
  // ⚠️ Só a ROTA cobra isto na criação: o INSERT abaixo é direto na tabela (com
  // service role), então não passa por `fn_appointment_change_core`, que é onde
  // o banco cobra a mesma regra na alteração e no cancelamento.
  const ehDonoDoQueVaiNascer = ctx.actor.type === "user" && donoId === ctx.actor.id;
  if (aOpcaoPodeRecortar(ctx.actor, ehDonoDoQueVaiNascer)) {
    const agendaDosColegasLigada = await colegasPodemMexerNaAgenda(supabase, ctx);
    if (recusaMudancaNaAgendaAlheia(ctx.actor, agendaDosColegasLigada, ehDonoDoQueVaiNascer)) {
      throw new ApiError(403, "appointment_do_colega", undefined, ctx.requestId, RECUSA_DO_COLEGA);
    }
  }

  // O `contact_id` É INPUT EXTERNO E PRECISA SER RESOLVIDO, não repassado.
  //
  // ⚠️ Ele atravessava a borda cru: `lib/mcp/tools/agendamento.ts:259` aceita
  // `z.string().uuid()` livre do modelo, e o INSERT abaixo o gravava sem
  // perguntar de quem é. Este handler roda com service role e filtra
  // `organization_id` em toda query — `contact_id` era o ÚNICO campo de entrada
  // que não era resolvido. Pela rota HTTP bastava um `agent` da org A.
  //
  // Hoje não vaza PII (a tela lê contatos com a sessão do usuário, sob RLS, e
  // volta nulo) e não permite enumerar (o par 201/404 só confirma um uuid que
  // quem chamou já tem). O que preocupa é o DEPOIS: o cabeçalho da migration
  // 0177 diz que `contact_id` é "quem recebe o LEMBRETE". No dia em que o worker
  // de lembrete nascer, esta linha vira a organização A mandando WhatsApp para o
  // cliente da B — e `on delete restrict` faz a linha ficar presa numa org que
  // não a enxerga nem consegue soltá-la.
  //
  // O molde é o de `app/api/v1/messages/_handler.ts:333` — resolver contra a org
  // e recusar com 404, sem dizer se o id existe noutro lugar.
  if (input.contact_id) {
    const { data: contato, error: erroContato } = await supabase
      .from("contacts")
      .select("id")
      .eq("id", input.contact_id)
      .eq("organization_id", ctx.organization_id)
      .maybeSingle();
    if (erroContato) {
      throw new ApiError(500, "internal_error", undefined, ctx.requestId, erroContato.message);
    }
    if (!contato) {
      throw new ApiError(404, "not_found", undefined, ctx.requestId, "Contato não encontrado.");
    }
  }

  const fim = new Date(inicio.getTime() + tipo.duration_minutes * 60_000);
  const consulta = await exigeHorarioLivre(supabase, ctx, {
    eventTypeId: tipo.id,
    donoId,
    inicio,
    fim,
  });

  const booking = tipo.location_kind === "google_meet" ? ctx.meetingBooking : undefined;
  if (booking && (booking.boundary.organization_id !== ctx.organization_id || booking.boundary.contact_id !== input.contact_id || ctx.actor.type !== "ai_agent")) {
    throw new ApiError(403,"forbidden",undefined,ctx.requestId,"A conversa deste atendimento mudou.");
  }
  const delivery = booking ? { state:"waiting_for_link",generation:randomUUID(),service_boundary:booking.boundary,source_operation_id:booking.sourceJobId,
    booking_claim:booking.claim,authorized_by:{kind:ctx.actor.type,id:ctx.actor.id} } : {state:"none"};
  const { data: criado, error: erroInsert } = await supabase
    .from("calendar_appointments")
    .insert({
      organization_id: ctx.organization_id,
      event_type_id: tipo.id,
      title: input.title ?? tipo.name,
      starts_at: inicio.toISOString(),
      ends_at: fim.toISOString(),
      // O fuso do compromisso é campo de primeira classe: é o da JORNADA, onde
      // o horário foi decidido, e ele viaja até o lembrete (ACHADO 09).
      time_zone: consulta.fusoDaRegra,
      status: tipo.requires_confirmation ? "pending" : "confirmed",
      owner_user_id: donoId,
      contact_id: input.contact_id ?? null,
      conversation_id: booking?.boundary.conversation_id ?? input.conversation_id ?? null,
      meeting_delivery: delivery as unknown as Json,
      location_kind: tipo.location_kind,
      location_details:
        input.location_details !== undefined
          ? input.location_details.trim() || null
          : tipo.location_details,
      description: input.description !== undefined ? input.description.trim() || null : null,
      notes: input.notes ?? null,
      // `|| null` e não `?? null`: a rota deixa passar `""` (o campo limpo na
      // tela), e string vazia gravada seria um convidado sem e-mail — que faz o
      // Google recusar o EVENTO INTEIRO, não só o convidado.
      guest_email: input.guest_email || null,
      created_by_kind: autorParaCriacao(ctx.actor),
      created_by_user_id: ctx.actor.type === "user" ? ctx.actor.id : null,
      source: ctx.actor.type === "user" ? "ui" : "mcp",
    })
    .select("id, starts_at, ends_at, status, time_zone, revision, meeting_state, meeting_url")
    .single();
  if (erroInsert) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, erroInsert.message);
  }

  const transicao: Transicao = criado.status === "pending" ? "pending" : "confirmed";
  await fecharOLaco(supabase, ctx, {
    appointmentId: criado.id,
    contactId: input.contact_id ?? null,
    atividade: atividadeDaTransicao(null, transicao),
    gatilho: gatilhoDaTransicao(null, transicao),
    transicao,
    fusoDoCompromisso: criado.time_zone,
    nomeDoTipo: tipo.name,
  });

  void audit({
    action: "agenda.appointment_created",
    actorUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
    organizationId: ctx.organization_id,
    resourceType: "calendar_appointment",
    resourceId: criado.id,
    requestId: ctx.requestId,
    metadata: { event_type_id: tipo.id, owner_user_id: donoId, time_zone: criado.time_zone },
  });

  return criado as Record<string, unknown>;
}

/**
 * ⚠️ REMARCAR NÃO É CANCELAR MAIS CRIAR — é a MESMA linha mudando de horário.
 *
 * 1. A TIMELINE conta a história certa. Cancelar+criar emitiria
 *    `appointment_cancelled` seguido de `appointment_scheduled`: duas linhas
 *    dizendo que o cliente desistiu e voltou, quando ele só mudou de horário.
 * 2. O ESPELHO NO GOOGLE é atualizado, não destruído e refeito — recriar exigiria
 *    casar o evento antigo lá fora, e casar por janela de horário erra nos dois
 *    sentidos (barrado até haver identificador próprio no espelho).
 * 3. O `id` que o cliente já recebeu continua valendo.
 *
 * `rescheduled_from_id` fica VAZIO: ele é do fluxo em que a remarcação gera
 * compromisso NOVO (auto-agendamento), que não existe. Usá-lo aqui seria
 * inventar encadeamento onde há uma linha só.
 */
export async function alterarAgendamentoHandler(
  supabase: SB,
  ctx: HandlerCtx,
  input: AlterarInput,
): Promise<Record<string, unknown>> {
  const atual = await exigeAgendamento(supabase, ctx, input.id, [
    "id",
    "revision",
    "event_type_id",
    "owner_user_id",
    "contact_id",
    "starts_at",
    "status",
    "time_zone",
  ]);

  await exigeDonoDoCompromisso(supabase, ctx, atual);

  if (input.revision !== undefined && input.revision !== Number(atual.revision)) throw new ApiError(409,"conflict",undefined,ctx.requestId,"O compromisso mudou. Recarregue antes de confirmar.");
  if (atual.status === "cancelled") {
    throw new ApiError(
      422,
      "agenda_ja_cancelado",
      undefined,
      ctx.requestId,
      "Este agendamento foi cancelado. Marque um novo em vez de reabrir este.",
    );
  }

  const mudanca: Record<string, unknown> = {};
  if (input.status === "completed" || input.status === "no_show") {
    if (ctx.actor.type !== "user") throw new ApiError(403,"forbidden",undefined,ctx.requestId,"Peça à equipe para confirmar a presença no compromisso. Uma interpretação de texto não registra o fato.");
    if (input.outcome_message_id) mudanca.outcome_message_id=input.outcome_message_id;
  }
  if(input.confirmation_next_at) mudanca.confirmation_next_at=input.confirmation_next_at;
  if (input.notes !== undefined) mudanca.notes = input.notes;
  // Trocar SÓ o convidado não é remarcação nem mudança de situação, então não
  // produz `transicao` — e não deveria: a timeline do lead não ganha notícia
  // por causa de um e-mail digitado. Quem leva a mudança ao Google é a coluna
  // gerada `needs_google_push` (migration 0225), que compara a revisão
  // publicável com o último aceite; notes e metadata não criam intenção.
  if (input.guest_email !== undefined) mudanca.guest_email = input.guest_email || null;
  let transicao: Transicao | null = null;

  if (input.starts_at) {
    const novoInicio = new Date(input.starts_at);
    const { data: tipo } = await supabase
      .from("calendar_event_types")
      .select("id, duration_minutes")
      .eq("organization_id", ctx.organization_id)
      .eq("id", (atual.event_type_id as string | null) ?? "")
      .maybeSingle();
    if (!tipo) {
      throw new ApiError(404, "not_found", undefined, ctx.requestId, "O tipo deste agendamento não existe mais.");
    }

    const novoFim = new Date(novoInicio.getTime() + tipo.duration_minutes * 60_000);
    // ⚠️ O PRÓPRIO COMPROMISSO OCUPA O HORÁRIO DELE. Remarcar para o mesmo
    // instante é no-op — sem esta guarda ele se veria como conflito e recusaria
    // a si mesmo.
    const mesmoHorario = new Date(atual.starts_at as string).getTime() === novoInicio.getTime();
    if (!mesmoHorario) {
      // REMARCAR segue a mesma assimetria de marcar (`exigeHorarioLivre`): a
      // pessoa que combinou o encaixe por fora da grade precisa poder movê-lo
      // também, senão o compromisso nasce possível e fica preso.
      const consulta = await exigeHorarioLivre(supabase, ctx, {
        eventTypeId: tipo.id,
        donoId: atual.owner_user_id as string,
        inicio: novoInicio,
        fim: novoFim,
        ignorarAgendamentoId: atual.id as string,
      });
      mudanca.starts_at = novoInicio.toISOString();
      mudanca.ends_at = novoFim.toISOString();
      mudanca.time_zone = consulta.fusoDaRegra;
      transicao = "rescheduled";
    }
  }

  if (input.status && input.status !== atual.status) {
    // ⚠️ DESFECHO É SOBRE O PASSADO. `completed` e `no_show` respondem "o que
    // aconteceu?", e num compromisso que ainda não começou não aconteceu nada.
    //
    // Isto não era guardado, e o buraco ficou barato enquanto só gente marcava
    // pela tela — os botões Realizado/Faltou vivem no histórico. Deixa de ser
    // barato agora que `crm_set_appointment_outcome` põe a mesma escrita na mão
    // de um modelo, que decide por texto e não por onde clicou.
    //
    // O dano do `no_show` prematuro é concreto e não é só um registro errado:
    // `no_show` está em `LIBERAM_O_HORARIO` (`lib/agenda/ocupados.ts`), então
    // ele DEVOLVE ao pool um horário que o cliente ainda espera. Outro cliente
    // pega, e os dois aparecem na mesma hora.
    //
    // O `completed` prematuro tem outro dano: grava `appointment_completed` na
    // timeline e some com os botões da tela, tirando de quem atendeu a chance de
    // registrar o que de fato aconteceu.
    //
    // A guarda é AQUI, no handler, e não na ferramenta: a regra não é sobre quem
    // chama. Recusa de negócio com o código do repo — a tool a traduz em resposta
    // ao modelo, sem derrubar o turno.
    if (
      (input.status === "completed" || input.status === "no_show") &&
      new Date(atual.starts_at as string).getTime() > Date.now()
    ) {
      throw new ApiError(
        422,
        "agenda_ainda_nao_aconteceu",
        undefined,
        ctx.requestId,
        "Este compromisso ainda não começou — não dá para registrar se a pessoa veio ou faltou. " +
          "Se ela avisou que não vem, desmarque em vez de registrar falta.",
      );
    }
    mudanca.status = input.status;
    // Remarcar vence: se vieram os dois, a notícia da timeline é a remarcação.
    transicao = transicao ?? input.status;
  }

  if (Object.keys(mudanca).length === 0) return { id: atual.id, inalterado: true };

  const salvo = await alteraComRevisao(supabase,ctx,input.id,input.revision ?? Number(atual.revision),mudanca);

  if (transicao) {
    await fecharOLaco(supabase, ctx, {
      appointmentId: atual.id as string,
      contactId: (atual.contact_id as string | null) ?? null,
      atividade: atividadeDaTransicao(atual.status as SituacaoAnterior, transicao),
      gatilho: gatilhoDaTransicao(atual.status as SituacaoAnterior, transicao),
      transicao,
      fusoDoCompromisso: String(salvo.time_zone),
      nomeDoTipo: await nomeDoTipoDoCompromisso(supabase, ctx, atual.event_type_id as string | null),
      outcome: {revision:salvo.revision,source_kind:salvo.outcome_source_kind,message_id:salvo.outcome_message_id,recorded_at:salvo.outcome_recorded_at},
    });

    void audit({action: transicao === "rescheduled" ? "agenda.appointment_rescheduled" : transicao === "completed" || transicao === "no_show" ? "agenda.appointment_outcome_recorded" : "agenda.appointment_updated",
      actorUserId:ctx.actor.type === "user" ? ctx.actor.id : null,organizationId:ctx.organization_id,
      resourceType:"calendar_appointment",resourceId:input.id,requestId:ctx.requestId,
      metadata:{status:salvo.status,revision:salvo.revision,outcome_source_kind:salvo.outcome_source_kind,outcome_message_id:salvo.outcome_message_id}});

  }

  if (!transicao) void audit({action:"agenda.appointment_updated",actorUserId:ctx.actor.type==="user"?ctx.actor.id:null,
    organizationId:ctx.organization_id,resourceType:"calendar_appointment",resourceId:input.id,requestId:ctx.requestId,
    metadata:{revision:salvo.revision,confirmation_next_at:salvo.confirmation_next_at}});
  return salvo as Record<string, unknown>;
}

/**
 * Cancela de verdade (status), não apaga a linha: o histórico do que foi marcado
 * e desmarcado é o que deixa o Radar distinguir lead que desistiu de lead que
 * nunca marcou, e o agente não reoferecer o horário que a pessoa recusou.
 *
 * ⚠️ O MOTIVO É OBRIGATÓRIO — é o que a equipe lê ao ver o horário vago. Sem ele,
 * alguém liga para o cliente perguntando o que houve, ou não liga e o lead esfria
 * sem ninguém saber por quê.
 */
export async function cancelarAgendamentoHandler(
  supabase: SB,
  ctx: HandlerCtx,
  input: CancelarInput,
): Promise<Record<string, unknown>> {
  const atual = await exigeAgendamento(supabase, ctx, input.id, [
    "id",
    "revision",
    // `owner_user_id` entrou com a opção "agenda dos colegas" (migration 0343,
    // issue #978): é a coluna que a recusa lê. Sem ela, o cancelamento era a
    // ÚNICA das duas mudanças que não sabia de quem era o compromisso — e o
    // caminho mais fácil de apagar a agenda de um colega.
    "owner_user_id",
    "contact_id",
    "event_type_id",
    "status",
    "time_zone",
  ]);

  await exigeDonoDoCompromisso(supabase, ctx, atual);

  // Idempotente: cancelar o que já está cancelado devolve o estado, não erro —
  // quem chamou queria o compromisso desmarcado, e ele está.
  if (input.revision !== undefined && input.revision !== Number(atual.revision)) throw new ApiError(409,"conflict",undefined,ctx.requestId,"O compromisso mudou. Recarregue antes de confirmar.");
  if (atual.status === "cancelled") {
    return { id: atual.id, status: "cancelled", ja_estava: true };
  }

  const salvo = await alteraComRevisao(supabase,ctx,input.id,input.revision ?? Number(atual.revision),{
    status:"cancelled",cancellation_reason:input.reason,
  });

  await fecharOLaco(supabase, ctx, {
    appointmentId: atual.id as string,
    contactId: (atual.contact_id as string | null) ?? null,
    atividade: atividadeDaTransicao(atual.status as SituacaoAnterior, "cancelled"),
    gatilho: gatilhoDaTransicao(atual.status as SituacaoAnterior, "cancelled"),
    transicao: "cancelled",
    fusoDoCompromisso: atual.time_zone as string,
    nomeDoTipo: await nomeDoTipoDoCompromisso(supabase, ctx, atual.event_type_id as string | null),
  });

  void audit({
    action: "agenda.appointment_cancelled",
    actorUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
    organizationId: ctx.organization_id,
    resourceType: "calendar_appointment",
    resourceId: atual.id as string,
    requestId: ctx.requestId,
    metadata: { reason: input.reason },
  });

  return salvo as Record<string, unknown>;
}

/** O compromisso, ou 404 — sempre com o filtro de organização. */
/**
 * O NOME DO TIPO DE ATENDIMENTO — lido da linha, nunca digitado aqui.
 *
 * Ele viaja no payload do gatilho de automação (`event.event_type_name`) e é o
 * ÚNICO campo por onde uma regra distingue "Limpeza" de "Avaliação": a linha do
 * compromisso guarda `event_type_id`, um uuid que ninguém digita numa condição.
 * O editor de regras oferece exatamente essa condição ("Tipo de atendimento
 * contém …").
 *
 * ⚠️ ISTO JÁ FOI UM LITERAL, e o literal é o defeito. `alterar` e `cancelar`
 * passavam `"Agendamento"` cravado, então três dos quatro gatilhos
 * (`confirmed`, `rescheduled`, `cancelled`) emitiam sempre a mesma palavra —
 * a condição aparecia na tela, o operador a salvava, e ela não casava nunca.
 * Controle decorativo é pior que controle ausente: a pessoa acredita que
 * configurou.
 *
 * Uma consulta a mais por transição, e só quando há transição. `marcar` não
 * chama esta função porque já tem a linha do tipo em mãos.
 */
async function nomeDoTipoDoCompromisso(
  supabase: SB,
  ctx: HandlerCtx,
  eventTypeId: string | null,
): Promise<string> {
  if (!eventTypeId) return NOME_GENERICO_DO_TIPO;
  const { data } = await supabase
    .from("calendar_event_types")
    .select("name")
    .eq("organization_id", ctx.organization_id)
    .eq("id", eventTypeId)
    .maybeSingle();
  const nome = (data as { name?: string | null } | null)?.name;
  // O tipo apagado depois do compromisso é o único caminho até aqui. Falhar a
  // leitura NÃO pode desfazer um cancelamento já gravado.
  return nome?.trim() ? nome : NOME_GENERICO_DO_TIPO;
}

async function exigeAgendamento(
  supabase: SB,
  ctx: HandlerCtx,
  id: string,
  colunas: string[],
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase
    .from("calendar_appointments")
    .select(colunas.join(", "))
    .eq("organization_id", ctx.organization_id)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  if (!data) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Agendamento não encontrado.");
  }
  return data as unknown as Record<string, unknown>;
}

/**
 * Quem pode marcar FORA da grade de horários.
 *
 * A grade (início da jornada + múltiplos da duração) é o que o sistema OFERECE.
 * Uma pessoa da equipe precisa poder marcar o que combinou por fora dela — o
 * cliente que só pode 10:30, o encaixe, o atendimento que começa mais cedo. Era
 * o que o sistema anterior deste negócio permitia, e a falta disso obrigaria a
 * equipe a mudar o horário do cliente para caber numa régua interna.
 *
 * ⚠️ A IA NÃO PODE, e essa é a assimetria inteira. Ela oferece o que a agenda
 * publicou; escolher um horário que ninguém publicou é decisão de quem responde
 * pelo negócio. É a mesma separação que o envio já faz — pessoa passa por cima
 * do modo de teste do canal, agente não.
 *
 * Integração por token também não: `deriveActor` (`lib/mcp/auth.ts`) devolve
 * `api_token` para token sem escopo de agente, e `webhook_source` não é gente.
 * Só `"user"` — a sessão de alguém da equipe — escolhe o encaixe.
 */
export function podeMarcarForaDaGrade(actor: Actor): boolean {
  return actor.type === "user";
}

/**
 * O horário pedido pode ser marcado por QUEM está pedindo?
 *
 * ⚠️ Pela MESMA coleta que responde o GET e as ferramentas de leitura
 * (`horariosLivresDaOrg`), nunca por uma segunda. Duas coletas divergem no
 * primeiro ajuste: se a regra do que OCUPA mudar, uma muda e a outra não — e aí
 * a tela oferece horário que a escrita recusa, ou a escrita aceita um que a tela
 * não ofereceu e alguém chega numa hora que já tinha dono.
 *
 * Duas perguntas, conforme o ator (`podeMarcarForaDaGrade`):
 *
 * - **A grade** (IA, token, webhook): o horário é um dos slots que
 *   `horariosLivres` calcula para a janela `[inicio, fim]` DO PRÓPRIO PEDIDO —
 *   não para o dia. Essa conta segura o alinhamento ao expediente, o aviso
 *   mínimo, a janela de reserva e a ocupação que CRUZA o pedido.
 *
 *   Alguns furos em que esta conta deixava passar o que o GET do dia esconde,
 *   anteriores ao encaixe, foram medidos em 2026-09-15 chamando este handler
 *   com a coleta de verdade sobre o banco em memória de
 *   `tests/unit/pessoa-marca-fora-da-grade.test.ts`. Os três estão fechados:
 *   · **buffer contra vizinho** (issue #876, PR #1027) — `coletaOQueOcupa` só
 *     trazia o que cruza `[inicio, fim]`, e com `buffer_before_minutes = 30` o
 *     pedido de 13:00Z não via o vizinho que termina 12:45Z. `horariosLivresDaOrg`
 *     agora alarga a coleta por `buffer_before`/`buffer_after`. Vigiado pelos
 *     casos de intervalo antes do atendimento no mesmo arquivo de teste.
 *
 *   · **remarcar contando a si mesmo** (issue #1084) — o efeito colateral do
 *     alargamento acima: a coleta passou a ver também o PRÓPRIO compromisso de
 *     saída. Com 30 min de intervalo antes, a IA remarcando 13:00Z → 14:00Z
 *     levava 422 `agenda_horario_indisponivel`; sem intervalo, o mesmo movimento
 *     era aceito. A grade agora repassa `ignorarAgendamentoId` a
 *     `horariosLivresDaOrg`. Vigiado pelos casos de remarcação com intervalo no
 *     mesmo arquivo de teste — inclusive um CONTROLE de que o intervalo segue
 *     valendo contra OUTRO compromisso.
 *
 *   · **exceção de data à noite** foi fechada (issue #878, PR #882): era colhida
 *   pela data UTC de `inicio`/`fim`, e em São Paulo 21:00 do dia 07 é 00:00Z do
 *   dia 08 — o pedido era ACEITO num dia inteiro bloqueado. `horariosLivresDaOrg`
 *   agora a busca no dia LOCAL do fuso da jornada, com um dia de margem de cada
 *   lado. Vigiado por "a exceção de data é do dia LOCAL" em
 *   `tests/unit/pessoa-marca-fora-da-grade.test.ts`.
 * - **O encaixe** (pessoa): as regras da grade são dispensadas — é a escolha
 *   explícita de quem atende —, mas a OCUPAÇÃO REAL não
 *   (`exigeSemSobreposicao`).
 *
 * ⚠️ A decisão mora AQUI DENTRO, e não em quem chama, de propósito: quando cada
 * chamador relaxava a grade e lembrava de chamar a sobreposição ao lado, nada
 * impedia um terceiro caminho de relaxar e esquecer. Um chamador novo desta
 * função não tem como dispensar a grade sem levar a conferência junto.
 *
 * A leitura de `horariosLivresDaOrg` acontece nos dois ramos porque é dela que
 * sai `fusoDaRegra`, que vira `time_zone` do compromisso e viaja até o lembrete.
 */
async function exigeHorarioLivre(
  supabase: SB,
  ctx: HandlerCtx,
  args: {
    eventTypeId: string;
    donoId: string;
    inicio: Date;
    fim: Date;
    /**
     * O compromisso sendo remarcado: ocupa o horário de ONDE SAI, não o de DESTINO.
     *
     * Vale para os DOIS ramos. A pergunta é a mesma nos dois — "o que já está
     * tomado?" — e a resposta tem de excluir este compromisso. No encaixe quem
     * exclui é `exigeSemSobreposicao`; na grade o id vai a `horariosLivresDaOrg`,
     * que o repassa à coleta. Sem isso, com intervalo configurado, o próprio
     * compromisso cruzava a janela alargada e a IA remarcando para logo depois do
     * próprio fim levava 422 `agenda_horario_indisponivel` por causa de si mesma
     * (issue #1084).
     */
    ignorarAgendamentoId?: string;
  },
): Promise<{ fusoDaRegra: string }> {
  const consulta = await horariosLivresDaOrg(supabase, ctx.organization_id, {
    eventTypeId: args.eventTypeId,
    ownerUserId: args.donoId,
    de: args.inicio,
    ate: args.fim,
    agora: new Date(),
    ignorarAgendamentoId: args.ignorarAgendamentoId,
  });

  if (!consulta.ok) {
    const { status, code } = CODIGO_DA_RECUSA[consulta.codigo];
    throw new ApiError(status, code, undefined, ctx.requestId, consulta.motivoParaOperador);
  }
  if (!consulta.publicouHorarios) {
    throw new ApiError(
      422,
      "agenda_fora_da_jornada",
      undefined,
      ctx.requestId,
      "Este responsável ainda não publicou horários de atendimento.",
    );
  }

  const foraDaGrade = podeMarcarForaDaGrade(ctx.actor);
  if (foraDaGrade) {
    await exigeSemSobreposicao(supabase, ctx, args);
  } else if (!consulta.slots.some((s) => s.inicio.getTime() === args.inicio.getTime())) {
    throw new ApiError(
      422,
      "agenda_horario_indisponivel",
      undefined,
      ctx.requestId,
      "Este horário não está disponível. Consulte os horários livres e escolha outro.",
    );
  }
  return { fusoDaRegra: consulta.fusoDaRegra };
}

/**
 * O encaixe não cruza a OCUPAÇÃO REAL do dono — a metade da grade que vale para
 * todo mundo.
 *
 * Ocupação real é o que `coletaOQueOcupa` devolve, a mesma coleta da grade:
 * outro agendamento que não liberou o horário (`LIBERAM_O_HORARIO`, em
 * `lib/agenda/ocupados.ts`) e evento do Google Agenda selecionado que ocupa. SEM
 * buffer, sem exceção de data e sem expediente — essas são regras de oferta, e o
 * encaixe existe para passar por cima delas. Ignorar a ocupação, ao contrário,
 * produz duas pessoas na mesma cadeira.
 *
 * Existe porque não há nada no schema que impeça a sobreposição: sem `exclude`
 * com `tstzrange` nem índice, a única guarda do produto é esta leitura.
 *
 * O GOOGLE QUE ELA VÊ NÃO DEPENDE DE QUEM PERGUNTA (issue #879, PR #883). Até
 * aqui dependia: a coleta chegava aos eventos pelo embed
 * `calendar_connections!inner`, tabela cuja RLS só mostra a conexão ao próprio
 * dono e a `manager`+, e para um `agent` marcando na agenda de OUTRA pessoa o
 * Google dela ficava fora da conta — medido num Postgres descartável com o
 * `baseline.sql`: dono 1 evento, gerente 1, atendente 0. `coletaOQueOcupa` lê
 * agora por `fn_agenda_ocupacao_google_do_dono` (migration 0260), `security
 * definer` que confere o pertencimento e devolve só ocupação — e a rota continua
 * passando o client de SESSÃO. Vigiado no banco por
 * `tests/invariants/agenda-ocupacao-google-do-dono.test.ts` e aqui por "o
 * ENCAIXE do atendente em cima do Google do dono é RECUSADO".
 */
async function exigeSemSobreposicao(
  supabase: SB,
  ctx: HandlerCtx,
  args: { donoId: string; inicio: Date; fim: Date; ignorarAgendamentoId?: string },
): Promise<void> {
  const oQueOcupa = await coletaOQueOcupa(supabase, ctx.organization_id, {
    donoId: args.donoId,
    de: args.inicio,
    ate: args.fim,
    ignorarAgendamentoId: args.ignorarAgendamentoId,
  });
  if (!oQueOcupa.ok) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, "Não foi possível conferir a agenda.");
  }
  const pedido = { inicio: args.inicio.getTime(), fim: args.fim.getTime() };
  const cruza = oQueOcupa.ocupados.some((o) => colide(o.inicio.getTime(), o.fim.getTime(), pedido));
  if (cruza) {
    throw new ApiError(
      422,
      "agenda_horario_indisponivel",
      undefined,
      ctx.requestId,
      "Este horário já está ocupado na agenda de quem atende — por outro compromisso ou pelo Google Agenda.",
    );
  }
}

/**
 * `Actor` → o vocabulário de `calendar_appointments.created_by_kind`.
 *
 * ⚠️ O TOKEN DE SERVIDOR NÃO É A IA. Este ternário dizia `ai` para TUDO que não
 * fosse pessoa, e a MESMA ação saía com duas autorias no MESMO request: a
 * timeline, logo abaixo, grava `autorParaTimeline(ctx.actor.type)` — que manda
 * `api_token` para `system` —, e a coluna do compromisso dizia `ai`. A tela
 * (`ROTULO_DO_AUTOR`) anunciava "Marcado pelo atendente de IA" para compromisso
 * que algoritmo nenhum escreveu (issue #866). Fora daqui, `actorParaAtividade`
 * (lib/leads/activity-emitter.ts) e `especieDe` (lib/operacao/autoria.ts) já
 * diziam o mesmo: quem age por token é o PRODUTO, não a IA.
 *
 * `webhook_source` continua `ai` — e isso é divergência CONHECIDA, não
 * esquecimento: a automação do motor se apresenta como IA no balão da conversa
 * (`components/inbox/MessageBubble.tsx`), e mover as duas colunas juntas é
 * decisão de produto com efeito de leitura (as telas que contam "o que a IA
 * marcou/falou" passam a excluir automação). Fica para issue própria, com o
 * mesmo argumento escrito no mapeamento de `messages.sent_via`.
 */
function autorParaCriacao(actor: Actor): string {
  if (actor.type === "user") return "user";
  if (actor.type === "api_token") return "system";
  return "ai";
}

/**
 * Vínculo e atividade no mesmo fluxo da mutação.
 *
 * `crm_lead_links` faz o compromisso PERTENCER ao negócio (é por ele que o
 * dossiê o lista); `crm_lead_activities` aparece na timeline. A pendência Google
 * vem da revisão publicável persistida. Só o vínculo e nada aparece na tela; só
 * a atividade e o dossiê não acha o compromisso.
 *
 * ⚠️ `crm_lead_activities.lead_id` é NOT NULL: agendamento de contato que ainda
 * não virou lead não tem onde ancorar, e o rastro vira `event_log` por
 * `registraFalhaDeAtividade` em vez de sumir. Não se inventa um terceiro caminho.
 */
async function fecharOLaco(
  supabase: SB,
  ctx: HandlerCtx,
  args: {
    appointmentId: string;
    contactId: string | null;
    atividade: string | null;
    /** Gatilho de automação, ou `null` quando a transição não é notícia para uma regra. */
    gatilho: string | null;
    transicao: Transicao;
    fusoDoCompromisso: string;
    nomeDoTipo: string;
    outcome?: Record<string,unknown>;
  },
): Promise<void> {
  // Pendência Google é derivada da revisão publicável; não emite evento sem consumer.

  // O gatilho de automação, ANTES de qualquer early-return. Ele não depende de
  // haver negócio aberto: uma regra de "avise a cliente que confirmou" vale
  // igual para quem não tem lead nenhum — e todo o resto desta função é sobre a
  // timeline do lead, que é outra pergunta.
  //
  // Fire-and-forget, como a atividade: falhar em emitir NÃO pode desfazer um
  // compromisso que já está gravado. O consumidor é o motor de regras
  // (`lib/automation/engine.ts`), que casa por `trigger_event`.
  //
  // POR `emit_event`, E NUNCA POR INSERT EM `event_log` (issue #877). O
  // `event_log` não tem policy PERMISSIVA de INSERT para `authenticated` — a
  // `support_write_insert` é RESTRITIVA, só estreita. Pela tela o `supabase`
  // daqui é o cliente da SESSÃO, então o INSERT direto voltava `new row
  // violates row-level security policy` em TODA marcação e confirmação, o
  // compromisso era gravado e nenhuma automação da Agenda rodava. A tool MCP
  // não via o defeito porque chega com service role.
  //
  // `emit_event` é o caminho de evento de domínio do produto: security definer,
  // executável por `authenticated`, e confere que quem chama é membro da
  // organização (`fn_role_at_least`, que também cobre a sessão de suporte).
  // Serve igual aos dois chamadores — o mesmo `registraFalhaDeAtividade` logo
  // abaixo já emite assim. A organização vem do contexto autenticado.
  if (args.gatilho) {
    const { error } = await supabase.rpc("emit_event", {
      p_organization_id: ctx.organization_id,
      p_event_type: args.gatilho,
      p_entity_kind: ENTIDADE_DO_AGENDAMENTO,
      p_entity_id: args.appointmentId,
      p_payload: {
        appointment_id: args.appointmentId,
        contact_id: args.contactId,
        event_type_name: args.nomeDoTipo,
        time_zone: args.fusoDoCompromisso,
        transicao: args.transicao,
      },
      // `request_id` sem o prefixo `rule:` de propósito: ele correlaciona com o
      // audit log e NÃO aciona o anti-loop do motor, que só barra o que uma
      // regra causou.
      p_metadata: { request_id: ctx.requestId },
    });
    if (error) {
      logger.error("[agenda] gatilho de automação não foi emitido", {
        appointment_id: args.appointmentId,
        organization_id: ctx.organization_id,
        gatilho: args.gatilho,
        error: error.message,
      });
    }
  }

  const leadId = args.contactId ? await leadAtivoDoContato(supabase, ctx, args.contactId) : null;

  // ⚠️ ANTES do early-return de `!args.atividade`. Confirmar um agendamento
  // pendente é `atividade: null` (nada novo pra timeline — `atividadeDaTransicao`
  // já contou "foi marcado" quando ele nasceu), mas é EXATAMENTE a transição que
  // move o card de "Agendamento solicitado" pra "Agendado". Um early-return
  // antes disto pularia o mirror no caso que mais importa para ele.
  if (leadId) {
    await moverLeadParaEtapaDeAgendamento(supabase, {
      organizationId: ctx.organization_id,
      leadId,
      transicao: args.transicao,
    }).catch((err) => {
      logger.error("[agenda] mirror de estágio falhou", {
        lead_id: leadId,
        organization_id: ctx.organization_id,
        transicao: args.transicao,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  if (!args.atividade) return;

  if (!leadId) {
    if (args.contactId) {
      await registraFalhaDeAtividade(supabase, {
        organizationId: ctx.organization_id,
        // Sem negócio não há âncora; o contato é o que se sabe, e vai no lugar
        // do id para o alerta não sair mudo sobre QUEM ficou sem rastro.
        leadId: args.contactId,
        tipo: args.atividade,
        origem: "agenda (sem negócio aberto para ancorar)",
        erro: undefined,
      });
    }
    return;
  }

  await supabase.from("crm_lead_links").insert({
    organization_id: ctx.organization_id,
    lead_id: leadId,
    target_kind: ALVO_DE_VINCULO_DO_AGENDAMENTO,
    target_id: args.appointmentId,
    link_kind: VINCULO_DE_AGENDAMENTO,
    created_by_user_id: ctx.actor.type === "user" ? ctx.actor.id : null,
  });

  await emitLeadActivity(supabase, {
    organizationId: ctx.organization_id,
    leadId,
    contactId: args.contactId,
    type: args.atividade as never,
    sourceModule: "agenda",
    sourceId: args.appointmentId,
    actor: ctx.actor,
    reason: `${args.nomeDoTipo} — ${args.atividade}`,
    payload: args.outcome ? {outcome:args.outcome} : {},
    // ⚠️ `sync` não existe no CHECK de `actor_kind`; `autorParaTimeline` mapeia.
    actorKind: autorParaTimeline(ctx.actor.type),
  } as never);
}

/**
 * O negócio ativo do contato — pela MESMA régua do resto do produto.
 *
 * `resolveActiveLeadForContact` distingue três desfechos que um `limit(2)` não
 * distingue: roteou, `no_open_lead` e `ambiguous_open_leads`. Os dois últimos
 * NÃO são erro: o agendamento existe e a atividade não nasce, porque não há
 * negócio a que ancorar.
 */
async function leadAtivoDoContato(
  supabase: SB,
  ctx: HandlerCtx,
  contactId: string,
): Promise<string | null> {
  const [{ data: candidatos }, { data: padrao }] = await Promise.all([
    supabase
      .from("crm_leads")
      .select("id, organization_id, pipeline_id, status, last_activity_at, created_at")
      .eq("organization_id", ctx.organization_id)
      .eq("contact_id", contactId),
    supabase
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", ctx.organization_id)
      .eq("is_default", true)
      .eq("is_archived", false)
      .maybeSingle(),
  ]);

  const rota = resolveActiveLeadForContact((candidatos ?? []) as LeadCandidate[], {
    defaultPipelineId: (padrao as { id: string } | null)?.id ?? null,
  });
  return rota.routed ? rota.leadId : null;
}

async function alteraComRevisao(supabase:SB,ctx:HandlerCtx,id:string,revision:number,patch:Record<string,unknown>):Promise<Record<string,unknown>> {
  const {data,error}=await supabase.rpc("fn_appointment_change",{p_org:ctx.organization_id,p_id:id,p_revision:revision,p_patch:patch});
  if(error) throw new ApiError(error.code === "40001" ? 409 : error.code === "42501" ? 403 : error.code === "P0002" ? 404 : 422,
    error.code === "40001" ? "conflict" : error.code === "42501" ? "forbidden" : error.code === "P0002" ? "not_found" : "validation_failed",undefined,ctx.requestId,
    error.code === "40001" ? "Este compromisso mudou. Atualize os dados antes de confirmar novamente." : "Não foi possível alterar este compromisso. Confira a presença, o horário e a mensagem vinculada.");
  return data as Record<string,unknown>;
}
