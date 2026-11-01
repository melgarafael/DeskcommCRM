/**
 * A rota de empresa e o CNPJ alfanumérico da Receita (#3495).
 *
 * O defeito medido na `main`: `normalizeCnpj` só enxergava dígitos, então o
 * CNPJ que a Receita passou a emitir (12 posições alfanuméricas + 2 dígitos
 * verificadores) era RECUSADO no cadastro, na edição e na consulta — a pessoa
 * digitava o documento certo e a tela dizia "CNPJ inválido". O validador que já
 * sabia ler esse formato (`isValidCnpj`, `lib/cobranca/documento.ts`) existia no
 * repositório e a rota simplesmente não o usava.
 *
 * O que estes testes fixam:
 *   1. as TRÊS portas da rota (criar, editar, consultar) aceitam o alfanumérico
 *      e gravam a forma MAIÚSCULA, sem máscara, em `normalized_cnpj`;
 *   2. o DV errado continua recusado — numérico e alfanumérico — com mensagem
 *      que diz o que conferir, em vez de um "inválido" sem saída;
 *   3. o numérico que já entrava continua entrando (nada de trocar um formato
 *      pelo outro).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/crm-b2b/enrich", () => ({ enrichCompanyFromBrasilApi: vi.fn() }));

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import {
  createCompanyHandler,
  lookupCompanyCnpjHandler,
  patchCompanyHandler,
} from "@/lib/crm-b2b/companies-handler";

const ORG = "11111111-1111-4111-8111-111111111111";
const EMPRESA = "22222222-2222-4222-8222-222222222222";
const ATOR = "33333333-3333-4333-8333-333333333333";

const CTX: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: ATOR, role: "manager" },
  requestId: "req-3495",
  idioma: "pt-BR",
};

const ALFA = "12ABC34501DE35";
const ALFA_FORMATADO = "12.ABC.345/01DE-35";
const NUMERICO = "11222333000181";
const NUMERICO_FORMATADO = "11.222.333/0001-81";

/** Banco falso do INSERT: registra o que a rota mandou gravar. */
function bancoDeCriacao() {
  const insercoes: Array<Record<string, unknown>> = [];
  const banco = {
    from: () => ({
      select: () => {
        const consulta = {
          eq: () => consulta,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return consulta;
      },
      insert: (dados: Record<string, unknown>) => {
        insercoes.push(dados);
        return {
          select: () => ({
            single: async () => ({ data: { id: EMPRESA, ...dados }, error: null }),
          }),
        };
      },
    }),
  };
  return { banco: banco as unknown as SupabaseClient, insercoes };
}

/** Banco falso do UPDATE: registra o patch e devolve a linha atualizada. */
function bancoDePatch() {
  const atualizacoes: Array<Record<string, unknown>> = [];
  const banco = {
    from: () => ({
      update: (dados: Record<string, unknown>) => {
        atualizacoes.push(dados);
        const consulta = {
          eq: () => consulta,
          select: () => ({
            maybeSingle: async () => ({ data: { id: EMPRESA, ...dados }, error: null }),
          }),
        };
        return consulta;
      },
    }),
  };
  return { banco: banco as unknown as SupabaseClient, atualizacoes };
}

/** Banco falso da consulta: nenhuma empresa com esse CNPJ ainda. */
function bancoDeConsulta() {
  const consulta = {
    eq: () => consulta,
    maybeSingle: async () => ({ data: null, error: null }),
  };
  return { from: () => ({ select: () => consulta }) } as unknown as SupabaseClient;
}

function falhaDeValidacao(erro: unknown): ApiError {
  expect(erro).toBeInstanceOf(ApiError);
  const api = erro as ApiError;
  expect(api.status).toBe(422);
  expect(api.code).toBe("validation_failed");
  return api;
}

describe("cadastro de empresa aceita o CNPJ alfanumérico da Receita (#3495)", () => {
  it.each([
    ["sem máscara", ALFA, ALFA],
    ["com máscara", ALFA_FORMATADO, ALFA],
    ["em minúsculas", "12.abc.345/01de-35", ALFA],
  ])("criar grava o alfanumérico %s em MAIÚSCULA", async (_caso, entrada, esperado) => {
    const { banco, insercoes } = bancoDeCriacao();
    await createCompanyHandler(banco, CTX, ATOR, {
      legal_name: "Empresa Alfanumérica LTDA",
      cnpj: entrada,
      enrich: false,
    });
    expect(insercoes).toHaveLength(1);
    expect(insercoes[0]).toMatchObject({ normalized_cnpj: esperado, cnpj: ALFA_FORMATADO });
  });

  it("criar continua aceitando o CNPJ numérico (o formato que já entrava)", async () => {
    const { banco, insercoes } = bancoDeCriacao();
    await createCompanyHandler(banco, CTX, ATOR, {
      legal_name: "Empresa Numérica LTDA",
      cnpj: NUMERICO_FORMATADO,
      enrich: false,
    });
    expect(insercoes[0]).toMatchObject({
      normalized_cnpj: NUMERICO,
      cnpj: NUMERICO_FORMATADO,
    });
  });

  it.each([
    ["numérico com o DV errado", "11.222.333/0001-00"],
    ["alfanumérico com o DV errado", "12ABC34501DE36"],
  ])("criar recusa o CNPJ %s dizendo o que conferir, sem gravar", async (_caso, entrada) => {
    const { banco, insercoes } = bancoDeCriacao();
    const erro = await createCompanyHandler(banco, CTX, ATOR, {
      legal_name: "Empresa Errada LTDA",
      cnpj: entrada,
      enrich: false,
    }).catch((e: unknown) => e);
    const api = falhaDeValidacao(erro);
    expect(api.message).toMatch(/dígitos verificadores/);
    expect(insercoes).toEqual([]);
  });

  it("editar grava o alfanumérico em MAIÚSCULA", async () => {
    const { banco, atualizacoes } = bancoDePatch();
    await patchCompanyHandler(banco, CTX, ATOR, EMPRESA, { cnpj: "12.abc.345/01de-35" });
    expect(atualizacoes[0]).toMatchObject({ normalized_cnpj: ALFA, cnpj: ALFA_FORMATADO });
  });

  it("editar recusa o alfanumérico com o DV errado, sem tocar na empresa", async () => {
    const { banco, atualizacoes } = bancoDePatch();
    const erro = await patchCompanyHandler(banco, CTX, ATOR, EMPRESA, {
      cnpj: "12ABC34501DE36",
    }).catch((e: unknown) => e);
    falhaDeValidacao(erro);
    expect(atualizacoes).toEqual([]);
  });

  it("consultar aceita o alfanumérico e pergunta à BrasilAPI pela forma normalizada", async () => {
    const lookupCnpj = vi.fn(async () => ({
      ok: true as const,
      data: { cnpj: ALFA, razao_social: "EMPRESA ALFANUMERICA LTDA" },
      raw: {},
    }));
    const resultado = await lookupCompanyCnpjHandler(
      bancoDeConsulta(),
      CTX,
      { cnpj: "12.abc.345/01de-35" },
      { lookupCnpj },
    );
    expect(lookupCnpj).toHaveBeenCalledWith(ALFA);
    expect(resultado).toMatchObject({ cnpj: ALFA_FORMATADO, normalized_cnpj: ALFA });
  });

  it("consultar recusa o alfanumérico com o DV errado sem chamar a rede", async () => {
    const lookupCnpj = vi.fn();
    const erro = await lookupCompanyCnpjHandler(
      bancoDeConsulta(),
      CTX,
      { cnpj: "12ABC34501DE36" },
      { lookupCnpj },
    ).catch((e: unknown) => e);
    falhaDeValidacao(erro);
    expect(lookupCnpj).not.toHaveBeenCalled();
  });
});
