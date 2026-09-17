import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A CAMADA PLATAFORMA NÃO DITA COMO O AGENTE SE APRESENTA.
 *
 * ## O defeito que fez este teste existir
 *
 * `platform.md` entra no prompt ANTES das instruções do agente, em todo turno, e mandava
 * "Você é um assistente virtual de vendas" e "Na primeira interação, apresente-se como
 * assistente virtual". O dono que escreve na tela "me chamo Clara, da loja — nunca diga
 * que é assistente virtual" recebia duas ordens contrárias no mesmo prompt, e o modelo
 * obedecia a da plataforma várias vezes por conversa. Medido numa instalação real
 * (gpt-5.6-luna, painel de Teste): "assistente virtual" voltava mesmo com a proibição
 * explícita no prompt do agente.
 *
 * Apresentação é persona, e persona é do agente. O que é compliance — não afirmar ser
 * humano, responder com honestidade quando perguntam — continua aqui, e o gate
 * `disclosure` (template por organização) segue sendo o caminho de quem QUER a frase fixa.
 *
 * ## O que este teste NÃO prova
 *
 * Que o modelo obedece. Ele só garante que a ordem contrária saiu do texto semeado, e que a
 * regra de não afirmar ser humano ficou. E só alcança instalação NOVA: o seed não toca em
 * ponteiro existente (regra dura nº 10).
 */
const PLATFORM = readFileSync(
  path.join(process.cwd(), "lib", "agent-engine", "playbooks", "platform.md"),
  "utf8",
);

describe("platform.md não impõe apresentação ao agente", () => {
  it("não manda se apresentar como assistente virtual", () => {
    expect(PLATFORM).not.toMatch(/apresente-se como assistente virtual/i);
    expect(PLATFORM).not.toMatch(/Você é um assistente virtual/i);
  });

  it("mantém a regra de não afirmar ser humano e de responder com honestidade", () => {
    expect(PLATFORM).toMatch(/Nunca afirme ser humano/);
    expect(PLATFORM).toMatch(/responda com honestidade/);
  });
});
