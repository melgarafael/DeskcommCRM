import { describe, expect, it } from "vitest";

import { aplicarEdicaoNoPrompt, explicarRecusa, PROMPT_MAX } from "./editar-prompt";

const BASE = "Você é o atendente da loja.\nResponda em português.\nNunca invente preço.";

describe("aplicarEdicaoNoPrompt", () => {
  it("troca um trecho que aparece uma vez e diz quantas trocas fez", () => {
    const r = aplicarEdicaoNoPrompt(BASE, {
      substituicoes: [{ procurar: "Responda em português.", substituir_por: "Responda no idioma do cliente." }],
    });
    expect(r).toEqual({
      ok: true,
      texto: "Você é o atendente da loja.\nResponda no idioma do cliente.\nNunca invente preço.",
      aplicadas: [{ procurar: "Responda em português.", ocorrencias: 1 }],
    });
  });

  it("recusa trecho que não existe — nada é gravado no lugar errado", () => {
    const r = aplicarEdicaoNoPrompt(BASE, { substituicoes: [{ procurar: "Responda em inglês.", substituir_por: "x" }] });
    expect(r).toMatchObject({ ok: false, motivo: "trecho_nao_encontrado" });
  });

  it("recusa trecho repetido sem `todas`, e troca todos com `todas`", () => {
    const texto = "Diga oi. Diga oi. Fim do texto aqui.";
    expect(aplicarEdicaoNoPrompt(texto, { substituicoes: [{ procurar: "Diga oi.", substituir_por: "Olá." }] })).toMatchObject({
      ok: false,
      motivo: "trecho_repetido",
      ocorrencias: 2,
    });
    expect(
      aplicarEdicaoNoPrompt(texto, { substituicoes: [{ procurar: "Diga oi.", substituir_por: "Olá.", todas: true }] }),
    ).toMatchObject({ ok: true, texto: "Olá. Olá. Fim do texto aqui.", aplicadas: [{ ocorrencias: 2 }] });
  });

  it("o texto novo com $& e $1 entra literal, sem virar padrão de substituição", () => {
    const r = aplicarEdicaoNoPrompt(BASE, {
      substituicoes: [{ procurar: "Nunca invente preço.", substituir_por: "Preço: $& e $1 são literais." }],
    });
    expect(r.ok && r.texto.endsWith("Preço: $& e $1 são literais.")).toBe(true);
  });

  it("anexa no fim com uma linha em branco", () => {
    const r = aplicarEdicaoNoPrompt(BASE, { anexar_ao_final: "Se pedirem desconto, ofereça frete grátis." });
    expect(r.ok && r.texto).toBe(`${BASE}\n\nSe pedirem desconto, ofereça frete grátis.`);
  });

  it("recusa misturar texto inteiro com edição por pedaço, e pedido vazio", () => {
    expect(aplicarEdicaoNoPrompt(BASE, { novo_prompt: "Novo texto inteiro aqui.", anexar_ao_final: "x" })).toMatchObject({
      ok: false,
      motivo: "modos_misturados",
    });
    expect(aplicarEdicaoNoPrompt(BASE, {})).toMatchObject({ ok: false, motivo: "pedido_vazio" });
  });

  it("recusa passar do limite de tamanho da tela, com o tamanho na explicação", () => {
    const quaseCheio = "a".repeat(PROMPT_MAX - 20);
    const r = aplicarEdicaoNoPrompt(quaseCheio, { anexar_ao_final: "Uma regra nova que não cabe mais no texto." });
    expect(r).toMatchObject({ ok: false, motivo: "tamanho_invalido" });
    if (!r.ok) expect(explicarRecusa(r)).toContain(String(PROMPT_MAX));
  });

  it("recusa a edição que não muda nada", () => {
    expect(aplicarEdicaoNoPrompt(BASE, { novo_prompt: BASE })).toMatchObject({ ok: false, motivo: "sem_mudanca" });
  });
});
