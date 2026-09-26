/**
 * GET /api/v1/ai/runs — o filtro por provedor existe de verdade, e o Jev chega
 * à tela com nome de gente.
 *
 * O cabeçalho da rota prometia filtrar por provedor desde o primeiro dia, e o
 * `?provider=` era descartado: a lista voltava inteira, sem erro. O link "Ver as
 * decisões do Jev" do cartão depende deste filtro.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  JEV_FALHOU_AO_LADO,
  JEV_FALHOU_E_A_IA_COBRIU,
  JEV_FALHOU_SEM_RESERVA,
  O_QUE_FAZER_DO_JEV,
} from "@/lib/ai/decisao/textos";
import { PONTO_POR_ID } from "@/lib/ai/pontos/registro";
import { EXPLICACAO_DA_ORIGEM } from "@/lib/ai/pontos/resolver";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

import { GET } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";

function linha(over: Record<string, unknown>) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    purpose: "sentiment_classify",
    provider: "anthropic",
    model: "anthropic/claude-haiku-4-5",
    status: "ok",
    error_code: null,
    error_message: null,
    http_status: null,
    origem_da_escolha: null,
    input_tokens: 10,
    output_tokens: 2,
    cost_cents: 0.01,
    latency_ms: 300,
    created_at: "2026-09-23T12:00:00Z",
    ...over,
  };
}

let filtros: Array<[string, unknown]>;
let linhas: ReturnType<typeof linha>[];

beforeEach(() => {
  filtros = [];
  linhas = [];
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u", idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
  const chain = {
    select: () => chain,
    order: () => chain,
    limit: () => chain,
    eq: (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return chain;
    },
    or: (expressao: string) => {
      filtros.push(["or", expressao]);
      return chain;
    },
    then: (resolve: (r: unknown) => unknown) => resolve({ data: linhas, error: null }),
  };
  vi.mocked(createClient).mockResolvedValue({
    from: (tabela: string) => {
      expect(tabela).toBe("llm_calls");
      return chain;
    },
  } as unknown as Awaited<ReturnType<typeof createClient>>);
});

async function pedir(query = "") {
  const res = await GET(new NextRequest(`http://localhost/api/v1/ai/runs${query}`));
  return { status: res.status, corpo: await res.json() };
}

describe("GET /api/v1/ai/runs", () => {
  it("?provider= vira filtro na consulta, e a organização é a da sessão", async () => {
    const { status } = await pedir("?provider=anthropic");
    expect(status).toBe(200);
    expect(filtros).toContainEqual(["provider", "anthropic"]);
    expect(filtros).toContainEqual(["organization_id", ORG]);
  });

  it("'Só o Jev' traz também as linhas da reserva que o cobriu", async () => {
    // O cartão conta "Vezes que a IA de sempre cobriu o Jev" e o link dele
    // vem para cá: filtrar só pelo provedor escondia justamente essas linhas.
    await pedir("?provider=typesafe");
    expect(filtros).toContainEqual(["or", "provider.eq.typesafe,origem_da_escolha.eq.reserva_do_jev"]);
    expect(filtros).toContainEqual(["organization_id", ORG]);
  });

  it("controle: sem ?provider=, nenhum filtro de provedor", async () => {
    await pedir();
    expect(filtros.some(([coluna]) => coluna === "provider")).toBe(false);
  });

  it("o provedor chega com nome de gente; desconhecido sai como está", async () => {
    linhas = [
      linha({ provider: "typesafe", model: "typesafe/jev-1.13.0", origem_da_escolha: "jev" }),
      linha({ provider: "anthropic" }),
      linha({ provider: "fornecedor-que-saiu" }),
    ];
    const { corpo } = await pedir();
    expect(corpo.data.execucoes.map((e: { provedorRotulo: string }) => e.provedorRotulo)).toEqual([
      "Jev (TypeSafe AI)",
      "Anthropic (Claude)",
      "fornecedor-que-saiu",
    ]);
  });

  it("a reserva que cobriu o Jev não carrega consequência; a falha sem reserva carrega", async () => {
    linhas = [
      linha({ origem_da_escolha: "reserva_do_jev" }),
      linha({
        provider: "typesafe",
        model: "typesafe/jev-1.13.0",
        status: "erro",
        error_code: "jev_credencial_invalida",
        origem_da_escolha: "jev",
      }),
    ];
    const { corpo } = await pedir();
    const [reserva, falha] = corpo.data.execucoes;

    expect(reserva.consequencia).toBeNull();
    expect(reserva.porQueEsteModelo).toBe(EXPLICACAO_DA_ORIGEM.reserva_do_jev);

    expect(falha.consequencia).toBe(PONTO_POR_ID.get("sentiment_classify")?.sintomaDeFalha);
    expect(falha.oQueFazer).toBe(O_QUE_FAZER_DO_JEV.jev_credencial_invalida);
    // "O Jev decidiu" seria falso na única linha em que ninguém mediu.
    expect(falha.porQueEsteModelo).toBe(JEV_FALHOU_SEM_RESERVA);
  });

  it("a linha do Jev diz o fato: decidiu, só observou, ou foi um teste", async () => {
    linhas = [
      linha({ provider: "typesafe", model: "typesafe/jev-1.13.0", origem_da_escolha: "jev" }),
      linha({ provider: "typesafe", model: "typesafe/jev-1.13.0", origem_da_escolha: "jev_observacao" }),
      linha({ purpose: "intent_router", provider: "typesafe", model: "typesafe/jev-1.13.0", origem_da_escolha: "jev_teste" }),
    ];
    const { corpo } = await pedir("?provider=typesafe");
    expect(corpo.data.execucoes.map((e: { porQueEsteModelo: string }) => e.porQueEsteModelo)).toEqual([
      "O Jev decidiu.",
      "O Jev observou: a resposta dele ficou registrada para comparar, e não decidiu nada.",
      // O clique em "Testar classificação" não entra na comparação (R5).
      "Teste na tela do roteador — não entra na comparação.",
    ]);
  });

  it("a cobertura do roteador decidindo diz que a IA de sempre decidiu no lugar dele, sem inventar consequência", async () => {
    linhas = [
      linha({
        purpose: "intent_router",
        provider: "typesafe",
        model: "typesafe/jev-1.13.0",
        status: "erro",
        error_code: "jev_provedor_indisponivel",
        origem_da_escolha: "reserva_do_jev",
        input_tokens: 0,
        output_tokens: 0,
        cost_cents: 0,
      }),
    ];
    const { corpo } = await pedir("?provider=typesafe");
    const [cobertura] = corpo.data.execucoes;
    expect(PONTO_POR_ID.get("intent_router")?.sintomaDeFalha).toBeTruthy();
    expect(cobertura.consequencia).toBeNull();
    expect(cobertura.porQueEsteModelo).toBe(JEV_FALHOU_E_A_IA_COBRIU);
    expect(cobertura.oQueFazer).toBe(O_QUE_FAZER_DO_JEV.jev_provedor_indisponivel);
  });

  it.each(["jev_sem_credencial", "jev_disjuntor_aberto"] as const)(
    "a cobertura em que nada saiu para a rede (%s) diz o que houve",
    async (codigo) => {
      linhas = [
        linha({
          purpose: "intent_router",
          provider: "typesafe",
          model: "typesafe/jev-1.13.0",
          status: "erro",
          error_code: codigo,
          origem_da_escolha: "reserva_do_jev",
          input_tokens: 0,
          output_tokens: 0,
          cost_cents: 0,
        }),
      ];
      const { corpo } = await pedir("?provider=typesafe");
      const [cobertura] = corpo.data.execucoes;
      expect(cobertura.consequencia).toBeNull();
      expect(cobertura.porQueEsteModelo).toBe(JEV_FALHOU_E_A_IA_COBRIU);
      expect(cobertura.oQueFazer).toBe(O_QUE_FAZER_DO_JEV[codigo]);
    },
  );

  it("a falha do Jev na manipulação não afirma consequência: a IA de sempre seguiu decidindo", async () => {
    // A linha que `lib/ai/decisao/manipulacao.ts` grava quando a chave é recusada
    // (a mesma que `tests/invariants/jev-manipulacao-no-turno.test.ts` lê do banco).
    linhas = [
      linha({
        purpose: "jailbreak_detect",
        provider: "typesafe",
        model: "typesafe/jev-1.13.0",
        status: "erro",
        error_code: "jev_credencial_invalida",
        http_status: 401,
        origem_da_escolha: "jev_observacao",
        input_tokens: 0,
        output_tokens: 0,
        cost_cents: 0,
      }),
    ];
    const { corpo } = await pedir();
    const [falha] = corpo.data.execucoes;
    // Controle: o ponto TEM sintoma de falha — é ele que a tela afirmava.
    expect(PONTO_POR_ID.get("jailbreak_detect")?.sintomaDeFalha).toBeTruthy();
    expect(falha.consequencia).toBeNull();
    expect(falha.oQueFazer).toBe(O_QUE_FAZER_DO_JEV.jev_credencial_invalida);
    expect(falha.porQueEsteModelo).toBe(JEV_FALHOU_AO_LADO);
    expect(corpo.data.resumo.erros).toBe(1);
  });

  it("observação com a IA de sempre caída: a falha dela não afirma consequência que não houve", async () => {
    linhas = [linha({ status: "erro", error_code: "provedor_indisponivel", origem_da_escolha: "jev_cobriu" })];
    const { corpo } = await pedir();
    const [linhaDaIa] = corpo.data.execucoes;
    expect(linhaDaIa.consequencia).toBeNull();
    expect(linhaDaIa.oQueFazer).not.toBeNull();
    expect(linhaDaIa.porQueEsteModelo).toBe(EXPLICACAO_DA_ORIGEM.jev_cobriu);
  });
});
