import { describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * OS ÍNDICES DO CAMINHO QUENTE (MIGRATION 0522) EXISTEM E SERVEM A CONSULTA QUE OS JUSTIFICA.
 *
 * Existir não basta: índice parcial só é usado quando o WHERE da consulta
 * IMPLICA o predicado dele, e um predicado escrito um pouco diferente deixa o
 * índice de pé, pagando escrita, sem servir nada. Por isso cada consulta é
 * planejada aqui com `enable_seqscan = off`: se o plano não cita o índice, o
 * Postgres não consegue usá-lo para aquela forma de consulta.
 *
 * As consultas são as do código, com literais no lugar dos parâmetros:
 * `countPriorAcceptedSends` e `ultimaInboundJaRespondida` (send_ledger), o
 * `update ... set job_id = null where job_id = $1` que o Postgres roda no
 * `on delete set null` vindo de `job_queue` (a poda diária), e os dois reapers
 * de evento preso (`edge/crm/drain.ts` e `lib/event-log/drain.ts`).
 *
 * `explain` sem `analyze` não executa nada; ainda assim tudo roda numa
 * transação desfeita, para o `set local` não vazar.
 */

const INDICES: Record<string, string> = {
  event_log_processing_por_tipo_idx: "event_log",
  idx_lead_checkpoints_job_id: "lead_checkpoints",
  idx_lead_state_transitions_job_id: "lead_state_transitions",
  idx_llm_calls_job_id: "llm_calls",
  idx_send_ledger_contato_entregue: "send_ledger",
};

const ORG = "00000000-0000-4000-8000-000000000001";
const CONTATO = "00000000-0000-4000-8000-000000000002";
const JOB = "00000000-0000-4000-8000-000000000003";

function plano(consulta: string): string {
  return sql(`begin;\nset local enable_seqscan = off;\nexplain (costs off) ${consulta};\nrollback;`);
}

describe("migration 0522: índices do caminho quente", () => {
  it("os cinco índices existem, cada um na sua tabela", () => {
    const nomes = Object.keys(INDICES)
      .map((n) => `'${n}'`)
      .join(",");
    const achados = lastLine(
      sql(`select coalesce(string_agg(indexname || ':' || tablename, ',' order by indexname), '')
             from pg_indexes where schemaname = 'public' and indexname in (${nomes});`),
    );
    const esperado = Object.entries(INDICES)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([n, t]) => `${n}:${t}`)
      .join(",");
    expect(achados).toBe(esperado);
  });

  it("o índice de event_log não tem updated_at (o trigger de touch tiraria o HOT update)", () => {
    const def = lastLine(
      sql(`select indexdef from pg_indexes
            where schemaname = 'public' and indexname = 'event_log_processing_por_tipo_idx';`),
    );
    expect(def).toContain("(event_type)");
    expect(def).toContain("'processing'");
    expect(def).not.toContain("updated_at");
  });

  const casos = [
    {
      nome: "1º outbound: envios accepted do contato",
      indice: "idx_send_ledger_contato_entregue",
      consulta: `select count(*) from public.send_ledger
                  where organization_id = '${ORG}' and contact_id = '${CONTATO}' and status = 'accepted'`,
    },
    {
      nome: "turno já respondido: envios accepted/queued do contato",
      indice: "idx_send_ledger_contato_entregue",
      consulta: `select 1 from public.send_ledger s
                  where s.organization_id = '${ORG}' and s.contact_id = '${CONTATO}'
                    and s.status in ('accepted', 'queued')`,
    },
    {
      nome: "poda da fila: set null em llm_calls",
      indice: "idx_llm_calls_job_id",
      consulta: `update public.llm_calls set job_id = null where job_id = '${JOB}'`,
    },
    {
      nome: "poda da fila: set null em lead_checkpoints",
      indice: "idx_lead_checkpoints_job_id",
      consulta: `update public.lead_checkpoints set job_id = null where job_id = '${JOB}'`,
    },
    {
      nome: "poda da fila: set null em lead_state_transitions",
      indice: "idx_lead_state_transitions_job_id",
      consulta: `update public.lead_state_transitions set job_id = null where job_id = '${JOB}'`,
    },
    {
      nome: "reaper do drain do agente",
      indice: "event_log_processing_por_tipo_idx",
      consulta: `update public.event_log set status = 'pending', updated_at = now()
                  where event_type = 'ai_agent.dispatch_requested' and status = 'processing'
                    and 'agent-engine' = any(consumed_by)
                    and updated_at < now() - interval '5 minutes'`,
    },
    {
      nome: "reaper do dreno geral (só status + updated_at)",
      indice: "event_log_processing_por_tipo_idx",
      consulta: `select id from public.event_log
                  where status = 'processing' and updated_at < now() - interval '5 minutes'`,
    },
  ];

  for (const c of casos) {
    it(`${c.nome} usa ${c.indice}`, () => {
      expect(plano(c.consulta)).toContain(c.indice);
    });
  }
});
