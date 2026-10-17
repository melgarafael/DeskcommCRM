import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * O CANAL POR QR ASSINAVA A MESMA MENSAGEM DUAS VEZES.
 *
 * ─── O defeito, e por que ele era invisível ─────────────────────────────────
 *
 * `WHATSAPP_HOOK_EVENTS` pedia `message` E `message.any`. O WAHA emite os dois
 * para a mesma mensagem, e `lib/waha/ingest.ts` já chama isso de corrida e
 * deduplica — então NADA aparecia errado no produto: nenhuma mensagem em
 * dobro, nenhum alerta.
 *
 * O que dobrava era o ARQUIVO do corpo cru. Medido numa instalação real:
 * 22.939 linhas de `message` ao lado de 24.582 de `message.any`, numa tabela
 * que era 86% do banco. 41% dela era cópia.
 *
 * ─── Por que dá para tirar `message`, e como isso foi provado ───────────────
 *
 * Não pela documentação — pelo banco. Cruzando os ids de mensagem dos dois
 * eventos em 22.815 mensagens reais:
 *
 *   chegaram só por `message` ......... 0
 *   chegaram só por `message.any` ..... 1.642   (as que saíram de nós)
 *
 * Superconjunto estrito, medido. E a doutrina do CLAUDE.md já mandava assinar
 * `message.any` "não só `message`" por causa de multi-device — o que faltava
 * era tirar o irmão redundante.
 *
 * ─── O que este teste segura ────────────────────────────────────────────────
 *
 * Que alguém devolva `message` à lista "por segurança". A segurança aqui é
 * medida e está acima; devolvê-lo dobra de novo a tabela que mais pesa no
 * banco de todo clone, sem trazer uma única mensagem a mais.
 */

const COMPOSES = ["docker-compose.prod.yml", "docker-compose.yml", "docker-compose.local.yml"];

/** A lista de eventos do `WHATSAPP_HOOK_EVENTS` de um compose, em ordem. */
function eventosDe(arquivo: string): string[] {
  const linha =
    readFileSync(arquivo, "utf8")
      .split("\n")
      .find((l) => l.includes("WHATSAPP_HOOK_EVENTS")) ?? "";
  return (linha.split('"')[1] ?? "").split(",").map((e) => e.trim()).filter(Boolean);
}

describe("a assinatura de eventos do canal por QR", () => {
  for (const arquivo of COMPOSES) {
    const linha =
      readFileSync(arquivo, "utf8")
        .split("\n")
        .find((l) => l.includes("WHATSAPP_HOOK_EVENTS")) ?? "";

    it(`${arquivo}: assina \`message.any\``, () => {
      // O superconjunto. Sem ele o canal perde as mensagens que SAEM de nós,
      // que é o caso multi-device da doutrina.
      expect(linha).toContain("message.any");
    });

    it(`${arquivo}: NÃO assina \`message\` sozinho`, () => {
      const eventos = (linha.split('"')[1] ?? "").split(",").map((e) => e.trim());
      expect(eventos, "`message` voltou — dobra o arquivo sem trazer mensagem nova").not.toContain(
        "message",
      );
    });

    it(`${arquivo}: os outros eventos continuam`, () => {
      // O conserto não pode ter custado o resto: ack move o status, revoked e
      // edited corrigem linha existente, e os dois de sessão são o que faz o
      // canal enxergar a própria queda.
      for (const e of ["message.ack", "message.edited", "message.revoked", "session.status", "state.change"]) {
        expect(linha, `sumiu ${e}`).toContain(e);
      }
    });
  }
});

/**
 * OS TRÊS COMPOSES CONTAM A MESMA HISTÓRIA — e a divergência fica vermelha.
 *
 * A reação chega pelo evento PRÓPRIO `message.reaction` (#2797): o WAHA não a
 * entrega dentro de `message.any`, então o evento tem de estar assinado em TODO
 * compose que sobe um WAHA. O PR #2815 acrescentou só no `docker-compose.yml`
 * (o de desenvolvimento) e a instalação real — que sobe o `.prod.yml` pelo kit
 * — continuava sem assinar: o código tratava a reação perfeitamente e o
 * transporte nunca a enviava. É o mesmo elo silencioso de `message.edited`
 * (345db9cae), e a divergência entre os arquivos é o que o esconde.
 *
 * O `.local.yml` entra aqui também: um clone que só rodasse o compose local
 * teria o mesmo buraco, e descobri-lo de novo custaria o mesmo tanto.
 */
describe("os três composes assinam os mesmos eventos do canal por QR", () => {
  it("todos assinam `message.reaction` (sem ele a reação nunca chega)", () => {
    for (const arquivo of COMPOSES) {
      expect(
        eventosDe(arquivo),
        `${arquivo} não assina message.reaction — a reação do cliente não chega`,
      ).toContain("message.reaction");
    }
  });

  it("a lista de eventos é IDÊNTICA nos três (a divergência fica vermelha)", () => {
    const referencia = eventosDe(COMPOSES[0]!);
    for (const arquivo of COMPOSES) {
      expect(
        eventosDe(arquivo),
        `${arquivo} divergiu do ${COMPOSES[0]} — a instalação que sobe este compose não vê os mesmos eventos`,
      ).toEqual(referencia);
    }
  });
});
