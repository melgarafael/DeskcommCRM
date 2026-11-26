/**
 * Ler o estado de elegibilidade de uma conversa via pool `pg` (o transporte do
 * agent-engine). Uma query, três tabelas: o modo do gate do canal, as travas do
 * contato, o silêncio da conversa.
 *
 * O drain (decide ENFILEIRAR) e o turno (decide RODAR) chamam isto e passam o
 * resultado para `decidirElegibilidade` — a MESMA regra pura.
 */
import type pg from "pg";

import { tetoDoAnonimoDoCanal } from "@/lib/channels/teto-do-anonimo";
import { logger } from "@/lib/logger";
import type { Logger } from "../../agent-engine/obs/logger";

import {
  decidirElegibilidade,
  montarEstadoDeElegibilidade,
  type DecisaoDaConversa,
} from "./gate";

interface LinhaDeElegibilidade {
  channel_metadata: Record<string, unknown> | null;
  force_human: boolean;
  ai_opt_out: boolean;
  assignee_kind: string | null;
  /** `conversations.metadata` — o modo "IA com o dono" (#3967) mora aqui. */
  conversation_metadata: unknown;
  bot_silenced_until: Date | string | null;
  ai_authorized_at: Date | string | null;
  phone_number: string | null;
  email: string | null;
  /** `contacts.social_identity` — o testador de Instagram/Facebook casa por aqui. */
  social_identity: string | null;
  org_status: string | null;
  /** `contacts.tags` — a régua de contato interno (#2353) e a da equipe (#3534). */
  contact_tags: string[] | null;
  /** `organizations.settings` — as listas moram em `.crm.internal_contact_tags` e `.crm.team_contact_tags`. */
  org_settings: unknown;
  /** `channel_sessions.provider` — o seam de canais decide o teto do anônimo. */
  provider: string | null;
}

/**
 * Roda a query e a regra. `null` = conversa não encontrada (deixe o chamador
 * decidir; o drain trata como "sem gate", segue o fluxo antigo).
 *
 * Falha na leitura da contagem do teto do anônimo: `respostasDaIa = null` + log
 * (o gate passa com `tetoDoAnonimo.respostasDaIa === null`, nunca em silêncio).
 */
export async function decidirElegibilidadeDaConversa(
  pool: pg.Pool,
  input: {
    organizationId: string;
    conversationId: string;
    agora: Date;
    ttlMs: number;
    /** Opcional: chamada existente não passa. */
    log?: Logger;
  },
): Promise<DecisaoDaConversa | null> {
  const { rows } = await pool.query<LinhaDeElegibilidade>(
    `select
        cs.metadata                  as channel_metadata,
        cs.provider                  as provider,
        ct.force_human               as force_human,
        ct.ai_opt_out                as ai_opt_out,
        ct.email                     as email,
        ct.phone_number              as phone_number,
        cv.assignee_kind             as assignee_kind,
        cv.metadata                  as conversation_metadata,
        cv.bot_silenced_until        as bot_silenced_until,
        ct.ai_authorized_at          as ai_authorized_at,
        ct.social_identity           as social_identity,
        ct.tags                      as contact_tags,
        o.status                     as org_status,
        o.settings                   as org_settings
      from conversations cv
      join organizations o on o.id = cv.organization_id
      join contacts ct
        on ct.id = cv.contact_id and ct.organization_id = cv.organization_id
      join channel_sessions cs
        on cs.id = cv.channel_session_id and cs.organization_id = cv.organization_id
      where cv.organization_id = $1 and cv.id = $2`,
    [input.organizationId, input.conversationId],
  );
  const r = rows[0];
  if (r === undefined) return null;

  const teto = tetoDoAnonimoDoCanal(r.provider ?? "", r.channel_metadata);
  let respostasDaIa: number | null = null;
  // Só conta quando o canal declara teto E o contato é anônimo (sem telefone
  // nem e-mail). Quem deixou um dos dois sai do teto do anônimo.
  if (teto !== null && !r.phone_number && !r.email) {
    respostasDaIa = await contarRespostasDaConversa(
      pool,
      input.organizationId,
      input.conversationId,
      // Nenhum chamador passa `log`: sem o projeto como reserva, a falha da
      // contagem abriria a guarda sem deixar linha nenhuma.
      input.log ?? logger,
    );
  }

  const estado = montarEstadoDeElegibilidade({
    orgStatus: r.org_status,
    canalDesativado: r.channel_metadata?.disabled,
    aiGate: r.channel_metadata?.ai_gate,
    aiGateMode: r.channel_metadata?.ai_gate_mode,
    aiTestPhoneNumbers: r.channel_metadata?.ai_test_phone_numbers,
    contactPhoneNumber: r.phone_number,
    aiTestSocialIdentities: r.channel_metadata?.ai_test_social_identities,
    contactSocialIdentity: r.social_identity,
    forceHuman: r.force_human,
    contactTags: r.contact_tags,
    orgSettings: r.org_settings,
    aiOptOut: r.ai_opt_out,
    assigneeKind: r.assignee_kind,
    metadataDaConversa: r.conversation_metadata,
    botSilencedUntil: r.bot_silenced_until,
    aiAuthorizedAt: r.ai_authorized_at,
    agora: input.agora,
    ttlMs: input.ttlMs,
    tetoDoAnonimo:
      teto === null ? null : { limite: teto, respostasDaIa },
  });
  // #3534: a decisão viaja com o fato que o medidor de clima precisa — a mesma
  // régua de equipe que o turno lê aqui, no mesmo `contact_tags`/`org_settings`.
  return { ...decidirElegibilidade(estado), contatoDaEquipe: estado.contatoDaEquipe };
}

/**
 * Conta as respostas da IA desta conversa (total, sem janela de tempo).
 *
 * `direction = 'outbound'`, `sent_via = 'ai'`, `status <> 'failed'`, filtrado
 * por `organization_id` e `conversation_id` — a mesma régua de
 * `teto-de-respostas.ts`, aplicada ao teto do anônimo.
 *
 * Nunca lança: falha registra o aviso e devolve `null` (`respostasDaIa = null`,
 * e o gate passa).
 */
async function contarRespostasDaConversa(
  pool: pg.Pool,
  organizationId: string,
  conversationId: string,
  log: Pick<Logger, "warn">,
): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ total: number }>(
      `select count(*)::int as total
         from messages
        where organization_id = $1
          and conversation_id = $2
          and direction = 'outbound'
          and sent_via = 'ai'
          and status <> 'failed'`,
      [organizationId, conversationId],
    );
    return rows[0]?.total ?? 0;
  } catch (err) {
    log.warn("teto do visitante anônimo: contagem não lida — gate passa", {
      organization_id: organizationId,
      conversation_id: conversationId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
