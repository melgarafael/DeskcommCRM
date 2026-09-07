import { currentExecutionBoundary, guardServiceEffect } from "@/lib/atendimento/fronteira-server";
/**
 * O `RetornoDb` sobre `pg.Pool` — o lado do motor do agente.
 *
 * Existe pelo mesmo motivo do adaptador do Supabase: a REGRA do retorno é uma só
 * (`./retorno.ts`) e o que muda entre os dois runtimes é apenas como se fala com
 * o banco. O motor roda fora do request, sem client do Supabase; o Next roda
 * dentro. Sem esta separação, a validação de janela e o guard anti-empilhamento
 * existiriam duas vezes e divergiriam no primeiro ajuste.
 *
 * `import type` no `pg`: o tipo é apagado na compilação, então este módulo pode
 * ser importado pelo bundle do Next sem arrastar o driver — mesma disciplina de
 * `lib/leads/agent-activity.ts`.
 */
import type pg from "pg";

import { situacaoDoRetorno, type RetornoAgendado, type RetornoDb } from "./retorno";

const COLUNAS =
  "id, contact_id, next_run_at, enabled, payload, cancelled_at, cancel_reason";

interface LinhaDeCron {
  id: string;
  contact_id?: string | null;
  next_run_at?: Date | string | null;
  enabled?: boolean | null;
  payload?: Record<string, unknown> | null;
  cancelled_at?: Date | string | null;
  cancel_reason?: string | null;
  /** Presente quando a query projeta o instante prometido direto do payload. */
  promised_at?: string | null;
}

function iso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : v;
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function paraRetorno(row: LinhaDeCron, contactIdPadrao: string): RetornoAgendado {
  const payload = row.payload ?? {};
  return {
    id: row.id,
    contactId: row.contact_id ?? contactIdPadrao,
    quando: iso(row.next_run_at) ?? "",
    prometidoPara: texto(payload.promised_at) ?? texto(row.promised_at),
    situacao: situacaoDoRetorno({
      enabled: row.enabled ?? true,
      cancelled_at: iso(row.cancelled_at),
    }),
    motivo: texto(payload.reason) ?? "Retorno agendado",
    promessa: texto(payload.promise),
    canceladoEm: iso(row.cancelled_at),
    motivoDoCancelamento: row.cancel_reason ?? null,
  };
}

export function criaRetornoDbPg(db: pg.Pool): RetornoDb {
  return {
    async buscaRetornoVivo(orgId, contactId) {
      const { rows } = await db.query<LinhaDeCron>(
        `select ${COLUNAS}, (payload->>'promised_at') as promised_at
           from cron_jobs
          where organization_id = $1 and contact_id = $2
            and kind = 'at' and job_kind = 'followup_turn' and enabled = true
          order by next_run_at asc
          limit 1`,
        [orgId, contactId],
      );
      const row = rows[0];
      return row ? paraRetorno(row, contactId) : null;
    },

    async insere(orgId, input) {
      await guardServiceEffect();
      const boundary = currentExecutionBoundary();
      const { rows } = await db.query<LinhaDeCron>(
        `insert into cron_jobs
           (organization_id, contact_id, kind, job_kind, payload, next_run_at)
         values ($1, $2, 'at', 'followup_turn', $3, $4)
         returning ${COLUNAS}`,
        [orgId, input.contactId, { ...input.payload, service_boundary: boundary, conversation_id: boundary?.conversation_id }, input.quando],
      );
      const row = rows[0];
      if (row === undefined) throw new Error("retorno_insert_failed: sem linha");
      return paraRetorno(row, input.contactId);
    },

    async buscaPorId(orgId, retornoId) {
      const { rows } = await db.query<LinhaDeCron>(
        `select ${COLUNAS} from cron_jobs
          where organization_id = $1 and id = $2
            and kind = 'at' and job_kind = 'followup_turn'`,
        [orgId, retornoId],
      );
      const row = rows[0];
      return row ? paraRetorno(row, row.contact_id ?? "") : null;
    },

    async marcaCancelado(orgId, retornoId, quando, motivo) {
      const { rowCount } = await db.query(
        `update cron_jobs
            set enabled = false, cancelled_at = $3, cancel_reason = $4, updated_at = now()
          where organization_id = $1 and id = $2
            and kind = 'at' and job_kind = 'followup_turn' and enabled = true`,
        [orgId, retornoId, quando, motivo.slice(0, 200)],
      );
      return (rowCount ?? 0) > 0;
    },

    async lista(orgId, contactId, limite) {
      const { rows } = await db.query<LinhaDeCron>(
        `select ${COLUNAS} from cron_jobs
          where organization_id = $1 and contact_id = $2
            and kind = 'at' and job_kind = 'followup_turn'
          order by next_run_at desc
          limit $3`,
        [orgId, contactId, limite],
      );
      return rows.map((r) => paraRetorno(r, contactId));
    },
  };
}
