import { describe, expect, it, vi } from "vitest";

const originRpc = vi.hoisted(() => vi.fn(async (_fn: string, _args: unknown) => ({ data: null, error: null })));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: originRpc }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// `tests/helpers/stages-db-double.ts` importa `createClient`/`requireRole` de
// verdade para poder `vi.mocked(...).mockResolvedValue(...)` — sem mockar os
// módulos aqui, a importação real de `lib/auth/server` (via `require-role`)
// valida env no boot e explode antes do teste rodar (mesmo padrão de
// `app/api/v1/pipelines/[id]/stages/route.test.ts`). Este teste nem chama
// `requireRole` — a ação recebe `HandlerCtx` já pronto — mas o mock precisa
// existir porque o double importa o módulo de qualquer forma.
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { getAction } from "@/lib/automation/actions";
// Import isolado da ação — registra `create_or_move_lead` no registry do
// módulo (mesmo padrão que `register-all.ts` faz para o motor de verdade).
import "@/lib/automation/actions/create-or-move-lead";
import type { ActionCtx } from "@/lib/automation/types";
import { ORG_ID, PIPE, etapa, funilRow, makeDb, negocio } from "@/tests/helpers/stages-db-double";

/**
 * Regressão pedida pelo dono do produto (2026-08-27, rascunho de
 * `automation_rule` do fluxo Respondi): a classificação inicial
 * (`lib/leads/classificacao-inicial.ts` — score A/B/C/D, "nao_avaliado",
 * "revisao_humana") NÃO PODE bloquear o ENCAMINHAMENTO do lead pela
 * automação — nem quando ele já existe (move de etapa via
 * `create_or_move_lead`), nem quando ele nasce por ela (create).
 *
 * `guarda-do-contato.test.ts` já prova o lado do ENVIO (send_whatsapp_message
 * / send_ai_message não leem classificação). Este arquivo prova o lado do
 * ROTEAMENTO: `create_or_move_lead` não lê `custom_fields.classificacao_*`
 * em NENHUM dos dois caminhos (create/move) — só `pipeline_id`/`stage_id` da
 * config da regra e `ctx.context.lead`/`ctx.context.contact`.
 *
 * Sabotagem verificada manualmente ao escrever este teste: adicionei em
 * `create-or-move-lead.ts` um `if (lead?.custom_fields?.classificacao_inicial_classe
 * === "D") return { type: "create_or_move_lead", status: "skipped", detail: {
 * reason: "classe_d" } }` antes do `moveLeadHandler` — o caso "classe D" abaixo
 * reprovou sozinho, os demais continuaram verdes. Sabotagem revertida antes
 * deste commit.
 */

const ETAPA_ORIGEM = etapa({ id: "novo", name: "Novo lead — Formulário", position: 1000 });
const ETAPA_DESTINO = etapa({ id: "triagem", name: "Triagem e classificação", position: 2000 });

function ctxComLead(customFields: Record<string, unknown>, admin: ActionCtx["admin"]): ActionCtx {
  return {
    admin,
    organizationId: ORG_ID,
    ruleId: "rule-1",
    ruleName: "SDR IA — Respondi Imobiliário — 1º contato",
    event: {} as ActionCtx["event"],
    requestId: "req-1",
    context: {
      lead: {
        id: "lead-1",
        pipeline_id: PIPE,
        custom_fields: customFields,
      },
    },
  };
}

function ctxComContato(customFields: Record<string, unknown> | undefined): ActionCtx["context"] {
  return {
    contact: { id: "contato-1", name: "Fulano", custom_fields: customFields },
  };
}

describe("create_or_move_lead — pontuação/classificação nunca bloqueia o ENCAMINHAMENTO (move)", () => {
  const CLASSIFICACOES: Array<[string, Record<string, unknown>]> = [
    ["classe A", { classificacao_inicial_classe: "A", classificacao_inicial_percentual: 92 }],
    ["classe B", { classificacao_inicial_classe: "B", classificacao_inicial_percentual: 55 }],
    ["classe C", { classificacao_inicial_classe: "C", classificacao_inicial_percentual: 20 }],
    ["classe D (piso do score)", { classificacao_inicial_classe: "D", classificacao_inicial_percentual: 0 }],
    ["nao_avaliado (sem respondi_score)", { classificacao_inicial_classe: "nao_avaliado", classificacao_inicial_percentual: null }],
    [
      "revisao_humana / incoerencia_investimento",
      { classificacao_inicial_status: "revisao_humana", classificacao_inicial_motivo: "incoerencia_investimento" },
    ],
    [
      "revisao_humana / spam_suspeito",
      { classificacao_inicial_status: "revisao_humana", classificacao_inicial_motivo: "spam_suspeito" },
    ],
    ["sem classificação nenhuma (custom_fields vazio)", {}],
  ];

  it.each(CLASSIFICACOES)("%s → move normalmente, status success", async (_nome, customFields) => {
    const db = makeDb({ contacts: [{ id: "contato-1", organization_id: ORG_ID }],
      pipelines: [funilRow({ id: PIPE, name: "funil comercial imobiliário" })],
      stages: [ETAPA_ORIGEM, ETAPA_DESTINO],
      leads: [negocio("lead-1", "novo")],
    });
    const action = getAction("create_or_move_lead");
    expect(action).toBeDefined();

    const resultado = await action!.execute(
      ctxComLead(customFields, db.client as unknown as ActionCtx["admin"]),
      { pipeline_id: PIPE, stage_id: "triagem" },
    );

    expect(resultado).toEqual({ type: "create_or_move_lead", status: "success", detail: { moved: "lead-1" } });
    expect(db.tabelas.crm_leads.find((l) => l.id === "lead-1")?.stage_id).toBe("triagem");
  });
});

// ── CAMINHO 6 dos campos obrigatórios (issue #1536) ─────────────────────────
//
// Esta ação delega o move ao `moveLeadHandler` e o fecho a `encerraDemanda` —
// os dois já testados —, mas o critério pede teste POR CAMINHO: a promessa é
// que a recusa da régua sobreviva à camada da automação (que engole erro em
// `status: failed` em vez de 422) e o lead NÃO mude de etapa em silêncio.
// `obrigatorio_em.etapas` é `z.string().uuid()` — um id literal seria
// DESCARTADO por `camposDoFunil` (o parse falha e o campo some), então a etapa
// de destino deste teste é um UUID, como na instalação de verdade.
const ETAPA_PROPOSTA_UUID = "77777777-7777-4777-8777-777777777777";

describe("create_or_move_lead — a régua de campos obrigatórios chega aqui (#1536)", () => {
  it("etapa de destino com campo exigido vazio: a ação falha e o lead continua na origem", async () => {
    const db = makeDb({
      contacts: [{ id: "contato-1", organization_id: ORG_ID }],
      pipelines: [
        funilRow({
          id: PIPE,
          name: "funil comercial imobiliário",
          settings: {
            fields: [
              {
                key: "concorrente",
                label: "Concorrente",
                type: "text",
                obrigatorio_em: { etapas: [ETAPA_PROPOSTA_UUID] },
              },
            ],
          },
        }),
      ],
      stages: [
        ETAPA_ORIGEM,
        etapa({ id: ETAPA_PROPOSTA_UUID, name: "Proposta enviada", position: 3000 }),
      ],
      leads: [negocio("lead-1", "novo")],
    });
    const action = getAction("create_or_move_lead");

    const resultado = await action!.execute(
      ctxComLead({}, db.client as unknown as ActionCtx["admin"]),
      { pipeline_id: PIPE, stage_id: ETAPA_PROPOSTA_UUID },
    );

    // A automação reporta `failed` com a FRASE da recusa — é o que a aba
    // Atividade mostra ao operador, e sem ela o erro vira um sucesso calado.
    expect(resultado.status).toBe("failed");
    expect(JSON.stringify(resultado)).toContain("Concorrente");
    // E a prova de que nada foi movido.
    expect(db.tabelas.crm_leads.find((l) => l.id === "lead-1")?.stage_id).toBe("novo");
  });

  it("mesma ação com o campo preenchido: move (controle positivo)", async () => {
    const db = makeDb({
      contacts: [{ id: "contato-1", organization_id: ORG_ID }],
      pipelines: [
        funilRow({
          id: PIPE,
          name: "funil comercial imobiliário",
          settings: {
            fields: [
              {
                key: "concorrente",
                label: "Concorrente",
                type: "text",
                obrigatorio_em: { etapas: [ETAPA_PROPOSTA_UUID] },
              },
            ],
          },
        }),
      ],
      stages: [
        ETAPA_ORIGEM,
        etapa({ id: ETAPA_PROPOSTA_UUID, name: "Proposta enviada", position: 3000 }),
      ],
      leads: [negocio("lead-1", "novo", { custom_fields: { concorrente: "ACME" } } as never)],
    });
    const action = getAction("create_or_move_lead");

    const resultado = await action!.execute(
      ctxComLead({ concorrente: "ACME" }, db.client as unknown as ActionCtx["admin"]),
      { pipeline_id: PIPE, stage_id: ETAPA_PROPOSTA_UUID },
    );

    expect(resultado).toEqual({ type: "create_or_move_lead", status: "success", detail: { moved: "lead-1" } });
    expect(db.tabelas.crm_leads.find((l) => l.id === "lead-1")?.stage_id).toBe(ETAPA_PROPOSTA_UUID);
  });
});

describe("create_or_move_lead — pontuação/classificação nunca bloqueia a CRIAÇÃO", () => {
  it("contato com custom_fields de classe D no contexto: cria o lead normalmente", async () => {
    const db = makeDb({ contacts: [{ id: "contato-1", organization_id: ORG_ID }],
      pipelines: [funilRow({ id: PIPE, name: "funil comercial imobiliário" })],
      stages: [ETAPA_ORIGEM, ETAPA_DESTINO],
      leads: [],
    });
    const action = getAction("create_or_move_lead");

    const ctx: ActionCtx = {
      admin: db.client as unknown as ActionCtx["admin"],
      organizationId: ORG_ID,
      ruleId: "rule-1",
      ruleName: "SDR IA — Respondi Imobiliário — 1º contato",
      event: {} as ActionCtx["event"],
      requestId: "req-1",
      context: ctxComContato({ classificacao_inicial_classe: "D" }),
    };

    const resultado = await action!.execute(ctx, { pipeline_id: PIPE, stage_id: "novo" });

    expect(resultado.status).toBe("success");
    expect(resultado.type).toBe("create_or_move_lead");
    expect(db.tabelas.crm_leads).toHaveLength(1);
    expect(db.tabelas.crm_leads[0]?.stage_id).toBe("novo");
  });
});

/**
 * #958 — gatilho de tag no CONTATO. Medido numa instalação real: a regra rodava
 * 9 vezes em 9 horas, sempre "Parcial" com `missing_input`, e o contato ficava
 * com leads repetidos.
 *
 * O contexto de evento de contato não tem `lead` (`lib/automation/engine.ts`).
 * Daí os dois sintomas medidos aqui:
 *   1. a ação só sabia CRIAR — o negócio que o contato já tinha no funil de
 *      destino era ignorado, e nascia outro;
 *   2. a ação seguinte da mesma regra (`assign_owner`) continuava sem lead e
 *      devolvia `skipped: missing_input`.
 */
let ctxPublicado: ActionCtx | null = null;
/** Mesmo contexto de gatilho de contato, guardado para inspeção depois da execução. */
function ctxDoContatoPublicado(db: ReturnType<typeof makeDb>): ActionCtx {
  ctxPublicado = {
    admin: db.client as unknown as ActionCtx["admin"],
    organizationId: ORG_ID,
    ruleId: "rule-1",
    ruleName: "Google Meu Negócio",
    event: {} as ActionCtx["event"],
    requestId: "req-1",
    context: { contact: { id: "contato-1", name: "Fulano" } },
  };
  return ctxPublicado;
}

describe("create_or_move_lead — gatilho de contato (#958)", () => {
  function ctxDoContato(db: ReturnType<typeof makeDb>): ActionCtx {
    return {
      admin: db.client as unknown as ActionCtx["admin"],
      organizationId: ORG_ID,
      ruleId: "rule-1",
      ruleName: "Google Meu Negócio",
      event: {} as ActionCtx["event"],
      requestId: "req-1",
      context: { contact: { id: "contato-1", name: "Fulano" } },
    };
  }

  it("contato que já tem negócio aberto no funil de destino: MOVE, não duplica", async () => {
    const db = makeDb({ contacts: [{ id: "contato-1", organization_id: ORG_ID }],
      pipelines: [funilRow({ id: PIPE, name: "Funil" })],
      stages: [ETAPA_ORIGEM, ETAPA_DESTINO],
      leads: [negocio("lead-1", "novo", { contact_id: "contato-1", status: "open" } as Partial<
        Parameters<typeof negocio>[2]
      >)],
    });

    const resultado = await getAction("create_or_move_lead")!.execute(ctxDoContato(db), {
      pipeline_id: PIPE,
      stage_id: "triagem",
    });

    expect(resultado).toEqual({ type: "create_or_move_lead", status: "success", detail: { moved: "lead-1" } });
    expect(db.tabelas.crm_leads).toHaveLength(1);
    expect(db.tabelas.crm_leads[0]?.stage_id).toBe("triagem");
  });

  it("contato SEM negócio no funil de destino: cria, como antes", async () => {
    const db = makeDb({ contacts: [{ id: "contato-1", organization_id: ORG_ID }],
      pipelines: [funilRow({ id: PIPE, name: "Funil" })],
      stages: [ETAPA_ORIGEM, ETAPA_DESTINO],
      leads: [],
    });

    const resultado = await getAction("create_or_move_lead")!.execute(ctxDoContato(db), {
      pipeline_id: PIPE,
      stage_id: "novo",
    });

    expect(resultado.status).toBe("success");
    expect(db.tabelas.crm_leads).toHaveLength(1);
  });

  it("o lead fica no contexto para a ação seguinte da regra — fim do missing_input", async () => {
    const db = makeDb({ contacts: [{ id: "contato-1", organization_id: ORG_ID }],
      pipelines: [funilRow({ id: PIPE, name: "Funil" })],
      stages: [ETAPA_ORIGEM, ETAPA_DESTINO],
      leads: [],
    });
    const ctx = ctxDoContato(db);

    await getAction("create_or_move_lead")!.execute(ctx, { pipeline_id: PIPE, stage_id: "novo" });

    const noContexto = ctx.context.lead as { id: string; pipeline_id: string } | undefined;
    expect(noContexto?.id).toBe(db.tabelas.crm_leads[0]?.id);
    expect(noContexto?.pipeline_id).toBe(PIPE);
  });
});

/**
 * O que o contexto publicado PRECISA carregar — e por que não pode ser um
 * objeto de três campos.
 *
 * A ação seguinte da mesma regra lê `ctx.context.lead` como "o negócio do
 * banco": `add_tag` faz `const prev = row.tags ?? []` e grava
 * `[...prev, ...added]`, e `call_webhook` projeta o objeto sobre
 * LEAD_PUBLIC_FIELDS. Publicar `{ id, pipeline_id, contact_id }` faz o merge de
 * tags virar SOBRESCRITA — o negócio perde as tags que tinha, inclusive a de
 * anúncio (`lib/leads/nascimento-do-lead.ts`) — e faz o corpo entregue ao
 * endpoint do cliente encolher, os dois em silêncio.
 *
 * Sabotagem prevista e medida: voltar `publicaNoContexto` ao objeto parcial →
 * 2 vermelhos, os dois casos abaixo.
 */
describe("create_or_move_lead — o contexto publicado é a linha inteira", () => {
  it("move: as tags do negócio sobrevivem no contexto para a ação seguinte", async () => {
    const db = makeDb({ contacts: [{ id: "contato-1", organization_id: ORG_ID }],
      pipelines: [funilRow({ id: PIPE, name: "Funil" })],
      stages: [ETAPA_ORIGEM, ETAPA_DESTINO],
      leads: [
        negocio("lead-1", "novo", { contact_id: "contato-1", status: "open", tags: ["Meta_ads"], title: "Fulano" } as Partial<
          Parameters<typeof negocio>[2]
        >),
      ],
    });

    await getAction("create_or_move_lead")!.execute(ctxDoContatoPublicado(db), {
      pipeline_id: PIPE,
      stage_id: "triagem",
    });

    const publicado = (ctxPublicado?.context.lead ?? {}) as Record<string, unknown>;
    expect(publicado.id).toBe("lead-1");
    expect(publicado.tags).toEqual(["Meta_ads"]);
    expect(publicado.title).toBe("Fulano");
  });

  it("criação: o contexto traz a linha criada, não só o id", async () => {
    const db = makeDb({ contacts: [{ id: "contato-1", organization_id: ORG_ID }],
      pipelines: [funilRow({ id: PIPE, name: "Funil" })],
      stages: [ETAPA_ORIGEM, ETAPA_DESTINO],
      leads: [],
    });

    await getAction("create_or_move_lead")!.execute(ctxDoContatoPublicado(db), {
      pipeline_id: PIPE,
      stage_id: "novo",
    });

    const publicado = (ctxPublicado?.context.lead ?? {}) as Record<string, unknown>;
    expect(publicado.id).toBe(db.tabelas.crm_leads[0]?.id);
    expect(publicado.stage_id).toBe("novo");
    expect(publicado.contact_id).toBe("contato-1");
  });
});

describe("create_or_move_lead — não lê nenhuma chave classificacao_inicial_* do código-fonte", () => {
  it("o arquivo da ação não menciona 'classificacao' em lugar nenhum", async () => {
    // Prova estrutural complementar à prova por comportamento acima: se algum
    // dia alguém adicionar uma leitura de classificação aqui, este teste
    // reprova ANTES de precisar de um cenário específico para pegar o ramo.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const fonte = readFileSync(
      resolve(process.cwd(), "lib/automation/actions/create-or-move-lead.ts"),
      "utf-8",
    );
    expect(fonte.toLowerCase()).not.toContain("classificacao");
    expect(fonte.toLowerCase()).not.toContain("respondi_score");
  });
});


it("CRM derivado propaga referência original sem observar ou abrir atendimento", async () => {
  originRpc.mockClear();
  const db = makeDb({ contacts: [{ id: "contato-1", organization_id: ORG_ID }], pipelines: [funilRow({ id: PIPE, name: "Funil" })], stages: [ETAPA_ORIGEM, ETAPA_DESTINO], leads: [negocio("lead-1", "novo")] });
  const ctx = ctxComLead({}, db.client as unknown as ActionCtx["admin"]);
  ctx.event = { id: "evento-original", event_type: "message.received" } as ActionCtx["event"];
  ctx.context.contact = { id: "contato-1" };
  expect((await getAction("create_or_move_lead")!.execute(ctx, { pipeline_id: PIPE, stage_id: "triagem" })).status).toBe("success");
  expect(originRpc).toHaveBeenCalledWith("emit_event", expect.objectContaining({ p_payload: expect.objectContaining({ service_origin: {kind:"event",event_id:"evento-original",organization_id:ORG_ID,contact_id:"contato-1"} }) }));
  expect(originRpc.mock.calls.every(call => call[0] === "emit_event")).toBe(true);
});
