/**
 * O adaptador `pg.Pool` do handler `scheduled_message`.
 *
 * Tudo aqui é SQL direto no Postgres do harness — o worker não fala PostgREST. A
 * disciplina é a das outras entregas do motor: toda query filtra
 * `organization_id`, o estado muda com UPDATE condicional (nunca leitura seguida
 * de escrita cega) e nenhuma mensagem de erro carrega PII.
 */
import type pg from "pg";

import type { FatosDoDisparo } from "./regras";
import type { PacoteDoDisparo, PacoteDb, ParteDoDisparo } from "./disparo";

interface LinhaDePacote {
  id: string;
  conversation_id: string;
  contact_id: string;
  channel_session_id: string;
  created_by: string | null;
  cancel_if_contact_replies: boolean;
  attempts: number;
}

interface LinhaDeParte {
  id: string;
  position: number;
  body: string | null;
  media_storage_path: string | null;
  media_mime: string | null;
  media_size_bytes: string | number | null;
  status: ParteDoDisparo["status"];
  internal_message_id: string;
  message_id: string | null;
}

/**
 * Quanto tempo um pacote pode ficar em `sending` antes de outro tick poder
 * retomá-lo. O worker morto no meio do envio deixa a linha reservada; sem esta
 * janela o pacote ficaria preso para sempre. Retomar é seguro porque a
 * anti-duplicata é o `internal_message_id` de cada parte, não a reserva.
 */
export const JANELA_DE_RESERVA_MORTA = "5 minutes";

export function criaPacoteDbPg(pool: pg.Pool): PacoteDb {
  return {
    async reserva(organizationId, pacoteId) {
      const { rowCount } = await pool.query(
        `update public.scheduled_messages
            set status = 'sending', updated_at = now()
          where organization_id = $1 and id = $2
            and (
              status = 'scheduled'
              or (status = 'sending' and updated_at < now() - interval '${JANELA_DE_RESERVA_MORTA}')
            )`,
        [organizationId, pacoteId],
      );
      return (rowCount ?? 0) === 1;
    },

    async carrega(organizationId, pacoteId) {
      const { rows } = await pool.query<LinhaDePacote>(
        `select id, conversation_id, contact_id, channel_session_id, created_by,
                cancel_if_contact_replies, attempts
           from public.scheduled_messages
          where organization_id = $1 and id = $2`,
        [organizationId, pacoteId],
      );
      const pacote = rows[0];
      if (pacote === undefined) return null;

      const { rows: partes } = await pool.query<LinhaDeParte>(
        `select id, position, body, media_storage_path, media_mime, media_size_bytes,
                status, internal_message_id, message_id
           from public.scheduled_message_parts
          where scheduled_message_id = $1
          order by position`,
        [pacoteId],
      );

      return {
        ...pacote,
        attempts: Number(pacote.attempts),
        parts: partes.map((parte) => ({
          ...parte,
          position: Number(parte.position),
          media_size_bytes:
            parte.media_size_bytes === null ? null : Number(parte.media_size_bytes),
        })),
      } satisfies PacoteDoDisparo;
    },

    async fatos(organizationId, pacote) {
      const { rows } = await pool.query<{
        organizacao_operante: boolean;
        contato_bloqueado: boolean;
        contato_anonimizado: boolean;
        canal_arquivado: boolean;
        sessao_status: string | null;
        contato_respondeu: boolean;
      }>(
        // `archived_at` via jsonb: clone que subiu o código sem a coluna (0106)
        // continua funcionando, e "sem a coluna" quer dizer "nada arquivado".
        `select public.fn_org_operante(m.organization_id) as organizacao_operante,
                coalesce(c.is_blocked, false) as contato_bloqueado,
                coalesce(c.is_anonymized, false) as contato_anonimizado,
                ((to_jsonb(s) ->> 'archived_at') is not null) as canal_arquivado,
                s.status as sessao_status,
                exists (
                  select 1 from public.messages msg
                   where msg.organization_id = m.organization_id
                     and msg.conversation_id = m.conversation_id
                     and msg.direction = 'inbound'
                     and msg.created_at >= m.created_at
                ) as contato_respondeu
           from public.scheduled_messages m
           join public.contacts c
             on c.organization_id = m.organization_id and c.id = m.contact_id
           join public.channel_sessions s
             on s.organization_id = m.organization_id and s.id = m.channel_session_id
          where m.organization_id = $1 and m.id = $2`,
        [organizationId, pacote.id],
      );
      const linha = rows[0];
      if (linha === undefined) {
        throw new Error(`scheduled_message ${pacote.id}: fatos não encontrados`);
      }
      return {
        organizacaoOperante: linha.organizacao_operante === true,
        contatoBloqueado: linha.contato_bloqueado === true,
        contatoAnonimizado: linha.contato_anonimizado === true,
        canalArquivado: linha.canal_arquivado === true,
        sessaoEmDia: linha.sessao_status === "WORKING",
        contatoRespondeu: linha.contato_respondeu === true,
        // A janela do número é decidida fora do SQL (mesma régua da automação).
        janelaReabreEm: null,
      } satisfies FatosDoDisparo;
    },

    async marcaParteEnviada({ organizationId, parteId, messageId, quando }) {
      await pool.query(
        `update public.scheduled_message_parts p
            set status = 'sent', message_id = $3, sent_at = $4, error_code = null
          where p.id = $2
            and exists (
              select 1 from public.scheduled_messages m
               where m.id = p.scheduled_message_id and m.organization_id = $1
            )`,
        [organizationId, parteId, messageId, quando],
      );
    },

    async marcaParteFalha({ organizationId, parteId, motivo }) {
      await pool.query(
        `update public.scheduled_message_parts p
            set status = 'failed', error_code = $3
          where p.id = $2
            and exists (
              select 1 from public.scheduled_messages m
               where m.id = p.scheduled_message_id and m.organization_id = $1
            )`,
        [organizationId, parteId, motivo],
      );
    },

    async marcaPartePulada({ organizationId, parteId }) {
      await pool.query(
        `update public.scheduled_message_parts p
            set status = 'skipped'
          where p.id = $2 and p.status = 'pending'
            and exists (
              select 1 from public.scheduled_messages m
               where m.id = p.scheduled_message_id and m.organization_id = $1
            )`,
        [organizationId, parteId],
      );
    },

    async fechaPacote({ organizationId, pacoteId, status, motivo }) {
      await pool.query(
        `update public.scheduled_messages
            set status = $3, last_error = $4, updated_at = now()
          where organization_id = $1 and id = $2`,
        [organizationId, pacoteId, status, motivo],
      );
    },

    async cancelaPacote({ organizationId, pacoteId, motivo, quando }) {
      await pool.query(
        `update public.scheduled_messages
            set status = 'cancelled', cancelled_at = $3, cancel_reason = $4, updated_at = now()
          where organization_id = $1 and id = $2 and status = 'sending'`,
        [organizationId, pacoteId, quando, motivo],
      );
    },

    async devolveParaAgenda({ organizationId, pacoteId, quando, motivo, tentativas }) {
      await pool.query(
        `update public.scheduled_messages
            set status = 'scheduled', scheduled_for = $3, attempts = $4,
                last_error = $5, updated_at = now()
          where organization_id = $1 and id = $2 and status = 'sending'`,
        [organizationId, pacoteId, quando, tentativas, motivo],
      );
      await pool.query(
        `update public.cron_jobs
            set enabled = true, next_run_at = $3, last_error = $4, updated_at = now()
          where organization_id = $1
            and job_kind = 'scheduled_message'
            and payload ->> 'scheduled_message_id' = $2`,
        [organizationId, pacoteId, quando, motivo],
      );
    },

    async desligaCronDoPacote(organizationId, pacoteId) {
      await pool.query(
        `update public.cron_jobs
            set enabled = false, updated_at = now()
          where organization_id = $1
            and job_kind = 'scheduled_message'
            and payload ->> 'scheduled_message_id' = $2
            and enabled = true`,
        [organizationId, pacoteId],
      );
    },

    async avisaNaCentral({ organizationId, pacoteId, titulo, corpo }) {
      await pool.query(
        `insert into public.agent_inbox_items
           (organization_id, kind, severity, title, body, ref_kind, ref_id)
         select $1, 'scheduled_message_failed', 'warn', $2, $3, 'scheduled_messages', $4
          where not exists (
            select 1 from public.agent_inbox_items i
             where i.organization_id = $1
               and i.kind = 'scheduled_message_failed'
               and i.ref_kind = 'scheduled_messages'
               and i.ref_id = $4
               and i.status = 'open'
          )`,
        [organizationId, titulo, corpo, pacoteId],
      );
    },
  };
}
