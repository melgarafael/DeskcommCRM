import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { blocoDoModoDePrevia } from "@/lib/agent-engine/agent/inbound-turn";

/**
 * DE QUEM É A VOZ DO RASCUNHO (#3757).
 *
 * O botão **Sugerir resposta** do Inbox (`POST /api/v1/conversations/[id]/draft-reply`)
 * roda o agente publicado em prévia (`reply-drafts.ts` → `runAgentPreview` com
 * `kind: "assisted"`) e joga o texto na caixa do ATENDENTE HUMANO, que revisa e envia.
 *
 * Até esta correção as duas prévias recebiam o MESMO bloco — o de "MODO PRÉVIA",
 * escrito para o teste do agente. O prompt do agente, porém, é o de atendimento
 * automático: atender, qualificar e PASSAR A VEZ a uma pessoa. Numa conversa já
 * assumida, o modelo obedecia a esse prompt e o rascunho saía na voz do assistente
 * — "vou avisar o atendente e ele já te responde", "um especialista vai te chamar"
 * — em terceira pessoa em relação a quem ia enviar. O atendente descartava a
 * sugestão e escrevia do zero.
 *
 * O que este arquivo prende:
 *
 *   1. `assisted` diz de quem é a voz: primeira pessoa, como o atendente, sem falar
 *      como IA e sem propor passar o atendimento;
 *   2. `sandbox` (o botão "Testar" do agente) NÃO muda — o literal é o de antes,
 *      byte a byte, e é o controle do caso 1: um bloco que servisse aos dois
 *      passaria por metade destes testes sem conservar nada;
 *   3. o `system` de fato recebe o bloco do TIPO da prévia — medido no call site,
 *      porque `runAgentTurn` não é alcançável por unidade (precisa do turno
 *      inteiro) e um bloco certo que ninguém chama é indistinguível de bloco nenhum.
 *
 * O que NÃO se mede aqui: o rascunho gerado por um modelo de verdade (a frase
 * "vou avisar" some ou não com o bloco novo). Isso pede o agente falso do repo com
 * a conversa assumida, e está declarado como não medido no PR.
 */

const RAIZ = process.cwd();
const INBOUND = path.join(RAIZ, "lib/agent-engine/agent/inbound-turn.ts");

/** O bloco do sandbox tal como estava ANTES do #3757 — a régua do "não mudou". */
const SANDBOX_ANTES =
  "MODO PRÉVIA: proponha a resposta com send_message. Operações são propostas separadas; nunca diga que executou uma proposta. Nenhum envio real acontece.";

describe("bloco do modo de prévia — assisted fala como o atendente", () => {
  it("⛔ o assisted NÃO recebe o bloco de MODO PRÉVIA (é o defeito do #3757)", () => {
    expect(blocoDoModoDePrevia("assisted")).not.toContain("MODO PRÉVIA");
  });

  it("o assisted recebe o bloco de MODO ASSISTIDO, dizendo de quem é a voz", () => {
    const bloco = blocoDoModoDePrevia("assisted");
    expect(bloco.startsWith("MODO ASSISTIDO:")).toBe(true);
    expect(bloco).toContain("RASCUNHO");
    expect(bloco).toContain("atendente humano");
    expect(bloco).toContain("em nome dele");
    expect(bloco).toContain("primeira pessoa");
  });

  it("o assisted proíbe falar como IA e proíbe propor passar o atendimento", () => {
    const bloco = blocoDoModoDePrevia("assisted");
    expect(bloco).toContain("Não fale como assistente nem como IA");
    expect(bloco).toContain("não diga que vai avisar, chamar ou transferir");
    expect(bloco).toContain("não proponha passar o atendimento");
  });

  it("a garantia de que NADA é enviado sobrevive à separação", () => {
    // O bloco novo não pode ter perdido o "nenhum envio real acontece" — é o que
    // impede o rascunho de virar promessa de envio ao cliente.
    expect(blocoDoModoDePrevia("assisted")).toContain("Nenhum envio real acontece");
    expect(blocoDoModoDePrevia("assisted")).toContain("nunca diga que executou uma proposta");
  });
});

describe("bloco do modo de prévia — sandbox é o controle (não muda)", () => {
  it("o sandbox recebe o bloco de antes, byte a byte", () => {
    expect(blocoDoModoDePrevia("sandbox")).toBe(SANDBOX_ANTES);
  });

  it("o sandbox não fala do atendente humano — ele é o teste do próprio agente", () => {
    const bloco = blocoDoModoDePrevia("sandbox");
    expect(bloco).not.toContain("MODO ASSISTIDO");
    expect(bloco).not.toContain("atendente humano");
    expect(bloco).not.toContain("primeira pessoa");
  });

  it("os dois blocos são DIFERENTES — controle negativo da função", () => {
    // Uma função que devolvesse o mesmo bloco para os dois kinds passaria pelos
    // casos acima que só olham um lado. Este caso é o que a impede.
    expect(blocoDoModoDePrevia("assisted")).not.toBe(blocoDoModoDePrevia("sandbox"));
  });
});

describe("o call site do turno entrega o bloco do TIPO da prévia", () => {
  const fonte = fs.readFileSync(INBOUND, "utf8");

  it("o `system` recebe `blocoDoModoDePrevia(preview.kind)`, não um literal fixo", () => {
    expect(fonte).toContain("if (preview) blocosResidentes.push(blocoDoModoDePrevia(preview.kind));");
  });

  it("o literal de MODO PRÉVIA existe UMA vez — dentro do mapa, e não no call site", () => {
    const ocorrencias = fonte.split("'MODO PRÉVIA:").length - 1;
    expect(ocorrencias).toBe(1);
    expect(fonte).not.toContain("blocosResidentes.push(\n      '" + "MODO PRÉVIA:");
  });
});
