/**
 * O lado TS da regra do doc 146 (opção B) que as telas de cadastro usam: o
 * Google some (e o seletor é obrigatório) exatamente quando o gatilho da 0679
 * recusaria um cadastro sem escolha. O lado do banco é
 * `tests/invariants/cobranca-entrada-paga-na-criacao.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ ligado: vi.fn(async () => true) }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: h.ligado }));

import { lerCadastroNaTela, planoInicialDoSeletor, planosNaMoedaDoLink, type PlanoDoCadastro } from "./cadastro";

const plano = (id: string): PlanoDoCadastro => ({ id, nome: id, preco_cents: 4990, moeda: "BRL", intervalo: "mes", trial_dias: 7 });

function banco(p: { oferecidos: PlanoDoCadastro[]; padrao: string | null; erro?: boolean }) {
  return {
    from: () => {
      const q = {
        select: () => q,
        is: () => q,
        eq: () => q,
        order: async () => (p.erro ? { data: null, error: { code: "57014" } } : { data: p.oferecidos, error: null }),
        maybeSingle: async () => ({ data: p.padrao ? { id: p.padrao } : null, error: null }),
      };
      return q;
    },
  } as never;
}

beforeEach(() => h.ligado.mockResolvedValue(true));

describe("lerCadastroNaTela — quando o Google some", () => {
  it("⭐ sem plano nenhum (nem padrão, nem oferecido): nada a escolher e o Google fica — a empresa nasce isenta", async () => {
    expect(await lerCadastroNaTela(banco({ oferecidos: [], padrao: null }))).toEqual({ oferecidos: [], padraoId: null, exigeEscolha: false });
  });

  it("⭐ plano oferecido e sem padrão: o Google some e a escolha é obrigatória", async () => {
    expect((await lerCadastroNaTela(banco({ oferecidos: [plano("a")], padrao: null }))).exigeEscolha).toBe(true);
  });

  it("⭐ com padrão: o Google fica (a empresa dele nasce no padrão)", async () => {
    expect((await lerCadastroNaTela(banco({ oferecidos: [plano("a")], padrao: "p" }))).exigeEscolha).toBe(false);
  });

  it("cobrança desligada, ou leitura que falha: a tela não esconde nem exige nada (quem recusa é a action)", async () => {
    expect((await lerCadastroNaTela(banco({ oferecidos: [plano("a")], padrao: null, erro: true }))).exigeEscolha).toBe(false);
    h.ligado.mockResolvedValue(false);
    expect((await lerCadastroNaTela(banco({ oferecidos: [plano("a")], padrao: null }))).exigeEscolha).toBe(false);
  });
});

describe("planoInicialDoSeletor", () => {
  it("vem marcado o PADRÃO quando ele é oferecido — não o mais barato", () => {
    expect(planoInicialDoSeletor([plano("barato"), plano("padrao")], "padrao")).toBe("padrao");
  });
  it("padrão fora dos oferecidos (ou sem padrão): o primeiro", () => {
    expect(planoInicialDoSeletor([plano("barato"), plano("outro")], "negociado")).toBe("barato");
    expect(planoInicialDoSeletor([], null)).toBeUndefined();
  });
});

describe("planosNaMoedaDoLink — a moeda que o link pede (migration 9332)", () => {
  const brl = { ...plano("brl"), moeda: "BRL" };
  const usd = { ...plano("usd"), moeda: "USD" };
  const eur = { ...plano("eur"), moeda: "EUR" };
  const todos = [brl, usd, eur];

  it("sem pedido, a lista inteira, como sempre", () => {
    expect(planosNaMoedaDoLink(todos, {})).toEqual(todos);
  });
  it("?moeda= filtra, sem caixa e com espaços", () => {
    expect(planosNaMoedaDoLink(todos, { moeda: " usd " })).toEqual([usd]);
  });
  it("?plano= decide pela moeda do plano escolhido", () => {
    expect(planosNaMoedaDoLink(todos, { plano: "eur" })).toEqual([eur]);
  });
  it("?moeda= vence o ?plano=, e moeda sem plano oferecido não esvazia a lista", () => {
    expect(planosNaMoedaDoLink(todos, { moeda: "BRL", plano: "eur" })).toEqual([brl]);
    expect(planosNaMoedaDoLink(todos, { moeda: "JPY" })).toEqual(todos);
    expect(planosNaMoedaDoLink(todos, { moeda: ["USD", "EUR"] })).toEqual([usd]);
  });
});
