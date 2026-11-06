/**
 * O ENCERRAMENTO NOVO NÃO ACORDA CONSUMIDOR NENHUM POR ENGANO (#4023).
 *
 * O fato `conversation.closed` existe para uma automação reagir a ele — mas
 * essa automação é a FATIA SEGUINTE (pesquisa 1–5). Esta entrega é só o fato, e
 * um fato que já nasce consumido por um handler meia-boca mandaria mensagem para
 * o cliente de quem nunca pediu pesquisa.
 *
 * O que este arquivo mede, então, é a CONTAGEM de consumidores: zero. Os dois
 * lados que podem ligar um consumidor sem ninguém decidir:
 *
 *   1. o registro de handlers do dreno (`register-handlers.ts`) — quem assina um
 *      tipo é quem o recebe primeiro;
 *   2. o seletor de gatilho da automação (`TRIGGER_EVENTS`, a fonte única de
 *      `lib/schemas/webhooks.ts`) — a regra salva na tela nasce daqui, e um tipo
 *      nesta lista faria a regra rodar sem que a ação exista.
 *
 * ⚠️ QUANDO A PESQUISA CHEGAR, ESTE ARQUIVO MUDA DE LADO — de propósito. Ela vai
 * acrescentar o handler (e provavelmente o gatilho) e os dois casos passam a
 * cobrar o CONTRÁRIO: que exista exatamente um consumidor, com a chave certa. O
 * que não pode acontecer é o tipo entrar numa das duas listas de carona num PR
 * que não era sobre isso.
 */
import { describe, expect, it } from "vitest";

import { getRegisteredHandlers } from "@/lib/event-log/dispatcher";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";
import { TRIGGER_EVENTS } from "@/lib/schemas/webhooks";

const TIPO = "conversation.closed";

describe("o fato do fechamento não dispara nada hoje", () => {
  it("CONTROLE: o registro de handlers não vem vazio (sem isso o caso abaixo é verde por não medir nada)", () => {
    ensureHandlersRegistered();
    expect(getRegisteredHandlers().length).toBeGreaterThan(10);
  });

  it("nenhum handler do dreno assina conversation.closed", () => {
    ensureHandlersRegistered();
    const assinantes = getRegisteredHandlers()
      .filter((h) => h.events.includes(TIPO))
      .map((h) => h.key);
    expect(
      assinantes,
      "Um consumidor passou a assinar o encerramento da conversa sem a feature que " +
        "reage a ele. O fato sozinho não manda nada a ninguém; o consumidor é a fatia " +
        "da pesquisa de satisfação (#4023).",
    ).toEqual([]);
  });

  it("nenhum gatilho de automação é conversation.closed", () => {
    expect(
      (TRIGGER_EVENTS as readonly string[]).includes(TIPO),
      "O gatilho entrou no seletor da tela: a regra é salva, o operador acredita " +
        "que ela roda e nenhum efeito existe. Gatilho novo entra com a ação que o " +
        "executa, na fatia que a issue descreve.",
    ).toBe(false);
  });
});
