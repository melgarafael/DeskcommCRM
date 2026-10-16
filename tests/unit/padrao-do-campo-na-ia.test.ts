/**
 * A GRAVAÇÃO PELA IA PERGUNTA DE NOVO (#2730) — o terceiro ponto da issue.
 *
 * O `padrao` do campo vale para o agente também: quando o valor não casa, o
 * campo SAI da escrita e volta para o modelo um ERRO DE ENSINO dizendo o que
 * perguntar — os outros campos da mesma chamada seguem gravando.
 *
 * O detalhe que este arquivo mede com mais cuidado: a régua é
 * DETERMINÍSTICA e roda ANTES do interruptor da conferência (#2234), que
 * nasce DESLIGADA. Se o padrão dependesse do Jev, o produto gravaria torto em
 * toda organização que nunca ligou aquilo — que é o estado padrão.
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

const MENSAGEM_DO_CAMPO = "Use só números separados por vírgula, ex.: 2,9";

const CAMPO_IDADES = {
  key: "idades",
  label: "Idades das crianças",
  type: "text",
  padrao: "^\\d{1,2}(,\\d{1,2})*$",
  mensagem_padrao: MENSAGEM_DO_CAMPO,
};

/** O estado padrão do produto: a conferência de campo NASCE DESLIGADA. */
const DESLIGADA = { jev: { ligado: false } };

/** A conferência ligada e decidindo — para provar que o padrão vem ANTES. */
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

interface Opcoes {
  pipelineSettings: unknown;
  config?: unknown;
  mensagens?: Array<{ direction: string; body: string | null; created_at: string }>;
}

function bancoFalso(opcoes: Opcoes): { cliente: SupabaseClient; lidas: string[] } {
  const lidas: string[] = [];
  const conversa = "55555555-5555-4555-8555-555555555555";
  const mensagens = opcoes.mensagens ?? [
    {
      direction: "inbound",
      body: "minha filha tem 2 anos",
      created_at: "2026-09-01T10:00:00.000Z",
    },
  ];

  const linhaDe = (tabela: string): unknown => {
    if (tabela === "organizations")
      return opcoes.config === null ? null : { settings: opcoes.config ?? DESLIGADA };
    if (tabela === "crm_leads") return { pipeline_id: "pipe-1" };
    if (tabela === "crm_pipelines") return { settings: opcoes.pipelineSettings };
    if (tabela === "conversations") return { id: conversa };
    return null;
  };

  const de = (tabela: string) => {
    const alvo: Record<string, unknown> = {};
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = (chave: string, valor: unknown) => {
      alvo[chave] = valor;
      return c;
    };
    let decrescente = false;
    let limite = 1000;
    c.order = (_coluna: string, o?: { ascending?: boolean }) => {
      decrescente = o?.ascending === false;
      return c;
    };
    c.limit = (n: number) => {
      limite = n;
      return c;
    };
    c.maybeSingle = async () => ({ data: linhaDe(tabela), error: null });
    c.insert = async () => ({ data: null, error: null });
    c.then = (ok: (v: unknown) => unknown, ruim?: (e: unknown) => unknown) =>
      Promise.resolve({
        data:
          tabela === "messages"
            ? (decrescente ? [...mensagens].reverse() : mensagens).slice(0, limite)
            : [linhaDe(tabela)].filter(Boolean),
        error: null,
      }).then(ok, ruim);
    return c;
  };

  const cliente = {
    from: (tabela: string) => {
      lidas.push(tabela);
      return de(tabela);
    },
  } as unknown as SupabaseClient;

  return { cliente, lidas };
}

function ctxDoAgente(cliente: SupabaseClient, extra: Partial<McpContext> = {}): McpContext {
  return {
    organizationId: ORG,
    role: "ai_operator",
    actor: {
      type: "ai_agent",
      id: "agent-1",
      agent_id: "agent-1",
      role: "ai_operator",
      api_token_id: "tok",
    },
    apiTokenId: "tok",
    requestId: "req-1",
    supabase: cliente,
    contatoDoTurno: CONTATO,
    ...extra,
  } as unknown as McpContext;
}

function deps() {
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {},
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
        {
          status: 200,
        },
      ),
  );
  return { fetchImpl, buscarChave: () => Promise.resolve("chave-teste") };
}

async function escrever(
  campos: Record<string, unknown>,
  opcoes: Opcoes,
  contexto: Partial<McpContext> = {},
) {
  const { cliente } = bancoFalso(opcoes);
  const d = deps();
  const resultado = await conferirCamposPersonalizados(
    ctxDoAgente(cliente, contexto),
    { leadId: LEAD },
    campos,
    d,
  );
  return { resultado, jev: d.fetchImpl };
}

describe("a IA não grava fora do padrão — mesmo com a conferência desligada", () => {
  it("o campo torto sai da escrita e volta como ERRO DE ENSINO pedindo para perguntar de novo", async () => {
    const { resultado, jev } = await escrever(
      { idades: "dois", bairro: "Asa Norte" },
      {
        pipelineSettings: { fields: [CAMPO_IDADES] },
        config: DESLIGADA,
      },
    );

    // O que não casa NÃO é gravado; o resto da mesma chamada segue.
    expect(resultado.custom_fields).toEqual({ bairro: "Asa Norte" });
    expect(resultado.recusados).toHaveLength(1);
    expect(resultado.recusados[0]).toMatchObject({ campo: "idades", motivo: "fora_do_padrao" });
    // A frase que o modelo recebe é a DO CAMPO, e manda perguntar de novo.
    expect(resultado.recusados[0]?.mensagem).toContain(MENSAGEM_DO_CAMPO);
    expect(resultado.recusados[0]?.mensagem).toContain("pergunt");
    // Régua determinística: nenhum centavo de Jev gasto para chegar aqui.
    expect(jev).not.toHaveBeenCalled();
  });

  it("o valor que casa segue o fluxo de hoje, sem recusa nenhuma", async () => {
    const { resultado, jev } = await escrever(
      { idades: "2,9" },
      {
        pipelineSettings: { fields: [CAMPO_IDADES] },
        config: DESLIGADA,
      },
    );

    expect(resultado.custom_fields).toBeUndefined();
    expect(resultado.recusados).toEqual([]);
    expect(jev).not.toHaveBeenCalled();
  });

  it("sem `padrao` no campo, a IA grava o que escreveu — o de sempre", async () => {
    const { resultado } = await escrever(
      { idades: "dois e meio" },
      {
        pipelineSettings: { fields: [{ key: "idades", label: "Idades", type: "text" }] },
        config: DESLIGADA,
      },
    );

    expect(resultado.custom_fields).toBeUndefined();
    expect(resultado.recusados).toEqual([]);
  });
});

describe("regex inválida configurada — a IA não grava nada na chave e avisa", () => {
  it("motivo `padrao_invalido`, com a frase de configuração quebrada", async () => {
    const { resultado } = await escrever(
      { idades: "2,9" },
      {
        pipelineSettings: { fields: [{ ...CAMPO_IDADES, padrao: "^\\d{1,2(" }] },
        config: DESLIGADA,
      },
    );

    expect(resultado.custom_fields).toEqual({});
    expect(resultado.recusados).toHaveLength(1);
    expect(resultado.recusados[0]?.motivo).toBe("padrao_invalido");
    expect(resultado.recusados[0]?.mensagem).toContain("inválido");
    expect(resultado.recusados[0]?.mensagem).toContain("Idades das crianças");
  });
});

describe("com a conferência LIGADA, o padrão decide ANTES do Jev", () => {
  it("nada sobra para perguntar: o Jev não é chamado e o campo volta recusado", async () => {
    const { resultado, jev } = await escrever(
      { idades: "dois" },
      {
        pipelineSettings: { fields: [CAMPO_IDADES] },
        config: DECIDINDO,
      },
    );

    expect(resultado.custom_fields).toEqual({});
    expect(resultado.recusados).toHaveLength(1);
    expect(resultado.recusados[0]?.motivo).toBe("fora_do_padrao");
    expect(jev).not.toHaveBeenCalled();
  });

  it("o que NÃO tem padrão continua passando pela conferência de sempre", async () => {
    const { resultado, jev } = await escrever(
      { bairro: "Asa Norte" },
      {
        pipelineSettings: { fields: [CAMPO_IDADES] },
        config: DECIDINDO,
      },
    );

    // Sem padrão no campo escrito, o degrau 2 é quem decide — e sem mensagem
    // de contradicção ele grava (a régua #2234 não muda).
    expect(jev).toHaveBeenCalled();
    expect(resultado.custom_fields).toEqual({ bairro: "Asa Norte" });
    expect(resultado.recusados).toEqual([]);
  });
});

describe("a catraca por origem continua valendo", () => {
  it("tela e API de terceiros não passam por nenhuma recusa de padrão", async () => {
    const { resultado } = await escrever(
      { idades: "dois" },
      { pipelineSettings: { fields: [CAMPO_IDADES] }, config: DESLIGADA },
      { role: "manager" },
    );

    expect(resultado.estado).toBe("nao_conferida");
    expect(resultado.recusados).toEqual([]);
    expect(resultado.custom_fields).toBeUndefined();
  });
});
