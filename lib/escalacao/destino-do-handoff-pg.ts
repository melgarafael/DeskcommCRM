/**
 * A PORTA DO ENGINE (`pg.Pool`) para `entregarAoDonoDoHandoff`.
 *
 * `performHumanHandoff` (`lib/agent-engine/agent/human-handoff`) é o funil do
 * motor que fala `pg.Pool` — a ferramenta nativa do modelo, a detecção
 * determinística de "quero falar com uma pessoa", o opt-out provável, o teto de
 * orçamento e o fluxo que coleta campos. Todos passam por ali, e é ali que a
 * entrega ao dono acontece uma vez.
 *
 * ─── Por que uma porta e não a do supabase-js ─────────────────────────────
 *
 * O engine não monta cliente supabase para escrever a conversa: ele tem o pool,
 * e é por ele que os outros efeitos do handoff passam. Criar um segundo cliente
 * aqui faria o handoff depender de credencial que o caminho quente não usa — e
 * faria um teste do motor precisar de env que ele nunca precisou.
 *
 * ─── A régua é a MESMA, escrita em SQL ────────────────────────────────────
 *
 * A conferência de vínculo está em `lib/automation/vinculo-do-destino` (TS,
 * service-role). Aqui ela é a mesma pergunta em uma consulta — membro não
 * revogado, papel diferente de `viewer` —, e a diferença entre "não é membro" e
 * "não deu para saber" é preservada: exceção de leitura é `indeterminado`, e
 * indeterminado NÃO atribui.
 *
 * A escrita é a porta única da atribuição, `fn_conversation_assign`, com
 * `reason = 'handoff'`: o evento da linha do tempo nasce na mesma transação, e
 * o `bot_silenced_until = 'infinity'` que ela grava é o mesmo que o handoff já
 * tinha acabado de armar.
 */
import type pg from "pg";

import type { VinculoDoDestino } from "@/lib/automation/vinculo-do-destino";
import type { ConversaDaEntrega, PortaDaEntrega } from "@/lib/escalacao/destino-do-handoff";

export function portaDaEntregaPg(db: pg.Pool | pg.PoolClient): PortaDaEntrega {
  return {
    async lerSettings(organizationId) {
      const { rows } = await db.query<{ settings: unknown }>(
        "select settings from organizations where id = $1",
        [organizationId],
      );
      return rows[0]?.settings ?? null;
    },

    async lerConversa(organizationId, conversationId) {
      const { rows } = await db.query<{
        assigned_to_user_id: string | null;
        assignee_kind: string | null;
        contact_id: string | null;
      }>(
        `select assigned_to_user_id, assignee_kind, contact_id
           from conversations
          where organization_id = $1 and id = $2`,
        [organizationId, conversationId],
      );
      const linha = rows[0];
      if (!linha) return null;
      return {
        assigned_to_user_id: linha.assigned_to_user_id ?? null,
        assignee_kind: linha.assignee_kind ?? null,
        contact_id: linha.contact_id ?? null,
      } satisfies ConversaDaEntrega;
    },

    /**
     * O negócio ABERTO mais recente do contato — a mesma régua de
     * `negocio-aberto-do-contato` (#3177). Sem aberto, a cadeia cai na carteira.
     */
    async lerNegocioDoContato(organizationId, contactId) {
      const { rows } = await db.query<{ owner_user_id: unknown; owner_kind: unknown }>(
        `select owner_user_id, owner_kind
           from crm_leads
          where organization_id = $1 and contact_id = $2 and status = 'open'
          order by updated_at desc
          limit 1`,
        [organizationId, contactId],
      );
      return rows[0] ?? null;
    },

    async lerContato(organizationId, contactId) {
      const { rows } = await db.query<{ carteira_user_id: unknown }>(
        "select carteira_user_id from contacts where organization_id = $1 and id = $2",
        [organizationId, contactId],
      );
      return rows[0] ?? null;
    },

    async conferirVinculo(organizationId, userId): Promise<VinculoDoDestino> {
      try {
        const { rows } = await db.query<{ role: string | null }>(
          `select role
             from user_organizations
            where organization_id = $1 and user_id = $2 and revoked_at is null`,
          [organizationId, userId],
        );
        const linha = rows[0];
        if (!linha) return { ok: false, motivo: "user_not_in_org" };
        if (linha.role === "viewer") return { ok: false, motivo: "invalid_owner" };
        return { ok: true };
      } catch (err) {
        // Não é "não é membro": é "não deu para saber". Fail-closed na ação,
        // aberto na informação — a mensagem vai para o log de quem chamou.
        return { ok: false, indeterminado: err instanceof Error ? err.message : String(err) };
      }
    },

    async atribuir(organizationId, conversationId, userId) {
      try {
        await db.query("select public.fn_conversation_assign($1, $2, $3, 'handoff')", [
          organizationId,
          conversationId,
          userId,
        ]);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },

    async enfileirarNoRodizio(organizationId, conversationId) {
      try {
        await db.query("select public.fn_request_channel_routing($1, $2)", [
          organizationId,
          conversationId,
        ]);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
  };
}
