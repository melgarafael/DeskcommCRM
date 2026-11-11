/**
 * A COBRANÇA AVULSA DO NEGÓCIO — a parte que decide sem banco (issue #4058,
 * migration 9345).
 *
 * O que NÃO se mede aqui, de propósito: isolamento entre tenants e a regra de
 * que "paga" é do servidor. As duas moram no banco (RLS + gatilhos) e a prova
 * delas é `tests/invariants/cobranca-avulsa-do-negocio.test.ts`, com duas
 * organizações de verdade. Este arquivo mede só o que é cálculo e validação.
 */

import { describe, expect, it } from "vitest";

import {
  DESCRICAO_MAXIMA,
  conferirCobranca,
  estadoExibido,
  hojeDaEmpresa,
} from "@/lib/cobranca/avulsa";

const LEAD = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const AUTOR = "44444444-4444-4444-8444-444444444444";

describe("conferirCobranca — o payload que a rota manda para o banco", () => {
  it("negócio como âncora: nasce pendente, em BRL, sem vencimento", () => {
    const r = conferirCobranca({
      descricao: "Entrada do projeto de identidade visual",
      valorCents: 150000,
      leadId: LEAD,
    });

    expect(r).toEqual({
      ok: true,
      cobranca: {
        descricao: "Entrada do projeto de identidade visual",
        valor_cents: 150000,
        moeda: "BRL",
        vencimento: null,
        estado: "pendente",
        lead_id: LEAD,
        conversation_id: null,
        contact_id: null,
        created_by_user_id: null,
      },
    });
  });

  it("a CONVERSA sozinha é âncora válida: é ela que dá o canal do envio", () => {
    const r = conferirCobranca({
      descricao: "Sinal do orçamento 118",
      valorCents: 5000,
      conversationId: CONVERSA,
      contactId: CONTATO,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cobranca.conversation_id).toBe(CONVERSA);
    expect(r.cobranca.lead_id).toBeNull();
    expect(r.cobranca.contact_id).toBe(CONTATO);
  });

  it("sem negócio E sem conversa: recusa — cobrança sem âncora ninguém sabe de quem é", () => {
    const r = conferirCobranca({
      descricao: "Consulta avulsa",
      valorCents: 20000,
      contactId: CONTATO,
    });

    expect(r).toEqual({ ok: false, motivo: "sem_ancora" });
  });

  it("descrição só com espaço, ou acima do teto, é descrição vazia", () => {
    expect(conferirCobranca({ descricao: "   ", valorCents: 100, leadId: LEAD })).toEqual({
      ok: false,
      motivo: "descricao_vazia",
    });
    expect(
      conferirCobranca({
        descricao: "x".repeat(DESCRICAO_MAXIMA + 1),
        valorCents: 100,
        leadId: LEAD,
      }),
    ).toEqual({ ok: false, motivo: "descricao_vazia" });
  });

  it("a descrição vai APARADA — o espaço do formulário não vira parte do dado", () => {
    const r = conferirCobranca({ descricao: "  Mensalidade  ", valorCents: 9900, leadId: LEAD });
    expect(r.ok && r.cobranca.descricao).toBe("Mensalidade");
  });

  it("valor: zero, negativo, fracionado e não-número são o MESMO defeito", () => {
    for (const valorCents of [0, -1, 10.5, Number.NaN, Number.MAX_SAFE_INTEGER + 10]) {
      expect(conferirCobranca({ descricao: "x", valorCents, leadId: LEAD })).toEqual({
        ok: false,
        motivo: "valor_invalido",
      });
    }
  });

  it("moeda: moeda não é maiúscula de três letras", () => {
    for (const moeda of ["brl", "BR", "BRLX", "", "R$"]) {
      expect(conferirCobranca({ descricao: "x", valorCents: 100, leadId: LEAD, moeda })).toEqual({
        ok: false,
        motivo: "moeda_invalida",
      });
    }
  });

  it("vencimento: 30 de fevereiro casa o formato e não existe no calendário", () => {
    for (const vencimento of ["2026-02-30", "07/11/2026", "2026-11-7", "2026-13-01"]) {
      expect(
        conferirCobranca({ descricao: "x", valorCents: 100, leadId: LEAD, vencimento }),
      ).toEqual({ ok: false, motivo: "vencimento_invalido" });
    }
    expect(
      conferirCobranca({ descricao: "x", valorCents: 100, leadId: LEAD, vencimento: "2026-02-28" })
        .ok,
    ).toBe(true);
  });

  it("id que não é UUID vira recusa na rota, não 22P02 no Postgres", () => {
    expect(conferirCobranca({ descricao: "x", valorCents: 100, leadId: "123" })).toEqual({
      ok: false,
      motivo: "id_invalido",
    });
  });
});

describe("estadoExibido — 'vencida' é derivada, nunca gravada", () => {
  const HOJE = "2026-11-07";

  it("pendente com vencimento no passado aparece vencida", () => {
    expect(estadoExibido({ estado: "pendente", vencimento: "2026-11-06" }, HOJE)).toBe("vencida");
  });

  it("vencimento HOJE ainda não vence: o cliente tem o dia inteiro", () => {
    expect(estadoExibido({ estado: "pendente", vencimento: HOJE }, HOJE)).toBe("pendente");
  });

  it("sem vencimento combinado não existe atraso", () => {
    expect(estadoExibido({ estado: "pendente", vencimento: null }, HOJE)).toBe("pendente");
  });

  it("paga e cancelada NÃO viram vencida, mesmo com vencimento no passado", () => {
    expect(estadoExibido({ estado: "paga", vencimento: "2020-01-01" }, HOJE)).toBe("paga");
    expect(estadoExibido({ estado: "cancelada", vencimento: "2020-01-01" }, HOJE)).toBe("cancelada");
  });

  it("a virada do ano é comparação de data, não de instante", () => {
    expect(estadoExibido({ estado: "pendente", vencimento: "2026-12-31" }, "2027-01-01")).toBe(
      "vencida",
    );
    expect(estadoExibido({ estado: "pendente", vencimento: "2027-01-01" }, "2026-12-31")).toBe(
      "pendente",
    );
  });
});

describe("hojeDaEmpresa — o 'hoje' é o da empresa, não o do servidor", () => {
  it("1h de 08/11 em UTC ainda é 07/11 em São Paulo", () => {
    const agora = new Date("2026-11-08T01:00:00Z");
    expect(hojeDaEmpresa("America/Sao_Paulo", agora)).toBe("2026-11-07");
    expect(hojeDaEmpresa("UTC", agora)).toBe("2026-11-08");
  });

  it("fuso ilegível cai no padrão em vez de derrubar o cálculo", () => {
    const agora = new Date("2026-11-08T01:00:00Z");
    expect(hojeDaEmpresa("Fuso/Que_Nao_Existe", agora)).toBe("2026-11-07");
    expect(hojeDaEmpresa(null, agora)).toBe("2026-11-07");
  });
});
