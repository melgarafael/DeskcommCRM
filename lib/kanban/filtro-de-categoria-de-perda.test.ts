/**
 * FILTRAR POR CATEGORIA DE PERDA, INCLUSIVE PELO QUE NÃO TEM CATEGORIA (#4437).
 *
 * O filtro do quadro agrupa pela categoria que o MOTIVO tem no funil — a
 * categoria não é coluna do negócio, é configuração (`settings.lost_reasons`).
 * Dois buracos fechados aqui:
 *
 *  1. o motivo SEM categoria não casava com opção nenhuma e ficava fora de
 *     qualquer recorte (justamente os administrativos: "É fornecedor", "Card
 *     duplicado"). Ele ganhou o balde explícito "Sem categoria", o mesmo do
 *     relatório — filtrar e ler o relatório passam a falar do mesmo grupo;
 *  2. a categoria do funil continua mandando, mesmo depois de a categoria ser
 *     ESCONDIDA da lista: esconder é não oferecer aos outros motivos, não é
 *     apagar o dado de quem já a usa.
 */
import { describe, expect, it } from "vitest";

import { applyFilters } from "@/lib/kanban/filters";
import { SEM_CATEGORIA, categoriaDoMotivo } from "@/lib/leads/motivos-de-perda-do-funil";
import type { Lead } from "@/lib/types/leads";

const SETTINGS = {
  lost_reasons: [
    "É fornecedor",
    { label: "Possível fraude", categoria: "Risco" },
    { label: "Sem perfil", categoria: "Mérito" },
  ],
  // "Mérito" foi escondida da lista, mas o motivo continua sendo dela.
  lost_reason_categories: ["Cliente", "Risco"],
};

const contexto = { categoriaDo: (motivo: string) => categoriaDoMotivo(motivo, SETTINGS) };

const perda = (id: string, lost_reason: string | null) =>
  ({
    id,
    status: "lost",
    lost_reason,
    tags: [],
    stage_id: "e1",
    owner_user_id: null,
    owner_agent_id: null,
    expected_close_date: null,
    created_at: "2026-01-01T00:00:00.000Z",
  }) as unknown as Lead;

const leads = [
  perda("sem-motivo", null),
  perda("fornecedor", "É fornecedor"),
  perda("fraude", "Possível fraude"),
  perda("perfil", "Sem perfil"),
];

const filtrar = (lostCategory: string) =>
  applyFilters(leads, { lostCategory } as Parameters<typeof applyFilters>[1], contexto).map(
    (l) => l.id,
  );

describe("filtro por categoria de perda (#4437)", () => {
  it("categoria do funil acha os motivos dela", () => {
    expect(filtrar("Risco")).toEqual(["fraude"]);
  });

  it("categoria ESCONDIDA continua achando quem já é dela", () => {
    // "Mérito" saiu de `lost_reason_categories`, mas o motivo segue "Mérito":
    // esconder não pode cegar o recorte de quem já estava no balde.
    expect(filtrar("Mérito")).toEqual(["perfil"]);
  });

  it("«Sem categoria» acha exatamente os motivos sem categoria — e nada mais", () => {
    // Card sem motivo nenhum NÃO é "sem categoria": ele não tem perda
    // registrada, e misturar os dois faria o balde mentir no relatório.
    expect(filtrar(SEM_CATEGORIA)).toEqual(["fornecedor"]);
  });

  it("categoria que ninguém usa devolve vazio, sem cair no balde dos sem categoria", () => {
    expect(filtrar("Cliente")).toEqual([]);
    expect(filtrar("Concorrência")).toEqual([]);
  });

  it("motivo só com espaços é «sem motivo», não «sem categoria» — e o balde não o inventa", () => {
    // `trim` é a mesma régua do save: um motivo em branco não é um motivo. Ele
    // cai no balde de "sem dado", não no de "sem categoria" — misturar os dois
    // faria o relatório contar duas vezes a mesma ausência.
    expect(
      applyFilters(
        [perda("vazio", "   ")],
        { lostCategory: SEM_CATEGORIA } as Parameters<typeof applyFilters>[1],
        contexto,
      ).map((l) => l.id),
    ).toEqual([]);
  });

  it("sem contexto ninguém casa por categoria de NEGÓCIO — e o balde vazio continua honesto", () => {
    // Sem a configuração do funil não há categoria nenhuma; o sentinela então
    // pega todo motivo existente (menos o negócio SEM motivo, que é outro caso).
    expect(
      applyFilters(leads, { lostCategory: "Risco" } as Parameters<typeof applyFilters>[1]).length,
    ).toBe(0);
    expect(
      applyFilters(
        leads,
        { lostCategory: SEM_CATEGORIA } as Parameters<typeof applyFilters>[1],
      ).map((l) => l.id),
    ).toEqual(["fornecedor", "fraude", "perfil"]);
  });
});
