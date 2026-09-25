/**
 * `send_message` com `produto_codigo` manda a foto do catálogo PELA CADEIA
 * `before_send` (ideia de @vgamkt, #1130; migration 0390).
 *
 * A lógica mora em `agent/fotos-do-produto.ts` e é testada lá, por
 * comportamento. O que este arquivo prende é a FIAÇÃO dentro do `execute`, que é
 * uma closure do turno sem ponto de injeção barato (mesma técnica de
 * `send-message-corpo-vazio.test.ts`): a foto só pode sair de dentro do `send`
 * que o guardrail chama — por fora, pularia opt-out, LGPD e o ritmo anti-ban.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AGENT_TOOL_DEFS } from "@/lib/agent-engine/agent/inbound-turn";

const FONTE = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
const corpoDoSend = (() => {
  const i = FONTE.indexOf("send_message: tool({");
  const j = FONTE.indexOf("update_lead_state: tool({", i);
  expect(i).toBeGreaterThan(-1);
  expect(j).toBeGreaterThan(i);
  return FONTE.slice(i, j);
})();

describe("send_message leva a foto do produto", () => {
  it("o modelo enxerga o campo produto_codigo, opcional", () => {
    const schema = AGENT_TOOL_DEFS.send_message.inputSchema;
    expect(schema.safeParse({ body: "oi" }).success).toBe(true);
    expect(schema.safeParse({ body: "oi", produto_codigo: "IP15" }).data).toEqual({
      body: "oi",
      produto_codigo: "IP15",
    });
  });

  it("as fotos são preparadas ANTES da cadeia (fora do lock) e o código errado volta sem enviar", () => {
    const prepara = corpoDoSend.indexOf("prepararFotosDoProduto(");
    const cadeia = corpoDoSend.indexOf("runBeforeSend(beforeSendArgs)");
    expect(prepara).toBeGreaterThan(-1);
    expect(cadeia).toBeGreaterThan(-1);
    expect(prepara).toBeLessThan(cadeia);
  });

  it("a foto sai de DENTRO do `send` do guardrail, com o corpo que a cadeia aprovou", () => {
    const send = corpoDoSend.slice(corpoDoSend.indexOf("send: (finalBody: string) =>"));
    expect(send).toContain("enviarComFotos(finalBody, fotosDoProduto,");
  });
});
