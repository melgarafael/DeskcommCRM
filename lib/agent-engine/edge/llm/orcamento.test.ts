import { describe, expect, it, vi } from "vitest";

import {
  decidirTetoDoPlano,
  lerTetoDoPlano,
  PURPOSES_ISENTOS,
  SQL_TETO_DO_PLANO,
} from "./orcamento";

/**
 * O TETO DE IA DO PLANO (spec da cobrança do revendedor §5, decisão D-9).
 *
 * É o bolso do DONO da instalação, e não a escolha da organização
 * (`ai_budgets`): por isso o `modo 'off'` da org não o desliga, e só a chave da
 * instalação o consulta — a chamada com chave própria é paga pela empresa.
 * As decisões do orçamento da org moram em `tests/unit/orcamento-decisao.test.ts`.
 */
const ESTOURADO = {
  tetoUsdCents: 1000,
  gastoUsdCents: 1000,
  origemDaChave: "chave_da_instalacao",
  purpose: "agent_turn",
  chave: "on",
} as const;

describe("decidirTetoDoPlano", () => {
  it("⭐ gasto ≥ teto com a chave da instalação BLOQUEIA", () => {
    expect(decidirTetoDoPlano(ESTOURADO)).toEqual({ acao: "bloquear", porque: "teto_do_plano" });
  });

  it("BYOK nunca bloqueia — a chave própria é paga pela empresa", () => {
    expect(decidirTetoDoPlano({ ...ESTOURADO, origemDaChave: "credencial_da_organizacao" })).toEqual({
      acao: "seguir",
      porque: "chave_da_organizacao",
    });
  });

  it.each(PURPOSES_ISENTOS)("purpose isento %s segue — diagnóstico e guardrail não são cortados", (purpose) => {
    expect(decidirTetoDoPlano({ ...ESTOURADO, purpose }).acao).toBe("seguir");
  });

  it("a chave de emergência 'off' desliga o teto do plano (D-9)", () => {
    expect(decidirTetoDoPlano({ ...ESTOURADO, chave: "off" })).toEqual({
      acao: "seguir",
      porque: "chave_de_emergencia",
    });
  });

  it("a chave 'avisar' NÃO afrouxa o teto do plano — só o 'off' é o interruptor do dono (decisão do dono, 30/09)", () => {
    expect(decidirTetoDoPlano({ ...ESTOURADO, chave: "avisar" }).acao).toBe("bloquear");
  });

  it("sem teto (cobrança desligada, org isenta, plano sem teto) segue", () => {
    expect(decidirTetoDoPlano({ ...ESTOURADO, tetoUsdCents: null }).porque).toBe("sem_teto");
  });

  it("um centavo abaixo do teto segue", () => {
    expect(decidirTetoDoPlano({ ...ESTOURADO, gastoUsdCents: 999 }).porque).toBe("abaixo_do_teto");
  });
});

describe("lerTetoDoPlano", () => {
  const ORG = "33333333-3333-4333-8333-333333333333";

  it("pergunta ao statement com o recurso ia_usd_cents e coage o numeric do node-pg", async () => {
    const query = vi.fn(async () => ({ rows: [{ teto: 1000, gasto: "1500.0000" }] }));
    expect(await lerTetoDoPlano({ query } as never, ORG)).toEqual({ tetoUsdCents: 1000, gastoUsdCents: 1500 });
    expect(query).toHaveBeenCalledWith(SQL_TETO_DO_PLANO, [ORG, "ia_usd_cents"]);
  });

  it("sem teto devolve null e gasto 0 — o statement nem somou", async () => {
    const query = vi.fn(async () => ({ rows: [{ teto: null, gasto: null }] }));
    expect(await lerTetoDoPlano({ query } as never, ORG)).toEqual({ tetoUsdCents: null, gastoUsdCents: 0 });
  });

  it("⭐ erro de banco NUNCA lança: vira 'indisponível' com o SQLSTATE", async () => {
    const query = vi.fn(async () => {
      throw Object.assign(new Error("function public.fn_limite_do_plano(uuid, text) does not exist"), {
        code: "42883",
      });
    });
    const lido = await lerTetoDoPlano({ query } as never, ORG);
    expect(lido).toEqual({ indisponivel: expect.stringMatching(/^42883: function public\.fn_limite_do_plano/) });
  });

  it("o statement só soma o gasto quando há teto", () => {
    expect(SQL_TETO_DO_PLANO).toMatch(/case when teto is null then null else public\.fn_gasto_de_ia_do_mes\(\$1\) end/);
  });
});
