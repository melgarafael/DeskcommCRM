import { describe, expect, it, vi } from "vitest";

import { lerValorDaConversa, trechoSustentaOValor } from "./valor-da-conversa";

const ORG = "11111111-1111-1111-1111-111111111111";
const CONTATO = "33333333-3333-3333-3333-333333333333";

/** Mensagens na ordem do banco: mais nova primeiro (a função inverte). */
function adminCom(mensagens: Array<{ direction: string; body: string | null; media_derived_text?: string | null }>) {
  const filtros: Array<[string, unknown]> = [];
  const construtor = {
    select: () => construtor,
    eq: (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return construtor;
    },
    in: () => construtor,
    order: () => construtor,
    limit: async () => ({
      data: mensagens.map((m) => ({ media_derived_text: null, ...m })),
      error: null,
    }),
  };
  return { admin: { from: () => construtor } as never, filtros };
}

const CONVERSA = [
  { direction: "inbound", body: "fechado, 497 no pix" },
  { direction: "outbound", body: "A Mentoria Speed sai por R$ 497,00 à vista" },
  { direction: "inbound", body: "quanto custa a mentoria?" },
];

describe("trechoSustentaOValor — a guarda contra valor inventado", () => {
  const transcricao = "Cliente: quanto custa?\nAtendente: A Mentoria sai por R$ 1.497,00 à vista";

  it("aceita trecho que existe na conversa e carrega o número", () => {
    expect(trechoSustentaOValor("A Mentoria sai por R$ 1.497,00", transcricao, 1497)).toBe(true);
  });

  it("recusa trecho que não está na conversa (alucinação)", () => {
    expect(trechoSustentaOValor("ficou R$ 1.497,00 no total", transcricao, 1497)).toBe(false);
  });

  it("recusa o décuplo, mesmo com os dígitos todos no trecho (1.497,00 nunca é 14970)", () => {
    expect(trechoSustentaOValor("A Mentoria sai por R$ 1.497,00", transcricao, 14970)).toBe(false);
    expect(trechoSustentaOValor("A Mentoria sai por R$ 1.497,00", transcricao, 149.7)).toBe(false);
  });

  it.each([
    ["fechado em 497 no pix", 497],
    ["fica R$ 497,90", 497.9],
    ["total USD 1,497.00", 1497],
    ["deu 1.497 certinho", 1497],
    ["R$2.350,5 no cartão", 2350.5],
  ])("lê a quantia de %j como %d", (trecho, valor) => {
    expect(trechoSustentaOValor(trecho, `Cliente: ${trecho}`, valor)).toBe(true);
  });
});

describe("lerValorDaConversa", () => {
  it("devolve valor, moeda, produto e trecho quando o valor está dito", async () => {
    const { admin, filtros } = adminCom(CONVERSA);
    const chamarModelo = vi.fn().mockResolvedValue({
      houve_valor: true,
      valor: 497,
      moeda: "brl",
      produto: "Mentoria Speed",
      trecho: "fechado, 497 no pix",
    });

    const r = await lerValorDaConversa(admin, ORG, CONTATO, "BRL", { chamarModelo });

    expect(r).toEqual({
      ok: true,
      valorCentavos: 497_00,
      moeda: "BRL",
      produto: "Mentoria Speed",
      trecho: "fechado, 497 no pix",
    });
    // Organização no filtro: o client é service-role.
    expect(filtros).toContainEqual(["organization_id", ORG]);
    // A transcrição vai em ordem cronológica, da pergunta ao fechamento.
    const transcricao = chamarModelo.mock.calls[0]![0] as string;
    expect(transcricao.indexOf("quanto custa")).toBeLessThan(transcricao.indexOf("fechado"));
  });

  it("valor que não aparece na conversa é recusado, mesmo com o modelo dizendo que achou", async () => {
    const { admin } = adminCom(CONVERSA);
    const chamarModelo = vi.fn().mockResolvedValue({
      houve_valor: true,
      valor: 4970,
      moeda: "BRL",
      produto: null,
      trecho: "fechado, 4970 no pix",
    });

    const r = await lerValorDaConversa(admin, ORG, CONTATO, "BRL", { chamarModelo });

    expect(r.ok).toBe(false);
  });

  it("modelo sem valor → ok:false com motivo legível", async () => {
    const { admin } = adminCom(CONVERSA);
    const chamarModelo = vi.fn().mockResolvedValue({
      houve_valor: false,
      valor: null,
      moeda: null,
      produto: null,
      trecho: null,
    });

    const r = await lerValorDaConversa(admin, ORG, CONTATO, "BRL", { chamarModelo });

    expect(r).toEqual({ ok: false, motivo: "A IA não encontrou o valor da venda dito na conversa." });
  });

  it("falha da IA (orçamento, provedor) nunca lança: vira motivo", async () => {
    const { admin } = adminCom(CONVERSA);
    const chamarModelo = vi.fn().mockRejectedValue(new Error("orçamento mensal de IA atingido"));

    const r = await lerValorDaConversa(admin, ORG, CONTATO, "BRL", { chamarModelo });

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivo).toContain("orçamento mensal de IA atingido");
  });

  it("moeda que não é ISO-4217 cai na moeda do negócio", async () => {
    const { admin } = adminCom(CONVERSA);
    const chamarModelo = vi.fn().mockResolvedValue({
      houve_valor: true,
      valor: 497,
      moeda: "reais",
      produto: null,
      trecho: "fechado, 497 no pix",
    });

    const r = await lerValorDaConversa(admin, ORG, CONTATO, "BRL", { chamarModelo });

    expect(r.ok && r.moeda).toBe("BRL");
  });

  it("áudio transcrito entra na conversa", async () => {
    const { admin } = adminCom([{ direction: "inbound", body: null, media_derived_text: "pode fechar os 300" }]);
    const chamarModelo = vi.fn().mockResolvedValue({
      houve_valor: true,
      valor: 300,
      moeda: "BRL",
      produto: null,
      trecho: "pode fechar os 300",
    });

    const r = await lerValorDaConversa(admin, ORG, CONTATO, "BRL", { chamarModelo });

    expect(r.ok && r.valorCentavos).toBe(300_00);
  });

  it("sem contato ou sem texto, nem chama o modelo", async () => {
    const chamarModelo = vi.fn();
    expect((await lerValorDaConversa(adminCom([]).admin, ORG, null, "BRL", { chamarModelo })).ok).toBe(false);
    expect((await lerValorDaConversa(adminCom([]).admin, ORG, CONTATO, "BRL", { chamarModelo })).ok).toBe(false);
    expect(chamarModelo).not.toHaveBeenCalled();
  });
});
