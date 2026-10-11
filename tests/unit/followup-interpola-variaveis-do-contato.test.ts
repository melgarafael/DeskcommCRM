/**
 * #2528 — FOLLOW-UP COM OS DADOS DE QUEM RECEBE.
 *
 * ## O defeito
 *
 * Nos nós `action` com `mode: "text"` e `mode: "template"` o texto saía
 * LITERAL: só `{{volta}}`/`{{voltas}}` eram interpolados (`interpolarVolta` em
 * `lib/followup/engine.ts` e `interpolarVoltaDoPayload` em
 * `lib/agent-engine/agent/followup-turn.ts`). "Oi {{primeiro_nome}}, como está
 * a viagem?" chegava ao cliente com a marcação crua — a mesma mensagem já
 * funcionava em automação, campanha e Composer.
 *
 * ## O que este arquivo prende
 *
 * 1. **Texto fixo com `{{primeiro_nome}}`** — o `fixed_body` enfileirado pelo
 *    engine sai COM o nome (e é esse corpo que os DOIS caminhos de envio
 *    mandam: o worker e o atalho inline de `enviar-texto-fixo.ts`);
 * 2. **Modelo (`message_templates`) com `{{lead.*}}` e `{{contact.*}}`** — o
 *    corpo resolvido em `followup-turn.ts` sai com o dado do negócio e do
 *    contato, não com a marcação;
 * 3. **A volta continua funcionando** — `{{volta}}`/`{{voltas}}` são
 *    interpolados ANTES do render (senão o render de CRM os apagaria);
 * 4. **Variável sem valor** — a régua da issue: some a marcação COM o espaço
 *    vizinho ("Oi {{primeiro_nome}}!" → "Oi!"), nunca `{{...}}` cru e nunca
 *    "Olá , tudo bem?".
 *
 * ## O que NÃO prova
 *
 * Nada com Postgres real: que o contato e o negócio estejam certos no banco é
 * das leituras (`loadRenderContext` / `contextoDoContato`), não do render.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { JobRow } from "@/lib/agent-engine/queue/queue";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import { avancarEnrollmentAtivo, type AdminClient, type TickDeps } from "@/lib/followup/engine";
import type { EnrollmentEventRef, EnrollmentRow } from "@/lib/followup/node-handlers";

const NOW = new Date("2026-10-08T17:03:00.000Z");
const ORG = "org-1";
const CONTATO = "contact-1";
const CONVERSA = "conversa-1";
const CANAL = "canal-1";
const MODELO_ID = "22222222-2222-4222-8222-222222222222";

const runBeforeSend = vi.fn(async (args: Record<string, unknown>) => {
  await (args.send as (b: string) => Promise<unknown>)(args.body as string);
  return { status: "sent", outcome: { kind: "sent" }, trace: [] };
});
vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend }));
vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({ isLeadInHandoff: vi.fn(async () => false) }));
vi.mock("@/lib/agent-engine/edge/crm/get-lead-context", () => ({
  getLeadContext: vi.fn(async () => ({
    ok: true,
    context: { contact: { is_blocked: false } },
    lgpd: { isAnonymized: false, isProspecting: false, legalBasis: {} },
  })),
}));
const runAgentTurn = vi.fn(async () => undefined);
vi.mock("@/lib/agent-engine/agent/inbound-turn", async (original) => ({
  ...(await original<typeof import("@/lib/agent-engine/agent/inbound-turn")>()),
  runAgentTurn,
}));
vi.mock("@/lib/agent-engine/edge/crm/send-ledger", () => ({
  resultadoDoEnvioDoFollowup: vi.fn(async () => ({ kind: "sent" })),
}));

/** 1º caso: o TEXTO FIXO do nó `action` enfileirado pelo engine. */
describe("texto fixo do follow-up (#2528)", () => {
  const BODY = "Oi {{primeiro_nome}}, esta é a volta {{volta}} de {{voltas}}";

  function grafo(body: string): FlowGraph {
    return {
      nodes: [{ id: "action-1", type: "action", config: { mode: "text", body } }],
      edges: [],
    } as unknown as FlowGraph;
  }

  function enrollment(): EnrollmentRow {
    return {
      id: "enr-1",
      organization_id: ORG,
      pointer_id: "ptr-1",
      version_id: "ver-1",
      contact_id: CONTATO,
      conversation_id: null,
      current_node_id: "action-1",
      status: "active",
      next_eval_at: NOW.toISOString(),
      claimed_until: null,
      attempts: 0,
      max_attempts: 5,
      last_error: null,
      steps_taken: 3,
      outcome: null,
      cancel_reason: null,
      started_at: NOW.toISOString(),
      completed_at: null,
      updated_at: NOW.toISOString(),
    };
  }

  /** A volta do `repeat` anterior — mora nos eventos, não na linha do lead. */
  const EVENTOS: EnrollmentEventRef[] = [
    {
      node_id: "repeat-1",
      idempotency_key: "repeat-1:2",
      event_type: "node_advanced",
      payload: { repeat_index: 2, repeat_total: 3 },
    },
  ];

  async function enfileirar(body: string, contexto: Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const payloads: Array<Record<string, unknown>> = [];
    const db = {
      loadFlowGraph: vi.fn(async () => grafo(body)),
      loadLeadFacts: vi.fn(async () => ({ lead_stage: null, tags: [] })),
      loadRenderContext: vi.fn(async () => contexto),
      loadEnrollmentEvents: vi.fn(async () => EVENTOS),
      loadLastInboundBody: vi.fn(async () => null),
      loadFlowPointerName: vi.fn(async () => null),
      insertEnrollmentEvent: vi.fn(async () => ({ inserted: true })),
      updateEnrollment: vi.fn(async () => {}),
    } as unknown as AdminClient;
    const deps: TickDeps = {
      db,
      clock: () => NOW,
      enqueueJob: async (job) => {
        payloads.push(job.payload as unknown as Record<string, unknown>);
      },
    };
    await avancarEnrollmentAtivo(deps, enrollment());
    expect(payloads).toHaveLength(1);
    return payloads[0]!;
  }

  it("⭐ sai com o PRIMEIRO NOME e a volta preenchidos — nunca a marcação crua", async () => {
    const payload = await enfileirar(BODY, {
      contact: { name: "Ana Souza" },
      lead: { custom_fields: { servico: "reforma" } },
    });

    expect(payload.fixed_body).toBe("Oi Ana, esta é a volta 2 de 3");
  });

  it("⭐ variável sem valor sai da frase com a pontuação vizinha: \"Oi!\"", async () => {
    const payload = await enfileirar("Oi {{primeiro_nome}}!", { contact: { name: null }, lead: null });

    expect(payload.fixed_body).toBe("Oi!");
  });

  it("o valor do cadastro entra como TEXTO — passada única, nunca vira modelo", async () => {
    const payload = await enfileirar("Oi {{nome}}", {
      contact: { name: "{{lead.title}}" },
      lead: { title: "Obra" },
    });

    expect(payload.fixed_body).toBe("Oi {{lead.title}}");
  });

  it("sem contexto no adaptador o comportamento é o de antes — marcação literais, nunca vazias", async () => {
    const payload = await enfileirar(BODY, null);

    expect(payload.fixed_body).toBe("Oi {{primeiro_nome}}, esta é a volta 2 de 3");
  });
});

/** 2º caso: o CORPO de `message_templates` resolvido no turno do worker. */
describe("modelo do follow-up (#2528)", () => {
  const CORPO = "Fechou a {{lead.custom_fields.servico}}, {{contact.name}}?";

  function fakePool() {
    const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>> }> => {
      // A fronteira de serviço do turno (a mesma consulta da #1913) — vem antes
      // porque as demais citam outras tabelas no corpo.
      if (sql.includes("d.fechada_em::text")) {
        return {
          rows: [
            {
              organization_id: ORG,
              contact_id: CONTATO,
              conversation_id: CONVERSA,
              service_revision: 1,
              demanda_id: null,
              demanda_revision: null,
              status: "open",
              demanda_fechada_em: null,
            },
          ],
        };
      }
      if (sql.includes("select current_node_id, status from followup_enrollments")) {
        return { rows: [{ current_node_id: "passo", status: "active" }] };
      }
      if (/from message_templates/.test(sql)) return { rows: [{ body: CORPO }] };
      if (/from crm_leads/.test(sql)) {
        return { rows: [{ id: "lead-1", title: "Obra", custom_fields: { servico: "reforma" } }] };
      }
      if (/from contacts/.test(sql)) return { rows: [{ id: CONTATO, name: "Ana Souza", email: null }] };
      if (/from conversations/.test(sql)) {
        return { rows: [{ id: CONVERSA, channel_session_id: CANAL, archived_at: null }] };
      }
      return { rows: [] };
    });
    return { query } as never;
  }

  function job(payload: Record<string, unknown>): JobRow {
    return {
      id: "job-1",
      organization_id: ORG,
      contact_id: CONTATO,
      kind: "followup_turn",
      source_event_id: null,
      payload: {
        followup_enrollment_id: "11111111-1111-4111-8111-111111111111",
        node_id: "passo",
        purpose: "send_message",
        ...payload,
        service_boundary: {
          organization_id: ORG,
          contact_id: CONTATO,
          conversation_id: CONVERSA,
          service_revision: 1,
          demanda_id: null,
          demanda_revision: null,
        },
      },
      status: "running",
      priority: 0,
      run_after: new Date(),
      attempts: 1,
      max_attempts: 3,
      last_error: null,
      locked_by: "w1",
      locked_at: new Date(),
      created_at: new Date(),
    } as JobRow;
  }

  function deps() {
    const send = vi.fn(async (_input: Record<string, unknown>) => ({ ok: true }));
    const completeFollowupTurn = vi.fn(async () => undefined);
    const d = {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      crmCfg: {},
      llmCfg: {},
      knobs: {},
      channel: () => ({ send }),
      completeFollowupTurn,
    } as never;
    return { d, send };
  }

  let criarHandler: typeof import("@/lib/agent-engine/agent/followup-turn").createFollowupTurnHandler;

  beforeAll(async () => {
    ({ createFollowupTurnHandler: criarHandler } = await import("@/lib/agent-engine/agent/followup-turn"));
  }, 60_000);

  it("⭐ o corpo do modelo sai com o NEGÓCIO e o CONTATO resolvidos", async () => {
    const { d } = deps();
    runBeforeSend.mockClear();
    await criarHandler(d)(job({ template_id: MODELO_ID }), fakePool(), { workerId: "w1" });

    expect(runBeforeSend).toHaveBeenCalledTimes(1);
    expect(runBeforeSend.mock.calls[0]![0].body).toBe("Fechou a reforma, Ana Souza?");
  });

  it("⭐ o texto fixo NÃO passa pelo render de novo no turno — já chega renderizado do enfileiramento", async () => {
    // O `fixed_body` traz o dado do cadastro já posto no lugar. Se o turno o
    // renderizasse outra vez, um nome com marcação viraria modelo.
    const { d } = deps();
    runBeforeSend.mockClear();
    await criarHandler(d)(job({ fixed_body: "Oi {{lead.custom_fields.servico}}, tudo?" }), fakePool(), {
      workerId: "w1",
    });

    expect(runBeforeSend.mock.calls[0]![0].body).toBe("Oi {{lead.custom_fields.servico}}, tudo?");
  });
});
