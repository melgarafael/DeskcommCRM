import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { marcaDaSaida } from "@/lib/branding/saida";
import { canalDoEventoDesativado } from "@/lib/channels/desativado";
import { createAdminClient } from "@/lib/supabase/admin";
import { montarPayloadDeInbound, truncar } from "./push_payload";
import { enviarPushAoUsuario, enviarPushAQuemVeAConversa, enviarPushDaOrg } from "./web_push";
import { carregarDestinatariosDaMensagem, type DestinatariosDaMensagem } from "./destinatarios-da-mensagem";
import { logger } from "@/lib/logger";
import { vapidPronto } from "./vapid";
import { pushDoAvisoDaCentral } from "./push-dos-avisos";
import type { PushPayload } from "./push_payload";
import { rotuloDoContato, SEM_NOME } from "@/lib/contacts/rotulo-do-contato";

export const WEB_PUSH_INBOUND_KEY = "web-push-inbound.v1";

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
  const previewRaw = row.payload.body_preview;
  const preview = typeof previewRaw === "string" && previewRaw.trim() ? previewRaw : "Nova mensagem";
  const type = typeof row.payload.type === "string" ? row.payload.type : "text";
  const body = type === "text" ? preview : "Mídia";

  const marca = await marcaDaSaida(row.organization_id);
  const contactId = typeof row.payload.contact_id === "string" ? row.payload.contact_id : null;
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
  });
  const destino = await destinatariosDoInbound(row.organization_id, conversationId, contactId);
  // Quem DEVE ser avisado (`destino`) nunca alarga quem PODE ver: nome e prévia
  // só saem para quem a RLS de `conversations` deixaria abrir a conversa.
  const soUsuarios = destino.tipo === "restrito" ? destino.userIds : undefined;
  const { sent } = await enviarPushAQuemVeAConversa(row.organization_id, conversationId, payload, soUsuarios);
  const detail = soUsuarios ? `sent:${sent};restrito:${soUsuarios.length}` : `sent:${sent}`;
  return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "ok", detail };
}

/**
 * Para quem vai o push da mensagem recebida — regra em
 * `./destinatarios-da-mensagem.ts` (responsável + admins, ou todos).
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
 * está falando. Título fixo, igual em toda organização.
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
  const previewRaw = row.payload.body_preview;
  const preview = typeof previewRaw === "string" && previewRaw.trim() ? previewRaw : "Nova mensagem";
  const type = typeof row.payload.type === "string" ? row.payload.type : "text";
  const body = type === "text" ? preview : "Mídia";

  const payload: PushPayload = {
    title: "Nova mensagem no grupo",
    body: truncar(body),
    tag: `msg:${conversationId}`,
    href: `/app/inbox?id=${conversationId}`,
  };
  const { sent } = await enviarPushAQuemVeAConversa(row.organization_id, conversationId, payload);
  return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "ok", detail: `sent:${sent}` };
}

/** Os avisos da Central que pedem gente — ver `./push-dos-avisos.ts`. */
async function handleAvisoQuePedeGente(row: EventRow): Promise<HandlerResult> {
  const id = typeof row.payload.item_id === "string" ? row.payload.item_id : row.entity_id;
  if (!id) return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "sem_alvo" };
  const payload = await pushDoAvisoDaCentral(createAdminClient(), row.organization_id, id);
  if (payload === null) {
    return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "aviso_fora_do_celular" };
  }
  const { sent } = await enviarPushDaOrg(row.organization_id, payload);
  return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "ok", detail: `sent:${sent}` };
}

async function leadBits(organizationId: string, leadId: string): Promise<{
  title: string;
  ownerUserId: string | null;
  pipelineId: string | null;
}> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("crm_leads")
    .select("title, owner_user_id, pipeline_id")
    .eq("id", leadId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const row = data as {
    title?: string | null;
    owner_user_id?: string | null;
    pipeline_id?: string | null;
  } | null;
  return {
    title: row?.title?.trim() || "Lead",
    ownerUserId: row?.owner_user_id ?? null,
    pipelineId: row?.pipeline_id ?? null,
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
      const preview =
        typeof row.payload.body_preview === "string" ? row.payload.body_preview : "Você foi mencionado";
      // Mencionado que não pode ver a conversa não recebe aviso nenhum — nem sem
      // prévia: tag e link já apontam a conversa. É o que o sino dentro do app
      // já faz (a nota chega pela RLS de `conversation_notes`).
      const { sent } = await enviarPushAQuemVeAConversa(
        row.organization_id,
        conversationId,
        {
          title: "Você foi mencionado",
          body: truncar(preview),
          tag: `mention:${conversationId}`,
          href: `/app/inbox/${conversationId}`,
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
        title: "Lead atribuído a você",
        body: truncar(lead.title),
        tag: `lead-assigned:${leadId}`,
        href,
      });
    }
    if (row.event_type === "lead.won") {
      return enviarParaUsuario(row.organization_id, lead.ownerUserId, {
        title: "Lead ganho",
        body: truncar(lead.title),
        tag: `lead-won:${leadId}`,
        href,
      });
    }
    return enviarParaUsuario(row.organization_id, lead.ownerUserId, {
      title: "Lead perdido",
      body: truncar(lead.title),
      tag: `lead-lost:${leadId}`,
      href,
    });
  },
};
