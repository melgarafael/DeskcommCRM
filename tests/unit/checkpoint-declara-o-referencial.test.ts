/**
 * O CHECKPOINT DIZ QUANDO FOI ESCRITO, E O CADASTRO VAZIO NÃO É AUTORIDADE
 * (issue #510).
 *
 * ─── O defeito, medido numa conversa real ───────────────────────────────────
 *
 * O agente pediu o e-mail do cliente QUATRO vezes na mesma conversa, com o
 * cliente respondendo três. Duas causas somadas:
 *
 * 1. `CHECKPOINT_INSTRUCTION` pede "próxima ação" SEM referencial. O checkpoint
 *    é escrito no FECHO do turno — depois de a pergunta já ter saído e ANTES de
 *    a resposta chegar. Sem referencial, o modelo grava como próxima ação a
 *    pergunta que ACABOU de fazer. No turno seguinte esse texto volta como o
 *    PRIMEIRO bloco do prompt, acima do histórico — e a instrução mais recente
 *    manda repetir a pergunta que o histórico logo abaixo já responde.
 *
 * 2. `contact.email: null` chega ao contexto como fato. O modelo lê "não tem
 *    e-mail" com a autoridade de um cadastro, e essa leitura vence o histórico
 *    onde o cliente acabou de digitar o e-mail. Não há caminho de escrita: o
 *    campo NUNCA deixa de ser null, então o pedido se repete para sempre.
 *
 * ─── ⚠️ O QUE ESTE ARQUIVO NÃO PROVA ────────────────────────────────────────
 *
 * Ele vigia TEXTO, não comportamento. `toContain` sobre uma instrução é BUSCA:
 * impede a REGRESSÃO da frase, não garante que o modelo parou de repetir. A
 * prova do efeito é conversa real com o modelo em produção, e ela não cabe em
 * vitest.
 *
 * Isso está escrito aqui de propósito, para o verde não virar álibi.
 */
import { describe, expect, it } from "vitest";

import { CHECKPOINT_INSTRUCTION, ritualBlocks } from "@/lib/agent-engine/agent/inbound-turn";

describe("a instrução do checkpoint declara O QUANDO da próxima ação", () => {
  it("⭐ amarra a próxima ação à resposta que ainda NÃO chegou", () => {
    // Sem referencial, "próxima ação" no fecho do turno é ambígua entre "o que
    // eu acabei de fazer" e "o que farei depois" — e o modelo grava a primeira.
    expect(
      /depois da resposta/i.test(CHECKPOINT_INSTRUCTION),
      "a instrução não diz que a próxima ação vem DEPOIS da resposta que o agente está esperando",
    ).toBe(true);
  });

  it("⭐ nega explicitamente a pergunta recém-feita", () => {
    // Dizer o que É não basta quando o erro tem um atrator forte. A negação é o
    // que separa a instrução nova da anterior para um modelo pequeno.
    expect(
      /nunca a pergunta que você acabou de fazer/i.test(CHECKPOINT_INSTRUCTION),
      "a instrução não proíbe gravar como próxima ação a pergunta que acabou de sair",
    ).toBe(true);
  });

  it("a declaração obrigatória do turno continua dentro da instrução", () => {
    // Guarda contra o conserto quebrar o que já estava certo: `declaracao-do-turno`
    // exige que DECLARACAO_INSTRUCTION esteja aqui, e a concatenação é posicional.
    expect(CHECKPOINT_INSTRUCTION).toContain("Sem texto fora do JSON.");
    expect(CHECKPOINT_INSTRUCTION).toContain('"next_action"');
  });
});

describe("o bloco do checkpoint declara a precedência do histórico", () => {
  const checkpoint = {
    commitments: ["enviar proposta"],
    objections: [],
    next_action: "pedir o e-mail do cliente",
    rolling_summary: "cliente pediu orçamento",
  } as never;

  const blocos = () =>
    ritualBlocks(
      checkpoint as never,
      null,
      { contact: { name: "Cliente", email: null } } as never,
      "sem notas",
      false,
    ).join("\n");

  it("⭐ o cabeçalho diz que o checkpoint foi escrito ANTES da última mensagem", () => {
    // Ele volta como PRIMEIRO bloco do prompt, acima do histórico. Sem dizer
    // quando foi escrito, ele lê como a instrução mais recente — e vence o
    // histórico que o contradiz.
    const t = blocos();
    expect(
      /antes da última mensagem/i.test(t),
      "o cabeçalho do checkpoint não diz que ele é anterior à última mensagem do cliente",
    ).toBe(true);
  });

  it("⭐ e diz quem manda quando os dois discordam", () => {
    expect(
      /o histórico manda|prevalece o histórico|vale o histórico/i.test(blocos()),
      "o cabeçalho não declara a precedência: com checkpoint e histórico discordando, o modelo não sabe qual seguir",
    ).toBe(true);
  });

  it("controle positivo: o instrumento enxerga os blocos", () => {
    // Sem isto, um `ritualBlocks` que devolvesse vazio faria as asserções acima
    // falharem por motivo errado — e as de ausência passariam por vacuidade.
    const t = blocos();
    expect(t).toContain("Checkpoint anterior");
    expect(t).toContain("pedir o e-mail do cliente");
  });
});

describe("cadastro vazio não se apresenta como fato", () => {
  it("⭐ `email: null` no contexto vem com a ressalva de que o histórico pode ter", () => {
    // É a segunda camada, e é ela que mata o caso medido de 4×: o campo NUNCA
    // deixa de ser null (não há caminho de escrita), então lido como autoridade
    // ele repete o pedido para sempre.
    const t = ritualBlocks(
      null,
      null,
      { contact: { name: "Cliente", email: null } } as never,
      "sem notas",
      false,
    ).join("\n");

    expect(
      /não confirmado no cadastro|pode já ter sido dito|cadastro pode estar vazio/i.test(t),
      "o contexto apresenta `email: null` como fato — o modelo lê 'não tem e-mail' com autoridade de cadastro e ignora o histórico onde o cliente acabou de dizer",
    ).toBe(true);
  });

  it("cadastro PREENCHIDO não ganha ressalva — ela existe para o vazio", () => {
    // Controle na direção oposta: uma ressalva incondicional ensinaria o modelo
    // a duvidar de dado bom, que é o defeito espelhado.
    const t = ritualBlocks(
      null,
      null,
      { contact: { name: "Cliente", email: "cliente@exemplo.com" } } as never,
      "sem notas",
      false,
    ).join("\n");

    expect(/não confirmado no cadastro/i.test(t)).toBe(false);
  });
});
