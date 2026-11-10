/**
 * #3813 — A ESCOLHA DO FLUXO CHEGA À GUARDA DE ENVIO DO WORKER `pg`.
 *
 * `lib/agent-engine/edge/crm/send-message.ts` é o ponto de envio do worker
 * (`sendTurnMessage` → `sendMessageHandler`). Ele montava o `ProactiveContext`
 * do job `followup_turn` SEM `escolhaNoEnvio`, então a guarda de agenda lia o
 * padrão (`adiar`) e desfazia o que o fluxo publicou: um fluxo em `enviar`
 * seguia sendo segurado, e um em `nao_enviar` seguia adiando.
 *
 * E, quando o pulo acontecia ali, o `AgendaPuladoError` era traduzido em
 * `CrmTransportError` ("handler de envio indisponível") — leitura de falha
 * transiente para o que é decisão de produto.
 */
import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const INSCRICAO = "11111111-1111-4111-8111-111111111111";
const FRONTEIRA = {
  organization_id: ORG,
  contact_id: LEAD,
  conversation_id: CONVERSA,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

const handlerDoEnvio = vi.hoisted(() => ({ sendMessageHandler: vi.fn() }));

vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: handlerDoEnvio.sendMessageHandler,
}));

const guarda = vi.hoisted(() => ({
  chamadas: [] as Array<Record<string, unknown>>,
  erro: null as unknown,
}));

vi.mock("@/lib/agenda/efeito", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("@/lib/agenda/efeito")),
  assertAgendaEffectPg: vi.fn(async (_db: unknown, ctx: Record<string, unknown>) => {
    guarda.chamadas.push(ctx);
    if (guarda.erro) throw guarda.erro;
  }),
}));

function poolDoJob(escolha: string | null) {
  const sqls: string[] = [];
  const db = {
    async query(sql: string, _params?: unknown[]) {
      sqls.push(sql);
      if (/select payload,kind from job_queue/.test(sql)) {
        return {
          rows: [
            {
              kind: "followup_turn",
              payload: {
                followup_enrollment_id: INSCRICAO,
                node_id: "passo",
                service_boundary: FRONTEIRA,
              },
            },
          ],
        };
      }
      if (/d.fechada_em::text/.test(sql)) {
        return { rows: [{ ...FRONTEIRA, status: "open", demanda_fechada_em: null }] };
      }
      // A configuração publicada do follow-up (a escolha do FLUXO).
      if (/left join ai_agents/.test(sql)) {
        return { rows: [{ followup: escolha === null ? {} : { quando_ha_compromisso: escolha } }] };
      }
      if (/fn_autonomous_turn_revoked/.test(sql)) return { rows: [{ current: true }] };
      if (/insert into send_ledger/.test(sql)) return { rows: [{ id: "chave-1" }] };
      return { rows: [] };
    },
  } as unknown as Queryable;
  return { db, sqls };
}

async function enviar(escolha: string | null) {
  const { sendTurnMessage } = await import("@/lib/agent-engine/edge/crm/send-message");
  const { db } = poolDoJob(escolha);
  return sendTurnMessage(db, { agentActorId: "agente-1" } as never, {
    tenantId: ORG,
    leadId: LEAD,
    jobId: "job-1",
    jobClaim: { worker_id: "w1", acquired_at: new Date("2026-10-20T13:00:00.000Z") } as never,
    seq: 1,
    conversationId: CONVERSA,
    body: "Oi! Passando para retomar.",
  });
}

describe("a escolha do fluxo no envio do worker (#3813)", () => {
  it("`nao_enviar` publicado no follow-up chega à guarda de agenda", async () => {
    guarda.chamadas.length = 0;
    guarda.erro = null;
    await enviar("nao_enviar").catch(() => undefined);

    expect(guarda.chamadas[0]?.escolhaNoEnvio, "a guarda recebeu o padrão em vez da escolha do fluxo").toBe(
      "nao_enviar",
    );
  });

  it("`enviar` publicado no follow-up chega à guarda (a autorização não é desfeita no segundo portão)", async () => {
    guarda.chamadas.length = 0;
    guarda.erro = null;
    await enviar("enviar").catch(() => undefined);

    expect(guarda.chamadas[0]?.escolhaNoEnvio).toBe("enviar");
  });

  it("o pulo que nasce DENTRO do handler de envio sobe como pulo — nunca como falha de transporte", async () => {
    // A guarda do handler roda de novo antes de cada corte da mensagem
    // (`_handler.ts:1166`). Ali dentro o erro caía no `catch` de transporte de
    // `sendTurnMessage` e virava "handler de envio indisponível" — falha
    // transiente para quem só tinha decidido não enviar.
    const { AgendaPuladoError } = await import("@/lib/agenda/escolha-no-envio");
    const erroDoPulo = new AgendaPuladoError({
      adiar: true,
      motivo: "agendado",
      appointment_id: "compromisso-1",
      reavaliar_em: null,
    });
    guarda.chamadas.length = 0;
    guarda.erro = null;
    handlerDoEnvio.sendMessageHandler.mockRejectedValue(erroDoPulo);

    const erro = await enviar("nao_enviar").catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(AgendaPuladoError);
    expect(erro).toBe(erroDoPulo);
  });

  it("o pulo da guarda sobe como pulo — nunca como falha de transporte", async () => {
    const { AgendaPuladoError } = await import("@/lib/agenda/escolha-no-envio");
    guarda.chamadas.length = 0;
    guarda.erro = new AgendaPuladoError({
      adiar: true,
      motivo: "agendado",
      appointment_id: "compromisso-1",
      reavaliar_em: null,
    });

    const erro = await enviar("nao_enviar").catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(AgendaPuladoError);
    expect((erro as Error).name, "o pulo foi traduzido em falha de transporte").toBe("AgendaPuladoError");
    guarda.erro = null;
  });
});
