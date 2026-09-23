// @vitest-environment node
//
// O LEAD NASCE NA MOEDA DA ORGANIZAÇÃO — não num literal "BRL".
//
// ─── O defeito, medido na main antes do conserto ────────────────────────────
//
// Havia QUATRO pontos gravando real em duro no caminho de criação, e os dois
// primeiros bastavam para que uma organização em peso ou dólar nunca visse
// outra moeda num lead criado pela tela:
//
//   lib/schemas/leads.ts:69          currency: z.string().length(3).default("BRL")
//   app/api/v1/leads/_handler.ts:317 currency: input.currency ?? "BRL"
//   components/kanban/NewLeadDialog.tsx:127  currency: "BRL"
//   lib/mcp/tools/leads.ts:191       currency: input.currency ?? "BRL"   ← consertado depois, com o euro
//
// O `.default()` do schema é o que torna os outros inalcançáveis: ele preenche
// o campo ANTES do handler, então o `?? "BRL"` de lá nunca rodava e nenhum
// conserto só no handler mudaria coisa alguma. É o mesmo defeito que a migration
// 0208 consertou no catálogo de produtos — valor certo, símbolo mentindo —,
// repetido no funil.
//
// ─── O que estes casos provam ───────────────────────────────────────────────
//
// Que o schema deixa o campo AUSENTE quando ninguém o mandou (é o que permite o
// handler decidir), e que o handler grava a moeda que a ORGANIZAÇÃO declarou —
// com o controle de que uma moeda mandada explicitamente continua vencendo, que
// é o contrato da API e do import.

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ error: null }),
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/atendimento/origem", () => ({
  observeServiceOrigin: async () => "humano",
}));

import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { crmCreateLead } from "@/lib/mcp/tools/leads";
import { createLeadSchema } from "@/lib/schemas/leads";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PIPELINE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ETAPA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/**
 * Supabase de mentira, encadeável, que responde por TABELA. Guarda o objeto
 * inserido em `crm_leads` — é ele que a asserção lê.
 */
function supabaseCom(moedaDaOrg: string | null) {
  const inseridos: Record<string, unknown>[] = [];

  const cadeia = (tabela: string) => {
    const resposta = () => {
      if (tabela === "crm_stages") {
        return { data: { id: ETAPA, pipeline_id: PIPELINE, organization_id: ORG }, error: null };
      }
      if (tabela === "organizations") {
        return { data: moedaDaOrg === null ? null : { currency: moedaDaOrg }, error: null };
      }
      // crm_leads: a leitura do MAX(position_in_stage) de uma etapa vazia.
      return { data: null, error: null };
    };

    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      is: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: async () => resposta(),
      single: async () => ({ data: { ...inseridos.at(-1), id: "lead-1" }, error: null }),
      insert: (linha: Record<string, unknown>) => {
        inseridos.push(linha);
        return q;
      },
    };
    return q;
  };

  return {
    cliente: { from: (tabela: string) => cadeia(tabela) } as never,
    inseridos,
  };
}

const ctx = {
  organization_id: ORG,
  actor: { type: "user" as const, id: "user-1" },
  requestId: "req-1",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createLeadSchema", () => {
  it("deixa a moeda AUSENTE quando ninguém a mandou — sem `.default('BRL')`", () => {
    const parsed = createLeadSchema.parse({
      pipeline_id: PIPELINE,
      stage_id: ETAPA,
      title: "Lead sem moeda",
    });

    expect(parsed.currency).toBeUndefined();
  });

  it("continua aceitando a moeda quando ela VEM no corpo", () => {
    const parsed = createLeadSchema.parse({
      pipeline_id: PIPELINE,
      stage_id: ETAPA,
      title: "Lead com moeda",
      currency: "MXN",
    });

    expect(parsed.currency).toBe("MXN");
  });
});

describe("createLeadHandler — moeda", () => {
  it("grava a moeda que a ORGANIZAÇÃO declarou quando o corpo não manda nenhuma", async () => {
    const { cliente, inseridos } = supabaseCom("MXN");

    await createLeadHandler(cliente, ctx, {
      pipeline_id: PIPELINE,
      stage_id: ETAPA,
      title: "Lead da loja mexicana",
      tags: [],
      source: "manual",
    });

    expect(inseridos).toHaveLength(1);
    expect(inseridos[0]).toMatchObject({ currency: "MXN" });
  });

  it("a moeda do corpo vence a da organização — contrato da API e do import", async () => {
    const { cliente, inseridos } = supabaseCom("MXN");

    await createLeadHandler(cliente, ctx, {
      pipeline_id: PIPELINE,
      stage_id: ETAPA,
      title: "Lead com moeda explícita",
      currency: "USD",
      tags: [],
      source: "manual",
    });

    expect(inseridos[0]).toMatchObject({ currency: "USD" });
  });

  it("organização sem linha legível degrada para o padrão, sem derrubar a criação", async () => {
    // `moedaDaOrganizacao` cai em `MOEDA_PADRAO` e deixa rastro (console.error
    // + Sentry) em vez de lançar. Criar lead não pode morrer porque a leitura de
    // um campo de configuração falhou.
    const { cliente, inseridos } = supabaseCom(null);
    const silenciado = vi.spyOn(console, "error").mockImplementation(() => {});

    await createLeadHandler(cliente, ctx, {
      pipeline_id: PIPELINE,
      stage_id: ETAPA,
      title: "Lead sem org legível",
      tags: [],
      source: "manual",
    });

    expect(inseridos[0]).toMatchObject({ currency: "BRL" });
    expect(silenciado).toHaveBeenCalled();
    silenciado.mockRestore();
  });

  it("o agente pelo MCP também: sem moeda no argumento, vale a da organização", async () => {
    // `crm_create_lead` trocava a moeda ausente por "BRL" ANTES de chamar o
    // handler, e o agente criava em real o negócio de uma empresa em euro.
    const { cliente, inseridos } = supabaseCom("EUR");

    await crmCreateLead.handler(
      { pipeline_id: PIPELINE, stage_id: ETAPA, title: "Negócio aberto pelo agente" },
      { supabase: cliente, organizationId: ORG, actor: { type: "user", id: "user-1" }, requestId: "req-1" } as never,
    );

    expect(inseridos[0]).toMatchObject({ currency: "EUR" });
  });
});
