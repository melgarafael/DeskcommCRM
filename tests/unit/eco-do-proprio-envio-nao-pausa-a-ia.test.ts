import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { socialMessageId } from "@/lib/channels/social/catalog";
import { parseSocialMessage } from "@/lib/channels/social/parser";

/**
 * O ECO DO NOSSO PRÓPRIO ENVIO NÃO PODE PAUSAR A IA.
 *
 * ## O risco, e por que ele é silencioso
 *
 * `lib/channels/zernio/ingest.ts` pausa a IA por 60 minutos quando chega uma
 * mensagem `outbound` de canal social — a leitura é "um humano assumiu e
 * respondeu pelo aplicativo do celular".
 *
 * Só que TODO envio nosso volta como `outbound` pelo webhook. A única coisa que
 * separa "humano assumiu" de "eco do que nós mesmos mandamos" é a mensagem casar
 * como **duplicada** pelo `unique (organization_id, external_id)` — e o ramo da
 * pausa está aninhado em `if (inseridaNaExistente !== "duplicate")`.
 *
 * Se o casamento falhar, o desfecho é cruel de diagnosticar: a IA some daquela
 * conversa por uma hora, a tela diz "alguém assumiu a mão", e quem for
 * investigar procura um humano que não existe. Pior: cada resposta da IA
 * renova o silêncio — ela responde uma vez e morre ali.
 *
 * ## O que este arquivo mede, e o que ele NÃO pode medir
 *
 * Os dois lados derivam o id de campos com nomes diferentes:
 *
 *   envio    `lib/channels/social/adapter.ts`  → `data.messageId`
 *   webhook  `lib/channels/social/parser.ts`   → `message.platformMessageId ?? message.id`
 *
 * Se o provedor devolve o MESMO valor nos dois, casam e está tudo certo. Se
 * devolve valores diferentes, não casam. **Daqui não dá para saber o que o
 * provedor faz** — por isso o sintoma não é defeito provado, é risco com
 * caminho conhecido.
 *
 * O que dá para fixar, e é o que este arquivo faz: que a nossa metade é
 * consistente. Mesmo formato, mesma função, e o campo que o webhook prefere é o
 * que o envio grava. Se alguém mexer num lado só, isto reprova.
 */

const RAIZ = path.resolve(__dirname, "../..");
const CONTA = "652f1a2b3c4d5e6f70819293";

/** O que o adapter grava em `messages.external_id` depois de enviar. */
function idDoEnvio(messageIdDoProvedor: string): string {
  return socialMessageId(CONTA, messageIdDoProvedor);
}

/** O que a ingestão vai procurar quando o eco chegar. */
function idDoEco(payload: unknown): string | null {
  // A assinatura real leva a conta e a plataforma: o parser RECUSA payload de
  // outra conta, que é uma proteção a mais e não um detalhe do teste.
  const parsed = parseSocialMessage(payload, CONTA, "instagram");
  return parsed?.externalId ?? null;
}

/**
 * O payload do eco, na FORMA que o schema do parser exige.
 *
 * Montei-o pela primeira vez de memória e o parser devolveu `null` — faltavam
 * `message.platform`, `message.direction` e `conversation.participantId`. Um
 * `null` ali teria passado despercebido se as asserções fossem frouxas: o teste
 * "não casou" ficaria verde pelo motivo errado, provando nada sobre ids.
 */
function ecoDe(campos: { id?: string; platformMessageId?: string | null }) {
  return {
    event: "message.sent",
    account: { id: CONTA, platform: "instagram" },
    message: {
      id: campos.id ?? "MSG-123",
      platformMessageId: campos.platformMessageId ?? null,
      conversationId: "conversa-1",
      platform: "instagram",
      direction: "outgoing",
      text: "oi",
      attachments: [],
    },
    conversation: { participantId: "pessoa-1" },
  };
}

describe("ida e volta: o que o envio grava é o que o eco procura", () => {
  it("CONTROLE: o parser aceita o payload — sem isto, tudo abaixo mede `null`", () => {
    // Um payload que o schema recusa devolve `null`, e `null` nunca é igual a
    // coisa nenhuma: o caso da divergência passaria pelo motivo errado.
    expect(idDoEco(ecoDe({ id: "MSG-123" }))).not.toBeNull();
  });

  it("o provedor devolvendo o mesmo id nos dois lados: CASAM", () => {
    // O caminho feliz, e o que sustenta a proteção inteira hoje.
    const enviado = idDoEnvio("MSG-123");
    const ecoado = idDoEco(ecoDe({ id: "MSG-123" }));
    expect(ecoado).toBe(enviado);
  });

  it("o webhook PREFERE `platformMessageId` — e é aí que a divergência entra", () => {
    // Este caso não é uma falha: é a CONDIÇÃO desenhada. Ele existe para que
    // quem ler saiba exatamente qual é o risco, com o valor na frente.
    const enviado = idDoEnvio("MSG-123");
    const ecoado = idDoEco(ecoDe({ id: "MSG-123", platformMessageId: "PLAT-999" }));
    expect(ecoado).not.toBe(enviado);
    expect(ecoado).toBe(socialMessageId(CONTA, "PLAT-999"));
  });

  it("os dois lados usam a MESMA função de formato", () => {
    // Se um lado passasse a montar a string à mão, o casamento morreria sem
    // ninguém mexer em id nenhum — e o sintoma seria a IA sumindo de conversas.
    const adapter = fs.readFileSync(path.join(RAIZ, "lib/channels/social/adapter.ts"), "utf8");
    const parser = fs.readFileSync(path.join(RAIZ, "lib/channels/social/parser.ts"), "utf8");
    expect(adapter).toMatch(/socialMessageId\(/);
    expect(parser).toMatch(/socialMessageId\(/);
    // E nenhum dos dois monta o prefixo na mão.
    expect(adapter).not.toMatch(/`social:\$\{/);
    expect(parser).not.toMatch(/`social:\$\{/);
  });
});

describe("a pausa da IA é a consequência, e está aninhada na proteção", () => {
  const ingest = fs.readFileSync(path.join(RAIZ, "lib/channels/zernio/ingest.ts"), "utf8");

  it("pausar só acontece DENTRO do ramo de não-duplicada", () => {
    // Esta é a asserção que guarda a regressão mais perigosa: soltar a chamada
    // de pausa para fora do `if` faria TODO eco do nosso próprio envio calar a
    // IA por 60 minutos.
    const chamada = ingest.indexOf("await pausarIaPorAtendimentoManual(");
    expect(chamada).toBeGreaterThan(-1);
    const guarda = ingest.lastIndexOf('if (inseridaNaExistente !== "duplicate") {', chamada);
    expect(
      guarda,
      "a pausa da IA saiu de dentro do ramo que exclui mensagem duplicada",
    ).toBeGreaterThan(-1);
  });

  it("e só para mensagem de SAÍDA de canal social", () => {
    const trecho = ingest.slice(
      ingest.lastIndexOf("if (input.socialMessage", ingest.indexOf("await pausarIaPorAtendimentoManual(")),
      ingest.indexOf("await pausarIaPorAtendimentoManual("),
    );
    expect(trecho).toMatch(/msg\.direction === "outbound"/);
  });
});
