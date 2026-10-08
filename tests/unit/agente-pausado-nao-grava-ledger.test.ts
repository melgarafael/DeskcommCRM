/**
 * AGENTE PAUSADO NÃO DEIXA LINHA NO LEDGER.
 *
 * O handler de mensagens também recusa o agente pausado, mas só roda DEPOIS de
 * `sendWithLedger` inserir a linha 'requested'. A recusa (StaleServiceBoundary)
 * não é 403, então a linha fica 'requested' para sempre, e o disjuntor de saúde
 * (`health/circuit.ts`, `total_sends`) a conta como envio: infla o denominador
 * da taxa de bloqueio. Por isso `sendTurnMessage` confere a operação pelo pg
 * antes do ledger. Nada aqui usa Postgres real: o dublê só devolve as linhas
 * que cada leitura teria.
 */
import { describe, expect, it, vi } from "vitest";

const sendMessageHandler = vi.hoisted(() => vi.fn());
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler }));

import { sendTurnMessage } from "@/lib/agent-engine/edge/crm/send-message";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { SERVICE_BOUNDARY_SQL } from "@/lib/atendimento/fronteira-server";
import type { Queryable } from "@/lib/agent-engine/queue/queue";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const AGENT = "55555555-5555-4555-8555-555555555555";
const VERSION = "66666666-6666-4666-8666-666666666666";

const FRONTEIRA = {
  organization_id: ORG,
  contact_id: CONTACT,
  conversation_id: CONV,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

function banco() {
  const sqls: string[] = [];
  const db: Queryable = {
    query: vi.fn(async (sql: string) => {
      sqls.push(sql);
      if (sql.includes("from ai_agents"))
        return {
          rows: [
            {
              published_version_id: VERSION,
              operation_revision: "3",
              operation_mode: "automatic",
              paused_at: "2026-10-05T12:00:00Z",
              archived_at: null,
            },
          ],
        };
      if (sql.includes("from job_queue"))
        return { rows: [{ kind: "agent_turn", payload: { service_boundary: FRONTEIRA } }] };
      if (sql === SERVICE_BOUNDARY_SQL)
        return { rows: [{ ...FRONTEIRA, status: "open", demanda_fechada_em: null }] };
      if (sql.includes("insert into send_ledger")) return { rows: [{ id: "chave-1" }] };
      return { rows: [] };
    }),
  } as unknown as Queryable;
  return { db, sqls };
}

describe("sendTurnMessage com o agente pausado", () => {
  it("recusa antes de gravar no send_ledger e sem chamar o handler", async () => {
    // Se a recusa ficasse só no handler, ele lançaria isto depois do insert.
    sendMessageHandler.mockRejectedValue(new StaleServiceBoundaryError());
    const { db, sqls } = banco();

    await expect(
      sendTurnMessage(db, { supabase: {} } as never, {
        agentOperation: { organizationId: ORG, agentId: AGENT, versionId: VERSION, revision: "3" },
        tenantId: ORG,
        leadId: CONTACT,
        jobId: "job-1",
        seq: 2,
        conversationId: CONV,
        body: "segunda bolha",
      }),
    ).rejects.toBeInstanceOf(StaleServiceBoundaryError);

    expect(sqls.filter((s) => s.includes("insert into send_ledger"))).toHaveLength(0);
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });
});
