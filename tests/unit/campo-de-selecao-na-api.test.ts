/**
 * A MESMA RÉGUA DA OPÇÃO NOS TRÊS CAMINHOS DE ESCRITA (#3508).
 *
 * O defeito medido na issue: `validarValorPesquisavel` já casava o valor com a
 * opção, mas valia só para `searchable_select` e só a tela a chamava. A API
 * (`POST`/`PATCH /api/v1/leads`), as tools MCP (`crm_create_lead`,
 * `crm_update_lead`) e a captação por webhook gravavam o texto cru: um funil com
 * a opção "São Paulo" (`value` `sp`) nascia com `estado: "sao paulo"`, e a ficha
 * não marcava opção nenhuma.
 *
 * Este arquivo mede os TRÊS caminhos, cada um pelo seu ponto de entrada de
 * verdade:
 *
 *  1. API REST → `createLeadHandler`/`updateLeadHandler`, que são o handler das
 *     rotas `app/api/v1/leads`;
 *  2. MCP → `crmCreateLead.handler`/`crmUpdateLead.handler`, com os handlers de
 *     verdade atrás (a conferência do agente é a única peça dublada, porque ela
 *     fala com o modelo);
 *  3. captação → os mesmos handlers com as opções que a rota do webhook passa
 *     (`exigirCamposDaEtapa: false, exigirPadraoDoCampo: false,
 *     manterForaDaLista: true`). A rota em si, que só repassa essas opções, é
 *     medida em `app/api/v1/webhooks/in/[token]/route.test.ts`.
 *
 * E os CONTROLES que impedem a régua de virar regressão:
 *
 *  - campo sem opções cadastradas segue gravando o texto como veio;
 *  - valor torto JÁ gravado que não mudou não barra a edição de outro campo;
 *  - sem `manterForaDaLista`, o MESMO valor que a captação aceita é recusado —
 *    é a prova de que a exceção é da captação, e não da régua.
 *
 * O Supabase é de mentira; os handlers são os de verdade.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * As chamadas `rpc` do cliente ADMIN — é por ele que passa o merge atômico dos
 * campos (`fn_lead_anotar_campos`, migration 0502), separado do cliente que o
 * handler lê. Hoisted porque a fábrica de `vi.mock` é içada para o topo.
 */
const h = vi.hoisted(() => ({
  rpcAdmin: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => false),
  hashEmail: (e: string) => e,
}));
vi.mock("@/lib/atendimento/origem", () => ({
  observeServiceOrigin: vi.fn(async () => null),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcAdmin.push({ fn, args });
      return { data: null, error: null };
    },
  })),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: () => "movido",
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));
/**
 * A conferência da IA (#2234) pergunta ao modelo o que o cliente disse — fora
 * do escopo desta issue e impossível de exercitar sem LLM. Dublada como
 * PASSTHROUGH de propósito: com ela devolvendo os campos intactos, o que o
 * teste mede é exatamente o que vem DEPOIS dela, a régua da opção no handler.
 */
vi.mock("@/lib/mcp/conferencia-de-campos", () => ({
  conferirCamposPersonalizados: vi.fn(async (_ctx: unknown, _alvo: unknown, campos: unknown) => ({
    custom_fields: campos,
    recusados: [],
  })),
}));

import { createLeadHandler, updateLeadHandler } from "@/app/api/v1/leads/_handler";
import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import { MENSAGEM_DE_FORA_DA_LISTA } from "@/lib/leads/opcao-do-campo-no-servidor";
import { crmCreateLead, crmUpdateLead } from "@/lib/mcp/tools/leads";

const ORG = "22222222-2222-4222-8222-222222222222";
const FUNIL = "44444444-4444-4444-8444-444444444444";
const ETAPA = "55555555-5555-4555-8555-555555555555";
const USUARIO = "11111111-1111-4111-8111-111111111111";

const CAMPO_ESTADO = {
  key: "estado",
  label: "Estado",
  type: "select",
  options: [
    { value: "sp", label: "São Paulo", aliases: ["SP", "Sampa"] },
    { value: "mg", label: "Minas Gerais" },
  ],
};

const CAMPO_INTERESSES = {
  key: "interesses",
  label: "Interesses",
  type: "multiselect",
  options: [
    { value: "casa", label: "Casa" },
    { value: "apto", label: "Apartamento" },
  ],
};

/** O campo `select` SEM lista — o de sempre, que aceita o que vier. */
const CAMPO_LIVRE = { key: "estado", label: "Estado", type: "select" };

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: USUARIO },
  requestId: "req-1",
  idioma: "pt-BR",
};

/** As opções que a ROTA de captação passa — copiadas de propósito. */
const COMO_A_CAPTACAO = {
  exigirCamposDaEtapa: false,
  exigirPadraoDoCampo: false,
  manterForaDaLista: true,
};

const CRIAR = {
  pipeline_id: FUNIL,
  stage_id: ETAPA,
  title: "Aluguel em São Paulo",
  tags: [],
  source: "manual",
};

// ── O banco falso dos LEADS ──────────────────────────────────────────────────

function banco(fields: unknown[], opcoes: { gravados?: Record<string, unknown> } = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const gravado: Record<string, unknown> = {
    id: "lead-1",
    organization_id: ORG,
    pipeline_id: FUNIL,
    stage_id: ETAPA,
    title: "Aluguel",
    tags: [],
    custom_fields: (opcoes.gravados ?? {}) as Record<string, unknown>,
    updated_at: "2026-10-27T12:00:00.000Z",
    contact_id: null,
  };

  const from = (tabela: string) => {
    let escrita: Record<string, unknown> | null = null;
    const q: Record<string, unknown> = {};
    const mesmo = () => q;
    for (const nome of ["select", "eq", "neq", "is", "order", "limit"]) q[nome] = mesmo;
    q.insert = (linha: Record<string, unknown>) => {
      escrita = linha;
      inserts.push(linha);
      return q;
    };
    q.update = (linha: Record<string, unknown>) => {
      escrita = linha;
      updates.push(linha);
      return q;
    };
    const linha = () => {
      if (tabela !== "crm_leads") return null;
      if (!escrita) return { ...gravado };
      return { ...gravado, ...escrita };
    };
    q.maybeSingle = async () => {
      if (tabela === "crm_stages")
        return { data: { id: ETAPA, pipeline_id: FUNIL, organization_id: ORG }, error: null };
      if (tabela === "crm_pipelines") return { data: { settings: { fields } }, error: null };
      if (tabela === "organizations")
        return { data: { currency: "BRL", settings: { currency: "BRL" } }, error: null };
      return { data: linha(), error: null };
    };
    q.single = async () => ({
      data:
        tabela === "crm_leads"
          ? { ...(escrita ?? {}), id: "lead-1", pipeline_id: FUNIL, stage_id: ETAPA, title: "Aluguel" }
          : null,
      error: null,
    });
    q.then = (ok: (v: unknown) => unknown, ruim?: (e: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(ok, ruim);
    return q;
  };

  const cliente = {
    from,
    rpc: async () => ({ data: null, error: null }),
  } as unknown as never;

  return { cliente, inserts, updates };
}

async function recusa(promise: Promise<unknown>): Promise<ApiError> {
  const erro = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(erro, "a escrita deveria ter sido recusada").toBeInstanceOf(ApiError);
  return erro as ApiError;
}

/**
 * As chamadas ao merge atômico, entre todas as do `rpc`: a edição também emite
 * `emit_event` (auditoria/timeline), e é o `fn_lead_anotar_campos` que prova o
 * que foi gravado nos campos.
 */
const anotacoes = () => h.rpcAdmin.filter((r) => r.fn === "fn_lead_anotar_campos");

/** O `McpContext` mínimo das tools — o banco é o de mentira de cima. */
function ctxMcp(cliente: unknown) {
  return {
    organizationId: ORG,
    role: "manager",
    actor: { type: "agent", id: USUARIO },
    apiTokenId: "token-1",
    requestId: "req-mcp",
    supabase: cliente,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rpcAdmin.length = 0;
});

// ── 1. API REST ──────────────────────────────────────────────────────────────

describe("API REST (POST /api/v1/leads) — a opção casa e grava o `value`", () => {
  it("as três grafias de São Paulo chegam ao banco como `sp`", async () => {
    const { cliente, inserts } = banco([CAMPO_ESTADO]);

    for (const entrada of ["sao paulo", "SÃO PAULO", "SP"]) {
      await createLeadHandler(cliente, ctx, {
        ...(CRIAR as object),
        custom_fields: { estado: entrada },
      } as never);
    }

    expect(inserts.map((l) => (l as { custom_fields?: unknown }).custom_fields)).toEqual([
      { estado: "sp" },
      { estado: "sp" },
      { estado: "sp" },
    ]);
  });

  it("multiselect com vírgula vira a LISTA de opções", async () => {
    const { cliente, inserts } = banco([CAMPO_INTERESSES]);

    await createLeadHandler(cliente, ctx, {
      ...(CRIAR as object),
      custom_fields: { interesses: "casa, apartamento" },
    } as never);

    expect(inserts[0]).toMatchObject({ custom_fields: { interesses: ["casa", "apto"] } });
  });

  it("valor fora da lista: 422 `custom_field_value_not_in_list` e NADA é gravado", async () => {
    const { cliente, inserts } = banco([CAMPO_ESTADO]);

    const erro = await recusa(
      createLeadHandler(cliente, ctx, {
        ...(CRIAR as object),
        custom_fields: { estado: "Bahia" },
      } as never),
    );

    expect(erro.status).toBe(422);
    expect(erro.code).toBe("custom_field_value_not_in_list");
    expect(erro.details).toEqual({
      recusas: [{ campo: "estado", motivo: "fora_da_lista", valor: "Bahia" }],
    });
    // A frase traduzível MAIS o campo e o valor: é só a mensagem que o agente
    // de IA recebe (o servidor MCP devolve `err.message`, não `details`).
    expect(erro.message).toContain(MENSAGEM_DE_FORA_DA_LISTA);
    expect(erro.message).toContain('"estado"');
    expect(erro.message).toContain('"Bahia"');
    expect(inserts, "nada foi gravado torto").toHaveLength(0);
  });

  it("a frase sai JÁ TRADUZIDA pelo idioma do contexto (es)", async () => {
    const { cliente } = banco([CAMPO_ESTADO]);

    const erro = await recusa(
      createLeadHandler(
        cliente,
        { ...ctx, idioma: "es" },
        { ...(CRIAR as object), custom_fields: { estado: "Bahia" } } as never,
      ),
    );

    expect(DICIONARIO[MENSAGEM_DE_FORA_DA_LISTA]?.es).toBeTruthy();
    expect(erro.message).toContain(DICIONARIO[MENSAGEM_DE_FORA_DA_LISTA]!.es);
  });

  it("CONTROLE: campo `select` SEM opções cadastradas segue gravando como veio", async () => {
    const { cliente, inserts } = banco([CAMPO_LIVRE]);

    await createLeadHandler(cliente, ctx, {
      ...(CRIAR as object),
      custom_fields: { estado: "Bahia" },
    } as never);

    expect(inserts[0]).toMatchObject({ custom_fields: { estado: "Bahia" } });
  });

  it("CONTROLE: tipo que não guarda opção (`text`) passa byte a byte", async () => {
    const { cliente, inserts } = banco([{ key: "estado", label: "Estado", type: "text" }]);

    await createLeadHandler(cliente, ctx, {
      ...(CRIAR as object),
      custom_fields: { estado: "sao paulo" },
    } as never);

    expect(inserts[0]).toMatchObject({ custom_fields: { estado: "sao paulo" } });
  });
});

// ── 2. MCP ───────────────────────────────────────────────────────────────────

describe("MCP (crm_create_lead / crm_update_lead) — os mesmos handlers, a mesma régua", () => {
  it("crm_create_lead grava o `value` da opção", async () => {
    const { cliente, inserts } = banco([CAMPO_ESTADO]);

    await crmCreateLead.handler(
      {
        pipeline_id: FUNIL,
        stage_id: ETAPA,
        title: "Aluguel em Minas",
        custom_fields: { estado: "minas gerais" },
      } as never,
      ctxMcp(cliente),
    );

    expect(inserts[0]).toMatchObject({ custom_fields: { estado: "mg" } });
  });

  it("crm_update_lead manda o `value` no merge atômico", async () => {
    const { cliente } = banco([CAMPO_ESTADO]);

    await crmUpdateLead.handler(
      { lead_id: "11111111-2222-4333-8444-555555555555", custom_fields: { estado: "São Paulo" } } as never,
      ctxMcp(cliente),
    );

    expect(anotacoes()).toHaveLength(1);
    expect(anotacoes()[0]).toMatchObject({ args: { p_campos: { estado: "sp" } } });
  });

  it("crm_update_lead recusa o que não casa, e o merge não roda", async () => {
    const { cliente } = banco([CAMPO_ESTADO]);

    const erro = await recusa(
      crmUpdateLead.handler(
        { lead_id: "11111111-2222-4333-8444-555555555555", custom_fields: { estado: "Bahia" } } as never,
        ctxMcp(cliente),
      ),
    );

    expect(erro.status).toBe(422);
    expect(erro.code).toBe("custom_field_value_not_in_list");
    expect(anotacoes()).toHaveLength(0);
  });
});

// ── 3. Captação por webhook ─────────────────────────────────────────────────

describe("captação por webhook — com as opções que a ROTA passa", () => {
  it("'sao paulo' vira `sp` mesmo sem exigir padrão nem campos da etapa", async () => {
    const { cliente, inserts } = banco([CAMPO_ESTADO]);

    await createLeadHandler(
      cliente,
      ctx,
      { ...(CRIAR as object), custom_fields: { estado: "sao paulo" } } as never,
      COMO_A_CAPTACAO,
    );

    expect(inserts[0]).toMatchObject({ custom_fields: { estado: "sp" } });
  });

  it("multiselect do formulário com vírgula vira a lista de `value`", async () => {
    const { cliente, inserts } = banco([CAMPO_INTERESSES]);

    await createLeadHandler(
      cliente,
      ctx,
      { ...(CRIAR as object), custom_fields: { interesses: "casa, apartamento" } } as never,
      COMO_A_CAPTACAO,
    );

    expect(inserts[0]).toMatchObject({ custom_fields: { interesses: ["casa", "apto"] } });
  });

  it("fora da lista: o lead NASCE com o texto cru (recusar perderia o lead)", async () => {
    const { cliente, inserts } = banco([CAMPO_ESTADO]);

    const lead = await createLeadHandler(
      cliente,
      ctx,
      { ...(CRIAR as object), custom_fields: { estado: "Bahia" } } as never,
      COMO_A_CAPTACAO,
    );

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ custom_fields: { estado: "Bahia" } });
    expect(lead.id).toBe("lead-1");
  });

  it("a atualização do card (reenvio/adoção) também não é barrada pela lista", async () => {
    const { cliente } = banco([CAMPO_ESTADO]);

    await updateLeadHandler(
      cliente,
      ctx,
      "lead-1",
      { custom_fields: { estado: "Bahia" } },
      { manterForaDaLista: true },
    );

    expect(anotacoes()).toHaveLength(1);
    expect(anotacoes()[0]).toMatchObject({ args: { p_campos: { estado: "Bahia" } } });
  });

  it("SEM a opção, o MESMO valor é recusado — a exceção é da captação, não da régua", async () => {
    const { cliente } = banco([CAMPO_ESTADO]);

    const erro = await recusa(
      updateLeadHandler(cliente, ctx, "lead-1", { custom_fields: { estado: "Bahia" } }),
    );

    expect(erro.code).toBe("custom_field_value_not_in_list");
    expect(anotacoes()).toHaveLength(0);
  });
});

// ── A edição: só o que MUDOU é julgado ──────────────────────────────────────

describe("PATCH /api/v1/leads/{id} — o diff contra o que está gravado", () => {
  it("o `value` que casa chega ao merge", async () => {
    const { cliente } = banco([CAMPO_ESTADO]);

    await updateLeadHandler(cliente, ctx, "lead-1", { custom_fields: { estado: "minas gerais" } });

    expect(anotacoes()).toHaveLength(1);
    expect(anotacoes()[0]).toMatchObject({ args: { p_campos: { estado: "mg" } } });
  });

  it("valor torto JÁ gravado e INALTERADO não barra a edição de outro campo", async () => {
    // A ficha manda o formulário inteiro a cada salvamento (#2814): julgar tudo
    // recusaria a troca de título por causa de um dado antigo que ninguém tocou.
    const { cliente, updates } = banco([CAMPO_ESTADO], { gravados: { estado: "sao paulo" } });

    await updateLeadHandler(cliente, ctx, "lead-1", {
      title: "Novo título",
      custom_fields: { estado: "sao paulo" },
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ title: "Novo título" });
  });
});
