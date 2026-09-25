/**
 * `send_message` recusa corpo que é só espaço/quebra de linha (@vgamkt, #1130).
 *
 * O schema da tool pede `min(1)`, e `"\n"` tem um caractere: passa. Medido ao
 * vivo pelo autor, o `gpt-4o-mini` mandou assim e o cliente recebeu bolhas em
 * branco no WhatsApp. A recusa devolve o erro ao modelo, que reescreve.
 *
 * Mesma técnica de `mensagem-atual-prioritaria.test.ts`: o `execute` é uma
 * closure dentro do turno, sem ponto de injeção barato, então o teste prende o
 * `if` no único caminho que fala no canal — e a posição dele, que é o que
 * garante que a recusa não gasta a cota de envios do turno.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const FONTE = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
const corpoDoSend = (() => {
  const i = FONTE.indexOf("send_message: tool({");
  const j = FONTE.indexOf("update_lead_state: tool({", i);
  expect(i).toBeGreaterThan(-1);
  expect(j).toBeGreaterThan(i);
  return FONTE.slice(i, j);
})();

describe("send_message nunca manda bolha em branco", () => {
  it("o execute recusa corpo vazio depois do trim, com erro que ensina o modelo", () => {
    expect(corpoDoSend).toMatch(/if \(body\.trim\(\) === ''\) \{\s*return \{\s*ok: false,/);
    expect(corpoDoSend).toContain("code: 'corpo_vazio'");
  });

  it("a recusa vem antes do teto de envios — corpo vazio não gasta a cota do turno", () => {
    // Presença antes de posição: `indexOf` de algo ausente é −1, e −1 é menor
    // que qualquer posição (o modo de falha já pago no teste irmão).
    const recusa = corpoDoSend.indexOf("'corpo_vazio'");
    const teto = corpoDoSend.indexOf("'max_sends_per_turn'");
    expect(recusa).toBeGreaterThan(-1);
    expect(teto).toBeGreaterThan(-1);
    expect(recusa).toBeLessThan(teto);
  });
});
