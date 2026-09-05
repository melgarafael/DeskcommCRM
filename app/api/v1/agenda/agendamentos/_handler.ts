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
import { horariosLivresDaOrg } from "@/lib/agenda/consulta";
import {
  atividadeDaTransicao,
  autorParaTimeline,
  precisaEmpurrarAoGoogle,
  type SituacaoAnterior,
  type Transicao,
} from "@/lib/agenda/laco";
import { ALVO_DE_VINCULO_DO_AGENDAMENTO, VINCULO_DE_AGENDAMENTO } from "@/lib/agenda/tipos";
import { ApiError } from "@/lib/api/types";
import type { Actor, HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
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
  title?: string;
  notes?: string;
  /**
   * Convidado externo, digitado na tela. `""` limpa; ausente não mexe.
   *
   * NÃO é `contact_id`, e a distinção é o motivo de a coluna existir: o contato
   * é quem recebe o atendimento, e quem precisa entrar na sala pode ser outra
   * pessoa. Quem transforma isto em convite do Google é o worker de push.
   */
  guest_email?: string;
}

export interface AlterarInput {
  id: string;
  starts_at?: string;
  status?: "confirmed" | "completed" | "no_show";
  notes?: string;
  /** Igual ao de `MarcarInput`: `""` desconvida, ausente não mexe. */
  guest_email?: string;
}

export interface CancelarInput {
  id: string;
  reason: string;
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
      location_kind: tipo.location_kind,
      location_details: tipo.location_details,
      notes: input.notes ?? null,
      // `|| null` e não `?? null`: a rota deixa passar `""` (o campo limpo na
      // tela), e string vazia gravada seria um convidado sem e-mail — que faz o
      // Google recusar o EVENTO INTEIRO, não só o convidado.
      guest_email: input.guest_email || null,
      created_by_kind: autorParaCriacao(ctx.actor),
      created_by_user_id: ctx.actor.type === "user" ? ctx.actor.id : null,
      source: ctx.actor.type === "user" ? "ui" : "mcp",
    })
    .select("id, starts_at, ends_at, status, time_zone")
    .single();
  if (erroInsert) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, erroInsert.message);
  }

  const transicao: Transicao = criado.status === "pending" ? "pending" : "confirmed";
  await fecharOLaco(supabase, ctx, {
    appointmentId: criado.id,
    contactId: input.contact_id ?? null,
    atividade: atividadeDaTransicao(null, transicao),
    transicao,
    empurrarAoGoogle: precisaEmpurrarAoGoogle(null, transicao),
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
    "event_type_id",
    "owner_user_id",
    "contact_id",
    "starts_at",
    "status",
    "time_zone",
  ]);

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
  if (input.notes !== undefined) mudanca.notes = input.notes;
  // Trocar SÓ o convidado não é remarcação nem mudança de situação, então não
  // produz `transicao` — e não deveria: a timeline do lead não ganha notícia
  // por causa de um e-mail digitado. Quem leva a mudança ao Google é a coluna
  // gerada `needs_google_push` (migration 0200), que passa a `true` sozinha
  // porque o trigger de `updated_at` disparou neste mesmo UPDATE.
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
      const consulta = await exigeHorarioLivre(supabase, ctx, {
        eventTypeId: tipo.id,
        donoId: atual.owner_user_id as string,
        inicio: novoInicio,
        fim: novoFim,
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

  const { data: salvo, error: erroUpdate } = await supabase
    .from("calendar_appointments")
    .update(mudanca)
    .eq("organization_id", ctx.organization_id)
    .eq("id", atual.id as string)
    .select("id, starts_at, ends_at, status, time_zone")
    .single();
  if (erroUpdate) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, erroUpdate.message);
  }

  if (transicao) {
    await fecharOLaco(supabase, ctx, {
      appointmentId: atual.id as string,
      contactId: (atual.contact_id as string | null) ?? null,
      atividade: atividadeDaTransicao(atual.status as SituacaoAnterior, transicao),
      transicao,
      empurrarAoGoogle: precisaEmpurrarAoGoogle(atual.status as SituacaoAnterior, transicao),
      fusoDoCompromisso: salvo.time_zone,
      nomeDoTipo: "Agendamento",
    });

    // ⚠️ `completed` e `no_show` NÃO são auditados, por decisão do maestro: não
    // são mutação de intenção, são registro de fato já consumado, e vivem na
    // timeline. Procurar o tipo de audit deles e não achar é o esperado.
    if (transicao === "rescheduled") {
      void audit({
        action: "agenda.appointment_rescheduled",
        actorUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
        organizationId: ctx.organization_id,
        resourceType: "calendar_appointment",
        resourceId: atual.id as string,
        requestId: ctx.requestId,
        metadata: { de: atual.starts_at, para: salvo.starts_at },
      });
    }
  }

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
    "contact_id",
    "status",
    "time_zone",
  ]);

  // Idempotente: cancelar o que já está cancelado devolve o estado, não erro —
  // quem chamou queria o compromisso desmarcado, e ele está.
  if (atual.status === "cancelled") {
    return { id: atual.id, status: "cancelled", ja_estava: true };
  }

  const { data: salvo, error: erroUpdate } = await supabase
    .from("calendar_appointments")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      cancellation_reason: input.reason,
    })
    .eq("organization_id", ctx.organization_id)
    .eq("id", atual.id as string)
    .select("id, status, cancelled_at, cancellation_reason")
    .single();
  if (erroUpdate) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, erroUpdate.message);
  }

  await fecharOLaco(supabase, ctx, {
    appointmentId: atual.id as string,
    contactId: (atual.contact_id as string | null) ?? null,
    atividade: atividadeDaTransicao(atual.status as SituacaoAnterior, "cancelled"),
    transicao: "cancelled",
    empurrarAoGoogle: precisaEmpurrarAoGoogle(atual.status as SituacaoAnterior, "cancelled"),
    fusoDoCompromisso: atual.time_zone as string,
    nomeDoTipo: "Agendamento",
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
 * O horário pedido está entre os que esta agenda oferece?
 *
 * ⚠️ Pela MESMA coleta que responde o GET e as ferramentas de leitura
 * (`horariosLivresDaOrg`), nunca por uma segunda. Duas coletas divergem no
 * primeiro ajuste: se a regra do que OCUPA mudar, uma muda e a outra não — e aí
 * a tela oferece horário que a escrita recusa, ou a escrita aceita um que a tela
 * não ofereceu e alguém chega numa hora que já tinha dono.
 */
async function exigeHorarioLivre(
  supabase: SB,
  ctx: HandlerCtx,
  args: { eventTypeId: string; donoId: string; inicio: Date; fim: Date },
): Promise<{ fusoDaRegra: string }> {
  const consulta = await horariosLivresDaOrg(supabase, ctx.organization_id, {
    eventTypeId: args.eventTypeId,
    ownerUserId: args.donoId,
    de: args.inicio,
    ate: args.fim,
    agora: new Date(),
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
  if (!consulta.slots.some((s) => s.inicio.getTime() === args.inicio.getTime())) {
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

/** `Actor` → o vocabulário de `calendar_appointments.created_by_kind`. */
function autorParaCriacao(actor: Actor): string {
  return actor.type === "user" ? "user" : "ai";
}

/**
 * Os TRÊS emissores do laço, no mesmo fluxo da mutação.
 *
 * `crm_lead_links` faz o compromisso PERTENCER ao negócio (é por ele que o
 * dossiê o lista); `crm_lead_activities` é o que aparece na TIMELINE; `event_log`
 * é o que leva o compromisso ao Google. Só o vínculo e nada aparece na tela; só
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
    transicao: Transicao;
    empurrarAoGoogle: boolean;
    fusoDoCompromisso: string;
    nomeDoTipo: string;
  },
): Promise<void> {
  if (args.empurrarAoGoogle) {
    // ⚠️ AINDA SEM CONSUMIDOR. `agenda.appointment.push_to_google` não é
    // declarado por handler nenhum, e `drain.ts:54` filtra por
    // `.in("event_type", handledTypes)` — a linha nunca é SELECIONADA e fica
    // `pending` para sempre: não vira `dead`, não conta tentativa, não acende
    // aviso. E não há sonda sobre `event_log` parado. O consumidor é da frente
    // do Google; o contrato e o payload (com o fuso) já estão prontos aqui.
    await supabase.from("event_log").insert({
      organization_id: ctx.organization_id,
      event_type: "agenda.appointment.push_to_google",
      entity_kind: "calendar_appointment",
      entity_id: args.appointmentId,
      payload: { appointment_id: args.appointmentId, time_zone: args.fusoDoCompromisso },
    });
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
