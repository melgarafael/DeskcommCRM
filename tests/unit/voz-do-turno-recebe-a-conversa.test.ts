/**
 * A LIGAÇÃO do #4345 no turno real.
 *
 * `tests/unit/resolver-voz-do-turno.test.ts` prova a decisão quando ela RECEBE
 * a conversa — mas chama `textosDoClienteNoHistorico` à mão. O que faz o pedido
 * de áudio de duas mensagens atrás valer em produção é `inbound-turn.ts`
 * entregar o histórico que o turno já carregou. Se essa linha voltar a passar
 * só a mensagem atual, os testes da decisão seguem verdes e o cliente que
 * escreveu "não sei ler, manda áudio" volta a receber texto na mensagem
 * seguinte. Esta cerca reprova essa volta.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const TURNO = readFileSync(
  path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
  "utf8",
);

describe("a voz do turno recebe a CONVERSA, não só a mensagem (#4345)", () => {
  it("inbound-turn entrega à decisão os textos do cliente no histórico carregado", () => {
    expect(TURNO).toMatch(
      /inboundTexts:\s*textosDoClienteNoHistorico\(\s*openingContext\.context\.messages\s*,\s*currentInboundText\s*\)/,
    );
  });
});
