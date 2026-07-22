/**
 * Tool consolidada `get_lead_context` pós-fusão: o payload CURADO (contato +
 * últimas N mensagens) agora vem de LEITURA DIRETA das tabelas canônicas do CRM
 * (contacts/conversations/messages — mesmo banco), não mais de tools MCP.
 *
 * Garantias preservadas do design original:
 *   - org-scoped: TODA query filtra organization_id + contact_id de fonte
 *     confiável (closure do job — regra dura nº 1), nunca de payload;
 *   - erro vira MENSAGEM DE ENSINO pt-br pro modelo, nunca stack cru;
 *   - determinístico: mesmo input ⇒ mesmo payload byte-a-byte (truncamento é
 *     função pura do conteúdo);
 *   - is_blocked lido DIRETO da fonte (contacts) — não existe mais cache.
 */
import type { Queryable } from '../../queue/queue';
import type { CrmEdgeConfig } from './mcp-client';
import { deriveLgpdFromContact, type LgpdInput } from '../../guardrails/lgpd/legal-basis';

/**
 * Heurística conservadora de contagem: ~3,5 chars/token para pt-br (BPE real fica
 * entre 3,5 e 4; dividir por menos SUPERESTIMA tokens — erra pro lado seguro).
 */
const CHARS_PER_TOKEN = 3.5;

export function countPayloadTokens(serialized: string): number {
  return Math.ceil(serialized.length / CHARS_PER_TOKEN);
}

/** Knobs do payload (env LEAD_CONTEXT_*; defaults documentados no .env.example). */
export interface LeadContextKnobs {
  /** Últimas N mensagens do histórico incluídas (default 20). */
  historyLimit: number;
  /** Teto do payload serializado, contado por countPayloadTokens (default 1000). */
  maxTokens: number;
}

/** Uma mensagem do histórico, já curada. */
export interface LeadContextMessage {
  direction: 'inbound' | 'outbound';
  /** Corpo textual; mídia usa o derivado (transcrição/visão/pdf) ou marcador [tipo]. */
  body: string;
  sent_at: string;
  /** Metadados de mídia (Onda 3): presentes só em mensagens com mídia. */
  type?: string;
  media_storage_path?: string | null;
  media_mime?: string | null;
}

/** Payload curado que o modelo recebe. */
export interface LeadContext {
  lead_id: string;
  contact: {
    name: string | null;
    phone: string | null;
    email: string | null;
    tags: string[];
    /** contacts.is_blocked lido NESTE turno (fonte da verdade do gate 1). */
    is_blocked: boolean;
  };
  conversation_id: string | null;
  /** Últimas N mensagens, da mais antiga para a mais nova. */
  messages: LeadContextMessage[];
}

export type LeadContextErrorCode = 'lead_not_found' | 'crm_error' | 'crm_unavailable';

/**
 * Resultado da tool. `ok:false` é a mensagem de ensino pro modelo — pt-br,
 * instrutiva, sem stack e sem credencial.
 */
export type LeadContextResult =
  | { ok: true; context: LeadContext; tokenCount: number; lgpd: LgpdInput }
  | { ok: false; error: { code: LeadContextErrorCode; message: string } };

function teach(code: LeadContextErrorCode, message: string): LeadContextResult {
  return { ok: false, error: { code, message } };
}

interface ContactRow {
  name: string | null;
  display_name: string | null;
  email: string | null;
  phone_number: string | null;
  tags: string[] | null;
  is_blocked: boolean;
  source: string | null;
  consent: Record<string, unknown> | null;
  is_anonymized: boolean;
}

interface HistoryRow {
  direction: 'inbound' | 'outbound';
  type: string;
  body: string | null;
  media_url: string | null;
  media_storage_path: string | null;
  media_mime: string | null;
  media_derived_text: string | null;
  sent_at: string;
}

export async function getLeadContext(
  db: Queryable,
  _cfg: CrmEdgeConfig,
  input: { tenantId: string; leadId: string; conversationId?: string | null },
  knobs: LeadContextKnobs,
): Promise<LeadContextResult> {
  const { rows: contactRows } = await db.query<ContactRow>(
    `select name, display_name, email, phone_number, tags, is_blocked, source, consent, is_anonymized
     from contacts where organization_id = $1 and id = $2`,
    [input.tenantId, input.leadId],
  );
  const contact = contactRows[0];
  if (!contact) {
    return teach(
      'lead_not_found',
      'não encontrei esse lead nesta organização — confira o lead antes de continuar; se o problema persistir, peça handoff humano.',
    );
  }

  // Conversa: a do job quando informada (fonte confiável); senão a 1:1 mais
  // recente do contato. Grupos NUNCA (regra dura nº 12).
  let conversationId = input.conversationId ?? null;
  if (conversationId === null) {
    const { rows } = await db.query<{ id: string }>(
      `select id from conversations
       where organization_id = $1 and contact_id = $2 and is_group = false
       order by last_message_at desc nulls last limit 1`,
      [input.tenantId, input.leadId],
    );
    conversationId = rows[0]?.id ?? null;
  }

  const history: HistoryRow[] = conversationId
    ? (
        await db.query<HistoryRow>(
          `select direction, type, body, media_url, media_storage_path, media_mime,
                  media_derived_text, sent_at::text as sent_at
           from messages
           where organization_id = $1 and conversation_id = $2
             and direction in ('inbound', 'outbound')
           order by sent_at desc, id desc
           limit $3`,
          [input.tenantId, conversationId, knobs.historyLimit],
        )
      ).rows.reverse()
    : [];

  // LGPD: base legal derivada DIRETO do contato (fonte da verdade, mesmo banco).
  // isProspecting=false: o MVP é inbound + follow-up — ambos respondem a lead que
  // já engajou, nunca 1º toque frio (o veto de is_anonymized vale SEMPRE).
  const lgpd = deriveLgpdFromContact(
    {
      source: contact.source,
      consent: contact.consent,
      is_anonymized: contact.is_anonymized,
    },
    false,
  );

  const context = fitToBudget(
    {
      lead_id: input.leadId,
      contact: {
        name: contact.display_name ?? contact.name,
        phone: contact.phone_number,
        email: contact.email,
        tags: contact.tags ?? [],
        is_blocked: contact.is_blocked,
      },
      conversation_id: conversationId,
    },
    history,
    knobs.maxTokens,
  );
  return { ok: true, context, tokenCount: countPayloadTokens(JSON.stringify(context)), lgpd };
}

/**
 * Encaixa o payload no orçamento (determinístico):
 *   1. mensagens mais ANTIGAS caem primeiro;
 *   2. restando uma única mensagem que ainda estoura, o corpo é cortado ao meio
 *      repetidamente até caber. Nunca erro fatal.
 */
function fitToBudget(
  base: Omit<LeadContext, 'messages'>,
  history: HistoryRow[],
  maxTokens: number,
): LeadContext {
  let messages: LeadContextMessage[] = history.map((m) => {
    const hasMedia = Boolean(m.media_storage_path || m.media_url);
    const derived = m.media_derived_text;
    // Onda 3: legenda e derivado (transcrição/visão/pdf) COEXISTEM, e o derivado
    // vem ENQUADRADO (frameMediaBody) — sem isso o agente caía no reflexo
    // "não consigo ver mídia" mesmo tendo o conteúdo. Sem derivado, marcador [tipo].
    const body = derived
      ? frameMediaBody(m.type, m.body, derived)
      : (m.body ?? (hasMedia ? `[${m.type}]` : ''));
    return {
      direction: m.direction,
      body,
      sent_at: m.sent_at,
      ...(hasMedia ? { type: m.type, media_storage_path: m.media_storage_path, media_mime: m.media_mime } : {}),
    };
  });
  const build = (msgs: LeadContextMessage[]): LeadContext => ({ ...base, messages: msgs });
  const over = (msgs: LeadContextMessage[]): boolean =>
    countPayloadTokens(JSON.stringify(build(msgs))) > maxTokens;

  while (messages.length > 1 && over(messages)) {
    messages = messages.slice(1);
  }
  while (messages.length === 1 && messages[0]!.body.length > 0 && over(messages)) {
    messages = [{ ...messages[0]!, body: messages[0]!.body.slice(0, Math.floor(messages[0]!.body.length / 2)) }];
  }
  return build(messages);
}

/** Substantivo pt-br por tipo de mídia (p/ o enquadramento do derivado). */
const MEDIA_NOUN: Record<string, string> = {
  image: 'uma imagem',
  video: 'um vídeo',
  audio: 'um áudio',
  document: 'um documento (PDF)',
  sticker: 'uma figurinha',
};

/**
 * Enquadra o derivado de mídia como PERCEPÇÃO do agente (Onda 3, ajuste pós-prova).
 * Sem isto, o modelo via a transcrição/descrição mas respondia "não consigo ver
 * mídia" por reflexo. O enquadramento diz explicitamente: o conteúdo já foi
 * processado; trate como se tivesse visto/ouvido; nunca negue a mídia. Legenda do
 * cliente (se houver) e conteúdo derivado coexistem. @internal exposto p/ teste.
 */
export function frameMediaBody(type: string, caption: string | null, derived: string): string {
  const noun = MEDIA_NOUN[type] ?? 'uma mídia';
  const parts = [
    `[Mídia do cliente: ele enviou ${noun} e o sistema já processou o conteúdo pra você. ` +
      `Trate o texto abaixo como se você mesma tivesse visto/ouvido — NUNCA responda que não ` +
      `consegue ver/ouvir mídia. Comente ou use o conteúdo naturalmente.]`,
  ];
  if (caption && caption.trim() !== '') parts.push(`Legenda do cliente: ${caption.trim()}`);
  parts.push(`Conteúdo: ${derived}`);
  return parts.join('\n');
}

/** @internal exposto p/ teste — não usar fora de testes. */
export const __test_fitToBudget = fitToBudget;
