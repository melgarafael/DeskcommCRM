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
import { ORG_ID, PIPE, etapa, funilRow, makeDb, negocio, type StageRow } from "@/tests/helpers/stages-db-double";

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


// ── #2769 — O GANHO NASCE A CONTINUAÇÃO NO FUNIL DE PÓS-VENDA ──────────────
//
// A agência trabalha com dois funis: Vendas (até fechar) e Experiência do
// Cliente (pré-viagem, em viagem, pós-viagem). O card tem de seguir para o
// segundo QUANDO o negócio fica ganho — e a origem tem de continuar GANHA:
// encerrar a origem como perdida (o que `transfereParaOFunil` faz) faz a venda
// sumir dos relatórios de vendas e comissão, que é o defeito medido na #2769.
//
// O que este bloco prende:
//   1. o card NOVO nasce no funil de destino COM os dados da origem (título,
//      descrição, contato, valor, tags, campos personalizados) — nunca em
//      branco — e traz `source_metadata.clonado_de`, o ponteiro que liga os
//      dois cards (gravado; nenhuma tela o mostra ainda — #2769, item 2);
//   2. a origem não recebe UMA escrita: `status` segue `won` e a etapa de
//      ganho continua sendo a dela;
//   3. apontar a ação para o MESMO funil é RECUSA, não movimento — regravar o
//      negócio que acabou de ganhar realimenta o próprio gatilho (#1528);
//   4. a continuação é UMA por NEGÓCIO de origem: o mesmo ganho reentregue
//      não cria um segundo card, e a 2ª venda do mesmo contato ganha o seu
//      sem mexer no card da 1ª.
const FUNIL_DE_VENDAS = PIPE;
const FUNIL_DE_POS_VENDA = "66666666-4444-4444-8866-666666666666";
const ETAPA_DE_GANHO = etapa({
  id: "pago",
  slug: "pago",
  name: "Pago",
  pipeline_id: FUNIL_DE_VENDAS,
  position: 3000,
  is_won: true,
});
const ETAPA_DE_POS_VENDA = etapa({
  id: "pos_venda",
  slug: "pos_venda",
  name: "Pós-venda",
  pipeline_id: FUNIL_DE_POS_VENDA,
  position: 7000,
});

/** A linha COMPLETA de `crm_leads` — é o que `buildContext` entrega em `context.lead`. */
const NEGOCIO_GANHO = {
  id: "lead-ganho-1",
  pipeline_id: FUNIL_DE_VENDAS,
  stage_id: "pago",
  organization_id: ORG_ID,
  contact_id: "contato-1",
  status: "won",
  title: "Reforma da cozinha",
  description: "Cliente pediu simulação",
  value_cents: 250000,
  currency: "BRL",
  owner_user_id: null,
  owner_agent_id: null,
  expected_close_date: null,
  tags: ["orcamento"],
  source: "whatsapp",
  custom_fields: { ambiente: "cozinha" },
  source_metadata: {},
};

const CONFIG_POS_VENDA = { pipeline_id: FUNIL_DE_POS_VENDA, stage_id: "pos_venda" };

function dbDoGanho(leads: Array<Record<string, unknown>> = [NEGOCIO_GANHO], extrasDeEtapa: StageRow[] = []) {
  return makeDb({
    contacts: [{ id: "contato-1", organization_id: ORG_ID }],
    pipelines: [
      funilRow({ id: FUNIL_DE_VENDAS, name: "Vendas" }),
      funilRow({ id: FUNIL_DE_POS_VENDA, name: "Experiência do Cliente" }),
    ],
    stages: [ETAPA_DE_GANHO, ETAPA_DE_POS_VENDA, ...extrasDeEtapa],
    leads: leads as never,
  });
}

/** O contexto que o motor entrega num `lead.won`: a linha do negócio + o contato. */
function ctxDoGanho(db: ReturnType<typeof makeDb>, tipoDoEvento = "lead.won"): ActionCtx {
  return {
    admin: db.client as unknown as ActionCtx["admin"],
    organizationId: ORG_ID,
    ruleId: "rule-pos-venda",
    ruleName: "Ganho → pós-venda",
    event: {
      id: "ev-ganho-1",
      organization_id: ORG_ID,
      event_type: tipoDoEvento,
      entity_kind: "crm_lead",
      entity_id: NEGOCIO_GANHO.id,
      payload: { lead_id: NEGOCIO_GANHO.id, value_cents: 250000 },
      metadata: {},
    } as unknown as ActionCtx["event"],
    context: {
      lead: { ...NEGOCIO_GANHO },
      contact: { id: "contato-1", name: "Fulano", phone_number: "+551****0001" },
    },
    requestId: "req-1",
  };
}

describe("create_or_move_lead — lead.won cria a continuação no funil de pós-venda (#2769)", () => {
  it("negócio GANHO → nasce o card no pós-venda COM os dados, e a origem segue ganha", async () => {
    const db = dbDoGanho();
    const ctx = ctxDoGanho(db);

    const resultado = await getAction("create_or_move_lead")!.execute(ctx, CONFIG_POS_VENDA);

    expect(resultado).toMatchObject({ type: "create_or_move_lead", status: "success" });
    expect(resultado.error).toBeUndefined();

    // O card novo, com o conteúdo da origem — não um card em branco.
    const criado = db.tabelas.crm_leads.find((l) => l.id !== NEGOCIO_GANHO.id);
    expect(criado, "um card novo no funil de pós-venda").toBeDefined();
    expect(criado).toMatchObject({
      organization_id: ORG_ID,
      pipeline_id: FUNIL_DE_POS_VENDA,
      stage_id: "pos_venda",
      status: "open",
      contact_id: "contato-1",
      title: "Reforma da cozinha",
      description: "Cliente pediu simulação",
      value_cents: 250000,
      currency: "BRL",
      tags: ["orcamento"],
      custom_fields: { ambiente: "cozinha" },
      source: "whatsapp",
      // O ponteiro "continuação de" (gravado; a tela ainda não o mostra).
      // `retomado_de_lead_id` fica NULLO de propósito: este
      // card não é uma nova TENTATIVA do mesmo negócio, é a continuação de um
      // negócio que JÁ ganhou (contá-lo aqui corromperia "tentativas até ganhar").
      retomado_de_lead_id: null,
      source_metadata: {
        clonado_de: { lead_id: NEGOCIO_GANHO.id, pipeline_id: FUNIL_DE_VENDAS },
      },
    });

    // A ORIGEM NÃO MEXE: o ganho continua contando nos relatórios.
    const origem = db.tabelas.crm_leads.find((l) => l.id === NEGOCIO_GANHO.id);
    expect(origem).toMatchObject({
      status: "won",
      stage_id: "pago",
      pipeline_id: FUNIL_DE_VENDAS,
      value_cents: 250000,
    });
    expect(
      db.escritas.filter((e) => e.table === "crm_leads" && e.tipo !== "insert"),
      "nenhuma escrita na origem — o ganho é intocável",
    ).toEqual([]);

    // O card novo é o que as ações seguintes da mesma regra enxergam.
    expect((ctx.context.lead as Record<string, unknown>).id).toBe(criado?.id);
    expect(resultado.detail).toMatchObject({ origem: NEGOCIO_GANHO.id });
  });

  it("CONTROLE: o mesmo cenário com lead.lost segue recusando cross_pipeline_move_not_allowed", async () => {
    const db = dbDoGanho();
    const ctx = ctxDoGanho(db, "lead.lost");

    const resultado = await getAction("create_or_move_lead")!.execute(ctx, CONFIG_POS_VENDA);

    expect(resultado).toEqual({
      type: "create_or_move_lead",
      status: "failed",
      error: "cross_pipeline_move_not_allowed",
    });
    expect(db.tabelas.crm_leads).toHaveLength(1);
    expect(db.escritas).toEqual([]);
  });

  it("gatilho lead.won apontando para o MESMO funil: recusa, nunca regrava o ganho (#1528)", async () => {
    const db = dbDoGanho();
    const ctx = ctxDoGanho(db);

    const resultado = await getAction("create_or_move_lead")!.execute(ctx, {
      pipeline_id: FUNIL_DE_VENDAS,
      stage_id: "pago",
    });

    expect(resultado.status).toBe("failed");
    expect(resultado.error).toBe("continuacao_exige_outro_funil");
    expect(db.tabelas.crm_leads).toHaveLength(1);
    expect(db.tabelas.crm_leads[0]).toMatchObject({ status: "won", stage_id: "pago" });
    expect(db.escritas).toEqual([]);
  });

  it("2ª venda do MESMO contato com o pós-venda da 1ª em andamento: card próprio, e o da 1ª não volta de etapa", async () => {
    const emViagem = etapa({ id: "em_viagem", slug: "em_viagem", name: "Em viagem", pipeline_id: FUNIL_DE_POS_VENDA, position: 8000 });
    const posDaPrimeira = {
      id: "pos-da-primeira",
      pipeline_id: FUNIL_DE_POS_VENDA,
      stage_id: "em_viagem",
      organization_id: ORG_ID,
      contact_id: "contato-1",
      status: "open",
      title: "Viagem 1",
      source_metadata: { clonado_de: { lead_id: "venda-anterior", pipeline_id: FUNIL_DE_VENDAS } },
    };
    const db = dbDoGanho([NEGOCIO_GANHO, posDaPrimeira], [emViagem]);
    const ctx = ctxDoGanho(db);

    const resultado = await getAction("create_or_move_lead")!.execute(ctx, CONFIG_POS_VENDA);

    expect(resultado).toMatchObject({ type: "create_or_move_lead", status: "success" });
    const doPosVenda = db.tabelas.crm_leads.filter((l) => l.pipeline_id === FUNIL_DE_POS_VENDA);
    expect(doPosVenda, "a 2ª venda ganha o próprio card").toHaveLength(2);
    expect(doPosVenda.find((l) => l.id === "pos-da-primeira"), "o card da 1ª venda não é tocado").toMatchObject({
      stage_id: "em_viagem",
      status: "open",
    });
    expect(db.escritas.filter((e) => e.table === "crm_leads" && e.tipo !== "insert")).toEqual([]);
  });

  it.each([
    ["com contato", "contato-1"],
    ["sem contato", null],
  ])("o mesmo ganho reentregue (%s): UM card só, e a regra segue sobre ele", async (_caso, contato) => {
    const negocio = { ...NEGOCIO_GANHO, contact_id: contato };
    const db = dbDoGanho([negocio]);
    const ctxDe = () => {
      const c = ctxDoGanho(db);
      c.context = contato ? { ...c.context, lead: { ...negocio } } : { lead: { ...negocio } };
      return c;
    };

    const primeira = await getAction("create_or_move_lead")!.execute(ctxDe(), CONFIG_POS_VENDA);
    const ctxDaSegunda = ctxDe();
    const segunda = await getAction("create_or_move_lead")!.execute(ctxDaSegunda, CONFIG_POS_VENDA);

    const doPosVenda = db.tabelas.crm_leads.filter((l) => l.pipeline_id === FUNIL_DE_POS_VENDA);
    expect(doPosVenda, "reentrega não duplica a continuação").toHaveLength(1);
    expect(primeira.detail).toMatchObject({ criado: doPosVenda[0]?.id });
    expect(segunda).toMatchObject({ status: "success", detail: { ja_existia: doPosVenda[0]?.id, origem: negocio.id } });
    expect((ctxDaSegunda.context.lead as Record<string, unknown>).id, "as ações seguintes enxergam a continuação").toBe(
      doPosVenda[0]?.id,
    );
  });

  it("a leitura da continuação FALHA: recusa, nunca cria às cegas", async () => {
    const db = makeDb({
      contacts: [{ id: "contato-1", organization_id: ORG_ID }],
      pipelines: [
        funilRow({ id: FUNIL_DE_VENDAS, name: "Vendas" }),
        funilRow({ id: FUNIL_DE_POS_VENDA, name: "Experiência do Cliente" }),
      ],
      stages: [ETAPA_DE_GANHO, ETAPA_DE_POS_VENDA],
      leads: [NEGOCIO_GANHO] as never,
      readError: (tabela, filtros) =>
        tabela === "crm_leads" && filtros.some(([c]) => c.includes("clonado_de"))
          ? { code: "57014", message: "canceling statement due to statement timeout" }
          : null,
    });

    const resultado = await getAction("create_or_move_lead")!.execute(ctxDoGanho(db), CONFIG_POS_VENDA);

    expect(resultado).toMatchObject({ status: "failed", error: "canceling statement due to statement timeout" });
    expect(db.tabelas.crm_leads, "falha transitória não vira card").toHaveLength(1);
    expect(db.escritas).toEqual([]);
  });

  it("etapa de destino É de fechamento: recusa — o card não nasce já ganho", async () => {
    const etapaDeGanhoNoDestino = etapa({
      id: "renovou",
      slug: "renovou",
      name: "Renovou",
      pipeline_id: FUNIL_DE_POS_VENDA,
      position: 9000,
      is_won: true,
    });
    const db = dbDoGanho([NEGOCIO_GANHO], [etapaDeGanhoNoDestino]);
    const ctx = ctxDoGanho(db);

    const resultado = await getAction("create_or_move_lead")!.execute(ctx, {
      pipeline_id: FUNIL_DE_POS_VENDA,
      stage_id: "renovou",
    });

    expect(resultado.status).toBe("failed");
    // A tela não pode receber CÓDIGO cru no lugar de frase (#1090): o que sai
    // daqui é `destino.texto`, uma frase de gente — não `stage_destino_terminal`.
    expect(String(resultado.error), "o operador não pode ler o código na aba Atividade").not.toMatch(
      /^[a-z][a-z0-9_]*$/,
    );
    expect(db.tabelas.crm_leads, "nada nasce dentro de uma etapa de fechamento").toHaveLength(1);
    expect(db.escritas).toEqual([]);
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
