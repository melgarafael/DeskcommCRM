// @vitest-environment node
//
// CRIAR DIRETO NUMA ETAPA EXIGENTE PASSA PELA RÉGUA (issue #1710) ────────────
//
// ─── O defeito, medido na main antes do conserto ────────────────────────────
//
// `createLeadHandler` é o escritor de CRIAÇÃO de todo o sistema (REST `POST
// /api/v1/leads`, a tool MCP `crm_create_lead`, o `NewLeadDialog` com
// `stage_id`, o webhook de captação, o import de planilha, a retomada e a
// transferência de funil da automação `create_or_move_lead`) — e era o ÚNICO
// escritor de etapa que não perguntava `validaCamposExigidos`. O arrasto, o
// lote, o encerramento, o `moveLeadHandler` e o clone já perguntavam; a criação
// nascia na coluna exigente com o campo em branco e a exigência só era cobrada
// na PRÓXIMA escrita — o negócio já estava lá.
//
// ─── O que estes casos provam ───────────────────────────────────────────────
//
// 1. criar direto na etapa exigente SEM o campo recusa com o MESMO erro da
//    régua existente — mesmo `code`, mesmo `details.faltando`, MESMA frase —
//    e nada é gravado;
// 2. com o campo, a mesma criação passa (controle positivo);
// 3. funil SEM `obrigatorio_em`, e settings ilegível: cria como antes — a
//    regra continua OPT-IN (critério de aceite nº 3 do #1536);
// 4. a tool MCP `crm_create_lead` cai na MESMA recusa;
// 5. a transferência de funil da automação (`transfereParaOFunil`) também — e
//    a ORIGEM NÃO é encerrada (a recusa acontece antes da primeira escrita).
//
// Sabotagem esperada: sem o bloco da régua em `createLeadHandler`, os casos 1,
// 4 e 5 ficam vermelhos (3 de 7) e os controles continuam verdes.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async () => ({ error: null }) }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/atendimento/origem", () => ({ observeServiceOrigin: async () => "humano" }));

import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { crmCreateLead } from "@/lib/mcp/tools/leads";
import { recusaDeCamposObrigatorios } from "@/lib/leads/campos-exigidos";
import { transfereParaOFunil } from "@/lib/leads/transfere-para-o-funil";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FUNIL_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FUNIL_B = "11111111-1111-4111-8111-111111111111";
const ETAPA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ETAPA_DESTINO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ETAPA_PERDA_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LEAD_ORIGEM = "99999999-9999-4999-8999-999999999999";
const LEAD_NOVO = "ffffffff-ffff-4fff-8fff-ffffffffffff";

/** O funil que EXIGE `concorrente` para entrar na etapa `ETAPA`. */
const EXIGENTE = funilQueExige(ETAPA);

/** O mesmo, para a etapa de destino da transferência (`ETAPA_DESTINO`). */
const EXIGENTE_NO_DESTINO = funilQueExige(ETAPA_DESTINO);

function funilQueExige(etapa: string) {
  return {
    fields: [
      { key: "concorrente", label: "Concorrente", type: "text", obrigatorio_em: { etapas: [etapa] } },
    ],
  };
}

/** O MESMO faltando que a régua devolve para esta exigência. */
const FALTANDO = [{ chave: "concorrente", rotulo: "Concorrente", tipo: "text" as const }];

const ctx = {
  organization_id: ORG,
  actor: { type: "user" as const, id: "user-1" },
  requestId: "req-1",
};

const payloadBase = {
  pipeline_id: FUNIL_A,
  stage_id: ETAPA,
  title: "Negócio criado direto",
  tags: [],
  source: "manual",
};

type Resposta = { data: unknown; error: { message: string } | null };

/**
 * Supabase de mentira, encadeável, que responde por TABELA + MÉTODO + ORDEM.
 *
 * `then` na própria cadeia cobre o `await` direto da query de LISTA
 * (`...order(...)`), que é como o PostgREST devolve — sem ele a transferência
 * penduraria. `single` devolve a linha inserida (o handler faz
 * `insert(...).select(...).single()`); `update` é registrado para a asserção
 * de que a ORIGEM da transferência não foi encerrada.
 */
function supabaseFake(responder: (tabela: string, metodo: string, ordem: number) => Resposta) {
  const ordens: Record<string, number> = {};
  const inseridos: Record<string, unknown>[] = [];
  const atualizacoes: Record<string, unknown>[] = [];

  const proxima = (tabela: string, metodo: string): Resposta => {
    const chave = `${tabela}:${metodo}`;
    ordens[chave] = (ordens[chave] ?? 0) + 1;
    return responder(tabela, metodo, ordens[chave]);
  };

  const from = (tabela: string) => {
    const q: Record<string, unknown> = {};
    const cadeia = () => q;
    for (const nome of ["select", "eq", "neq", "is", "order", "limit"]) q[nome] = cadeia;
    q.insert = (linha: Record<string, unknown>) => {
      inseridos.push(linha);
      return q;
    };
    q.update = (linha: Record<string, unknown>) => {
      atualizacoes.push(linha);
      return q;
    };
    q.maybeSingle = async () => proxima(tabela, "maybeSingle");
    q.single = async () => {
      const r = proxima(tabela, "single");
      return r.data === null && r.error === null
        ? { data: { ...inseridos.at(-1), id: LEAD_NOVO }, error: null }
        : r;
    };
    q.then = (ok: (v: Resposta) => void) => {
      ok(proxima(tabela, "lista"));
    };
    return q;
  };

  return { cliente: { from } as never, inseridos, atualizacoes };
}

/** O cenário simples de CRIAÇÃO: etapa de `FUNIL_A` + `settings` do funil. */
function criacao(settings: unknown, erroDeSettings = false) {
  return supabaseFake((tabela, metodo) => {
    if (tabela === "crm_stages" && metodo === "maybeSingle") {
      return {
        data: { id: ETAPA, pipeline_id: FUNIL_A, organization_id: ORG },
        error: null,
      };
    }
    if (tabela === "crm_pipelines" && metodo === "maybeSingle") {
      return erroDeSettings
        ? { data: null, error: { message: "leitura indisponível" } }
        : { data: settings === undefined ? null : { settings }, error: null };
    }
    if (tabela === "organizations" && metodo === "maybeSingle") {
      return { data: { currency: "BRL" }, error: null };
    }
    return { data: null, error: null };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createLeadHandler — a etapa em que o negócio NASCE", () => {
  it("recusa a criação direta na etapa exigente sem o campo, com o MESMO erro da régua", async () => {
    const { cliente, inseridos } = criacao(EXIGENTE);

    const erro = await createLeadHandler(cliente, ctx, payloadBase).catch((e: unknown) => e);

    expect(erro).toMatchObject({
      name: "ApiError",
      status: 422,
      code: "required_fields_missing",
      details: { faltando: FALTANDO },
    });
    // A MESMA frase que arrasto, lote, encerramento, move e clone devolvem.
    expect((erro as Error).message).toBe(
      recusaDeCamposObrigatorios(FALTANDO, undefined).mensagem,
    );
    // A pergunta vem ANTES da primeira escrita: nada foi gravado.
    expect(inseridos).toHaveLength(0);
  });

  it("com o campo preenchido no corpo, a MESMA criação passa", async () => {
    const { cliente, inseridos } = criacao(EXIGENTE);

    await createLeadHandler(cliente, ctx, {
      ...payloadBase,
      custom_fields: { concorrente: "ACME" },
    });

    expect(inseridos).toHaveLength(1);
  });

  it("funil SEM `obrigatorio_em`: cria como antes — a regra continua opt-in", async () => {
    // O asterisco antigo (`required: true`) NÃO barra: ele é destaque no
    // formulário, e quem barra é só `obrigatorio_em`.
    const { cliente, inseridos } = criacao({
      fields: [{ key: "concorrente", label: "Concorrente", type: "text", required: true }],
    });

    await createLeadHandler(cliente, ctx, payloadBase);

    expect(inseridos).toHaveLength(1);
  });

  it("settings do funil ilegível: fail-open, cria como antes", async () => {
    const { cliente, inseridos } = criacao(undefined, true);

    await createLeadHandler(cliente, ctx, payloadBase);

    expect(inseridos).toHaveLength(1);
  });
});

describe("crm_create_lead (MCP) — o mesmo escritor", () => {
  it("cai na MESMA recusa quando a etapa pede campo que o argumento não traz", async () => {
    const { cliente, inseridos } = criacao(EXIGENTE);

    const erro = await crmCreateLead
      .handler(
        { pipeline_id: FUNIL_A, stage_id: ETAPA, title: "Negócio aberto pelo agente" },
        {
          supabase: cliente,
          organizationId: ORG,
          actor: { type: "user", id: "user-1" },
          requestId: "req-1",
        } as never,
      )
      .catch((e: unknown) => e);

    expect(erro).toMatchObject({ status: 422, code: "required_fields_missing" });
    expect(inseridos).toHaveLength(0);
  });

  // #2297, caminho 2: a chave faltava no `inputSchema` da ferramenta. O
  // argumento passa pelo SHAPE, como o servidor MCP faz antes de chamar o
  // handler — sem `custom_fields` declarado, o `z.object` descarta a chave aqui
  // e a régua lá dentro recusa sem que o agente tivesse como evitar.
  it("com `custom_fields` no argumento, a MESMA criação na etapa exigente passa", async () => {
    const { cliente, inseridos } = criacao(EXIGENTE);

    const argumento = z.object(crmCreateLead.inputSchema).parse({
      pipeline_id: FUNIL_A,
      stage_id: ETAPA,
      title: "Negócio aberto pelo agente",
      custom_fields: { concorrente: "ACME" },
    });

    await crmCreateLead.handler(argumento, {
      supabase: cliente,
      organizationId: ORG,
      actor: { type: "user", id: "user-1" },
      requestId: "req-1",
    } as never);

    expect(inseridos).toHaveLength(1);
  });
});

function transferencia() {
  return supabaseFake((tabela, metodo, ordem) => {
    // 1) as etapas do funil de destino (query de LISTA, `await` do `q`).
    if (tabela === "crm_stages" && metodo === "lista" && ordem === 1) {
      return {
        data: [
          {
            id: ETAPA_DESTINO,
            pipeline_id: FUNIL_B,
            position: 1000,
            is_won: false,
            is_lost: false,
            is_archived: false,
          },
        ],
        error: null,
      };
    }
    // 2) a etapa de PERDA da origem (a que o encerramento usaria).
    if (tabela === "crm_stages" && metodo === "maybeSingle" && ordem === 1) {
      return { data: { id: ETAPA_PERDA_A }, error: null };
    }
    // 3) a etapa que o `createLeadHandler` valida.
    if (tabela === "crm_stages" && metodo === "maybeSingle" && ordem === 2) {
      return {
        data: { id: ETAPA_DESTINO, pipeline_id: FUNIL_B, organization_id: ORG },
        error: null,
      };
    }
    if (tabela === "crm_pipelines" && metodo === "maybeSingle") {
      return { data: { settings: EXIGENTE_NO_DESTINO }, error: null };
    }
    if (tabela === "organizations" && metodo === "maybeSingle") {
      return { data: { currency: "BRL" }, error: null };
    }
    return { data: null, error: null };
  });
}

describe("transfereParaOFunil — a troca de funil da automação (create_or_move_lead)", () => {
  it("recusa o clone na etapa exigente e NÃO encerra a origem", async () => {
    const { cliente, inseridos, atualizacoes } = transferencia();

    const origem = {
      id: LEAD_ORIGEM,
      pipeline_id: FUNIL_A,
      status: "open",
      title: "Negócio no funil A",
      tags: [],
      custom_fields: {},
    };

    const erro = await transfereParaOFunil(
      cliente,
      ORG,
      ctx,
      origem,
      FUNIL_B,
      ETAPA_DESTINO,
      "Levado para outro funil pela automação",
    ).catch((e: unknown) => e);

    expect(erro).toMatchObject({ status: 422, code: "required_fields_missing" });
    // Nem o clone nasceu…
    expect(inseridos).toHaveLength(0);
    // …nem a origem foi encerrada: a recusa vem ANTES das duas escritas.
    expect(atualizacoes).toHaveLength(0);
  });
});

// ─── #2295: QUEM fica fora da régua é a ROTA de captação, não o ATOR ────────
//
// `webhook_source` é o ator do webhook de captação, mas também da automação
// `create_or_move_lead` (criação e transferência) e da prospecção. A isenção é
// a opção `exigirCamposDaEtapa: false`, que só a rota de captação passa.
// Sabotagens que separam os desenhos: isentar por `ctx.actor.type` deixa os
// dois primeiros vermelhos; ignorar a opção deixa o terceiro vermelho.

const ctxDaAutomacao = {
  organization_id: ORG,
  actor: { type: "webhook_source" as const, id: "rule-1" },
  requestId: "req-1",
};

describe("ator `webhook_source` da automação continua na régua (#2295)", () => {
  it("createLeadHandler com ator webhook_source recusa com 422", async () => {
    const { cliente, inseridos } = criacao(EXIGENTE);

    const erro = await createLeadHandler(cliente, ctxDaAutomacao, payloadBase).catch((e: unknown) => e);

    expect(erro).toMatchObject({ status: 422, code: "required_fields_missing" });
    expect(inseridos).toHaveLength(0);
  });

  it("transfereParaOFunil com ator webhook_source recusa com 422 e não encerra a origem", async () => {
    const { cliente, inseridos, atualizacoes } = transferencia();

    const erro = await transfereParaOFunil(
      cliente,
      ORG,
      ctxDaAutomacao,
      {
        id: LEAD_ORIGEM,
        pipeline_id: FUNIL_A,
        status: "open",
        title: "Negócio no funil A",
        tags: [],
        custom_fields: {},
      },
      FUNIL_B,
      ETAPA_DESTINO,
      "Levado para outro funil pela automação",
    ).catch((e: unknown) => e);

    expect(erro).toMatchObject({ status: 422, code: "required_fields_missing" });
    expect(inseridos).toHaveLength(0);
    expect(atualizacoes).toHaveLength(0);
  });
});

describe("opção `exigirCamposDaEtapa: false` — só a captação passa (#2295)", () => {
  it("cria na etapa exigente sem o campo, como antes", async () => {
    const { cliente, inseridos } = criacao(EXIGENTE);

    await createLeadHandler(
      cliente,
      { ...ctxDaAutomacao, actor: { type: "webhook_source" as const, id: "fonte-1" } },
      payloadBase,
      { exigirCamposDaEtapa: false },
    );

    expect(inseridos).toHaveLength(1);
  });
});
