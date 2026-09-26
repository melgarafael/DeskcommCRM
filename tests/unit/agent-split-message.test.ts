// tests/unit/agent-split-message.test.ts
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

import { instrucaoDeBolhas, splitIntoBubbles } from "@/lib/agent-engine/agent/split-message";

describe("splitIntoBubbles", () => {
  it("texto curto vira uma bolha só (trim)", () => {
    expect(splitIntoBubbles("  Olá, tudo bem?  ", 600)).toEqual(["Olá, tudo bem?"]);
  });
  it("vazio/whitespace → []", () => {
    expect(splitIntoBubbles("", 600)).toEqual([]);
    expect(splitIntoBubbles("   \n  ", 600)).toEqual([]);
  });
  it("quebra por parágrafo quando cabe", () => {
    const out = splitIntoBubbles("Primeiro parágrafo.\n\nSegundo parágrafo.", 30);
    expect(out).toEqual(["Primeiro parágrafo.", "Segundo parágrafo."]);
  });
  it("nenhuma bolha excede maxChars (quebra por sentença)", () => {
    const text = "Oi! Como você está hoje? Queria falar do seu pedido. Ele já saiu para entrega.";
    const out = splitIntoBubbles(text, 30);
    expect(out.every((b) => b.length <= 30)).toBe(true);
    expect(out.join(" ")).toContain("pedido");
  });
  it("junta sentenças curtas adjacentes até o teto", () => {
    const out = splitIntoBubbles("Oi. Tudo bem? Beleza.", 100);
    expect(out).toHaveLength(1); // tudo cabe em 100
  });
  it("palavra única maior que o teto vai sozinha (não corta no meio)", () => {
    const big = "a".repeat(50);
    const out = splitIntoBubbles(`curto ${big} fim`, 20);
    expect(out).toContain(big);
    expect(out.every((b) => b.length > 0)).toBe(true);
  });
  it("não perde texto quando o ponto não é seguido de espaço (preço decimal)", () => {
    const out = splitIntoBubbles(
      "Seu pedido de R$149.90 já saiu para entrega hoje as 14h no bairro central.",
      30,
    );
    expect(out.join(" ")).toContain("Seu pedido");
    expect(out.join(" ")).toContain("149");
    expect(out.join(" ")).toContain("central");
  });

  it("nunca parte um valor em reais no separador de milhar (R$ 10.990) entre bolhas", () => {
    // Bug real em produção (2026-09-04): "R$ 10.990" virava bolha "R$ 10." + bolha
    // "990 no cartão…" — o cliente que via só a primeira lia "R$ 10" como o
    // preço de uma moto de R$ 10.990.
    const out = splitIntoBubbles(
      "Temos a DT3 por R$ 9.990 à vista no Pix ou R$ 10.990 no cartão em até 12x sem juros.",
      40,
    );
    for (const bubble of out) {
      expect(bubble).not.toMatch(/\d\.\s*$/); // nenhuma bolha termina em "dígito."
    }
    expect(out.join(" ")).toContain("10.990");
    expect(out.join(" ")).toContain("9.990");
  });

  it("não insere espaço espúrio dentro de um valor em reais (R$ 7. 990)", () => {
    const out = splitIntoBubbles("O valor é R$ 7.990 à vista no Pix.", 30);
    expect(out.join(" ")).not.toContain("7. 990");
    expect(out.join(" ")).toContain("7.990");
  });
});

// O parágrafo é a fronteira da bolha (medido em produção, 26/09/2026: com os
// parágrafos juntados até o teto, a opção não tinha ajuste — teto alto virava
// uma bolha só, teto baixo picotava o resumo do pedido no meio da linha).
describe("splitIntoBubbles — o parágrafo é a bolha", () => {
  it("três parágrafos curtos saem em três bolhas, na ordem, mesmo cabendo numa só", () => {
    const texto = "Olá! Tudo bem? 😊\n\nSim, serve para qualquer modelo.\n\nQuer que eu reserve?";
    expect(splitIntoBubbles(texto, 600)).toEqual([
      "Olá! Tudo bem? 😊",
      "Sim, serve para qualquer modelo.",
      "Quer que eu reserve?",
    ]);
  });

  it("o resumo do pedido — lista numa linha por item — sai inteiro, com as quebras de linha", () => {
    const resumo = [
      "Resumo do seu pedido:",
      "📦 Produto X x1 - R$ 135,00",
      "📍 Rua das Flores, 100, Centro",
      "📌 Ref: em frente à praça",
      "🕚 Amanhã às 11h",
      "💵 Pagamento em dinheiro na entrega",
      "Confirmamos assim?",
    ].join("\n");
    expect(splitIntoBubbles(resumo, 600)).toEqual([resumo]);
  });

  it("só o parágrafo que estoura o teto é partido, e dentro dele", () => {
    const texto = "Curto.\n\nPrimeira frase longa aqui. Segunda frase longa aqui.";
    expect(splitIntoBubbles(texto, 30)).toEqual([
      "Curto.",
      "Primeira frase longa aqui.",
      "Segunda frase longa aqui.",
    ]);
  });
});

// Medido em produção (26/09/2026): com a instrução antiga ("Prefira várias
// mensagens curtas a um texto único e longo"), o modelo chamava send_message
// várias vezes no mesmo passo — chamadas paralelas, que chegam fora de ordem.
// A instrução tem de pedir UM envio em parágrafos, e o corte do sistema tem de
// cumprir o que ela promete: partir nos parágrafos, em ordem.
describe("instrucaoDeBolhas", () => {
  it("desligado não diz nada ao modelo", () => {
    expect(instrucaoDeBolhas(false)).toBe("");
  });

  it("ligado pede UM envio em parágrafos — nunca várias chamadas de send_message", () => {
    const t = instrucaoDeBolhas(true);
    expect(t).toMatch(/ÚNICA chamada de send_message/);
    expect(t).toMatch(/parágrafos curtos separados por uma linha em branco/);
    // Resposta curta NÃO é partida: parágrafo só quando há mais de uma ideia.
    expect(t).toMatch(/Resposta curta vai num parágrafo só/);
    expect(t).toMatch(/Nunca chame send_message mais de uma vez/);
    expect(t).not.toMatch(/várias mensagens/i);
  });

  it("o texto escrito como a instrução pede sai em bolhas nos parágrafos, na mesma ordem", () => {
    const resposta = [
      "Olá! Aqui é a assistente da loja 😊",
      "Sobre o produto: ele usa a pressão da própria torneira para dar um jato forte.",
      "Sai por R$ 135,00, com frete grátis e pagamento na entrega. Quer que eu reserve?",
    ].join("\n\n");
    const bolhas = splitIntoBubbles(resposta, 90);
    expect(bolhas).toEqual([
      "Olá! Aqui é a assistente da loja 😊",
      "Sobre o produto: ele usa a pressão da própria torneira para dar um jato forte.",
      "Sai por R$ 135,00, com frete grátis e pagamento na entrega. Quer que eu reserve?",
    ]);
  });

  it("o turno usa esta instrução, e não um texto próprio", () => {
    const turno = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
    expect(turno).toMatch(/instrucaoDeBolhas\(agentConfig\?\.splitMessages/);
    expect(turno).not.toMatch(/Prefira várias mensagens curtas/);
  });
});
