import { describe, expect, it } from "vitest";

import {
  classificarInbound,
  detectarDesvio,
  ehAcenoOuSilencio,
  normalizarValorDoCampo,
  perguntaSaiuNosTextos,
  valorBateComTipo,
  type CampoPendenteParaCaptura,
} from "./captura-do-fluxo";

const campo = (
  type: CampoPendenteParaCaptura["type"],
  extra: Partial<CampoPendenteParaCaptura> = {},
): CampoPendenteParaCaptura => ({ key: "campo", label: "Campo", type, ...extra });

describe("normalizarValorDoCampo", () => {
  it("normaliza data BR para AAAA-MM-DD", () => {
    const r = normalizarValorDoCampo(
      campo("date", { key: "nascimento", label: "Data de nascimento" }),
      "nasci em 10/05/1990",
      { exigirContexto: false },
    );
    expect(r).toEqual({ key: "nascimento", valor: "1990-05-10", bruto: "nasci em 10/05/1990" });
  });

  it("normaliza data ISO", () => {
    const r = normalizarValorDoCampo(campo("date"), "1990-05-10", { exigirContexto: false });
    expect(r?.valor).toBe("1990-05-10");
  });

  it("número com pista de ano exige faixa plausível", () => {
    const c = campo("number", { key: "ano", label: "Ano da moto" });
    expect(normalizarValorDoCampo(c, "2020", { exigirContexto: false })?.valor).toBe("2020");
    expect(normalizarValorDoCampo(c, "24", { exigirContexto: false })).toBeNull();
  });

  it("número entende 'mil'", () => {
    const c = campo("number", { key: "km", label: "Km rodados" });
    expect(normalizarValorDoCampo(c, "rodei 50 mil", { exigirContexto: false })?.valor).toBe("50000");
  });

  it("booleano captura sim e não curtos", () => {
    const c = campo("boolean", { key: "cnh", label: "CNH" });
    expect(normalizarValorDoCampo(c, "tenho cnh", { exigirContexto: false })?.valor).toBe("true");
    expect(normalizarValorDoCampo(c, "não tenho cnh", { exigirContexto: false })?.valor).toBe("false");
  });

  it("booleano NÃO captura mensagem longa sem contexto", () => {
    const c = campo("boolean", { key: "cnh", label: "CNH" });
    expect(
      normalizarValorDoCampo(c, "tenho interesse em uma moto", { exigirContexto: false }),
    ).toBeNull();
  });

  it("booleano NÃO captura 'tenho interesse' nem com contexto frouxo (caso real 2026-09-18)", () => {
    // No teste ao vivo, "tenho interesse em comprar uma moto" foi gravado como
    // `true` no campo CNH — "tenho" estava na lista positiva sem exigir o rótulo.
    // A mensagem é de ABERTURA, não resposta a sim/não.
    const c = campo("boolean", { key: "cnh", label: "CNH" });
    expect(
      normalizarValorDoCampo(c, "tenho interesse em comprar uma moto", { exigirContexto: false }),
    ).toBeNull();
    // Com o rótulo presente, "tenho cnh" continua capturando (controle).
    expect(normalizarValorDoCampo(c, "tenho cnh", { exigirContexto: false })?.valor).toBe("true");
  });

  it("select casa a opção", () => {
    const c = campo("select", {
      key: "pagamento",
      label: "Forma de pagamento",
      options: ["Financiamento", "À vista"],
    });
    expect(normalizarValorDoCampo(c, "quero financiamento", { exigirContexto: false })?.valor).toBe(
      "Financiamento",
    );
  });

  it("texto livre nunca é capturado por regex", () => {
    expect(normalizarValorDoCampo(campo("text"), "São Paulo", { exigirContexto: false })).toBeNull();
  });
});

describe("classificarInbound", () => {
  it("respondeu quando casa regra", () => {
    const r = classificarInbound(campo("boolean", { key: "cnh", label: "CNH" }), "tenho cnh");
    expect(r.resultado).toBe("respondeu");
  });

  it("desviou quando o cliente pergunta outra coisa", () => {
    const r = classificarInbound(campo("text", { key: "nome", label: "Nome" }), "quanto custa a moto?");
    expect(r.resultado).toBe("desviou");
  });

  it("ignorou em aceno curto", () => {
    expect(classificarInbound(campo("text", { key: "nome", label: "Nome" }), "ok").resultado).toBe(
      "ignorou",
    );
    expect(classificarInbound(campo("text", { key: "nome", label: "Nome" }), "👍").resultado).toBe(
      "ignorou",
    );
  });

  it("nao_identificado em texto substantivo sem regra", () => {
    expect(
      classificarInbound(campo("text", { key: "cidade", label: "Cidade" }), "moro em Campinas").resultado,
    ).toBe("nao_identificado");
  });
});

describe("detectarDesvio / ehAcenoOuSilencio", () => {
  it("detecta pergunta e pedido", () => {
    expect(detectarDesvio("vocês aceitam troca?")).toBe(true);
    expect(detectarDesvio("quero ver o catálogo")).toBe(true);
    expect(detectarDesvio("moro em Campinas")).toBe(false);
  });

  it("aceno inclui vazio e emoji", () => {
    expect(ehAcenoOuSilencio("")).toBe(true);
    expect(ehAcenoOuSilencio("🎉🎉")).toBe(true);
    expect(ehAcenoOuSilencio("blz")).toBe(true);
    expect(ehAcenoOuSilencio("moro em Campinas")).toBe(false);
  });
});

describe("perguntaSaiuNosTextos", () => {
  it("reconhece a pergunta mesmo parafraseada", () => {
    const pergunta = "Qual é o ano da moto?";
    expect(perguntaSaiuNosTextos(pergunta, ["Sobre a moto, me diz o ano dela?"])).toBe(true);
  });

  it("não reconhece quando a pergunta não foi feita", () => {
    expect(perguntaSaiuNosTextos("Qual é o ano da moto?", ["Ótimo, temos várias opções!"])).toBe(false);
  });
});

describe("valorBateComTipo — o flow_collect do modelo respeita o tipo", () => {
  it("number recusa 'ok' e aceita número (bug do teste ao vivo: 'ok' virou troca_ano)", () => {
    const ano = campo("number", { key: "troca_ano", label: "Ano" });
    expect(valorBateComTipo(ano, "ok")).toBe(false);
    expect(valorBateComTipo(ano, "2019")).toBe(true);
    expect(valorBateComTipo(ano, "120.000")).toBe(true);
  });

  it("boolean recusa texto livre e aceita sim/não", () => {
    const doc = campo("boolean", { key: "doc", label: "Documentação" });
    expect(valorBateComTipo(doc, "mais ou menos")).toBe(false);
    expect(valorBateComTipo(doc, "sim")).toBe(true);
    expect(valorBateComTipo(doc, "true")).toBe(true);
  });

  it("select recusa valor fora das opções", () => {
    const c = campo("select", { key: "cor", label: "Cor", options: ["Azul", "Vermelha"] });
    expect(valorBateComTipo(c, "verde")).toBe(false);
    expect(valorBateComTipo(c, "azul")).toBe(true);
  });

  it("text aceita qualquer coisa não-vazia", () => {
    const t = campo("text", { key: "obs", label: "Observação" });
    expect(valorBateComTipo(t, "qualquer coisa")).toBe(true);
    expect(valorBateComTipo(t, "")).toBe(false);
  });
});
