import { describe, expect, it } from "vitest";

import {
  classificarInbound,
  detectarDesvio,
  ehAcenoOuSilencio,
  normalizarValorDoCampo,
  perguntaSaiuNosTextos,
  valorBateComTipo,
  type CampoPendenteParaCaptura,
  datasDoTexto,
  respostaTemLastro,
  textoCitaAOpcao,
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

describe("tipo cpf (achado 7 da prova do #1130)", () => {
  const cpf = { key: "cpf", label: "CPF", type: "cpf" as const };

  it("CPF válido, com ou sem pontuação, vira só os dígitos", () => {
    expect(classificarInbound(cpf, "529.982.247-25")).toEqual({
      resultado: "respondeu",
      captura: { key: "cpf", valor: "52998224725", bruto: "529.982.247-25" },
    });
    expect(classificarInbound(cpf, "meu cpf 52998224725").resultado).toBe("respondeu");
  });

  it("dígito verificador errado NÃO é resposta (a pergunta segue)", () => {
    expect(classificarInbound(cpf, "123.456.789-00").resultado).not.toBe("respondeu");
    expect(valorBateComTipo(cpf, "12345678900")).toBe(false);
    expect(valorBateComTipo(cpf, "52998224725")).toBe(true);
  });
});

describe("respostaTemLastro", () => {
  const ano = { key: "ano_troca", label: "Ano da moto", type: "number" as const };
  const km = { key: "km", label: "Quilometragem", type: "number" as const };
  const modelo = { key: "modelo", label: "Modelo", type: "select" as const, options: ["CG 160", "Outra"] };
  const nome = { key: "nome", label: "Nome completo", type: "text" as const };
  const cnh = { key: "cnh", label: "Tem CNH", type: "boolean" as const };

  it("select: a opção precisa estar no texto", () => {
    expect(respostaTemLastro(modelo, "Outra", "moto de uns 15 mil", { perguntaAtual: true })).toBe(false);
    expect(respostaTemLastro(modelo, "CG 160", "quero a cg 160", { perguntaAtual: false })).toBe(true);
  });

  it("número: precisa estar no texto; ano só entre 1950 e 2100", () => {
    expect(respostaTemLastro(ano, "125", "tenho uma Honda CG 125", { perguntaAtual: true })).toBe(false);
    expect(respostaTemLastro(ano, "2015", "é 2015", { perguntaAtual: true })).toBe(true);
    expect(respostaTemLastro(km, "120000", "rodou uns 120 mil", { perguntaAtual: true })).toBe(true);
    expect(respostaTemLastro(km, "90000", "rodou uns 120 mil", { perguntaAtual: true })).toBe(false);
  });

  it("texto livre: vale na pergunta feita; em outra, o valor precisa estar no texto", () => {
    expect(respostaTemLastro(nome, "Lia Mendes", "sou a lia mendes", { perguntaAtual: false })).toBe(true);
    expect(respostaTemLastro(nome, "Lia Mendes", "quero financiar", { perguntaAtual: false })).toBe(false);
    expect(respostaTemLastro(nome, "Lia", "Lia", { perguntaAtual: true })).toBe(true);
  });

  it("sim/não fora da pergunta feita precisa citar o assunto", () => {
    expect(respostaTemLastro(cnh, "true", "sim, quero financiar", { perguntaAtual: false })).toBe(false);
    expect(respostaTemLastro(cnh, "true", "tenho cnh sim", { perguntaAtual: false })).toBe(true);
  });
});

describe("revisão adversarial do PR 2", () => {
  it("datasDoTexto lê dd/mm/aaaa, dd-mm-aaaa, aaaa-mm-dd e por extenso", () => {
    expect(datasDoTexto("nasci em 12/03/1990")).toEqual(["1990-03-12"]);
    expect(datasDoTexto("12-03-1990")).toEqual(["1990-03-12"]);
    expect(datasDoTexto("1990-03-12")).toEqual(["1990-03-12"]);
    expect(datasDoTexto("nasci em 12 de março de 1990")).toEqual(["1990-03-12"]);
  });

  it("data com lastro é a MESMA data escrita", () => {
    const nasc = { key: "nascimento", label: "Nascimento", type: "date" as const };
    expect(respostaTemLastro(nasc, "1985-07-20", "nasci em 12/03/1990", { perguntaAtual: true })).toBe(false);
    expect(respostaTemLastro(nasc, "1990-03-12", "nasci em 12/03/1990", { perguntaAtual: true })).toBe(true);
    expect(respostaTemLastro(nasc, "12/03/1990", "nasci em 12 de março de 1990", { perguntaAtual: false })).toBe(true);
  });

  it("opção é PALAVRA inteira; opção de 1–2 letras só vale sozinha", () => {
    expect(textoCitaAOpcao("quero ver outras cores", "Outra")).toBe(false);
    expect(textoCitaAOpcao("vou de outra, então", "Outra")).toBe(true);
    expect(textoCitaAOpcao("quero ver a moto grande", "G")).toBe(false);
    expect(textoCitaAOpcao("G", "G")).toBe(true);
    // Opção "A" (plano A/B) e o artigo "a": palavra inteira não basta.
    expect(textoCitaAOpcao("quero a moto", "A")).toBe(false);
    expect(textoCitaAOpcao("tem tamanho G e M?", "M")).toBe(false);
    const cor = { key: "cor", label: "Cor", type: "select" as const, options: ["Outra", "Azul"] };
    expect(classificarInbound(cor, "quero ver outras cores").resultado).not.toBe("respondeu");
  });

  it('"tenho uns 2 mil de entrada" não é ano 2000', () => {
    const ano = { key: "ano", label: "Ano da moto", type: "number" as const };
    expect(respostaTemLastro(ano, "2000", "tenho uns 2 mil de entrada", { perguntaAtual: true })).toBe(false);
    expect(classificarInbound(ano, "uns 2 mil").resultado).not.toBe("respondeu");
    expect(respostaTemLastro(ano, "2000", "é uma 2000", { perguntaAtual: true })).toBe(true);
  });
});

