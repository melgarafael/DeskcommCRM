/**
 * A CHAVE QUE O FUNIL NÃO DECLARA (#4667, parte 2).
 *
 * `crm_update_lead` / `crm_create_lead` gravavam a chave inventada sem avisar,
 * em `crm_leads.custom_fields`, onde card nenhum a mostra. (A parte 1, os
 * campos em `crm_list_pipelines`, entrou pelo #4680 e tem os testes dela em
 * `lib/mcp/tools/pipelines.test.ts`.)
 *
 * A recusa mora no degrau 0 da conferência (`lib/mcp/conferencia-de-campos`),
 * ao lado do padrão (#2730): determinística, ANTES do interruptor do Jev, e só
 * para a origem do agente de IA. Tela, token de terceiro e automação seguem
 * gravando como hoje. Funil que não foi lido é fail-open, como o resto do
 * arquivo.
 */
import { describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { conferirCamposPersonalizados } from "@/lib/mcp/conferencia-de-campos";
import type { McpContext } from "@/lib/mcp/types";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const LEAD = "44444444-4444-4444-8444-444444444444";
const FUNIL = "66666666-6666-4666-8666-666666666666";

const CAMPOS = [
  { key: "orcamento_max", label: "Orçamento máximo", type: "currency" },
  {
    key: "tipo_imovel",
    label: "Tipo de imóvel",
    type: "select",
    options: [
      { value: "apartamento", label: "Apartamento" },
      { value: "casa", label: "Casa" },
    ],
  },
  { key: "cpf", label: "CPF", type: "text", escopo: "contato" },
];

/** O estado padrão do produto: a conferência de campo NASCE DESLIGADA. */
const DESLIGADA = { jev: { ligado: false } };

/** A conferência ligada e decidindo: a chave tem de sair ANTES do Jev. */
const DECIDINDO = {
  jev: {
    ligado: true,
    modo: "decide",
    aceite: {
      em: "2026-09-01T12:00:00.000Z",
      por: "22222222-2222-4222-8222-222222222222",
      alcance: "conversa",
    },
    tarefas: { campo_do_negocio: { estado: "decidindo" } },
  },
};

function bancoFalso(pipelineSettings: unknown, config: unknown): SupabaseClient {
  const linhaDe = (tabela: string): unknown => {
    if (tabela === "organizations") return { settings: config };
    if (tabela === "crm_leads") return { pipeline_id: FUNIL };
    if (tabela === "crm_pipelines") return { settings: pipelineSettings };
    if (tabela === "conversations") return { id: "55555555-5555-4555-8555-555555555555" };
    return null;
  };
  const mensagens = [{ direction: "inbound", body: "até uns 2 mil por mês", created_at: "2026-09-01T10:00:00.000Z" }];
  const de = (tabela: string) => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = () => c;
    c.order = () => c;
    c.limit = () => c;
    c.maybeSingle = async () => ({ data: linhaDe(tabela), error: null });
    c.insert = async () => ({ data: null, error: null });
    c.then = (ok: (v: unknown) => unknown, ruim?: (e: unknown) => unknown) =>
      Promise.resolve({
        data: tabela === "messages" ? mensagens : [linhaDe(tabela)].filter(Boolean),
        error: null,
      }).then(ok, ruim);
    return c;
  };
  return { from: de } as unknown as SupabaseClient;
}

function ctx(cliente: SupabaseClient, extra: Partial<McpContext> = {}): McpContext {
  return {
    organizationId: ORG,
    role: "ai_operator",
    actor: { type: "ai_agent", id: "agent-1", agent_id: "agent-1", role: "ai_operator", api_token_id: "tok" },
    apiTokenId: "tok",
    requestId: "req-1",
    supabase: cliente,
    contatoDoTurno: CONTATO,
    ...extra,
  } as unknown as McpContext;
}

function jevQueResponde() {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({ model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }),
        { status: 200 },
      ),
  );
}

async function escrever(
  campos: Record<string, unknown>,
  opcoes: { pipelineSettings: unknown; config?: unknown; alvo?: { leadId: string } | { pipelineId: string } },
  extra: Partial<McpContext> = {},
) {
  const fetchImpl = jevQueResponde();
  const resultado = await conferirCamposPersonalizados(
    ctx(bancoFalso(opcoes.pipelineSettings, opcoes.config ?? DESLIGADA), extra),
    opcoes.alvo ?? { leadId: LEAD },
    campos,
    { fetchImpl, buscarChave: () => Promise.resolve("chave-teste") },
  );
  return { resultado, jev: fetchImpl };
}

describe("crm_update_lead pelo agente: a chave inventada não é gravada", () => {
  it("chave fora do funil sai da escrita e volta com as chaves válidas do negócio", async () => {
    const { resultado, jev } = await escrever({ orcamento: 2000 }, { pipelineSettings: { fields: CAMPOS } });

    expect(resultado.custom_fields).toEqual({});
    expect(resultado.estado).toBe("chave_fora_do_funil");
    expect(resultado.recusados).toHaveLength(1);
    expect(resultado.recusados[0]).toMatchObject({ campo: "orcamento", motivo: "chave_fora_do_funil" });
    const mensagem = resultado.recusados[0]?.mensagem ?? "";
    expect(mensagem).toContain("orcamento_max (Orçamento máximo)");
    expect(mensagem).toContain("tipo_imovel (Tipo de imóvel)");
    // A lista de válidas é a do NEGÓCIO: o campo do contato não é sugerido aqui.
    expect(mensagem).not.toContain("cpf");
    expect(jev).not.toHaveBeenCalled();
  });

  it("a chave válida da mesma chamada segue gravando", async () => {
    const { resultado } = await escrever(
      { orcamento: 2000, orcamento_max: 2000 },
      { pipelineSettings: { fields: CAMPOS } },
    );

    expect(resultado.custom_fields).toEqual({ orcamento_max: 2000 });
    expect(resultado.recusados.map((r) => r.campo)).toEqual(["orcamento"]);
  });

  it("com a conferência LIGADA, a chave sai antes do Jev e o Jev não é chamado por ela", async () => {
    const { resultado, jev } = await escrever(
      { orcamento: 2000 },
      { pipelineSettings: { fields: CAMPOS }, config: DECIDINDO },
    );

    expect(resultado.custom_fields).toEqual({});
    expect(resultado.recusados[0]?.motivo).toBe("chave_fora_do_funil");
    expect(jev).not.toHaveBeenCalled();
  });

  it("funil sem campo nenhum: a recusa diz que não há campo para usar", async () => {
    const { resultado } = await escrever({ orcamento: 2000 }, { pipelineSettings: {} });

    expect(resultado.custom_fields).toEqual({});
    expect(resultado.recusados[0]?.motivo).toBe("chave_fora_do_funil");
    expect(resultado.recusados[0]?.mensagem).toContain("não tem campos personalizados");
  });

  it("chave declarada como campo do CONTATO não é tratada como inventada", async () => {
    const { resultado } = await escrever({ cpf: "123" }, { pipelineSettings: { fields: CAMPOS } });

    expect(resultado.recusados).toEqual([]);
    expect(resultado.custom_fields).toBeUndefined();
  });

  it("funil que não foi lido: fail-open, grava como hoje", async () => {
    const { resultado } = await escrever({ orcamento: 2000 }, { pipelineSettings: null });

    expect(resultado.recusados).toEqual([]);
    expect(resultado.custom_fields).toBeUndefined();
  });
});

describe("crm_create_lead pelo agente: a mesma régua no funil do argumento", () => {
  it("a chave fora do funil de nascimento é recusada", async () => {
    const { resultado } = await escrever(
      { orcamento: 2000, tipo_imovel: "casa" },
      { pipelineSettings: { fields: CAMPOS }, alvo: { pipelineId: FUNIL } },
    );

    expect(resultado.custom_fields).toEqual({ tipo_imovel: "casa" });
    expect(resultado.recusados[0]).toMatchObject({ campo: "orcamento", motivo: "chave_fora_do_funil" });
  });
});

describe("a catraca por origem continua valendo", () => {
  it("tela e token de terceiro gravam a chave livre como hoje", async () => {
    const { resultado } = await escrever(
      { orcamento: 2000 },
      { pipelineSettings: { fields: CAMPOS } },
      { role: "manager" },
    );

    expect(resultado.estado).toBe("nao_conferida");
    expect(resultado.recusados).toEqual([]);
    expect(resultado.custom_fields).toBeUndefined();
  });

  it("papel de agente sem contato do turno (token de API) também não passa pela régua", async () => {
    const { resultado } = await escrever(
      { orcamento: 2000 },
      { pipelineSettings: { fields: CAMPOS } },
      { contatoDoTurno: undefined },
    );

    expect(resultado.estado).toBe("nao_conferida");
    expect(resultado.recusados).toEqual([]);
  });
});
