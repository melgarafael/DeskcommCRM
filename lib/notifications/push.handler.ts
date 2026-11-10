import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { PAPEL_MINIMO_DA_CENTRAL } from "@/lib/ai/inbox-destino";
import { marcaDaSaida } from "@/lib/branding/saida";
import { canalDoEventoDesativado } from "@/lib/channels/desativado";
import { createAdminClient } from "@/lib/supabase/admin";
import { NOTIFY_KINDS } from "./kinds";
import { corpoDoAvisoDeMensagem, montarPayloadDeInbound, truncar } from "./push_payload";
import {
  enviarPushAoUsuario,
  enviarPushAQuemVeAConversa,
  enviarPushDaEtapaAQuemVeONegocio,
  enviarPushDaOrg,
} from "./web_push";
import { carregarDestinatariosDaMensagem, type DestinatariosDaMensagem } from "./destinatarios-da-mensagem";
import { logger } from "@/lib/logger";
import { vapidPronto } from "./vapid";
import { organizacaoDoPush, pushDoAvisoDaCentral } from "./push-dos-avisos";
import {
  escopoDeQuemRecebe,
  ganhosDeHoje,
  inicioDoDia,
  linhaDoDia,
  tituloComValor,
  valorDoNegocio,
} from "./push-de-venda";
import { traduzir } from "@/lib/i18n/dicionario";
import type { PushPayload } from "./push_payload";
import { rotuloDoContato, SEM_NOME } from "@/lib/contacts/rotulo-do-contato";

export const WEB_PUSH_INBOUND_KEY = "web-push-inbound.v1";

/** Corpo do aviso de mensagem a partir do evento (`body_preview` + `type`). */
function corpoDoEvento(row: EventRow): { body: string; corpoSemPrevia: string } {
  const previa = typeof row.payload.body_preview === "string" ? row.payload.body_preview : null;
  const tipo = typeof row.payload.type === "string" ? row.payload.type : "text";
  return corpoDoAvisoDeMensagem(tipo, previa);
}

async function handleInbound(row: EventRow): Promise<HandlerResult> {
  // Canal DESATIVADO (#2329): a lei do #2318 vale nos dois sentidos — o canal
  // desligado não acorda a IA e também não enche o bolso de quem está de
  // plantão com uma conversa que a inbox nem mostra. Mesma ida de
  // `channel_session_id` que o payload do `fn_emit_message_event` já traz.
  if (await canalDoEventoDesativado(createAdminClient(), row.organization_id, row.payload)) {
    return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "canal_desativado" };
  }
  const conversationId =
    (typeof row.payload.conversation_id === "string" ? row.payload.conversation_id : null) ?? null;
  // Sem conversa não há como saber quem pode vê-la: ninguém recebe.
  if (!conversationId) {
    return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "sem_conversa" };
  }
  const contactId = typeof row.payload.contact_id === "string" ? row.payload.contact_id : null;
  // Decidido antes de montar o payload: conversa que a IA conduz não avisa a
  // ninguém, e então nem nome nem foto do contato precisam ser lidos.
  const destino = await destinatariosDoInbound(row.organization_id, conversationId, contactId);
  if (destino.tipo === "ninguem") {
    return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "ia_conduz" };
  }
  const { body, corpoSemPrevia } = corpoDoEvento(row);

  const marca = await marcaDaSaida(row.organization_id, { semMemo: true });
  let contactName: string | null = null;
  let icon: string | null = null;
  if (contactId) {
    const admin = createAdminClient();
    const { data } = await admin
      .from("contacts")
      .select("display_name, name, phone_number, avatar_storage_path, is_anonymized, is_personal")
      .eq("id", contactId)
      .eq("organization_id", row.organization_id)
      .maybeSingle();
    const c = data as {
      display_name?: string | null;
      name?: string | null;
      phone_number?: string | null;
      avatar_storage_path?: string | null;
      is_anonymized?: boolean | null;
      is_personal?: boolean | null;
    } | null;
    // Pessoal não empurra nada no bolso (spec 21, etapa 10, caminho 3): sem push.
    if (c?.is_personal === true) {
      return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "contato_pessoal" };
    }
    // A cadeia CANÔNICA, e não a de dois campos remontada aqui: aquela deixava
    // passar o identificador técnico do WhatsApp — a notificação chegaria à tela
    // de bloqueio do celular escrita "Contato 543134@lid". `rotuloDoContato`
    // recusa identificador, cai para o telefone formatado, e só então desiste.
    //
    // (A varredura de `rotulo-do-contato.test.ts` lê o arquivo INTEIRO, comentário
    // incluído — por isso a cadeia proibida não é escrita nem aqui em prosa.)
    //
    // `SEM_NOME` volta a `null` de propósito: o payload já tem um desfecho
    // melhor para "não sei o nome" (`"Nova mensagem"`, em push_payload.ts), e
    // trocá-lo por "Sem nome" pioraria o título sem ninguém pedir.
    const rotulo = rotuloDoContato(c);
    contactName = rotulo === SEM_NOME ? null : rotulo;
    if (c?.avatar_storage_path && !c.is_anonymized) {
      const { data: signed } = await admin.storage
        .from("whatsapp-media")
        .createSignedUrl(c.avatar_storage_path, 300);
      icon = signed?.signedUrl ?? null;
    }
  }
  const payload = montarPayloadDeInbound({
    brand: marca.nome,
    conversationId,
    preview: body,
    contactName,
    icon,
    corpoSemPrevia,
  });
  // Quem DEVE ser avisado (`destino`) nunca alarga quem PODE ver: nome e prévia
  // só saem para quem a RLS de `conversations` deixaria abrir a conversa.
  const soUsuarios = destino.tipo === "restrito" ? destino.userIds : undefined;
  const { sent } = await enviarPushAQuemVeAConversa(row.organization_id, conversationId, payload, soUsuarios);
  const detail = soUsuarios ? `sent:${sent};restrito:${soUsuarios.length}` : `sent:${sent}`;
  return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "ok", detail };
}

/**
 * Para quem vai o push da mensagem recebida — regra em
 * `./destinatarios-da-mensagem.ts` (responsável + admins, ninguém quando a IA
 * conduz, quem está de plantão, ou todos).
 *
 * Falha de leitura cai para "todos", de propósito: era o comportamento antes
 * da regra, e um aviso a mais é um incômodo, enquanto um aviso a menos é
 * cliente sem resposta. O evento também não é reprocessado por isso — repetir
 * o handler mandaria o push duas vezes a quem já recebeu.
 */
async function destinatariosDoInbound(
  organizationId: string,
  conversationId: string,
  contactId: string | null,
): Promise<DestinatariosDaMensagem> {
  try {
    const destino = await carregarDestinatariosDaMensagem(
      createAdminClient(),
      organizationId,
      conversationId,
      contactId,
    );
    return destino ?? { tipo: "todos" };
  } catch (err) {
    logger.warn("push_inbound_destinatarios_falhou", {
      organization_id: organizationId,
      conversation_id: conversationId,
      detail: err instanceof Error ? err.message : String(err),
    });
    return { tipo: "todos" };
  }
}

/**
 * `message.group_received` — MESMO payload de `message.received` (a
 * conversa é a do GRUPO ligado, o "contato" é o placeholder de
 * `kind='whatsapp_group'`), mas nunca a cópia do 1:1: não busca nome/avatar de
 * contato (a IA não serve grupos, e a Task 8 não abre exceção só para a
 * notificação), não cria nem roteia nada — só avisa o atendente que o grupo
 * está falando. Título fixo, no idioma da organização.
 *
 * Quem recebe é a mesma régua do 1:1: só quem pode ver a conversa do grupo.
 */
async function handleGroupInbound(row: EventRow): Promise<HandlerResult> {
  // Canal DESATIVADO (#2329): a mesma régua de `handleInbound` — a inbox
  // esconde o grupo do canal pausado também, e o payload é o mesmo.
  if (await canalDoEventoDesativado(createAdminClient(), row.organization_id, row.payload)) {
    return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "canal_desativado" };
  }
  const conversationId = typeof row.payload.conversation_id === "string" ? row.payload.conversation_id : null;
  if (!conversationId) {
    return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "sem_conversa" };
  }
  const { body, corpoSemPrevia } = corpoDoEvento(row);
  const { idioma } = await organizacaoDoPush(createAdminClient(), row.organization_id);

  const payload: PushPayload = {
    title: traduzir("Nova mensagem no grupo", idioma),
    body,
    corpoSemPrevia,
    tag: `${NOTIFY_KINDS.message_inbound.tagPrefix}:${conversationId}`,
    href: `/app/inbox?id=${conversationId}`,
    tipo: "message",
  };
  const { sent } = await enviarPushAQuemVeAConversa(row.organization_id, conversationId, payload);
  return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "ok", detail: `sent:${sent}` };
}

/** Os avisos da Central que pedem gente — ver `./push-dos-avisos.ts`. */
async function handleAvisoQuePedeGente(row: EventRow): Promise<HandlerResult> {
  const id = typeof row.payload.item_id === "string" ? row.payload.item_id : row.entity_id;
  if (!id) return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "sem_alvo" };
  const aviso = await pushDoAvisoDaCentral(createAdminClient(), row.organization_id, id);
  if (aviso === null) {
    return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "aviso_fora_do_celular" };
  }
  // A etapa que avisa não tem um texto só: o valor e a soma do dia vão a quem
  // VÊ o negócio, e a frase fixa a quem não vê (`./web_push.ts`, #3981). Os
  // outros avisos seguem com um texto para a organização.
  if (aviso.etapa) {
    const { sent } = await enviarPushDaEtapaAQuemVeONegocio(
      row.organization_id,
      aviso.etapa.leadId,
      { ampla: aviso.payload, daCarteira: aviso.etapa.daCarteira, semValor: aviso.etapa.semValor },
      aviso.para.papelMinimo ?? PAPEL_MINIMO_DA_CENTRAL,
    );
    return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "ok", detail: `sent:${sent}` };
  }
  const { sent } = await enviarPushDaOrg(row.organization_id, aviso.payload, aviso.para);
  return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "ok", detail: `sent:${sent}` };
}

async function leadBits(organizationId: string, leadId: string): Promise<{
  title: string;
  ownerUserId: string | null;
  pipelineId: string | null;
  valor: ReturnType<typeof valorDoNegocio>;
}> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("crm_leads")
    .select("title, owner_user_id, pipeline_id, value_cents, currency")
    .eq("id", leadId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const row = data as {
    title?: string | null;
    owner_user_id?: string | null;
    pipeline_id?: string | null;
    value_cents?: number | null;
    currency?: string | null;
  } | null;
  return {
    title: row?.title?.trim() || "Lead",
    ownerUserId: row?.owner_user_id ?? null,
    pipelineId: row?.pipeline_id ?? null,
    valor: valorDoNegocio(row),
  };
}

function hrefDoLead(pipelineId: string | null): string {
  return pipelineId ? `/app/pipelines/${pipelineId}` : "/app/kanban";
}

async function enviarParaUsuario(
  organizationId: string,
  userId: string | null,
  payload: PushPayload,
): Promise<HandlerResult> {
  if (!userId) {
    return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "sem_destinatario" };
  }
  const { sent } = await enviarPushAoUsuario(organizationId, userId, payload);
  return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "ok", detail: `sent:${sent}` };
}

export const webPushInboundHandler: EventHandler = {
  key: WEB_PUSH_INBOUND_KEY,
  naOrgParada: "pula",
  events: [
    "message.received",
    "message.group_received",
    "lead.assigned",
    "lead.won",
    "lead.lost",
    "user.mentioned",
    // Os avisos que pedem gente (migration 0442) — ver `./push-dos-avisos.ts`.
    "central.aviso_criado",
  ],
  async handle(row): Promise<HandlerResult> {
    if (!vapidPronto()) {
      return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "vapid_ausente" };
    }
    if (row.event_type === "message.received") return handleInbound(row);
    if (row.event_type === "message.group_received") return handleGroupInbound(row);
    if (row.event_type === "central.aviso_criado") return handleAvisoQuePedeGente(row);

    // Os títulos saem no idioma da ORGANIZAÇÃO: ninguém está logado quando o
    // push sai. O fuso diz onde começa o "hoje" da soma dos ganhos.
    const { idioma, fuso, visibilidade } = await organizacaoDoPush(createAdminClient(), row.organization_id);

    if (row.event_type === "user.mentioned") {
      const toUserId = typeof row.payload.to_user_id === "string" ? row.payload.to_user_id : null;
      const conversationId =
        typeof row.payload.conversation_id === "string" ? row.payload.conversation_id : null;
      if (!toUserId) {
        return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "sem_destinatario" };
      }
      // Sem conversa não há como saber se o mencionado pode vê-la: ninguém recebe.
      if (!conversationId) {
        return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "sem_conversa" };
      }
      const titulo = traduzir("Você foi mencionado", idioma);
      const preview = typeof row.payload.body_preview === "string" ? row.payload.body_preview : titulo;
      // Mencionado que não pode ver a conversa não recebe aviso nenhum — nem sem
      // prévia: tag e link já apontam a conversa. É o que o sino dentro do app
      // já faz (a nota chega pela RLS de `conversation_notes`).
      const { sent } = await enviarPushAQuemVeAConversa(
        row.organization_id,
        conversationId,
        // Sem corpo sem prévia: o texto da nota é conteúdo.
        {
          title: titulo,
          body: truncar(preview),
          tag: `${NOTIFY_KINDS.mention.tagPrefix}:${conversationId}`,
          href: `/app/inbox/${conversationId}`,
          tipo: "mention",
        },
        [toUserId],
      );
      return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "ok", detail: `sent:${sent}` };
    }

    const leadId =
      (typeof row.payload.lead_id === "string" ? row.payload.lead_id : null) ??
      (typeof row.entity_id === "string" ? row.entity_id : null);
    if (!leadId) {
      return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "sem_lead" };
    }
    const lead = await leadBits(row.organization_id, leadId);
    const href = hrefDoLead(lead.pipelineId);

    if (row.event_type === "lead.assigned") {
      const toUserId = typeof row.payload.to_user_id === "string" ? row.payload.to_user_id : lead.ownerUserId;
      return enviarParaUsuario(row.organization_id, toUserId, {
        title: traduzir("Lead atribuído a você", idioma),
        body: truncar(lead.title),
        corpoSemPrevia: truncar(lead.title),
        tag: `${NOTIFY_KINDS.lead_assigned.tagPrefix}:${leadId}`,
        href,
        tipo: "lead_assigned",
      });
    }
    if (row.event_type === "lead.won") {
      // O valor do negócio no título e, no corpo, ao lado de quem ganhou,
      // quantos ganhos o dia já tem e a soma deles na mesma moeda
      // (`./push-de-venda.ts`).
      //
      // DUAS audiências, e não só o dono (#3981): a GESTÃO vê a organização
      // inteira, então recebe o ganho de qualquer negócio com a soma do dia
      // inteira; o DONO continua recebendo o dele com a soma que ELE vê (o
      // papel dele e o `visibility_mode`, via `escopoDeQuemRecebe`). Num texto
      // só isso não caberia — o número do dono é o da carteira dele e o da
      // gestão é o da organização, e mandar um deles aos dois mostraria a
      // alguém um número que a tela dele não mostra. O dono que também é gestor
      // recebe UMA vez, pelo texto do dono (`excetoUsuario`); o escopo dele já
      // é a organização inteira.
      const moeda = lead.valor?.moeda ?? null;
      const admin = createAdminClient();
      const desde = inicioDoDia(new Date(), fuso);
      const titulo = truncar(tituloComValor(traduzir("Lead ganho", idioma), lead.valor));
      const corpo = (dia: string | null) => truncar(dia ? `${lead.title} · ${dia}` : lead.title);
      const corpoSemPrevia = truncar(lead.title);
      const tag = `${NOTIFY_KINDS.lead_won.tagPrefix}:${leadId}`;

      const diaDaGestao = linhaDoDia(
        traduzir("Ganhos hoje: {quantidade}", idioma),
        await ganhosDeHoje(admin, row.organization_id, moeda, desde, null),
        moeda,
      );
      const daGestao = await enviarPushDaOrg(
        row.organization_id,
        { title: titulo, body: corpo(diaDaGestao), corpoSemPrevia, tag, href, tipo: "lead_won" },
        { papelMinimo: "manager", excetoUsuario: lead.ownerUserId ?? undefined },
      );

      // Negócio sem dono: não há a quem mandar o texto do dono — a gestão já
      // recebeu, e é ela quem enxerga (e atende) o negócio sem responsável.
      if (!lead.ownerUserId) {
        return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "ok", detail: `sent:${daGestao.sent}` };
      }
      const diaDoDono = linhaDoDia(
        traduzir("Ganhos hoje: {quantidade}", idioma),
        await ganhosDeHoje(
          admin,
          row.organization_id,
          moeda,
          desde,
          await escopoDeQuemRecebe(admin, row.organization_id, lead.ownerUserId, visibilidade),
        ),
        moeda,
      );
      const doDono = await enviarPushAoUsuario(row.organization_id, lead.ownerUserId, {
        title: titulo,
        body: corpo(diaDoDono),
        corpoSemPrevia,
        tag,
        href,
        tipo: "lead_won",
      });
      return {
        consumer_key: WEB_PUSH_INBOUND_KEY,
        status: "ok",
        detail: `sent:${daGestao.sent + doDono.sent};gestao:${daGestao.sent}`,
      };
    }
    return enviarParaUsuario(row.organization_id, lead.ownerUserId, {
      title: traduzir("Lead perdido", idioma),
      body: truncar(lead.title),
      corpoSemPrevia: truncar(lead.title),
      tag: `${NOTIFY_KINDS.lead_lost.tagPrefix}:${leadId}`,
      href,
      tipo: "lead_lost",
    });
  },
};
