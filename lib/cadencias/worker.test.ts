import { describe, expect, it } from "vitest";

import { assuntoDaResposta, avaliarRamo, type InscricaoRow } from "./worker";
import type { Passo } from "./tipos";

function inscricao(over: Partial<InscricaoRow> = {}): InscricaoRow {
  return {
    id: "insc-1",
    organization_id: "org-1",
    cadence_id: "cad-1",
    lead_id: "lead-1",
    contact_id: "contact-1",
    passo_atual_id: null,
    ultimo_email_em: null,
    ultimo_email_passo_id: null,
    aberturas: 0,
    emails_enviados: 0,
    tentativas: 0,
    inscrito_por: "user-1",
    ...over,
  };
}

const ramoAbriu = (vezes: number, dentroDeDias: number): Extract<Passo, { tipo: "ramo" }> => ({
  id: "r1",
  tipo: "ramo",
  condicao: { tipo: "abriu", vezes, dentroDeDias },
  sim: [],
  nao: [],
});

const ramoClicou = (dentroDeDias: number): Extract<Passo, { tipo: "ramo" }> => ({
  id: "r1",
  tipo: "ramo",
  condicao: { tipo: "clicou", dentroDeDias },
  sim: [],
  nao: [],
});

describe("avaliarRamo — condição abriu", () => {
  it("já atingiu o número de aberturas: vai pro sim, mesmo dentro do prazo", () => {
    const agora = new Date("2026-01-10T12:00:00Z");
    const insc = inscricao({ aberturas: 3, ultimo_email_em: "2026-01-09T12:00:00Z" });
    expect(avaliarRamo(ramoAbriu(2, 5), insc, agora)).toBe(true);
  });

  it("ainda não atingiu e o prazo não venceu: aguarda (null)", () => {
    const agora = new Date("2026-01-10T12:00:00Z");
    const insc = inscricao({ aberturas: 0, ultimo_email_em: "2026-01-09T12:00:00Z" }); // 1 dia atrás, prazo 5 dias
    expect(avaliarRamo(ramoAbriu(2, 5), insc, agora)).toBeNull();
  });

  it("prazo venceu sem atingir: vai pro não", () => {
    const agora = new Date("2026-01-20T12:00:00Z");
    const insc = inscricao({ aberturas: 1, ultimo_email_em: "2026-01-09T12:00:00Z" }); // 11 dias atrás, prazo 5
    expect(avaliarRamo(ramoAbriu(2, 5), insc, agora)).toBe(false);
  });

  it("sem e-mail enviado ainda: decide na hora (não, nunca sim sem dado)", () => {
    const agora = new Date("2026-01-10T12:00:00Z");
    const insc = inscricao({ aberturas: 0, ultimo_email_em: null });
    expect(avaliarRamo(ramoAbriu(1, 5), insc, agora)).toBe(false);
  });
});

describe("avaliarRamo — condição clicou/respondeu (sem fonte de dado)", () => {
  it("nunca resolve pra sim, mesmo aguardando — só aguarda ou cai em não", () => {
    const dentroDoPrazo = new Date("2026-01-10T12:00:00Z");
    const insc = inscricao({ ultimo_email_em: "2026-01-09T12:00:00Z" });
    expect(avaliarRamo(ramoClicou(5), insc, dentroDoPrazo)).toBeNull();

    const depoisDoPrazo = new Date("2026-01-20T12:00:00Z");
    expect(avaliarRamo(ramoClicou(5), insc, depoisDoPrazo)).toBe(false);
  });
});

describe("assuntoDaResposta", () => {
  it("sem passo anterior: 'Re:' genérico", () => {
    expect(assuntoDaResposta([], null)).toBe("Re:");
  });

  it("acha o assunto do passo anterior e prefixa Re:", () => {
    const passos: Passo[] = [
      { id: "e1", tipo: "email", assunto: "Uma ideia para a {{empresa}}", corpo: "x", mesmaConversa: false },
    ];
    expect(assuntoDaResposta(passos, "e1")).toBe("Re: Uma ideia para a {{empresa}}");
  });

  it("passo anterior sem assunto (também é resposta): cai no genérico", () => {
    const passos: Passo[] = [{ id: "e1", tipo: "email", assunto: "", corpo: "x", mesmaConversa: true }];
    expect(assuntoDaResposta(passos, "e1")).toBe("Re:");
  });
});
