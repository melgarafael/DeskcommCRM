/**
 * O RASCUNHO GUARDADO ENTRE OS DADOS (B1). A prévia que a pessoa revisou vai
 * para o modelo como CONTEÚDO — dentro da cerca de nonce, nunca como ordem — e
 * com TETO PRÓPRIO: 1200 caracteres (uma mensagem de WhatsApp revisada cabe),
 * contra os 500 dos outros campos. Acima disso ela é descartada INTEIRA em vez
 * de truncada: rascunho cortado no meio ensina o modelo a escrever cortado.
 *
 * 500 num rascunho de 800 era o defeito silencioso: o campo existia, chegava
 * mutilado e ninguém veria — o modelo só escreveria pior.
 */
import { describe, expect, it } from "vitest";
import { blocoDeModo, formatarDados } from "@/lib/agent-engine/agent/abordagem-de-formulario";
import { montarDadosDeAbordagem } from "@/lib/prospecting/estrategia-site";
import type { PreviaSalva } from "@/lib/prospecting/previa";

const BASE = {
  name: "Vitta",
  category: "Estética",
  address: "Rua X",
  website: null,
  rating: 5,
  socials: [],
};
const SITE_DEFINITIVO = {
  classe: "sem-site" as const,
  problemas: [] as string[],
  conteudo_resumo: null,
  provisorio: false,
  verificado_em: "2026-10-10T12:00:00.000Z",
};

function previaCom(texto: string): PreviaSalva {
  return {
    texto,
    baseada_em: "sem-site@derivado",
    gerada_em: "2026-10-11T09:00:00.000Z",
    agente_id: "11111111-1111-4111-8111-111111111111",
  };
}

describe("a prévia guardada entra nos dados e tem teto próprio", () => {
  it("E) o rascunho entra como campo e sobrevive até 1200 caracteres", () => {
    const texto = "a".repeat(800);
    const dados = montarDadosDeAbordagem(BASE, SITE_DEFINITIVO, previaCom(texto));
    expect(dados["Rascunho de abordagem"]).toBe(texto);
    const formatado = formatarDados(dados);
    expect(formatado, "o rascunho não pode ser cortado em 500").toContain(texto);
  });

  it("E) o rascunho ACIMA de 1200 é descartado inteiro, não truncado", () => {
    const grande = "z".repeat(1201);
    const dados = montarDadosDeAbordagem(BASE, SITE_DEFINITIVO, previaCom(grande));
    expect(dados["Rascunho de abordagem"]).toBe(grande);
    const formatado = formatarDados(dados);
    expect(formatado).not.toContain("Rascunho de abordagem");
    // e os outros campos do candidato continuam lá — descartar o rascunho não
    // apaga o resto da mensagem ao modelo.
    expect(formatado).toContain("- Empresa: Vitta");
  });

  it("E) exatamente 1200 passa; 1201 não", () => {
    const exato = "q".repeat(1200);
    expect(formatarDados({ "Rascunho de abordagem": exato })).toContain(exato);
    expect(
      formatarDados({ "Rascunho de abordagem": "q".repeat(1201) }),
    ).toBe("(o formulário não trouxe nenhum campo além do contato)");
  });

  it("E) os OUTROS campos continuam com teto de 500", () => {
    const longo = "y".repeat(900);
    expect(formatarDados({ Empresa: longo })).toBe(`- Empresa: ${"y".repeat(500)}`);
  });

  it("sem prévia, nenhum campo de rascunho aparece", () => {
    const dados = montarDadosDeAbordagem(BASE, SITE_DEFINITIVO, null);
    expect(dados["Rascunho de abordagem"]).toBeUndefined();
  });

  it("o prompt do ramo frio ganha a regra do rascunho guardado — e só ele", () => {
    const frio = blocoDeModo("prospeccao_fria", "abcd1234", "Ofereça uma conversa.");
    expect(frio).toMatch(/Rascunho de abordagem/);
    expect(frio, "o rascunho é conteúdo, não ordem").toMatch(/não como instrução/i);
    // A prévia pode ter saído do preparo automático sem ninguém a ler: o modelo
    // não pode recebê-la como texto revisado por uma pessoa.
    const regra = frio.split("\n").find((l) => l.includes("Rascunho de abordagem")) ?? "";
    expect(regra).toMatch(/pode não ter sido revisada/i);
    expect(regra).toMatch(/mesma confiança dos outros dados/i);
    expect(regra).not.toMatch(/operador|revisou/i);
    // Os outros ramos não recebem regra de rascunho: eles não têm prévia.
    expect(blocoDeModo("formulario", "abcd1234", "x")).not.toContain("Rascunho de abordagem");
    expect(blocoDeModo("automacao", "abcd1234", "x")).not.toContain("Rascunho de abordagem");
  });
});
